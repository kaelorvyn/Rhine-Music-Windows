// Kugou unofficial protocol adapter (非官方协议适配，用户已知悉平台协议风险).
// Endpoint contracts come from reverse-engineering the service desktop client
// (assets/reference binary scans) and public Kugou client implementations
// (CharlesPikachu/musicdl kugouutils.py + build_cookies_for_kugou.py, app966.cn
// signing writeup). Two signing families, both built from sorted "key=value"
// pairs concatenated WITHOUT separators, then salt-wrapped md5:
//  - login-user.kugou.com (QR login): web salt NVPh… — live-verified 2026-10:
//    /v2/qrcode returns data.qrcode for the params below (type=1 and
//    qrcode_txt are required), /v2/get_userinfo_qrcode answers data.status
//    (1 waiting, 4 scanned+confirmed with token/userid).
//  - gateway.kugou.com (account playlists): android salt OIl… with the raw
//    JSON request body between params and the closing salt — cross-checked
//    against the open-source KuGouMusicApi service (MakcRe/KuGouMusicApi:
//    module/user_playlist.js + module/playlist_track_all_new.js +
//    util/helper.js signatureAndroidParams), 2026-10. Those modules sign the
//    merged device query plus JSON body with appid 1005 / clientver 20489 and
//    route via x-router cloudlist.service.kugou.com; live end-to-end (scan,
//    then pull playlists) is 待用户真机确认.
//  - tracker.kugou.com (playback): android signing over query + JSON body,
//    tracker_param.key = md5(hash + 185672dd… + appid + mid + userid) — aligned
//    with KuGouMusicApi module/song_url_new.js + util/request.js, live-verified
//    2026-10 after the legacy wwwapi play/getdata route began refusing every
//    request with err_code 30020 (SSA anti-abuse).
// Unauthenticated search needs no signature; msearchcdn/mobilecdn lost their
// HTTPS certificates in 2026-10, so search runs over plain HTTP.
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '';
const CLIENT = { appid: 1001, clientver: 11440, mid: '1', uuid: '1', dfid: '0' };
// QR (login-user) device params: binary-evidenced (platform_auth.rs string
// table) and confirmed live — placeholders are accepted for dfid/mid/uuid.
const QR_CLIENT = { dfid: '-', mid: '-', uuid: '-', appid: '1001', clientver: '11440', type: '1', plat: '4', srcappid: '2919' };
const ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
// lite（概念版）客户端签名盐 + 设备参数——对齐 playlist_import.rs。
const LITE_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const LITE_CLIENT = { appid: '3116', clientver: '11440' };
// 概念版 lite 的 appid：二维码必须**按这个概念版身份签发**，才能拿去调概念版歌单接口。
// 【2026-10-15 根因修复】旧实现把二维码的 qrcode_txt/轮询 appid 写死成 1001（标准版），
// 于是「票按 1001 签发、却当 3116 用」→ 服务端一律回 error_code 20017（取不到歌单）。
// 实测对照（刚扫出的同一张票）：
//   lite 3116/11440 + lite 盐  → ✅ code=0，12 个歌单（「默认收藏」…）
//   标准 1005/20489 + 安卓盐   → ❌ 20017
//   1001/11440 + 安卓盐        → ❌ 20006
// 与参考实现 KuGouMusicApi 一致：/v2/qrcode 的 qrcode_txt 用「平台 appid」，
// /v2/get_userinfo_qrcode 也用平台 appid，并带上 dev 设备标识。
const LITE_APPID = LITE_CLIENT.appid;
/** 两种酷狗登录身份。都算「酷狗」，区别只在 appid/签名盐 —— 而票必须
 * 「按哪个身份签发、就用哪个身份使用」，否则服务端判定票无效。
 * 2026-10-15 实测（同一张票）：概念版身份 ✅ 取回 12 个歌单；标准版 ❌ 20017。 */
const KUGOU_IDENTITIES = {
  kugou: { label: '酷狗音乐', appid: '1005', clientver: '20489', salt: ANDROID_SALT },
  'kugou-lite': { label: '酷狗概念版', appid: LITE_APPID, clientver: '11440', salt: LITE_SALT },
};
/** 凭据 → 该用哪套身份签名（老凭据没有 identity 字段，按概念版兼容）。 */
const identityOf = credential => KUGOU_IDENTITIES[credential?.identity] ?? KUGOU_IDENTITIES['kugou-lite'];
/** 设备身份：参考实现 server.js —— GUID → calculateMid(guid) 作 mid，
 *  DEV 为 10 位随机大写十六进制，uuid/dfid 占位 '-'。 */
function kugouDevice() {
  const guid = randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  return {
    guid,
    mid: BigInt(`0x${createHash('md5').update(guid).digest('hex')}`).toString(),
    dev: randomBytes(8).toString('hex').slice(0, 10).toUpperCase(),
  };
}
// tracker.kugou.com priv_url 的 tracker_param.key 盐（KuGouMusicApi song_url_new.js）。
const TRACKER_KEY_SALT = '185672dd44712f60bb1736df5a377e82';
const sortedPairs = params => Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('');

/** gateway.kugou.com family (android signing; raw body sits before the tail salt). */
export function kugouSignature(params, data = '') {
  return createHash('md5').update(ANDROID_SALT + sortedPairs(params) + data + ANDROID_SALT).digest('hex');
}
/** login-user.kugou.com family (web signing) — live-verified for the QR flow. */
export function kugouWebSignature(params) {
  return createHash('md5').update(WEB_SALT + sortedPairs(params) + WEB_SALT).digest('hex');
}
/** lite 客户端签名（对齐 playlist_import.rs）。
 * 的个人歌单曲目接口 gateway.kugou.com/v4/get_list_all_file 走这套：
 * appid 3116 / clientver 11440 + lite 盐 LnT6xp…，不是 gateway 族标准盐。 */
