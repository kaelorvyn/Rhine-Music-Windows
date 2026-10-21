// Qishui (汽水音乐) protocol adapter.
// 端点依据：2026-10-20 实测 + PC 客户端 3.7.0 的 IDL 对照。
//
//   账号歌单  GET  /luna/pc/me/playlist?cursor=&count=            （需 sessionid）
//             -> { playlists, next_cursor, has_more, total_num }   ← cursor 分页，不是 offset
//   歌单详情  POST beta-luna.douyin.com/luna/playlist/detail       （免登录）
//             body { playlist_id, count, cursor }
//             -> { playlist, media_resources, has_more, next_cursor }
//   取曲      GET  /luna/h5/seo_track?track_id=                    （免签名）
//             -> track_player.video_model（JSON 字符串）→ video_list[0].main_url
//   账号信息  GET  /luna/pc/me -> { my_info: { id, nickname, ... } }（字段名是 my_info，不是 user）
//
// 【播放能力边界 —— 实测】
//   免费曲：h5/seo_track 下发**整首**（实测 208.774s vs 全曲 208.823s）。
//   VIP 曲：同一接口只给 **29 秒预览**（video_id 等于 preview.vid）。
//   整首走应用层 POST/GET /luna/pc/media-player，该接口需要 X-Helios / X-Medusa
//   签名（见 qishui-signer.mjs）。签名可用且已登录时给整首；否则回落 seo_track，
//   拿不到整首就如实报错，交给 music-server 既有的 LX 换源兜底。
//   绝不把预览片段当整首播。
//
// 【搜索】/luna/search/track 需要 a_bogus 类签名，恒返回 empty_search，因此不接入；
//   前端已把汽水排除在搜索页签之外（online-search-core.ts / online-music-search.ts）。

import { signHeaders, signerReady } from './qishui-signer.mjs';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = value => (value === undefined || value === null ? '' : String(value)).trim();

const BASE = 'https://api.qishui.com';
const APP_BASE = 'https://beta-luna.douyin.com';
const UA_APP = 'Luna/19.1.0 Android';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const CT = 'application/json; charset=utf-8';

// PC 端公共参数（对齐客户端 getTTCommonParams / shell_config.json 的 appId）。
const AID = '386088';
const IID = '4210500195088827';
const VERSION_CODE = '30070100';
/** 部分接口要单独带 device_id；与签名用的设备号无关，固定即可。 */
const DEVICE_ID = '46556f981720424883da62b74b60b46a';
const APP_VERSION = '3.7.0';
/** 客户端 UA 是 `LunaPC/{版本}({构建号})`，服务端会校验，用错会触发版本闸。 */
const UA_PC = `LunaPC/${APP_VERSION}(${VERSION_CODE})`;

/** 账号歌单一次翻多少；客户端上限 100。 */
const ACCOUNT_PAGE = 100;
/** 歌单详情一页多少。 */
const TRACK_PAGE = 50;
/** 账号歌单 / 歌单曲目的本地缓存时长。 */
const CACHE_MS = 300000;

/** 封面地址组装。实测三种拼法只有一种能用：
 *    urls[0]+uri                -> 400
 *    urls[0]+uri+'~'+tpl+'.webp'-> 400
 *    urls[0]+uri+'~'+tpl+'-15.webp' -> 200 image/webp 62942B  ✅
 * `-15` 是字节 CDN 的模板后缀（尺寸/格式档位），换别的数字会 400，别猜。 */
