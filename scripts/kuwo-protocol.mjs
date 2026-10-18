// Kuwo (酷我音乐) unofficial protocol adapter. Evidence first: endpoint list
// recovered from the service v3.6.1 binary strings (src\platform\kuwo.rs),
// response shapes probed live 2026-10-12 (probe-kuwo*.mjs in assets\reference):
//   search  http://search.kuwo.cn/r.s?client=kt&all=<kw>&ft=music&rn=&pn=0
//           &rformat=json&encoding=utf8  -> Python-repr style pseudo-JSON,
//           abslist[] with MUSICRID/NAME/ARTIST/ALBUM/DURATION/FORMATS/MINFO/
//           originalsongtype/payInfo/SUBTITLE/MKVRID
//   play    http://antiserver.kuwo.cn/anti.s?format=mp3&rid=<MUSICRID>
//           &response=url&type=convert_url3 -> {"code":200,"url":...} (live-verified)
//   info    http://musicpay.kuwo.cn/music.pay?src=kwplayer_ar_11.3.1.1_40.apk
//           &op=query&action=play&ids=<numeric> -> songs[] record (live-verified)
// Unverified parts stay out and are labeled in docs: playlist endpoints
// (nplserver.kuwo.cn/pl.svc), the newer convert_url_with_sign flow, lyrics
// (newlyric.kuwo.cn) and account login. Search and playback need no account.