export function kugouLiteSignature(params, data = '') {
  return createHash('md5').update(LITE_SALT + sortedPairs(params) + data + LITE_SALT).digest('hex');
}
export function kugouLiteParams(extra = {}, body = null) {
  const params = { ...LITE_CLIENT, dfid: '-', mid: '-', uuid: '-', clienttime: String(Math.floor(Date.now() / 1000)), ...extra };
  return { ...params, signature: kugouLiteSignature(params, body == null ? '' : JSON.stringify(body)) };
}
/** 标准版身份（1005/20489 + 安卓盐）签名参数 —— 供「酷狗音乐」入口登录的票使用。 */
export function kugouSignatureParams(identity, extra = {}, body = null) {
  const params = { appid: identity.appid, clientver: identity.clientver, dfid: '-', mid: '-', uuid: '-',
    clienttime: String(Math.floor(Date.now() / 1000)), ...extra };
  const data = body == null ? '' : JSON.stringify(body);
  return { ...params, signature: createHash('md5').update(identity.salt + sortedPairs(params) + data + identity.salt).digest('hex') };
}
export function kugouSignedParams(extra = {}) {
  const params = { ...CLIENT, clienttime: String(Math.floor(Date.now() / 1000)), ...extra };
  return { ...params, signature: kugouSignature(params) };
}
export function kugouQrParams(extra = {}) {
  const params = { ...QR_CLIENT, clienttime: String(Math.floor(Date.now() / 1000)), ...extra };
  return { ...params, signature: kugouWebSignature(params) };
}
// gateway 族设备参数（KuGouMusicApi util/config.json：appid 1005、clientver 20489）。
const GATEWAY_CLIENT = { dfid: '0', mid: '0', uuid: '0', appid: '1005', clientver: '20489' };
/** gateway 族签名：query 参数 + JSON body 拼进 md5(SALT + pairs + body + SALT)。 */
export function kugouGatewayParams(extra = {}, body = null) {
  const params = { ...GATEWAY_CLIENT, clienttime: String(Math.floor(Date.now() / 1000)), ...extra };
  return { ...params, signature: kugouSignature(params, body == null ? '' : JSON.stringify(body)) };
}