function coverOf(urlCover) {
  if (!urlCover || typeof urlCover !== 'object') return undefined;
  const base = Array.isArray(urlCover.urls) ? clean(urlCover.urls[0]) : '';
  const uri = clean(urlCover.uri);
  if (!uri) return undefined;
  if (/^https?:\/\//.test(uri)) return uri;
  if (!/^https?:\/\//.test(base)) return undefined;
  const tpl = clean(urlCover.template_prefix);
  return tpl ? `${base}${uri}~${tpl}-15.webp` : `${base}${uri}`;
}

/** 歌手：Luna 用 artists[]，旧接口用扁平字段。 */
function artistOf(item) {
  const list = Array.isArray(item?.artists) ? item.artists : [];
  const joined = list
    .map(a => clean(a?.name ?? a?.simple_display_name ?? a?.nickname))
    .filter(Boolean)
    .join('、');
  return joined || clean(item?.artist ?? item?.artist_name ?? item?.singer_name ?? item?.author) || '未知歌手';
}

/** 标签：只有明确标了 vip-only 才算受限曲。 */
function feeFrom(item) {
  if (item?.label_info?.only_vip_playable === true) return 1;
  if (item?.pay_type === 1 || item?.vip === 1 || item?.is_vip === 1) return 1;
  return 0;
}

function qualityFrom(item) {
  const q = clean(item?.quality ?? item?.video_meta?.quality ?? item?.bit_rate).toLowerCase();
  if (q.includes('lossless') || q.includes('flac') || q.includes('hires') || q.includes('master')) return '无损';
  if (q.includes('higher') || q.includes('320') || q.includes('excellent')) return '高品';
  return '标准';
}

/**
 * Luna 曲目归一化。字段来自 playlist/detail 与 seo_track 的 `track`：
 *   id / name / duration(毫秒) / album{name,url_cover} / artists[] / vid /
 *   label_info.only_vip_playable / preview{duration,vid}
 */
export function qishuiTrack(item) {
  const id = clean(item?.id ?? item?.track_id ?? item?.vid ?? item?.song_id);
  if (!id) return null;
  // duration 是**毫秒**；MusicTrack.duration 约定是**秒**（对照 netease-online 的 /1000）。
  const milliseconds = Number(item?.duration ?? item?.play_time ?? 0);
  return {
    id: `qishui-${id}`,
    albumId: `qishui-album-${clean(item?.album?.id ?? item?.album_id ?? '')}`,
    title: clean(item?.name ?? item?.title ?? item?.song_name) || '未知歌曲',
    artist: artistOf(item),
    duration: Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds / 1000) : 0,
    format: '在线音频',
    browserPlayable: true,
    localDecodable: false,
    audioUrl: '',
    relativePath: '',
    onlineSource: {
      provider: 'qishui',
      id,
      albumTitle: clean(item?.album?.name ?? item?.album_title ?? item?.album_name),
      coverUrl: coverOf(item?.album?.url_cover ?? item?.url_cover),
      pageUrl: 'https://qishui.com/',
      fee: feeFrom(item),
      albumId: clean(item?.album?.id ?? item?.album_id ?? ''),
      aliases: [],
      original: false,
      qualityLabel: qualityFrom(item),
    },
  };
}

/** 歌单归一化（账号歌单列表与歌单详情共用同一实体）。 */
function playlistOf(item, owned = true) {
  const id = clean(item?.id ?? item?.playlist_id);
  if (!id) return null;
  return {
    id,
    name: clean(item?.title ?? item?.name ?? item?.playlist_name) || '未命名歌单',
    trackCount: Math.min(100000, Math.max(0, Math.floor(Number(item?.count_tracks ?? item?.track_count ?? 0) || 0))),
    coverUrl: coverOf(item?.url_cover),
    owned,
  };
}

/** track_player.video_model 是**字符串**，不是对象。 */
function parseVideoModel(payload) {
  const raw = payload?.track_player?.video_model;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

/** seo_track 的歌词字段形态未完全确认，逐层兜底。 */
/**
 * 汽水的歌词是逐字时间的 QRC 格式：
 *   [880,6630]<0,470,0>隐<470,300,0>形<770,290,0>的...
 * 行首 [起始,时长]，字间 <偏移,时长,标记>。直接交给歌词组件会把标签当正文显示，
 * 所以转成标准 LRC：[mm:ss.xx]纯文本。
 */
function normalizeLyric(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 行首时间戳，单位毫秒
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    const body = line.replace(/^\[(\d+),(\d+)\]/, '').replace(/<\d+,\d+(?:,\d+)?>/g, '').trim();
    if (!head) {
      // 没有时间戳的行（例如标题、制作信息）原样保留
      if (body) lines.push(body);
      continue;
    }
    if (!body) continue; // 纯占位行（只有时长没有字）
    const totalMs = Number(head[1]);
    const minutes = String(Math.floor(totalMs / 60000)).padStart(2, '0');
    const seconds = ((totalMs % 60000) / 1000).toFixed(2).padStart(5, '0');
    lines.push(`[${minutes}:${seconds}]${body}`);
  }
  return lines.join('\n').slice(0, 200000);
}

function lyricOf(lyric) {
  if (typeof lyric === 'string') return normalizeLyric(lyric);
  if (!lyric || typeof lyric !== 'object') return '';
  const text = lyric.content ?? lyric.lyric ?? lyric.text ?? lyric.lrc ?? '';
  return typeof text === 'string' ? normalizeLyric(text) : '';
}

export class QishuiCatalog {
  constructor({ fetch: doFetch = globalThis.fetch, base = BASE, appBase = APP_BASE, auth = null, now = Date.now } = {}) {
    this.doFetch = doFetch;
    this.base = base;
    this.appBase = appBase;
    this.auth = auth;
    this.now = now;
    this.accountCache = null;
    this.trackCache = new Map();
  }

  credential() { return this.auth?.credential; }

  cookie() {
    const sessionid = this.credential()?.sessionid;
    return typeof sessionid === 'string' && sessionid ? { Cookie: `sessionid=${sessionid}` } : {};
  }

  /** 免签名取曲页载荷。免费曲返回整首，受限曲只返回预览片段。 */
  async seoTrack(id) {
    const response = await this.doFetch(`${this.base}/luna/h5/seo_track?track_id=${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': UA_WEB, ...this.cookie() },
    });
    if (!response.ok) throw failure('汽水音乐暂时无法连接，请稍后重试。', 502);
    const body = await response.json().catch(() => null);
    if (!body) throw failure('汽水音乐没有返回有效数据。', 502);
    return body;
  }

  /** 账号歌单：cursor 分页在内部摊平，对外保持 offset 接口（前端的统一契约）。 */
  async accountPlaylists() {
    const cached = this.accountCache;
    if (cached && this.now() - cached.at < CACHE_MS) return cached.value;
    const value = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({
        aid: AID, iid: IID, version_code: VERSION_CODE, count: String(ACCOUNT_PAGE),
        ...(cursor ? { cursor } : {}),
      });
      const response = await this.doFetch(`${this.base}/luna/pc/me/playlist?${params}`, {
        headers: { 'User-Agent': UA_PC, ...this.cookie() },
      });
      if (!response.ok) throw failure('汽水音乐暂时无法读取歌单，请稍后重试。', 502);
      const body = await response.json().catch(() => null);
      if (!body) throw failure('汽水音乐歌单返回格式发生变化。', 502);
      if (Number(body.status_code) === 1000016) {
        throw Object.assign(failure('登录状态已失效，请重新登录。', 401), { loginExpired: true });
      }
      for (const item of Array.isArray(body.playlists) ? body.playlists : []) {
        const playlist = playlistOf(item);
        if (playlist) value.push(playlist);
      }
      const next = clean(body.next_cursor);
      if (body.has_more !== true || !next || next === cursor) break;
      cursor = next;
    }
    this.accountCache = { at: this.now(), value };
    return value;
  }

  async playlists(offset = 0) {
    if (!this.credential()?.sessionid) throw failure('请先登录汽水音乐，再读取自己的歌单。', 401);
    const all = await this.accountPlaylists();
    const start = Math.max(0, Math.min(Number(offset) || 0, all.length));
    const playlists = all.slice(start, start + ACCOUNT_PAGE);
    return { provider: 'qishui', playlists, offset: start, limit: ACCOUNT_PAGE, hasMore: start + ACCOUNT_PAGE < all.length };
  }

  async fetchPlaylistPage(id, cursor) {
    const response = await this.doFetch(`${this.appBase}/luna/playlist/detail`, {
      method: 'POST',
      headers: { 'User-Agent': UA_APP, 'Content-Type': CT },
      body: JSON.stringify({ playlist_id: id, count: TRACK_PAGE, ...(cursor ? { cursor } : {}) }),
    });
    if (!response.ok) throw failure('汽水音乐暂时无法连接，请稍后重试。', 502);
    const payload = await response.json().catch(() => null);
    if (!payload) throw failure('汽水音乐歌单返回格式发生变化。', 502);
    const tracks = [];
    for (const item of Array.isArray(payload.media_resources) ? payload.media_resources : []) {
      // media_resources 里除了曲目还有别的类型；type 可能在包装层或实体层。
      if (item?.type !== 'track' && item?.entity?.type !== 'track') continue;
      const track = qishuiTrack(item?.entity?.track_wrapper?.track);
      if (track) tracks.push(track);
    }
    return {
      playlist: payload.playlist ?? {},
      tracks,
      hasMore: payload.has_more === true,
      nextCursor: clean(payload.next_cursor),
    };
  }

  async playlistTracks(value, offset = 0) {
    const id = /^\d{1,24}$/.test(clean(value)) ? clean(value) : '';
    if (!id) throw failure('无效的歌单标识。', 400);

    // cursor 与 offset 不等距（实测 20 条后 next_cursor=22），所以不能拿 offset 当 cursor：
    // 缓存已翻到的游标链，请求第 N 条时从 0 顺序补齐到 N+一页。
    const cached = this.trackCache.get(id);
    const state = cached && this.now() - cached.at < CACHE_MS
      ? cached
      : { at: this.now(), tracks: [], cursor: '', hasMore: true, total: 0 };

    const start = Math.max(0, Math.min(Number(offset) || 0, 1e6));
    const target = start + TRACK_PAGE;
    for (let page = 0; page < 20 && state.hasMore && state.tracks.length < target; page += 1) {
      const result = await this.fetchPlaylistPage(id, state.cursor);
      state.tracks.push(...result.tracks);
      state.total = Math.max(0, Number(result.playlist?.count_tracks) || state.total);
      state.hasMore = result.hasMore && !!result.nextCursor && result.nextCursor !== state.cursor;
      state.cursor = result.nextCursor;
    }
    state.at = this.now();
    this.trackCache.set(id, state);
    while (this.trackCache.size > 8) this.trackCache.delete(this.trackCache.keys().next().value);

    const tracks = state.tracks.slice(start, target);
    const total = state.total || state.tracks.length;
    return { playlistId: id, offset: start, total, tracks, hasMore: start + tracks.length < total || state.hasMore };
  }

  /**
   * 签名版取播放地址。带登录态时给整首（含受限曲），未登录/签名不可用时返回 null。
   *
   * 返回 { audioUrl, format, duration }；duration 是服务端下发的实际时长（秒），
   * 调用方用它跟曲目全曲时长比对，避免把预览片段当整首交出去。
   */
  async mediaPlayer(id) {
    const sessionid = clean(this.credential()?.sessionid);
    if (!sessionid || !signerReady()) return null;

    const params = new URLSearchParams({
      aid: AID, app_name: 'luna_pc', device_id: DEVICE_ID, iid: IID,
      version_name: APP_VERSION, version_code: VERSION_CODE, channel: 'official',
      device_platform: 'windows', device_type: 'Windows',
      media_id: id, media_type: 'track', queue_type: '',
      enable_refresh_api: 'false', enable_dash: 'true',
    });
    const url = `${this.base}/luna/pc/media-player?${params}`;
    // 签名覆盖 url + 请求头，所以头必须先生成再签。
    const headers = signHeaders(url, { 'user-agent': UA_PC, 'content-type': CT, cookie: `sessionid=${sessionid}` });
    const response = await this.doFetch(url, { headers });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || Number(body.status_code) === 1000016) return null;

    const info = Array.isArray(body.player_infos) ? body.player_infos[0] : null;
    const playUrl = clean(info?.url_player_info);
    if (!playUrl) return null;

    // url_player_info 指向 VOD，不用签名；里面才是真正的音频地址。
    const playResponse = await this.doFetch(playUrl, { headers: { 'User-Agent': UA_WEB } });
    if (!playResponse.ok) return null;
    const playBody = await playResponse.json().catch(() => null);
    const data = playBody?.Result?.Data ?? playBody?.Data ?? null;
    const list = Array.isArray(data?.PlayInfoList) ? data.PlayInfoList : [];
    // 档位从高到低排；跳过加密条目，取码率最高的可用地址。
    const best = list
      .filter(item => clean(item?.MainPlayUrl) || clean(item?.BackupPlayUrl))
      .filter(item => !Number(item?.EncryptionMethod))
      .sort((a, b) => Number(b?.Bitrate ?? 0) - Number(a?.Bitrate ?? 0))[0];
    const audioUrl = clean(best?.MainPlayUrl ?? best?.BackupPlayUrl);
    if (!audioUrl) return null;
    return { audioUrl, format: 'M4A', duration: Number(data?.Duration ?? best?.Duration ?? 0) };
  }

  async prepare(value) {
    const id = clean(value).replace(/^qishui-/, '');
    if (!id) throw failure('无效的汽水歌曲标识。', 400);

    // 并行：签名通道（可能给整首）与免签名通道（给元数据/时长基准）。
    const [payload, played] = await Promise.all([
      this.seoTrack(id).catch(() => null),
      this.mediaPlayer(id).catch(() => null),
    ]);
    const track = payload?.seo_track?.track ?? {};
    const fullSeconds = Number(track.duration) / 1000;

    if (played?.audioUrl) {
      const gotSeconds = Number(played.duration);
      // 服务端对无权益账号会下发片段；片段不许当整首交出去，继续走下面的兜底。
      const whole = !(fullSeconds > 0) || !Number.isFinite(gotSeconds) || gotSeconds <= 0 || gotSeconds + 1 >= fullSeconds;
      if (whole) return { audioUrl: played.audioUrl, format: played.format, fee: feeFrom(track) };
    }

    const model = parseVideoModel(payload);
    const first = Array.isArray(model.video_list) ? model.video_list[0] : null;
    const audioUrl = clean(first?.main_url ?? first?.backup_url);

    // 预览判定：video_duration 是**秒**（实测 208.774 / 29.002），track.duration 是**毫秒**。
    const gotSeconds = Number(model.video_duration);
    const previewVid = clean(track?.preview?.vid);
    const tooShort = Number.isFinite(gotSeconds) && gotSeconds > 0 && fullSeconds > 0 && gotSeconds + 1 < fullSeconds;
    const boundToPreview = !!previewVid && clean(model.video_id) === previewVid;
    if (!audioUrl || tooShort || boundToPreview) {
      // 用户可见文案不得出现「付费/会员/试听」字样（项目硬规则）。
      // music-server 会吞掉这个错误并转 LX 换源兜底。
      throw failure('汽水音乐暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    }
    return { audioUrl, format: 'M4A', fee: feeFrom(track) };
  }

  async songInfo(value) {
    const id = clean(value).replace(/^qishui-/, '');
    if (!id) throw failure('无效的汽水歌曲标识。', 400);
    const payload = await this.seoTrack(id);
    const track = qishuiTrack(payload?.seo_track?.track);
    if (!track) throw failure('汽水歌曲详情不可用。', 502);
    // music-server 读 info.track / info.album / info.lyrics —— 不是裸 track。
    const lyrics = lyricOf(payload?.lyric);
    return {
      track,
      album: { title: track.onlineSource.albumTitle || '未知专辑', artist: track.artist },
      lyrics: { original: lyrics, translated: '', instrumental: false, unavailable: !lyrics },
    };
  }

  /** 搜索需要 a_bogus 签名，恒空；保留实现只为路由完整性，前端不展示该页签。 */
  async search(query, offset = 0) {
    const keyword = clean(query);
    if (!keyword || keyword.length > 100) throw failure('请输入 1 至 100 个字符的搜索词。', 400);
    const page = Math.floor(Math.max(0, offset) / 20);
    const params = new URLSearchParams({
      device_id: '46556f98-1720-4248-83da-62b74b60b46a',
      keyword, count: '20', offset: String(page * 20),
      search_id: '', cursor: String(page * 20),
      type: 'search_one_track',
    });
    const response = await this.doFetch(`${this.base}/luna/search/track?${params}`, {
      headers: { 'User-Agent': UA_PC, 'Content-Type': CT },
    });
    const body = await response.json().catch(() => null);
    if (!body) throw failure('汽水音乐没有返回有效数据。', 502);
    const list = body?.data?.resultList ?? body?.resultList ?? body?.data?.tracks ?? body?.tracks ?? [];
    const tracks = (Array.isArray(list) ? list : []).map(item => qishuiTrack(item)).filter(Boolean);
    const total = Math.max(0, Number(body?.data?.total ?? body?.total ?? tracks.length));
    return { provider: 'qishui', query: keyword, offset, limit: 20, total, hasMore: (page + 1) * 20 < total, tracks };
  }
}