const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** 酷我把 `&` 转义成**字面** `\u0026`（不是 JSON 转义，是四个反斜杠 + u0026）。
 *
 *  2026-10 实测 raw 字节（scripts/kuwo-protocol.mjs 的 r.s 响应，`&` 处 16/16 命中）：
 *      `'ARTIST':'磯村由紀子\\\\u0026高橋美香'`
 *      字符码：30959,26449,30001,32000,23376,**92,92,92,92**,117,48,48,50,54,39640,…
 *  也就是 4 个反斜杠（0x5c）后跟 `u0026`。`pyToJson` 的字符串状态机把 `\\`→`\`，
 *  于是到 clean 手上剩 2 个反斜杠 + `u0026`（实测 `"蒋婷\\u0026磯村由紀子"` 码=…,92,92,117,…,）。
 *
 *  不修的话搜索列表直接显示 `磯村由紀子\u0026高橋美香`，而且多歌手曲目的
 *  artist 会连成一片没有分隔符 —— 这正是 t10 要修的显示质量问题。
 *  `allartistid` 同样受影响（`94635\u002684171`），一起解。 */
const unescapeLiteral = value => String(value).replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const clean = value => (value === undefined || value === null ? '' : unescapeLiteral(value)).replace(/&nbsp;/g, ' ').trim();

/** r.s returns Python-repr style objects: single-quoted strings. Convert to
 * JSON safely (no eval): string delimiters and escapes are rewritten. */
export function pyToJson(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '\\') {
        const next = text[index + 1];
        if (next === "'") { out += "'"; index++; }
        else if (next === '"') { out += '\\"'; index++; }
        else { out += char + (next ?? ''); index++; }
      } else if (char === "'") { out += '"'; inString = false; }
      else if (char === '"') { out += '\\"'; }
      else out += char;
    } else if (char === "'") { out += '"'; inString = true; }
    else out += char;
  }
  return JSON.parse(out);
}

/** qualityLabel is evidence-based: FORMATS/MINFO declare the tiers a song
 * carries (ALFLAC/flac=lossless, MP3H/bitrate:320=high). */
function qualityFrom(formats, minfo) {
  const surface = `${formats ?? ''}|${minfo ?? ''}`;
  if (/(ALFLAC|format:flac)/i.test(surface)) return '无损';
  if (/(MP3H|bitrate:320)/i.test(surface)) return '高品';
  return '标准';
}

/** 酷我档位码 → 我们的档位词汇（供 quality-tier.ts 的 LEVEL_TO_TIER 翻译）。
 *
 *  证据（2026-10 实测 r.s + music.pay 响应，`&` 与字段名逐字核对）：
 *
 *  ① `MINFO` / `N_MINFO` 是**同构**的分号分隔条目表，每条是
 *     `level:<码>,bitrate:<kbps>,format:<格式>,size:<Mb>Mb`：
 *        MINFO   = "level:ff,bitrate:2000,format:flac,size:22.58Mb;
 *                   level:p,bitrate:320,format:mp3,size:10.91Mb;
 *                   level:h,bitrate:128,format:mp3,size:4.36Mb;
 *                   level:s,bitrate:48,format:aac,size:1.65Mb;
 *                   level:h,bitrate:100,format:ogg,size:2.9Mb"
 *        N_MINFO = 同上 **加上**高阶加密码：
 *                   `level:zply,bitrate:20900,format:mflac,size:172.94Mb`、
 *                   `level:zpga501,bitrate:20501,format:mflac`、
 *                   `level:zpga201,bitrate:20201,format:mflac`、
 *                   `level:zpga714,bitrate:24000,format:mgg`、
 *                   `level:bcms,bitrate:22000,format:mgg`、
 *                   `level:dtsx,bitrate:25000,format:mmp4`
 *  ② `pc_formats` / `phone_formats` 是 PC / 手机侧的可用格式标记串（竖线分隔），
 *     比 r.s 的 `FORMATS` 更全：`AAC48|ALFLAC|MP3128|MP3H|OGG96|OGG192|WMA128|
 *     WMA96|ZPLY|ZPGA201|ZPGA501|BCMS|ZPGA714|DTSX|ZP|MP4|...`。
 *  ③ `payInfo.paytagindex` 是酷我自报的档位**升序索引**（实测逐字）：
 *     `{L:0, H:1, S:2, F:3, HR:4, ZP:6, DB:7, AR501:8, ZPGA201:9, ZPGA501:10, ZPLY:11}`
 *     —— 这是"哪个更高"的权威依据（ZPLY 最高）。
 *  ④  exe 里同族的档位码字面量（`2000kflac 4000kflac 20201kmflac
 *     20501kmflac 20900kmflac`，@0x1d0c303）与前端 `V2.Kuwo` 的 7 档表
 *     （标准128k/HQ320k/无损2000k FLAC/Hi-Res 4000k FLAC/至臻音质/至臻全景声/
 *     至臻母带）互相印证。
 *
 *  ⚠️ 之前文档写的 `kbps_map`（128/320/flac/hires/master_tape/stereo_atmos）
 *  在本机实测**全部取不到**（r.s 与 music.pay、三首歌、三种 src 变体皆 `undefined`）
 *  → 酷我 capabilities 改从 MINFO/N_MINFO + pc_formats + paytagindex 解析。
 */
/** 酷我的音质能力（那排徽章的数据源）。
 *
 *  映射锚点 = 酷我自报的档位升序索引 `payInfo.paytagindex`（实测逐字）：
 *    `{L:0, H:1, S:2, F:3, HR:4, ZP:6, DB:7, AR501:8, ZPGA201:9, ZPGA501:10, ZPLY:11}`
 *  ⚠️ 该表在**两首不同的歌上完全相同**（免费曲也带全量键）→ 它只是酷我的
 *  「标签→高低顺序」**词表**，**不是**"本曲具备该档位"的证据。所以只用它确定
 *  顺序，绝不用它往 levels 里塞档位（否则每首歌都会被谎报母带）。
 *  可用性证据只取 MINFO/N_MINFO 的实际条目 + pc_formats/phone_formats 标记。
 *  配合前端 `V2.Kuwo` 的 7 档名（标准/HQ 超高/无损/Hi-Res/至臻音质/至臻全景声/
 *  至臻母带）与 exe 的档位码字面量（2000kflac/4000kflac/20201kmflac/
 *  20501kmflac/20900kmflac）确定顺序，再落到我们的档位名：
 *    ff(2000k flac)→flac   p(320 mp3)→320k   h(128 mp3)→128k
 *    zpga201→hires(9)  zpga501→hifi(10)   zply→master(11，最高)
 *    zpga714→surround(7.1.4 全景声)   dtsx→dts   bcms→master(蝰蛇母带)
 *  ⚠️ `zp`（bitrate:20000, format:zp, size:**"zpMb"**）是**占位符**不是真实档位，
 *  必须丢弃 —— 它出现在免费曲上，采信就会把普通曲谎报成 hires。
 */
const KUWO_LEVEL_TIER = {
  ff: 'flac', p: '320k', h: '128k', s: '128k',
  zpga201: 'hires', zpga501: 'hifi', zply: 'master',
  zpga714: 'surround', dtsx: 'dts', bcms: 'master', ar501: 'dolby', db: 'dolby',
};
/** pc_formats / phone_formats / r.s FORMATS 的标记 → 档位名（仅确有对应档位者）。 */
const KUWO_FORMAT_TIER = {
  ALFLAC: 'flac', MP3H: '320k', MP3128: '128k', AAC48: '128k',
  OGG96: '128k', OGG192: '320k', OGGH: '320k', WMA128: '128k', WMA96: '128k',
  ZPLY: 'master', BCMS: 'master', ZPGA501: 'hifi', ZPGA201: 'hires',
  ZPGA714: 'surround', DTSX: 'dts',
};
/** MINFO/N_MINFO 是**同构**的分号条目表：`level:<码>,bitrate:<kbps>,format:<格式>,size:<Mb>Mb`。
 *  占位条目（size 非数字，如 `zpMb`）一律丢弃。 */
function parseKuwoEntries(value) {
  const entries = [];
  for (const chunk of String(value ?? '').split(';')) {
    const fields = {};
    for (const part of chunk.split(',')) {
      const at = part.indexOf(':');
      if (at > 0) fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
    }
    const level = fields.level;
    if (!level || level === 'zp') continue;   // 占位符档位
    const mb = Number.parseFloat(fields.size);
    entries.push({
      level,
      bitrate: Number(fields.bitrate) || 0,
      format: (fields.format || '').toLowerCase(),
      bytes: Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0,
    });
  }
  return entries;
}

function kuwoCapabilities(item) {
  const levels = [];
  const push = name => { if (name && !levels.includes(name)) levels.push(name); };
  const entries = [...parseKuwoEntries(item?.MINFO), ...parseKuwoEntries(item?.N_MINFO)];
  // ① MINFO/N_MINFO 条目：档位以 level 码为准（mflac/mgg/mmp4 是同族容器，
  //    真正的档位差异在 level 码上，不能按格式名判断）。
  for (const entry of entries) push(KUWO_LEVEL_TIER[entry.level]);
  // ② pc_formats/phone_formats（比 r.s 的 FORMATS 更全）按格式标记补。
  for (const tag of `${item?.pc_formats ?? ''}|${item?.phone_formats ?? ''}|${item?.FORMATS ?? ''}`.split('|')) {
    const key = tag.trim().toUpperCase();
    if (key && key !== 'ZP') push(KUWO_FORMAT_TIER[key]);
  }
  // ③ 真实字节数：每一档都给出来，下载弹窗才能显示「无损 41MB / 高品 7.9MB」
  //    让用户按体积自己权衡。
  //
  //    旧实现只填 `sizes.flac`，于是下载弹窗里除无损外的档位都没有体积，
  //    用户看不出 320k 和 128k 差多少 —— 等于把选择的依据抽掉了。
  //    MINFO 每个条目都带 size（`level:ff,bitrate:2000,format:flac,size:41.02Mb`），
  //    解析出来即可。
  const capabilities = { levels };
  const sizes = {};
  for (const entry of entries) {
    const tier = KUWO_LEVEL_TIER[entry.level];
    if (!tier || entry.bytes <= 0) continue;
    // 同档位取最大的那份（有些条目是同档不同容器，取大的更接近真实全曲）
    if (!sizes[tier] || sizes[tier] < entry.bytes) sizes[tier] = entry.bytes;
  }
  if (Object.keys(sizes).length) capabilities.sizes = sizes;
  const topKbps = entries.reduce((top, entry) => Math.max(top, entry.bytes > 0 ? entry.bitrate : 0), 0);
  if (topKbps > 0) capabilities.maxBitrate = topKbps * 1000;
  return capabilities;
}

const feeFrom = payInfo => {
  const feeType = payInfo?.feeType ?? {};
  return String(feeType.vip ?? '0') === '1' || String(feeType.song ?? '0') === '1' ? 1 : 0;
};

/** 酷我封面：搜索响应没有绝对 URL，只有 web_albumpic_short（形如
 * `120/7/83/4087363627.jpg`，开头 120 是尺寸档），拼 img1.kuwo.cn 前缀即可。
 * 该路径也是酷我网页版自己用的拼法（web_ 前缀字段即「网页用缩略图」）。
 * 2026-10-15 实测：120/200/240/300/500/800 全部 200 image/jpeg，
 * 真实搜索 20/20 命中；MVPIC 是 MV 封面（19/20），只在没有专辑封面时兜底。
 * 旧实现写死 coverUrl: undefined，所以酷我搜索结果、3D 墙、详情页全都没图。 */
function kuwoCover(item) {
  const short = clean(item?.web_albumpic_short) || clean(item?.web_albumpic);
  if (short) {
    // 换到 500 档（列表缩略图够用，也不至于拉原图浪费带宽）。
    const sized = short.replace(/^\d+(?=\/)/, '500');
    return /^https?:\/\//i.test(sized) ? sized.replace(/^http:\/\//i, 'https://') : `https://img1.kuwo.cn/star/albumcover/${sized}`;
  }
  const mv = clean(item?.hts_MVPIC) || (clean(item?.MVPIC) ? `https://img1.kuwo.cn/wmvpic/${clean(item.MVPIC)}` : '');
  return mv ? mv.replace(/^http:\/\//i, 'https://') : undefined;
}

