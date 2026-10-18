import { randomInt } from 'node:crypto';
import { PlatformLoginProtocols } from './platform-login-protocols.mjs';
import { platformCover, platformMediaUrl } from './platform-media.mjs';

const names = { qq: 'QQ 音乐', bodian: '波点音乐' };
const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : '';
const count = value => Math.min(100000, Math.max(0, Math.floor(Number(value) || 0)));
export function platformSongId(provider, id) {
  const value = String(id);
  if (provider !== 'qq' || !/^[A-Za-z0-9]{8,32}$/.test(value)) throw failure('无效的平台歌曲 ID。', 400);
  return value;
}
/** 「平台音质码 → 规范档位名」：**逐指令反汇编自真实 exe**。
 *
 *  
 *  结构：`mov rcx,r14; add rcx,-3; cmp rcx,8; ja 默认; jmp [跳转表]`，
 *  即按 **字符串长度-3** 分派（跳转表实测 9 项）：
 *
 *  跳转表（index = len-3）：           反汇编确认的调用点 →
 *    len=3  → 128→standard  320→high
 *                           sur→surround  sky→surround  dts→原样
 *    len=4  →   128k/m500→standard 320k/m800→high
 *                           flac/f000→lossless  q000→**hifi**()
 *                           q001→**surround**    ai00→master()
 *                           d004→dolby()  dt03→dts()
 *                           high→原样  hifi→原样
 *    len=5  →   atmos→surround  hires→原样  dolby→原样  vinyl→原样
 *    len=6  →   exhigh→**high**()  master→原样
 *    len=8  →   jyeffect→**hifi**() jymaster→**master**()
 *                           standard/lossless/surround→原样
 *    len=10 →   atmos_plus→**dts**（ 造 "dt"+"s"；
 *                           注意这里 exe 给的是 dts 不是 surround —— 对齐）
 *    len=11 →   surround714→原样（前端另有 `quality.surround714` 标签）
 *
 *  各分支的目标处常量（movabs/mov 立即数）即规范名，逐个核对过：
 * movabs 0x647261646e617473 = "standard"
 * mov     0x68676968         = "high"
 * movabs 0x646e756f72727573 = "surround"
 * mov     0x69666968         = "hifi"
 * mov     0x7473616d + word[4]=0x7265 = "master"
 * movabs 0x7373656c73736f6c = "lossless"
 * mov     0x626c6f64 + byte[4]=0x79 = "dolby"
 * mov     0x7464 + byte[2]=0x73 = "dts"   （dt03 与 atmos_plus 共用）
 * 原样返回输入（passthrough：hires/high/hifi/master/standard/
 *               lossless/surround/dolby/dts/vinyl/surround714）
 *
 *  输出值域 = exe 自己的 9 档枚举（`standard high lossless hires hifi surround
 *  master dolby dts`，见 exe 0x1c93ff0 与前端 `uP()` 的索引表：standard:0 …
 *  dolby:7 dts:8）。我们的 7 档枚举没有 dolby/dts 两位，由 quality-tier.ts
 *  把二者归到 surround（t14 范围）。
 *
 *  ⚠️ 注意这与 `src/quality-tier.ts`（t14 范围）里的启发式**不一致**：
 *  那里把 `q000/q001` 当 hires，exe 实为 q000→hifi、q001→surround。已上报。
 */
const QUALITY_CODE_TABLE = {
  // 3 字节
  '128': 'standard', '320': 'high', 'sur': 'surround', 'sky': 'surround', 'dts': 'dts',
  // 4 字节
  '128k': 'standard', m500: 'standard', '320k': 'high', m800: 'high',
  flac: 'lossless', f000: 'lossless', q000: 'hifi', q001: 'surround',
  ai00: 'master', d004: 'dolby', dt03: 'dts', high: 'high', hifi: 'hifi',
  // 5 字节
  atmos: 'surround', hires: 'hires', dolby: 'dolby', vinyl: 'vinyl',
  // 6 字节
  exhigh: 'high', master: 'master',
  // 8 字节
  jyeffect: 'hifi', jymaster: 'master', standard: 'standard', lossless: 'lossless', surround: 'surround',
  // 10 / 11 字节
  atmos_plus: 'dts', surround714: 'surround714',
};