/** One search/playlist entry becomes a MusicTrack; id is `hash.album_id`. */
export function kugouTrack(info) {
  // 对齐 playlist_items：song_id 就是 32 位十六进制文件 hash，
  // 不依赖 album_id（连 album_id 都不存）。
  // 旧实现强制要求数字 album_id，云歌单里的歌会被整批过滤掉。
  const hash = String(info?.hash ?? info?.song_id ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{16,40}$/.test(hash)) return undefined;
  const albumId = String(info?.album_id ?? info?.albumid ?? '').replace(/\D/g, '').slice(0, 24);
  const title = clean(info.songname || info.filename || info.audio_name || info.name);
  const artist = clean(info.singername || info.author_name || info.artist);
  if (!title) return undefined;
  const sq = info.sqhash && info.sqprivilege === 0;
  const high = info['320hash'] && info['320privilege'] === 0;
  // 酷狗搜索接口的响应**没有独立封面字段**，封面藏在 trans_param.union_cover 里，
  // 形如 http://imge.kugou.com/stdmusic/{size}/20230920/….jpg —— {size} 是尺寸占位符，
  // 换成 480 即为可直接访问的封面 URL（2026-10-15 实测 10/10 命中，200/image/jpeg）。
  // 旧实现写死 coverUrl: undefined，导致酷狗搜索结果、3D 墙、详情页全都无图。
  const cover = clean(
    info?.trans_param?.union_cover || info?.trans_param?.union_cover_s ||
    info?.album_image || info?.imgurl || info?.cover,
  ).replace('{size}', '480').replace(/^http:\/\//i, 'https://');
  // 【2026-10-15 用户报】搜索到的酷狗歌曲显示 3733:20 这种荒谬时长。
  // 根因：酷狗接口的 info.duration **本来就是秒**（"落了白" = 224 秒 = 3:44），
  // 旧实现误以为它是毫秒、又乘以 1000 变成 224000，而前端 time()/seconds()
  // 一律按秒解释 → 224000 秒 = 3733:20。对照：酷我 DURATION、JOOX playtime
  // 都没做换算，只有酷狗出这个怪值，所以这里必须**原样按秒**保留。
  // 注意区分：`timelen` 才是毫秒（见 playlistTracks），两者语义不同。
  const duration = Math.max(0, Math.round(Number(info.duration) || 0));
  return {
    id: `kugou-${hash}${albumId ? `.${albumId}` : ''}`, albumId: albumId ? `kugou-album-${albumId}` : 'kugou-album-unknown', title,
    artist: artist || '未知歌手',
    duration, format: String(info.extname || 'mp3').toUpperCase() || '在线音频',
    browserPlayable: true, localDecodable: false, audioUrl: '', relativePath: '',
    onlineSource: {
      provider: 'kugou', id: `${hash}${albumId ? `.${albumId}` : ''}`, albumTitle: clean(info.album_name || info.album) || '',
      coverUrl: cover || undefined, pageUrl: `https://www.kugou.com/song/#hash=${hash}`,
      fee: info.pay_type > 0 || info.pay_type_320 > 0 || info.pay_type_sq > 0 ? 1 : 0,
      albumId,
      aliases: clean(info.othername) ? [clean(info.othername)] : [],
      original: Number(info.isoriginal) === 1,
      qualityLabel: sq ? '无损' : high ? '高品' : '标准',
      // 【2026-10-18 补：酷狗的音质档位一直在响应里，只是没解析】
      //
      // 用户报「下载下来根本不是 FLAC」。核实：酷狗搜索响应同一个条目里
      // 同时带着好几档的音源，字段名各不相同：
      //
      //     FileHash/FileSize/Bitrate/ExtName   38B234… / 3489311  / 128  / mp3   ← 128k
      //     ResFileHash/ResFileSize/ResBitrate  4D1572… / 43016351 / 1578 / flac  ← 无损
      //     SQFileHash/SQFileSize/SQBitrate     …        / …        / 781          ← SQ
      //     SuperFileHash/SuperFileSize          ""       / 0                       ← 母带（无）
      //
      // 我们以前只读 FileHash 那一组（128k mp3），于是「点击下载无损」实际
      // 拿到的是 0.92MB 的 mp3，界面却标着「无损」。
      // capabilities 让下载弹窗能列出**这首歌真正有哪些档**，用户当场选。
      capabilities: kugouCapabilities(info),
    },
  };
}

/** 把酷狗搜索条目里的各档音源整理成 { levels, sizes }，供下载时选择。
 *
 *  排查顺序照音质从高到低：母带 → 无损 → SQ → 320k → 128k。
 *  hash 为空或 size 为 0 就跳过 —— 那表示平台没有这档，
 *  不要给用户一个点了会失败的选项。
 *
 *  ⚠️ **不看 privilege**。第一版要求 `privilege === 0` 才算可用，结果
 *  几乎所有条目都判成「无音质」—— 实测 msearchcdn 返回的
 *  `privilege` 普遍是 **10**（需要登录/VIP 的标记），而那些歌经共享池
 *  照样能取到完整音频（连续 5 次实测 5/5 成功）。
 *
 *  正确做法是**只看这一档的音源在不在**（hash 非空、size > 0），
 *  能不能取到交给取源那一步去判断。判断错了只会让用户少看到一个
 *  本来能用的选项，比列出一个点了报错的档位更糟。
 */
function kugouCapabilities(info) {
  const levels = [];
  const sizes = {};
  const add = (level, hash, size) => {
    const bytes = Number(size) || 0;
    if (!clean(hash) || bytes <= 0) return;
    if (levels.includes(level)) return;
    levels.push(level);
    sizes[level] = bytes;
  };
  // 母带 / Hi-Res
  add('master', info.SuperFileHash ?? info.super_hash, info.SuperFileSize ?? info.super_filesize);
  // 无损（FLAC）—— msearchcdn 用 ResFileHash，songsearch_v2 用同名大写字段
  add('lossless', info.ResFileHash ?? info.res_hash ?? info.sqhash, info.ResFileSize ?? info.res_filesize ?? info.sqfilesize);
  // SQ（部分接口单独给一档，通常比无损略低）
  add('hires', info.SQFileHash ?? info.sq_hash, info.SQFileSize ?? info.sq_filesize);
  // 320k
  add('high', info['320hash'] ?? info.hash_320, info['320filesize'] ?? info.filesize_320);
  // 128k（兜底档，几乎总有）
  add('standard', info.FileHash ?? info.hash, info.FileSize ?? info.filesize);
  return levels.length ? { levels, sizes } : undefined;
}

const readJson = text => { try { return JSON.parse(text); } catch { throw failure('酷狗响应格式发生变化。'); } };
/** 宽松解析：t.kugou.com/command/ 返回非标准 JSON 时退化为 null 而不是抛错。 */
const safeJson = text => { try { return JSON.parse(text); } catch { return null; } };
const stripJsonp = text => {
  const trimmed = text.trim();
  const start = trimmed.indexOf('('), end = trimmed.lastIndexOf(')');
  return readJson(start > 0 && end > start ? trimmed.slice(start + 1, end) : trimmed);
};
const songId = value => {
  // 酷狗 hash 是 **32 位大写十六进制**（如 B3A52A7A958BF0AED0EBFBA2E9A818B7）。
  // 过去这里只认小写 [0-9a-f] 且强制要求 `.<albumId>` 后缀，导致真实搜索/歌单里的
  // 歌曲在 prepare/songInfo 阶段一律被判「无效的酷狗歌曲标识」而播不了 ——
  // 这是「有些歌放不了」的一个真根因。
  // 兼容三种写法：纯 hash、`hash.albumId`、以及 albumId 为空时的 `hash.`（搜索结果里
  // AlbumID 可能是空串，拼出来就是尾点）。
  const text = String(value ?? '').trim().replace(/\.$/, '');
  const match = /^([0-9a-fA-F]{16,40})(?:\.(\d{1,24}))?$/.exec(text);
  return match ? { hash: match[1], albumId: match[2] ?? '' } : null;
};

export class KugouCatalog {
  constructor({ auth, fetch: doFetch = globalThis.fetch, now = Date.now } = {}) {
    this.auth = auth; this.doFetch = doFetch; this.now = now;
  }
  async get(url, { signal, jsonp = false, params } = {}) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) target.searchParams.set(key, value);
    const response = await this.doFetch(target.href, { signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.kugou.com/' } });
    const text = await response.text();
    if (!response.ok) throw failure(response.status === 429 ? '酷狗请求过于频繁，请稍后重试。' : '酷狗暂时无法连接，请稍后重试。', response.status >= 400 && response.status < 500 ? response.status : 502);
    return jsonp ? stripJsonp(text) : readJson(text);
  }
  /** gateway 族 POST（JSON body 入签名，x-router 选服务）——对齐 KuGouMusicApi useAxios 形态。 */
  async post(url, { params, body, signal, router = 'cloudlist.service.kugou.com', headers = {} } = {}) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) target.searchParams.set(key, value);
    const response = await this.doFetch(target.href, {
      method: 'POST', signal,
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'Content-Type': 'application/json',
        'x-router': router,
        dfid: String(params?.dfid ?? '0'), mid: String(params?.mid ?? '0'), clienttime: String(params?.clienttime ?? ''),
        ...headers,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    if (!response.ok) throw failure(response.status === 429 ? '酷狗请求过于频繁，请稍后重试。' : '酷狗暂时无法连接，请稍后重试。', response.status >= 400 && response.status < 500 ? response.status : 502);
    return readJson(text);
  }
  /** 通用请求（对齐 t.kugou.com/command/ 等非签名端点）。 */
  async request(url, { method = 'GET', headers = {}, signal } = {}) {
    const response = await this.doFetch(url, {
      method, signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.kugou.com/', ...headers,
      },
    });
    const text = await response.text();
    if (!response.ok) throw failure(response.status === 429 ? '酷狗请求过于频繁，请稍后重试。' : '酷狗暂时无法连接，请稍后重试。', response.status >= 400 && response.status < 500 ? response.status : 502);
    return text;
  }
  async search(query, offset = 0) {
    const keyword = clean(query);
    if (!keyword || keyword.length > 100) throw failure('请输入 1 至 100 个字符的搜索词。', 400);
    const page = Math.floor(Math.max(0, offset) / 20) + 1;
    // msearchcdn 的 HTTPS 证书 2026-10 起不再覆盖该主机名（ERR_TLS_CERT_ALTNAME_INVALID），
    // plain HTTP 实测 200 且响应结构不变（status/data.info/data.total）。
    const body = await this.get('http://msearchcdn.kugou.com/api/v3/search/song', {
      params: { plat: 0, keyword, page, pagesize: 20, version: 9108 },
    });
    if (!body?.data || !Array.isArray(body.data.info)) throw failure('酷狗搜索结果格式发生变化，请稍后重试。');
    const tracks = body.data.info.flatMap(info => { const track = kugouTrack(info); return track ? [track] : []; });
    const total = Math.max(0, Number(body.data.total) || 0);
    return { provider: 'kugou', query: keyword, offset, limit: 20, total, hasMore: page * 20 < total, tracks };
  }
  /** 酷狗权益（试听/付费）判定 —— 「只能听十几秒」的根治点。
   *
   * 【2026-10-14 实测修正】旧实现打的是
   *   POST https://gateway.kugou.com/goodsmstore/v1/get_res_privilege
   * 该路径现在**返回 404**（服务已迁移），于是本方法恒返回 null，
   * 权限判定整条失效 → 付费歌曲的试听片段被当成全曲播放（用户报的「放十几秒」）。
   *
   * 正确端点（对照 KuGouMusicApi module/privilege_lite.js）：
   *   POST https://gateway.kugou.com/v2/get_res_privilege/lite
   *   x-router: media.store.kugou.com
   *   body: { appid, clientver, area_code, behavior, need_hash_offset, relate,
   *           support_verify, qualities[], resource:[{type,page_id,hash,album_id}] }
   * 响应 data[0].relate_goods[] 每档音质一条：
   *   level     2=128 4=320 5=flac 6=Hi-Res 7=DSD，其它 0
   *   privilege 0=免费可获取，非 0=需会员/付费（实测付费歌曲 10）
   *   status    1=可播 0=不可播；pay_type=3 表示付费
   *   info.filesize 该档音质**全曲**字节数 —— 用它和实际拿到的字节数比对，
   *                 就能识别试听片段（实测周杰伦-晴天：全曲 4317292 字节，
   *                 实际只发 960116 字节 ≈ 60 秒）。 */
  async resourcePrivilege(hash, albumId = 0) {
    const credential = this.credential();
    const mid = credential?.mid && credential.mid !== '-' ? credential.mid : '0';
    const body = {
      appid: 1005, clientver: 20489, area_code: 1, behavior: 'play',
      need_hash_offset: 1, relate: 1, support_verify: 1,
      // resource 里刻意不带 album_audio_id —— 官方注释实测：带上上游会省略
      // 128 音质的 ogg 条目（概念版实际播放的就是该 ogg）。
      resource: [{ type: 'audio', page_id: 0, hash, album_id: Number(albumId) || 0 }],
      qualities: ['128', '320', 'flac', 'high', 'viper_atmos', 'viper_tape', 'viper_clear', 'super', 'multitrack'],
    };
    const params = kugouGatewayParams({ mid, uuid: '-' }, body);
    const response = await this.doFetch(
      `https://gateway.kugou.com/v2/get_res_privilege/lite?${new URLSearchParams(params)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-router': 'media.store.kugou.com',
          dfid: params.dfid, clienttime: params.clienttime, mid,
        },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok) return null; // 权限查询失败不阻断取址，交给后续判定
    const data = readJson(text);
    if (Number(data?.error_code ?? 0) !== 0) return null;
    const entry = Array.isArray(data?.data) ? data.data[0] : data?.data;
    if (!entry) return null;
    const relateGoods = Array.isArray(entry?.relate_goods) ? entry.relate_goods : [];
    // 各档音质的权益；privilege !== 0 即需会员/付费。
    const qualities = relateGoods.map(goods => ({
      quality: clean(goods?.quality),
      level: Number(goods?.level) || 0,
      privilege: Number(goods?.privilege) || 0,
      status: Number(goods?.status) || 0,
      payType: Number(goods?.pay_type) || 0,
      filesize: Number(goods?.info?.filesize) || 0,
      bitrate: Number(goods?.info?.bitrate) || 0,
      extname: clean(goods?.info?.extname),
    }));
    const paid = qualities.some(q => q.privilege !== 0);
    const blocked = qualities.length > 0 && qualities.every(q => q.status === 0);
    // 全曲字节数取**最高档可播**那条的 filesize；都没有就用 128。
    const best = qualities.filter(q => q.status === 1).sort((a, b) => a.level - b.level).pop()
      ?? qualities.find(q => q.quality === '128') ?? qualities[0];
    return {
      errorCode: 0,
      relateGoods,
      qualities,
      // privilege 非 0 或 pay_type 非 0 → 需要购买/会员
      needsPurchase: paid,
      // 全部档位都 status=0 → 完全不可播（只有试听）
      blocked,
      filesize: Number(best?.filesize ?? entry?.filesize ?? 0),
      enableRefreshApi: Number(data?.enable_refresh_api ?? entry?.enable_refresh_api ?? 0) === 1,
      privilege: Number(best?.privilege ?? entry?.privilege ?? 0),
      payType: Number(best?.payType ?? entry?.pay_type ?? 0),
      info: { bitrate: Number(best?.bitrate ?? entry?.info?.bitrate) || 0, extname: clean(best?.extname ?? entry?.info?.extname) },
      name: clean(entry?.name),
      singername: clean(entry?.singername),
      albumId: String(entry?.album_id ?? albumId ?? ''),
    };
  }
  /** tracker.kugou.com/v6/priv_url 取曲（KuGouMusicApi module/song_url_new.js
   * + util/request.js 对齐，实机互证 2026-10）：android 签名 query + JSON body，
   * tracker_param.key = md5(hash + 盐 + appid + mid + userid)，kg-* 头随行。
   * isFreePart: 对齐 —— 先查 get_res_privilege，只有确认是试听才置 1。 */
  async trackerEntry(hash, { isFreePart = 0 } = {}) {
    const credential = this.credential();
    const mid = '0', userid = 0;
    const key = createHash('md5').update(`${hash}${TRACKER_KEY_SALT}${GATEWAY_CLIENT.appid}${mid}${userid}`).digest('hex');
    const body = {
      area_code: '1', behavior: 'play',
      qualities: ['128', '320', 'flac', 'high', 'multitrack', 'viper_atmos', 'viper_tape', 'viper_clear', 'super'],
      resource: { collect_list_id: '3', collect_time: this.now(), hash, id: 0, page_id: 1, type: 'audio' },
      token: credential?.token || '',
      tracker_param: { all_m: 1, auth: '', is_free_part: isFreePart, key, module_id: 0, need_climax: 1, need_xcdn: 1, open_time: '', pid: '411', pidversion: '3001', priv_vip_type: '6', viptoken: '' },
      userid: String(userid), vip: 0,
    };
    const params = kugouGatewayParams({ mid, uuid: '-' }, body);
    const response = await this.doFetch(`http://tracker.kugou.com/v6/priv_url?${new URLSearchParams(params)}`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi', 'Content-Type': 'application/json',
        dfid: params.dfid, clienttime: params.clienttime, mid,
        'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw failure(response.status === 429 ? '酷狗请求过于频繁，请稍后重试。' : '酷狗暂时无法连接，请稍后重试。', response.status >= 400 && response.status < 500 ? response.status : 502);
    const entry = readJson(text)?.data?.[0];
    // 用户可见文案不得出现「会员/地区/付费」字样（硬规则）。
    if (!entry || Number(entry._errno) !== 0) throw failure('酷狗暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    return entry;
  }
  /** 对齐 src\platform\kugou.rs 的取址接口。
   * 
   *   https://gateway.kugou.com/v2/interface/index  (x-router: trackermv.kugou.com)
   *   响应字段: downurl / play_url / backupdownurl
   * 音质阶梯（0x1d7ee7b）：2000kflac / 4000kflac / 20201kmflac / 20501kmflac / 20900kmflac */
  async interfaceIndex(hash, albumId = 0) {
    const credential = this.credential();
    const mid = credential?.mid || 'NeZha';
    const params = kugouGatewayParams({ mid, uuid: '-' }, null);
    const query = new URLSearchParams({
      ...params,
      time: String(this.now()), server: 'kg', id: String(albumId || 0), level: 'flac',
    });
    const response = await this.doFetch(`https://gateway.kugou.com/v2/interface/index?${query}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/60.0.3112.90 Safari/537.36',
        'x-router': 'trackermv.kugou.com',
        dfid: params.dfid, mid,
      },
    });
    if (!response.ok) return null;
    const data = readJson(await response.text());
    const entry = data?.data ?? data;
    const url = [entry?.play_url, entry?.downurl, entry?.backupdownurl]
      .find(link => typeof link === 'string' && /^https?:\/\//.test(link));
    return url ? { url, raw: entry } : null;
  }
  async prepare(value) {
    const parsed = songId(value); if (!parsed) throw failure('无效的酷狗歌曲标识。', 400);
    const { hash } = parsed; const albumId = parsed.albumId || 0;
    // 对齐的决策顺序：① 先查权限（判定试听/付费）→ ② 再取播放地址。
    const privilege = await this.resourcePrivilege(hash, albumId).catch(() => null);
    // 权限接口说需要会员/付费，或所有档位都不可播 → 只能给试听片段。
    const needsPurchase = privilege?.needsPurchase === true;
    const restricted = needsPurchase || privilege?.blocked === true;
    const isFreePart = restricted ? 1 : 0;
    const entry = await this.trackerEntry(hash, { isFreePart });
    const info = entry.info || {};
    let url = (Array.isArray(info.tracker_url) ? info.tracker_url : []).find(link => typeof link === 'string' && /^https?:\/\//.test(link));
    // tracker 没给地址时，回退的 v2/interface/index。
    if (!url) {
      const fallback = await this.interfaceIndex(hash, albumId).catch(() => null);
      url = fallback?.url;
    }
    if (!url) throw failure('酷狗暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);

    // 判定试听片段。三条证据按可靠性排序：
    //  ① **实测字节数 vs 同档位全曲字节数**（最硬）：付费歌曲服务器只发一小段，
    //     实测周杰伦-晴天全曲 4317292 字节、实际只发 960116 字节（≈60 秒）。
    //     注意必须跟**同一码率档**比：免费歌全档可播时，128 档只有 4.7MB 而
    //     Hi-Res 档有 28MB，拿最高档比会把免费全曲误判成残片（实测踩过）。
    //  ② 权限接口说需要会员/付费（needsPurchase）。
    //  ③ tracker 明确回 is_free_part=1。
    const bitrate = Number(info.bitrate) || 0;
    // 取与 tracker 实际给出的码率同档的全曲字节数；没有同档就用 128 档兜底。
    const sameTier = privilege?.qualities?.find(q => q.bitrate === bitrate && q.filesize > 0)
      ?? privilege?.qualities?.find(q => q.quality === '128' && q.filesize > 0);
    const fullBytes = Number(sameTier?.filesize) || Number(info.filesize) || 0;
    let servedBytes = 0;
    try {
      const probe = await this.doFetch(url, { method: 'HEAD' });
      if (probe.ok) servedBytes = Number(probe.headers.get('content-length')) || 0;
    } catch { /* HEAD 不被支持时退回到证据 ②③ */ }
    // 实际字节明显小于同档全曲（留 5% 容差）→ 确实是残片。
    const truncated = fullBytes > 0 && servedBytes > 0 && servedBytes < fullBytes * 0.95;
    const freePart = truncated || needsPurchase || Number(entry.is_free_part) === 1 || isFreePart === 1;
    // 试听时长：优先用「实际能听多少字节」折算，这样界面显示的时长是真的。
    // 这里要的是**秒**：timelength 是毫秒，info.duration 是秒，分别换算后统一。
    const totalSeconds = Number(entry.timelength) ? Number(entry.timelength) / 1000
      : Math.max(0, Number(info.duration) || 0);
    const audibleBytes = servedBytes > 0 ? servedBytes : fullBytes;
    const trialEnd = audibleBytes > 0 && bitrate > 0
      ? (audibleBytes * 8) / (bitrate * 1000)
      : totalSeconds;
    return {
      audioUrl: url, bitrate: bitrate || undefined, format: clean(info.extname).toUpperCase() || undefined,
      // 只有确认是残片/受限才标 trial —— 免费全曲不会被误标。
      trial: freePart && trialEnd > 0 ? { start: 0, end: Math.max(0, trialEnd) } : undefined,
    };
  }
  async songInfo(value) {
    const parsed = songId(value); if (!parsed) throw failure('无效的酷狗歌曲标识。', 400);
    const { hash } = parsed; const albumId = parsed.albumId || 0;
    // 旧 wwwapi play/getdata（30020 后停用）曾同时给元数据与歌词；现改为
    // tracker 元数据 + m.kugou.com krc.php 歌词（两口实机 2026-10 验证）。
    const entry = await this.trackerEntry(hash);
    const info = entry.info || {};
    let lyrics = '';
    try {
      const response = await this.doFetch(`https://m.kugou.com/app/i/krc.php?cmd=100&hash=${hash}&timelength=${Number(info.duration) || 0}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://www.kugou.com/' } });
      if (response.ok) lyrics = (await response.text()).trim().slice(0, 200000);
    } catch {}
    return {
      track: {
        id: `kugou-${hash}${albumId ? `.${albumId}` : ''}`, albumId: `kugou-album-${albumId || 'unknown'}`, title: clean(entry.name) || '未知歌曲',
        artist: clean(entry.singername) || '未知歌手', duration: Math.max(0, (Number(info.duration) || 0) / 1000),
        format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
        onlineSource: { provider: 'kugou', id: `${hash}${albumId ? `.${albumId}` : ''}`, albumTitle: clean(entry.albumname) || '', pageUrl: 'https://www.kugou.com/', fee: Number(entry.pay_type) > 0 ? 1 : 0, albumId },
      },
      album: { title: clean(entry.albumname) || '未知专辑', artist: clean(entry.singername) || '未知歌手' },
      lyrics: { original: lyrics, translated: '', instrumental: false, unavailable: !lyrics },
    };
  }
  /** 对齐 src\platform\kugou.rs：歌单接口串行回退。
   * 
   *
   * 【2026-10-14 实测确定顺序】③ 已用真实 token 跑通（12 个歌单全部取回），
   * 所以把它放在第一位；① ② 只作历史回退保留：
   *   ③ gateway.kugou.com/v7/get_all_list  —— lite 身份，✅ 实测可用
   *   ① t.kugou.com/command/               —— ❌ 实测 err_code 20010 EOF
   *   ② gateway.kugou.com/pubsongs/v2/…    —— ❌ 实测 502（该服务已下线）
   * 曲目用 ④ gateway.kugou.com/v4/get_list_all_file。 */
  async playlists() {
    const credential = this.credential();
    if (!credential) throw failure('请先登录酷狗音乐。', 401);
    // ① 【首选】gateway.kugou.com/v7/get_all_list —— 云歌单列表。
    //
    // 【身份必须与签发这张票时一致】2026-10-15 用同一张新票实测：
    //   概念版 lite 3116/11440 + lite 盐  → ✅ code=0，12 个歌单
    //   标准版     1005/20489 + 安卓盐   → ❌ 20017
    //   1001/11440 + 安卓盐              → ❌ 20006
    // 所以这里按凭据里记下的 identity 选身份；用户可以在「酷狗」和「酷狗概念版」
    // 两个入口里任选其一登录，都能同步 —— 只要签发与使用是同一身份。
    // 老凭据（无 identity）按概念版兼容（历史上唯一能用的那套）。
    // 对照组：KuGouMusicApi module/user_playlist.js 也是 /v7/get_all_list
    // + encryptType:'android'，平台选 lite 才能取到数据。
    const identity = identityOf(credential);
    const signedParams = (extra, body) => identity.salt === LITE_SALT
      ? kugouLiteParams(extra, body)
      : kugouSignatureParams(identity, extra, body);
    try {
      const playlists = [];
      for (let page = 1; page <= 30; page += 1) {
        const body = { userid: credential.userid, token: credential.token, total_ver: 979, type: 2, page, pagesize: 100 };
        const response = await this.post('https://gateway.kugou.com/v7/get_all_list', {
          params: signedParams({ userid: credential.userid, token: credential.token, plat: 1,
            dfid: credential.dfid ?? '-', mid: credential.mid ?? '-' }, body),
          body,
          headers: {
            'x-router': 'cloudlist.service.kugou.com',
            'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1',
            'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
            Cookie: `token=${credential.token};userid=${credential.userid};dfid=${credential.dfid ?? '-'}`,
          },
        });
        // error_code 非 0 = 服务端拒绝（20017/20006 = 登录态失效）。
        // 过去这里被吞掉、返回空数组，界面就是一片空白 —— 必须如实报出来。
        const errorCode = Number(response?.error_code ?? 0);
        if (errorCode) {
          throw failure(
            errorCode === 20017 || errorCode === 20006
              ? '酷狗歌单未返回数据：登录态已失效，请退出酷狗后重新扫码登录。'
              : `酷狗歌单接口返回错误（error_code ${errorCode}），请稍后重试。`,
            403);
        }
        const entries = [response?.data?.info, response?.data?.list].find(Array.isArray) || [];
        for (const item of entries) {
          const id = String(item?.listid ?? item?.specialid ?? item?.id ?? '').slice(0, 24);
          const name = clean(item?.name || item?.listname);
          if (!/^\d{1,24}$/.test(id) || !name) continue;
          playlists.push({ id, name, trackCount: Math.max(0, Number(item.count ?? item.song_count ?? item.total) || 0), owned: true });
        }
        if (entries.length < 100) break;
      }
      if (playlists.length) return { playlists, hasMore: false };
    } catch (error) {
      // 认证类错误直接上抛，不要用「返回空」掩盖（那正是以前的老问题）。
      if (error?.status === 403) throw error;
      /* 其它异常回退到历史接口 */
    }
    // ② t.kugou.com/command/ —— 的首选接口（**实测已失效** err_code 20010 EOF，
    // 仅作历史回退保留）。
    try {
      const key = createHash('md5')
        .update(`36164c4015e704673c588ee202b9ecb8${credential.userid}`, 'utf8').digest('hex');
      const params = new URLSearchParams({
        appid: '1001', clientver: '11440', clienttime: String(Math.floor(Date.now() / 1000)),
        key, userid: credential.userid, token: credential.token,
        collected: '1', global_collection_id: '', gid: '', songs: '0', total: '0',
        plat: '1', page: '1', pagesize: '100',
      });
      const response = await this.request(`http://t.kugou.com/command/?${params}`, { method: 'GET' });
      const data = typeof response === 'string' ? safeJson(response) : response;
      const entries = [data?.data?.info, data?.data?.list, data?.info, data?.list].find(Array.isArray) || [];
      const playlists = entries.flatMap(item => {
        const id = String(item?.listid ?? item?.specialid ?? item?.id ?? '').slice(0, 24);
        const name = clean(item?.name || item?.listname);
        if (!/^\d{1,24}$/.test(id) || !name) return [];
        return [{ id, name, trackCount: Math.max(0, Number(item.count ?? item.song_count ?? item.total) || 0), owned: true }];
      });
      if (playlists.length) return { playlists, hasMore: false };
    } catch { /* 回退到 ③ */ }
    // ③ gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt —— 收藏歌单详情
    // （**实测 502**，该服务已下线，仅作历史回退保留）。
    try {
      const params = new URLSearchParams({
        specialname: '', global_collection_id: '', gid: '', pagesize: '100',
        appid: '1001', clientver: '11440', userid: credential.userid, token: credential.token,
      });
      const response = await this.request(
        `https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?${params}`,
        { method: 'GET', headers: { 'x-router': 'pubsongs.service.kugou.com' } },
      );
      const data = typeof response === 'string' ? safeJson(response) : response;
      const entries = [data?.data?.info, data?.data?.list, data?.info, data?.list].find(Array.isArray) || [];
      const playlists = entries.flatMap(item => {
        const id = String(item?.global_collection_id ?? item?.listid ?? item?.specialid ?? '').slice(0, 24);
        const name = clean(item?.specialname || item?.name);
        if (!name) return [];
        return [{ id: id || name, name, trackCount: Math.max(0, Number(item.song_count ?? item.count ?? item.total) || 0), owned: true }];
      });
      if (playlists.length) return { playlists, hasMore: false };
    } catch { /* 全部失败 */ }
    return { playlists: [], hasMore: false };
  }
  /** 对齐 src\playlist_import.rs 的个人歌单接口。
   * 
   *   listid  show_relate_goods  page  <lite 盐>
   *   https://gateway.kugou.com/v4/get_list_all_file
   *   x-router: cloudlist.service.kugou.com
   *   kg-rc: 1  kg-thash: 5d816a0  kg-rec: 1
   *   kg-rf: B9EDA08A64250DEFFBCADDEE00F8F25F
   *   Cookie: token=…;userid=…;dfid=…
   * 关键：在这里用 **lite 客户端签名盐**（LnT6xp…，appid 3116/clientver 11440），
   * 不是 gateway 族标准盐（OIlwieks…，appid 1005/clientver 20489）。 */
  async playlistTracks(id, offset = 0) {
    const credential = this.credential();
    if (!credential) throw failure('请先登录酷狗音乐。', 401);
    const listId = /^\d{1,24}$/.test(String(id)) ? String(id) : '';
    if (!listId) throw failure('无效的歌单标识。', 400);
    const page = Math.floor(Math.max(0, offset) / 50) + 1;
    const body = {
      listid: listId, show_relate_goods: 1, page, pagesize: 50, area_code: 1,
      allplatform: 1, show_cover: 1, type: 0,
      userid: credential.userid, token: credential.token,
    };
    const identity = identityOf(credential);
    const params = identity.salt === LITE_SALT
      ? kugouLiteParams({ userid: credential.userid, token: credential.token, dfid: credential.dfid ?? '-' }, body)
      : kugouSignatureParams(identity, { userid: credential.userid, token: credential.token,
          plat: 1, dfid: credential.dfid ?? '-', mid: credential.mid ?? '-' }, body);
    const response = await this.doFetch(`https://gateway.kugou.com/v4/get_list_all_file?${new URLSearchParams(params)}`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'Content-Type': 'application/json',
        'x-router': 'cloudlist.service.kugou.com',
        Cookie: `token=${credential.token};userid=${credential.userid};dfid=${credential.dfid ?? '-'}`,
        dfid: String(credential.dfid ?? '-'), mid: String(credential.mid ?? '-'), clienttime: String(params.clienttime),
        'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1',
        'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw failure('酷狗暂时无法连接，请稍后重试。', 502);
    const data = safeJson(text);
    const entries = [data?.data?.info, data?.data?.list, data?.data?.songs].find(Array.isArray) || [];
    // v4/get_list_all_file 的真实字段（2026-10-14 实测，见 scripts/probe-fields.mjs）：
    //   hash     文件 hash（32 hex）
    //   name     云歌单存的是文件名，形如 "歌手 - 歌名.mp3"，需剥扩展名并尝试切歌手
    //   timelen  时长（**毫秒**，不是 duration）
    //   album_id 专辑 id（字符串）
    //   mvhash   MV hash；bitrate 码率；size 字节数
    //   singerinfo[].name 通常为空，所以歌手要从 name 里切。
    const tracks = entries.flatMap(entry => {
      const info = entry?.info && typeof entry.info === 'object' ? entry.info : entry;
      const rawName = clean(info?.name || info?.songname || info?.filename);
      const withoutExt = rawName.replace(/\.(mp3|flac|m4a|ape|wav|ogg|aac|wma|dsf)$/i, '');
      const singerFromList = Array.isArray(info?.singerinfo)
        ? info.singerinfo.map(s => clean(s?.name)).filter(Boolean).join('、') : '';
      // "歌手 - 歌名" 切分：只在左侧不含括号且长度合理时采用，避免误切歌名里的连字符。
      const split = /^([^-]{1,40})\s+-\s+(.+)$/.exec(withoutExt);
      const title = split ? split[2] : withoutExt;
      const artist = singerFromList || (split ? split[1] : '');
      const track = kugouTrack({
        ...info,
        hash: info?.hash,
        songname: title,
        singername: artist,
        album_id: info?.album_id ?? info?.albumid ?? entry?.album_id,
        album_name: info?.albuminfo?.name || info?.album_name,
        // timelen 是**毫秒**，而 kugouTrack 现在按**秒**解释 duration（2026-10-15
        // 修完时长单位后必须在这里换算）；退回 info.duration 时它本身就是秒。
        duration: info?.timelen != null ? Math.round(Number(info.timelen) / 1000)
          : Math.max(0, Math.round(Number(info?.duration) || 0)),
        extname: /\.(flac)$/i.test(rawName) ? 'flac' : info?.extname || 'mp3',
      });
      return track ? [track] : [];
    });
    const total = Math.max(0, Number(data?.data?.total ?? data?.data?.count ?? data?.total) || 0);
    return { playlistId: listId, offset, total, tracks, hasMore: offset + tracks.length < total };
  }
  credential() { return this.auth?.credential; }
}

export class KugouLoginProtocol {
  constructor({ fetch: doFetch = globalThis.fetch } = {}) { this.doFetch = doFetch; }
  async call(path, { params, data, signal } = {}) {
    const target = new URL(path.startsWith('http') ? path : `https://login-user.kugou.com${path}`);
    for (const [key, value] of Object.entries(params ?? {})) target.searchParams.set(key, value);
    const response = await this.doFetch(target.href, {
      method: data ? 'POST' : 'GET', signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw failure(response.status === 429 ? '酷狗登录请求过于频繁，请稍后重试。' : '酷狗登录服务暂时不可用，请稍后重试。', response.status >= 400 && response.status < 500 ? response.status : 502);
    return readJson(text);
  }
  /** 创建二维码挑战。**票必须按将要使用它的身份签发** —— 这是「扫码成功却取不到
   * 歌单」的根因（旧实现把二维码写死成标准版 1001，却拿票去调概念版 3116 → 20017）。
   *
   * 两个入口都算「酷狗」，由用户选：
   *   'kugou'      标准版：appid 1005 / clientver 20489 / 安卓盐 + qrcode_txt appid=1005
   *   'kugou-lite' 概念版：appid 3116 / clientver 11440 / lite 盐 + qrcode_txt appid=3116
   * 取歌单时按凭据里记下的 identity 走同一套身份，所以两种登录都能同步。
   * 设备身份（mid/dev）也在这里生成，轮询与后续请求沿用同一套。 */
  async start(signal, method = 'kugou-lite') {
    const identity = method === 'kugou' ? 'kugou' : 'kugou-lite';
    const profile = KUGOU_IDENTITIES[identity];
    const device = kugouDevice();
    const body = await this.call('/v2/qrcode', {
      params: kugouQrParams({
        appid: profile.appid,
        clientver: profile.clientver,
        qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${profile.appid}&`,
        mid: device.mid,
      }), signal,
    });
    const token = clean(body?.data?.qrcode || body?.data?.token);
    if (!token || token.length > 512) throw failure('酷狗登录二维码暂时无法生成，请重试。');
    const target = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(token)}`;
    const image = await QRCode.toDataURL(target, { margin: 1, width: 320 });
    return { image, qrcode: token, expires: Date.now() + 120000, device, identity };
  }
  /** 轮询扫码状态：沿用与二维码相同的身份（appid/clientver）+ dev 设备标识。 */
  async poll(challenge, signal) {
    const device = challenge.device ?? kugouDevice();
    const identity = challenge.identity ?? 'kugou-lite';
    const profile = KUGOU_IDENTITIES[identity];
    const body = await this.call('/v2/get_userinfo_qrcode', {
      params: kugouQrParams({ qrcode: challenge.qrcode, appid: profile.appid, clientver: profile.clientver,
        mid: device.mid, dev: device.dev }), signal,
    });
    const data = body?.data || {};
    const token = clean(data.token || data.kg_token);
    const userId = String(data.userid ?? data.user_id ?? '').slice(0, 24);
    // data.status === 4 means the phone scanned and confirmed; credentials follow.
    if (data.status === 4 && token && userId) {
      return {
        state: 'authorized',
        credential: {
          token, userid: userId,
          dfid: clean(data.dfid) || '-', mid: device.mid,
          // 设备身份 + 登录身份一并存下：取歌单要和签发这张票时严格一致。
          dev: device.dev, guid: device.guid, identity,
        },
        profile: { userId, nickname: clean(data.nickname || data.username) || '酷狗用户' },
      };
    }
    if (data.status === 4) throw failure('酷狗登录未返回有效凭据，请重新扫码。');
    if (data.scanned || data.status === 2) return { state: 'scanned' };
    return { state: 'waiting' };
  }
  async profile(credential) {
    return { userId: String(credential.userid).slice(0, 24), nickname: '酷狗用户' };
  }
  async logout() { /* local session clearing is handled by PlatformAuth */ }
}

export function validKugouCredential(value) {
  return !!value && typeof value === 'object'
    && typeof value.token === 'string' && /^[A-Za-z0-9_=-]{8,4096}$/.test(value.token)
    && /^\d{1,24}$/.test(String(value.userid ?? ''))
    && (value.dfid === undefined || typeof value.dfid === 'string')
    && (value.mid === undefined || typeof value.mid === 'string')
    && (value.dev === undefined || typeof value.dev === 'string')
    && (value.guid === undefined || typeof value.guid === 'string');
}