export function kuwoTrack(item) {
  const rid = clean(item.MUSICRID);
  if (!rid) return null;
  // 【2026-10-18 修「串歌」的真正根因】
  //
  // 酷我搜索返回里 **NAME 是残缺的，SONGNAME 才带版本号**：
  //
  //     NAME     = "可能"                  ← 我们原来优先用这个
  //     SONGNAME = "可能&nbsp;(DJ翊轩版)"   ← 真正该用的
  //
  // 于是「可能」的几个版本（原唱 217s / DJ翊轩 213s / DJ阿卓 167s / Live 68s）
  // 在我们的列表里**全叫「可能」**，标题层面无法区分 —— 换源时自然串。
  //
  // 之前我以为「酷我数据本身没有版本信息」，只能靠时长兜底；实际是
  // **我们把版本信息丢了**。SONGNAME 一直在响应里躺着。
  //
  // SONGNAME 里带 `&nbsp;` 实体，clean() 不解码，必须手动处理，
  // 否则标题是 "可能&nbsp;(DJ翊轩版)"，titleParts 的版本词识别同样失效。
  const title = decodeEntities(clean(item.SONGNAME) || clean(item.NAME) || '未知歌曲');
  return {
    id: `kuwo-${rid}`, albumId: `kuwo-album-${clean(item.ALBUMID)}`, title,
    artist: clean(item.ARTIST) || '未知歌手',
    duration: Math.max(0, Number(item.DURATION) || 0), format: '在线音频',
    browserPlayable: true, localDecodable: false, audioUrl: '', relativePath: '',
    onlineSource: {
      provider: 'kuwo', id: rid, albumTitle: clean(item.ALBUM) || '',
      coverUrl: kuwoCover(item), pageUrl: 'https://www.kuwo.cn/', fee: feeFrom(item.payInfo),
      albumId: clean(item.ALBUMID),
      aliases: clean(item.SUBTITLE) ? [decodeEntities(clean(item.SUBTITLE))] : [],
      original: clean(item.originalsongtype) === '1',
      qualityLabel: qualityFrom(item.FORMATS, item.MINFO),
      // 音质能力（那排 母带/HiFi/5.1/SQ/HQ 徽章的数据源）：从 MINFO/N_MINFO/
      // FORMATS 解析真实档位（kbps_map 在本机实测取不到，见 kuwoCapabilities）。
      capabilities: kuwoCapabilities(item),
    },
  };
}