/** 7 档枚举 → QQ 的 `filename` 前缀码（只取 exe 里**存在**且是 QQ 文件名形态的码）。
 *  推导方式：找出所有 `normalize(code) === 该档` 的 4 字节码。
 *    standard←128k/m500  high←320k/m800  lossless←flac/f000
 *    hifi←q000  surround←q001  master←ai00   （dolby←d004 / dts←dt03 为附加档）
 *  hires 在 exe 里**没有**对应的 QQ 文件名码（只有字面 `hires` 原样返回，
 *  那是池子上报的值，不是可请求的 filename）→ 该档退化为「不带 filename」请求，
 *  由 QQ 自己挑，再用返回的 purl 反查真实档位。不发明 RS01/O600 之类 exe 里没有的码。 */
const QQ_QUALITY_CODE = {
  standard: 'M500', high: 'M800', lossless: 'F000',
  hifi: 'Q000', surround: 'Q001', master: 'AI00',
};
const QQ_CODE_EXTENSION = { M500: 'mp3', M800: 'mp3', F000: 'flac', Q000: 'flac', Q001: 'flac', AI00: 'flac', D004: 'm4a', DT03: 'm4a' };

/** 归一化一个平台音质码/文件名 → 规范档位名（exe 同款：只按长度分派查表，
 *  不做扩展名之类的猜测 —— exe 里没有这种推断）。 */
export function normalizeQualityCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return undefined;
  const direct = QUALITY_CODE_TABLE[raw];
  if (direct) return direct;
  // 文件名形态（M500xxx.mp3 / AI00xxx.flac）：取开头的字母数字码，最长前缀优先
  // （表里有 surround714 / atmos_plus 这种长码，必须从长到短试）。
  const head = /^[a-z0-9_]{3,11}/.exec(raw)?.[0];
  if (head) for (let n = head.length; n >= 3; n--) {
    const hit = QUALITY_CODE_TABLE[head.slice(0, n)];
    if (hit) return hit;
  }
  return undefined;
}

/** 从返回的 purl/filename 反查服务端**实际**给的档位（exe 同款解码）。
 *  对齐 exe 的 `actualQuality` 语义 —— 服务端自回落，客户端如实报告。 */
export function qqQualityOfFilename(value) {
  const text = String(value || '');
  const name = text.split('?')[0].split('/').pop() || '';
  return normalizeQualityCode(name) ?? normalizeQualityCode(text);
}

/** QQ 的音质能力：搜索响应自带各档位文件大小与试听窗口。
 *
 *  实测（_probe-qq-raw.mjs，匿名搜索「晴天」）原始字段：
 *    size128=4317292 size320=10792943 sizeape=0 sizeflac=55397039 sizeogg=5860576
 *    preview={trybegin:84346,tryend:142843,trysize:960887}
 *   exe 内的字段名 `size_128mp3 size_320mp3 size_flac size_hires size_dts`
 *  与之对应（下划线的 _new 版本在带登录态时出现）。
 *  另外 exe 还带 `availableQualities / highestQuality / qualitySizes / size_new`
 *  （0x1d2a060 附近的连续符号）—— 有就一起收，没有也不编。 */
function qqCapabilities(song) {
  const file = song?.file || {};
  const number = (...values) => { for (const value of values) { const n = Number(value) || 0; if (n > 0) return n; } return 0; };
  const sizes = {
    flac: number(song?.sizeflac, file.size_flac, file.sizeflac),
    hires: number(song?.sizehires, file.size_hires, file.sizehires),
    dts: number(song?.sizedts, file.size_dts, file.sizedts),
    ape: number(song?.sizeape, file.size_ape, file.sizeape),
  };
  const levels = [];
  // exe 自报的档位名列表优先（最权威）：availableQualities 是数组或逗号串。
  const declared = song?.availableQualities ?? song?.available_qualities;
  if (Array.isArray(declared)) for (const name of declared) { const v = clean(name).toLowerCase(); if (v && !levels.includes(v)) levels.push(v); }
  else if (typeof declared === 'string') for (const name of declared.split(/[,;|]/)) { const v = clean(name).toLowerCase(); if (v && !levels.includes(v)) levels.push(v); }
  const highest = clean(song?.highestQuality ?? song?.highest_quality).toLowerCase();
  if (highest && !levels.includes(highest)) levels.push(highest);
  if (sizes.hires) levels.push('hires');
  if (sizes.dts) levels.push('atmos');
  if (sizes.flac || sizes.ape) levels.push('lossless');
  if (number(song?.size320, file.size_320mp3, file.size320)) levels.push('320k');
  if (number(song?.size128, file.size_128mp3, file.size128)) levels.push('128k');
  const capabilities = { levels, sizes };
  const preview = song?.preview;
  if (preview && Number(preview.trybegin) >= 0 && Number(preview.tryend) > Number(preview.trybegin)) {
    capabilities.preview = { start: Number(preview.trybegin), end: Number(preview.tryend), size: Number(preview.trysize) || undefined };
  }
  // qualitySizes / size_new：登录态下出现的「各档位大小 + 最新档位」表。
  const qualitySizes = song?.qualitySizes ?? song?.quality_sizes;
  if (qualitySizes && typeof qualitySizes === 'object') {
    for (const [name, bytes] of Object.entries(qualitySizes)) {
      const key = clean(name).toLowerCase(), n = Number(bytes) || 0;
      if (n > 0 && key && !levels.includes(key)) levels.push(key);
    }
  }
  return capabilities;
}

export function platformTrack(provider, item) {
  if (provider !== 'qq') return undefined;
  const song = item?.songInfo || item?.songinfo || item;
  const id = song?.mid || song?.songmid, album = song?.album || {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{8,32}$/.test(id) || !clean(song.title || song.name || song.songname)) return undefined;
  const albumMid = album.mid || song.albummid;
  const mediaId = song.file?.media_mid || song.strMediaMid;
  const singers = song.singer || [];
  return { id: `qq-${id}`, albumId: `qq-album-${albumMid || album.id || id}`, title: clean(song.title || song.name || song.songname),
    artist: (Array.isArray(singers) ? singers : []).map(person => clean(person.name)).filter(Boolean).join(' / ') || '未知歌手',
    duration: Math.max(0, Number(song.interval) || 0), format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '', localDecodable: false,
    onlineSource: { provider, id, albumTitle: clean(album.title || album.name || song.albumname), albumId: String(albumMid || ''),
      // 音质能力：QQ 搜索原始响应直接带各档位文件大小（size128/size320/sizeape/
      // sizeflac/sizeogg）与 preview 试听窗口 ——  exe 里同名字段已确认。
      capabilities: qqCapabilities(song),
      ...(typeof mediaId === 'string' && /^[A-Za-z0-9]{8,32}$/.test(mediaId) ? { mediaId } : {}),
      coverUrl: typeof albumMid === 'string' && /^[A-Za-z0-9]{8,32}$/.test(albumMid) ? platformCover('qq', `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`) : undefined,
      pageUrl: `https://y.qq.com/n/ryqq/songDetail/${id}`, fee: song.pay?.pay_play ? 1 : 0 } };
}