/** 酷我标题带 HTML 实体（`&nbsp;` `&amp;` …），解码成正常字符。
 *  不处理的话 `可能&nbsp;(DJ翊轩版)` 里的括号前面粘着实体，
 *  titleParts 的版本词提取会拿到 `nbsp` 而不是 `dj`，串歌照旧。 */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export class KuwoCatalog {
  constructor({ fetch: doFetch = globalThis.fetch, searchBase = 'http://search.kuwo.cn', playBase = 'http://antiserver.kuwo.cn', payBase = 'http://musicpay.kuwo.cn' } = {}) {
    this.doFetch = doFetch; this.searchBase = searchBase; this.playBase = playBase; this.payBase = payBase;
    this.headers = { 'User-Agent': 'okhttp/3.12.0', Referer: 'http://www.kuwo.cn/' };
  }
  async search(query, offset = 0) {
    const keyword = clean(query);
    if (!keyword || keyword.length > 100) throw failure('请输入 1 至 100 个字符的搜索词。', 400);
    const page = Math.floor(Math.max(0, offset) / 20);
    const params = new URLSearchParams({ client: 'kt', all: keyword, ft: 'music', rn: '20', pn: String(page), rformat: 'json', encoding: 'utf8', vipver: 'MUSIC_8.0.3.0_BCS3' });
    const response = await this.doFetch(`${this.searchBase}/r.s?${params}`, { headers: this.headers });
    const body = await response.text();
    if (!response.ok) throw failure('酷我暂时无法连接，请稍后重试。', 502);
    let parsed;
    try { parsed = pyToJson(body); } catch { throw failure('酷我搜索响应格式发生变化，请稍后重试。'); }
    const tracks = (Array.isArray(parsed.abslist) ? parsed.abslist : []).flatMap(item => { const track = kuwoTrack(item); return track ? [track] : []; });
    const total = Math.max(0, Number(parsed.TOTAL) || tracks.length);
    return { provider: 'kuwo', query: keyword, offset, limit: 20, total, hasMore: (page + 1) * 20 < total, tracks };
  }
  /** 对齐 src\quality_info.rs 的酷我权限判定（试听根治）。
   * 
   *   GET http://musicpay.kuwo.cn/music.pay?src=kwplayer_ar_11.3.1.1_40.apk&op=query&action=play&ids=<rid>
   *   响应字段: songs[].payInfo / N_MINFO / songmid / kbps_map{128,320,flac,hires,master_tape,stereo_atmos} / item_list
   * 先查权限，只有受限才按试听处理 —— 这是「只能听十几秒」的根因：
   * 不查权限就把试听片段当全曲播。 */
  async payInfo(rid) {
    const params = new URLSearchParams({
      src: 'kwplayer_ar_11.3.1.1_40.apk', op: 'query', action: 'play',
      ids: String(rid).replace('MUSIC_', ''),
    });
    const response = await this.doFetch(`${this.payBase}/music.pay?${params}`, { headers: this.headers });
    const body = await response.json().catch(() => null);
    const song = body?.songs?.[0];
    if (!song) return null;
    const feeType = song.payInfo?.feeType ?? {};
    const limited = String(feeType.vip ?? '0') === '1' || String(feeType.song ?? '0') === '1';
    // kbps_map 是音质阶梯（128/320/flac/hires/master_tape/stereo_atmos）；
    // 有值但受限 = 只能试听。N_MINFO 是酷我的权限标记。
    const kbpsMap = song.kbps_map ?? song.kbpsMap ?? {};
    return { limited, kbpsMap, nMinfo: song.N_MINFO, duration: Number(song.duration) || 0, raw: song };
  }
  async prepare(value) {
    const rid = songId(value);
    if (!rid) throw failure('无效的酷我歌曲标识。', 400);
    // 对齐决策顺序：① 先查权限（判定试听/付费）→ ② 再取播放地址。
    const pay = await this.payInfo(rid).catch(() => null);
    const params = new URLSearchParams({ format: 'mp3', rid, response: 'url', type: 'convert_url3' });
    const response = await this.doFetch(`${this.playBase}/anti.s?${params}`, { headers: this.headers });
    const body = await response.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw failure('酷我没有返回可播放的音源。', 502); }
    if (!response.ok || parsed.code !== 200 || typeof parsed.url !== 'string' || !parsed.url) {
      // 用户可见文案不得出现「付费/地区」字样（硬规则）。
      throw failure('酷我暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    }
    // 对齐：受限曲目如实标为试听（时长取平台给的 duration），
    // 这样 applyLxFallback 会去备用音源拿全曲，而不是无声截断。
    const limited = pay?.limited === true || Number(parsed.free_part ?? 0) === 1;
    const totalSeconds = (pay?.duration ?? 0) / 1000;
    return {
      audioUrl: parsed.url, format: 'MP3',
      trial: limited ? { start: 0, end: Math.max(0, totalSeconds) } : undefined,
    };
  }
  async songInfo(value) {
    const rid = songId(value);
    if (!rid) throw failure('无效的酷我歌曲标识。', 400);
    const params = new URLSearchParams({ src: 'kwplayer_ar_11.3.1.1_40.apk', op: 'query', action: 'play', ids: rid.replace('MUSIC_', '') });
    const response = await this.doFetch(`${this.payBase}/music.pay?${params}`, { headers: this.headers });
    const body = await response.json().catch(() => null);
    const song = body?.songs?.[0];
    if (!response.ok || !song) throw failure('酷我查不到这首歌曲的信息。', 404);
    return {
      track: {
        id: `kuwo-${rid}`, albumId: `kuwo-album-${clean(song.albumid)}`, title: clean(song.name) || '未知歌曲',
        artist: clean(song.artist) || '未知歌手', duration: Math.max(0, Number(song.duration) || 0),
        format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
        onlineSource: { provider: 'kuwo', id: rid, albumTitle: clean(song.album) || '', pageUrl: 'https://www.kuwo.cn/', fee: feeFrom(song.payInfo), albumId: clean(song.albumid), qualityLabel: qualityFrom(song.formats, song.MINFO), capabilities: kuwoCapabilities(song) },
      },
      album: { title: clean(song.album) || '未知专辑', artist: clean(song.artist) || '未知歌手' },
      lyrics: { original: '', translated: '', instrumental: false, unavailable: true },
    };
  }
  async playlists() {
    throw failure('酷我歌单尚未接入（平台侧对应端点尚未验证）。', 501);
  }
  async playlistTracks() {
    throw failure('酷我歌单尚未接入（平台侧对应端点尚未验证）。', 501);
  }
}

const songId = value => {
  const text = String(value ?? '').replace(/^kuwo-/, '');
  return /^MUSIC_[0-9]{1,20}$/.test(text) ? text : '';
};