export class PlatformCatalog {
  constructor({ provider, auth, transport = new PlatformLoginProtocols(provider), now = Date.now }) {
    if (!['qq', 'bodian'].includes(provider)) throw new Error('Unsupported catalog provider');
    this.provider = provider; this.auth = auth; this.transport = transport; transport.limit = 4; this.now = now;
    this.cache = new Map(); this.pending = new Map(); this.tracks = new Map(); this.owned = new Map(); this.waiting = []; this.active = 0;
    // 与登录纪元同生：首次 scope() 不得把 remember 预热的曲目当换号清掉。
    this.epoch = auth?.epoch;
  }
  /** 未登录时的匿名通道：QQ 走 search_for_qq_cp 搜索 + 匿名 vkey（2026-10 实机
   * 验证免登录可搜可取免费曲）；波点匿名 API 返回 402，无匿名通道，如实要求登录。 */
  get anonymous() { return !this.auth?.credential; }
  requireAccount() { if (this.provider !== 'qq') throw failure(`请先登录${names[this.provider]}。`, 401); }
  scope() {
    if (this.epoch !== this.auth.epoch) { this.epoch = this.auth.epoch; this.cache.clear(); this.tracks.clear(); this.owned.clear(); }
    if (!this.auth.credential) throw failure(`请先登录${names[this.provider]}。`, 401);
    return this.epoch;
  }
  check(epoch) { if (epoch !== this.auth.epoch || !this.auth.credential) throw failure('平台账号已切换，请重新读取。', 409); }
  async run(task, priority = false) {
    if (this.active >= 4) {
      if (this.waiting.length >= 16) throw failure('平台请求繁忙，请稍后重试。', 429);
      await new Promise((resolve, reject) => {
        const entry = { start: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); reject(failure('平台请求等待超时。', 429)); }, 12000);
        priority ? this.waiting.unshift(entry) : this.waiting.push(entry);
      });
    } else this.active++;
    try { return await task(); } finally { const next = this.waiting.shift(); next ? next.start() : this.active--; }
  }
  rpc(module, method, param, priority = false) {
    if (this.anonymous) { this.requireAccount(); return this.run(() => this.transport.qqRpc(module, method, param, null)); }
    const epoch = this.scope(), credential = this.auth.credential;
    return this.run(async () => { this.check(epoch); const value = await this.transport.qqRpc(module, method, param, credential); this.check(epoch); return value; }, priority);
  }
  qqHttp(path, params) {
    const epoch = this.scope(), credential = this.auth.credential;
    return this.run(async () => { this.check(epoch); const value = await this.transport.qqHttp(path, params, credential); this.check(epoch); return value; });
  }
  async memo(key, task) {
    await this.auth?.ready; const epoch = this.scope(), qualified = `${epoch}:${key}`;
    const cached = this.cache.get(qualified);
    if (cached && this.now() - cached.at < (cached.value.lyrics?.error || cached.value.metadataError ? 30000 : 300000)) return cached.value;
    if (this.pending.has(qualified)) return this.pending.get(qualified);
    if (this.pending.size >= 16) throw failure('平台请求繁忙，请稍后重试。', 429);
    const operation = (async () => { const value = await task(); this.check(epoch); this.cache.set(qualified, { at: this.now(), value }); while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value); return value; })().finally(() => this.pending.delete(qualified));
    this.pending.set(qualified, operation); return operation;
  }
  remember(items, preserve = false) {
    return items.map(item => {
      const track = platformTrack(this.provider, item);
      if (track) {
        const previous = this.tracks.get(track.onlineSource.id);
        if (this.provider === 'qq' && !track.onlineSource.mediaId && previous?.onlineSource.mediaId) track.onlineSource.mediaId = previous.onlineSource.mediaId;
        this.tracks.delete(track.onlineSource.id); this.tracks.set(track.onlineSource.id, track); while (this.tracks.size > 6000) this.tracks.delete(this.tracks.keys().next().value);
      }
      return track || null;
    }).filter(item => preserve || item);
  }
  search(query, offset = 0) {
    if (typeof query !== 'string' || !query.trim() || query.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000 || offset % 20) throw failure('搜索词或分页无效。', 400);
    if (this.anonymous) return this.anonymousSearch(query.trim(), offset);
    return this.memo(`search:${query}:${offset}`, async () => {
      const data = await this.rpc('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', { query: query.trim(), page_num: offset / 20 + 1, num_per_page: 20, search_type: 0 });
      const songs = data.body?.song?.list;
      const total = count(data.meta?.sum ?? data.body?.song?.sum);
      if (!Array.isArray(songs)) throw failure(`${names[this.provider]}搜索结果格式发生变化。`);
      const tracks = this.remember(songs.slice(0, 20));
      return { provider: this.provider, query: query.trim(), offset, limit: 20, total, hasMore: offset + 20 < total, tracks };
    });
  }
  /** QQ 匿名搜索：官方网页端经典口（免登录实测 20 首/页，与桌面 RPC 同构字段）。 */
  async anonymousSearch(query, offset) {
    this.requireAccount();
    const data = await this.run(() => this.transport.qqSearchAnonymous(query, offset / 20 + 1));
    const songs = data?.data?.song?.list;
    if (!Array.isArray(songs)) throw failure(`${names[this.provider]}搜索结果格式发生变化。`);
    const tracks = this.remember(songs.slice(0, 20));
    const total = count(data?.data?.song?.totalnum);
    return { provider: this.provider, query, offset, limit: 20, total, hasMore: offset + 20 < total, tracks };
  }
  playlists(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || offset % 100) throw failure('歌单分页无效。', 400);
    return this.memo(`playlists:${offset}`, async () => {
      return this.qqPlaylists(offset);
    });
  }
  async qqPlaylists(offset) {
    const uin = this.auth.credential.strMusicid || this.auth.credential.musicid;
    // Two independently paged sources, 50 each. Never fetch 100 each and then
    // truncate their combined result: that would silently skip collected lists.
    const begin = offset / 2;
    const results = await Promise.allSettled([
      this.qqHttp('/rsc/fcgi-bin/fcg_user_created_diss', { hostUin: '0', hostuin: uin, sin: String(begin), size: '50' }),
      this.qqHttp('/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', { ct: '20', cid: '205360956', userid: uin, reqtype: '3', sin: String(begin), ein: String(begin + 49) }),
    ]);
    // An unavailable source is an error, never an apparently empty account.
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const created = results[0].value, collected = results[1].value;
    if (!Array.isArray(created.disslist) || !Array.isArray(collected.cdlist)) throw failure('QQ 音乐歌单列表格式发生变化。');
    const playlists = [], seen = new Set();
    for (const [items, owned] of [[created.disslist, true], [collected.cdlist, false]]) {
      for (const item of items.slice(0, 50)) {
        if (!item || typeof item !== 'object') continue;
        const dirid = String(item.dirid ?? '0');
        const tid = dirid === '201' ? '0' : String(item.tid || item.dissid || item.diss_id || item.id || '0');
        if (!/^\d{1,16}$/.test(dirid) || !/^\d{1,16}$/.test(tid) || tid === '0' && dirid !== '201') continue;
        const identity = tid === '0' ? 'liked' : tid;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const id = `${dirid}-${tid}`;
        const value = { id, name: clean(item.diss_name || item.name || item.title) || '未命名歌单',
          trackCount: count(item.song_cnt ?? item.songnum ?? item.total_song_num ?? item.song_count),
          coverUrl: platformCover('qq', item.diss_cover || item.logo || item.picurl || item.cover_url || item.cover), owned };
        this.owned.set(id, { value, tid, dirid }); playlists.push(value);
      }
    }
    const more = (data, items) => {
      const reported = Number(data.total ?? data.totaldiss ?? data.totalnum ?? data.total_num);
      return Number.isFinite(reported) ? begin + 50 < reported : items.length >= 50;
    };
    return { provider: 'qq', playlists, offset, limit: 100, hasMore: more(created, created.disslist) || more(collected, collected.cdlist) };
  }
  playlistTracks(id, offset = 0) {
    if (!/^[\d-]{1,40}$/.test(id) || !Number.isInteger(offset) || offset < 0 || offset >= 100000 || offset % 50) throw failure('歌单歌曲分页无效。', 400);
    return this.memo(`tracks:${id}:${offset}`, async () => {
      const playlist = this.owned.get(id);
      if (!playlist) throw failure('这个歌单不在当前账号的歌单列表中。', 403);
      // CgiGetDiss identifies the current account through its authenticated
      // request. Liked songs use disstid 0 / dirid 201; encrypt_uin is not a
      // prerequisite. A separate profile lookup could block valid sessions.
      const data = await this.rpc('music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: Number(playlist.tid), dirid: Number(playlist.dirid), tag: true, song_begin: offset, song_num: 50, userinfo: true, orderlist: true, onlysonglist: false });
      const songs = data.songlist || data.songList;
      if (!Array.isArray(songs)) throw failure(`${names[this.provider]}歌单歌曲格式发生变化。`);
      const total = count(data.total_song_num ?? data.songnum ?? data.dirinfo?.songnum ?? playlist.value.trackCount);
      playlist.value.trackCount = total;
      return { provider: this.provider, playlistId: id, offset, limit: 50, total, hasMore: offset + 50 < total, tracks: this.remember(songs.slice(0, 50), true) };
    });
  }
  /** vkey 响应里挑同一首歌的 purl（绝不换歌、绝不信任任意媒体主机）。 */
  selectPurl(data, id) {
    if (!Array.isArray(data.midurlinfo)) throw failure('QQ 音乐播放地址响应格式发生变化。');
    const bases = (Array.isArray(data.sip) ? data.sip.slice(0, 8) : []).filter(base => typeof base === 'string' && platformMediaUrl('qq', base));
    if (!bases.length) bases.push('https://isure.stream.qqmusic.qq.com/');
    for (const song of data.midurlinfo.slice(0, 8)) {
      if (song?.songmid !== id || typeof song.purl !== 'string' || !song.purl || song.purl.length > 8192) continue;
      for (const base of bases) {
        try { const url = platformMediaUrl('qq', new URL(song.purl, base).href); if (url) return url; } catch {}
      }
    }
    return undefined;
  }
  /** QQ 匿名取曲：网页 vkey 信封（comm uin 0），免费曲直接给 purl（2026-10 实机）。 */
  async anonymousPrepare(value, options = {}) {
    this.requireAccount();
    const id = platformSongId('qq', value);
    const quality = String(options.quality ?? '').toLowerCase();
    const code = QQ_QUALITY_CODE[quality];
    // 按请求档位要对应文件（CC 只给标准档时 filename 不生效，服务端自回落）。
    const filenames = code
      ? [`${code}${id}.${QQ_CODE_EXTENSION[code] ?? 'mp3'}`]
      : undefined;
    const data = await this.rpc('vkey.GetVkeyServer', 'CgiGetVkey', { guid: String(randomInt(10000000, 100000000)), uin: '0', loginflag: 1, platform: '20', songmid: [id], songtype: [0], ...(filenames ? { filename: filenames } : {}) }, true);
    const purl = this.selectPurl(data, id);
    const audioUrl = platformMediaUrl('qq', purl);
    // 用户可见文案不得出现「会员/试听」字样（硬规则）。
    if (!audioUrl) throw failure('QQ 音乐暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    return { audioUrl, format: '在线音频', actualQuality: qqQualityOfFilename(purl) ?? (code ? quality : undefined) };
  }
  async prepare(value, options = {}) {
    const quality = String(options.quality ?? '').toLowerCase();
    if (this.anonymous) return this.anonymousPrepare(value, options);
    await this.auth.ready; const epoch = this.scope(), id = platformSongId(this.provider, value);
    const found = await this.qqAudioUrl(id, epoch, quality);
    const audioUrl = platformMediaUrl('qq', found?.url);
    if (!audioUrl) throw failure('QQ 音乐暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    // 服务端实际给的档位从返回的文件名还原（exe 同款解码）。平台 prepare 的
    // 返回**没有 onlineSource**，所以档位放**顶层**由播放器回填。
    return { audioUrl, format: '在线音频', actualQuality: qqQualityOfFilename(found?.url) ?? found?.quality };
  }
  async qqAudioUrl(id, epoch, quality) {
    const credential = this.auth.credential;
    const param = { guid: String(randomInt(10000000, 100000000)), uin: credential.strMusicid || credential.musicid, loginflag: 1, platform: '20' };
    const request = filenames => {
      this.check(epoch);
      return this.rpc('vkey.GetVkeyServer', 'CgiGetVkey', { ...param, songmid: Array(filenames?.length || 1).fill(id), songtype: Array(filenames?.length || 1).fill(0), ...(filenames ? { filename: filenames } : {}) }, true);
    };
    const select = data => this.selectPurl(data, id);
    // 档位必须**真正参与取流**（t10 第 1 项）：显式要求了某档就先按那一档要文件。
    // 以前这里排在最前面的是「不带 filename 的自动请求」，QQ 只要回得出东西就
    // 直接 return，于是请求的档位**永远被忽略** —— 下载选母带也照样给标准 MP3。
    //
    // 顺序（都不发明 URL，每步失败就继续）：
    //   ① 请求的档位码（文件名前缀 ← 真实 exe 的解码表，见 qqQualityOfFilename）
    //   ② 不带 filename 的自动请求：让 QQ 自己挑可用资源（官方 Web 播放器就是
    //      这么做的，也是老行为，保留为兜底）
    //   ③ 标准 MP3/AAC 兼容组合（的 `M500…mp3` / `C400…m4a`）
    // 服务端可能自回落（返回的 purl 文件名不等于请求的码），此时 actualQuality
    // 由返回文件名如实还原，客户端不做降级阶梯。
    let fileId = this.tracks.get(id)?.onlineSource.mediaId || '';
    const code = QQ_QUALITY_CODE[quality];
    const mediaId = async () => {
      if (fileId) return fileId;
      fileId = this.tracks.get(id)?.onlineSource.mediaId;
      if (!fileId) {
        const detail = await this.memo(`playback-detail:${id}`, () => { this.check(epoch); return this.rpc('music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: id }, true); });
        this.check(epoch);
        if ((detail.track_info?.mid || detail.track_info?.songmid) !== id) throw failure('QQ 音乐没有返回对应歌曲资料。', 404);
        fileId = this.remember([detail.track_info])[0]?.onlineSource.mediaId || '';
      }
      return fileId;
    };
    if (code) {
      // media_mid is a file identifier and can differ from songmid.
      const wanted = select(await request([`${code}${await mediaId() || id}.${QQ_CODE_EXTENSION[code] ?? 'mp3'}`]));
      if (wanted) return { url: wanted, quality };
    }
    // The official Web player omits filename, allowing QQ to choose an
    // available resource. Keep any playable response, including a preview;
    // an empty purl alone does not establish the user's membership status.
    const automatic = select(await request());
    if (automatic) return { url: automatic };
    // One bounded compatibility request for standard MP3/AAC. No invented media URL.
    return { url: select(await request([`M500${await mediaId() || id}.mp3`, `C400${await mediaId() || id}.m4a`])) };
  }
  songInfo(value) {
    const id = platformSongId(this.provider, value);
    return this.memo(`info:${id}`, async () => {
      let track = this.tracks.get(id), published, company, description, lyrics = { original: '', translated: '', instrumental: false, unavailable: false };
      const detail = await this.rpc('music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: id });
      track = this.remember([detail.track_info])[0];
      if (!track) throw failure('QQ 音乐没有返回对应歌曲资料。', 404);
      try {
        const raw = await this.rpc('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', { songMid: id });
        const decode = value => typeof value === 'string' ? (value.includes('[') ? value : Buffer.from(value.slice(0, 280000), 'base64').toString('utf8')).slice(0, 200000) : '';
        lyrics.original = decode(raw.lyric); lyrics.translated = decode(raw.trans);
      } catch (error) { lyrics.error = error.message; }
      const info = detail.info || {};
      const field = key => clean(info[key]?.content?.map(item => item.value).join(' / '));
      published = field('pub_time'); company = field('company'); description = field('desc');
      lyrics.unavailable = !lyrics.original && !lyrics.error;
      return { track, album: { title: track.onlineSource.albumTitle, artist: track.artist, published, company, description }, lyrics };
    });
  }
}
