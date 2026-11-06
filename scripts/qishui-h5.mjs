// qishui-h5.mjs — 汽水音乐纯 JS 客户端（零 native 模块、零签名、零依赖）
//
// ══════════════════════════════════════════════════════════════════════════
// 公开 H5 通道的调用约定（本模块只走免签名端点）：
//
//   签名按端点各自要求，不按版本：h5 与 track 两类直接可读，pc 下的
//   track_v2 系列要签名，本模块不碰。
//   device_id 可省略；aid / version_name / version_code 至少带一个。
//   搜索字段是 q，不是 keyword。
// ══════════════════════════════════════════════════════════════════════════

const HOST = "https://api.qishui.com";

/** 全局 query 参数：只带 aid 即可，其余可选 */
export function baseQuery(extra = {}) {
  const p = new URLSearchParams({
    aid: "386088",
    app_name: "luna_h5",
    region: "cn",
    device_platform: "web",
    version_name: "1.0.0",
    version_code: "100000274",
    channel: "official",
    ...extra,
  });
  return p.toString();
}

/**
 * 发请求。自动识别三种失败并区分：
 *
 *   A. 签名校验拒绝  → 200 + 0 B + 无 bdturing-verify 头
 *      （端点要求 X-Helios/X-Medusa，本客户端只走免签名端点，正常不触发）
 *   B. 风控拦截      → 200 + 0 B + 有 bdturing-verify 头（subtype:"slide"）
 *      （bdturing 滑块验证码，间歇性触发，稍后重试通常可过）
 *   C. 业务错误      → JSON 里 status_code != 0
 *
 * 重试策略：仅对 B 类重试（A 类重试无意义）。
 */
async function req(method, path, { body, query, timeout = 25000, ua, retries = 2, retryDelay = 1500 } = {}) {
  const q = baseQuery(query);
  const url = HOST + path + "?" + q;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (ua) headers["user-agent"] = ua;

  let lastRisk = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(z => setTimeout(z, retryDelay * attempt));

    const r = await fetch(url, {
      method,
      headers,
      body: method === "POST" || method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await r.text();

    // 空响应：区分签名拒绝 vs 风控
    if (text.length === 0) {
      const bd = r.headers.get("bdturing-verify") || r.headers.get("x-vc-bdturing-parameters");
      if (bd) {
        let info = null;
        try { info = JSON.parse(bd); } catch { }
        lastRisk = { kind: "bdturing", subtype: info && info.subtype, detail: info && info.detail };
        continue; // 风控 → 重试
      }
      return {
        status: r.status, ok: r.ok, bytes: 0, json: null, text: "",
        error: { kind: "signature", message: "端点要求签名（200 + 0 B，无 bdturing 头）：" + path },
      };
    }

    let json = null;
    try { json = JSON.parse(text); } catch { }
    const out = { status: r.status, ok: r.ok, bytes: text.length, json, text };
    if (!json) out.error = { kind: "nonJSON", message: "响应非 JSON：" + path };
    if (lastRisk) out.riskRetried = lastRisk;
    return out;
  }

  // 重试耗尽，仍是风控
  return {
    status: 200, ok: true, bytes: 0, json: null, text: "",
    error: { kind: "bdturing", message: "bdturing 风控（重试 " + retries + " 次仍拦截）：" + path, subtype: lastRisk && lastRisk.subtype },
  };
}

function unwrap(res, label) {
  if (res.error && res.error.kind === "signature") throw new Error(label + ": " + res.error.message);
  if (res.error && res.error.kind === "bdturing") throw new Error(label + ": 触发滑块验证（bdturing subtype=" + (res.error.subtype || "slide") + "），稍后重试");
  const j = res.json;
  if (!j) throw new Error(label + ": 响应非 JSON (" + res.status + ", " + res.bytes + " B)");
  const code = j.status_code ?? (j.status_info && j.status_info.status_code) ?? 0;
  if (code !== 0) {
    const msg = (j.status_info && j.status_info.status_msg) || "";
    throw new Error(label + ": code=" + code + " " + msg);
  }
  return j;
}

// ────────────────────────────────────────────────────────────────────────
// 曲目
// ────────────────────────────────────────────────────────────────────────

/** 曲目详情（含播放信息）。base 前缀，无需签名。返回 10.5 KB。 */
export async function getTrack(trackId, opts = {}) {
  const r = await req("POST", "/luna/track", {
    body: { track_id: String(trackId), media_type: opts.mediaType || "track" },
  });
  return unwrap(r, "getTrack");
}

/** 仅播放信息。6.2 KB。 */
export async function getPlayerInfo(trackId) {
  const r = await req("GET", "/luna/track_player", {
    query: { track_id: String(trackId) },
  });
  return unwrap(r, "getPlayerInfo").player_info;
}

/** 相关曲目。28.8 KB。 */
export async function getRelatedTracks(trackId, opts = {}) {
  const r = await req("POST", "/luna/track/related", {
    body: { track_id: String(trackId), offset: opts.offset ?? 0, limit: opts.limit ?? 20 },
  });
  return unwrap(r, "getRelatedTracks");
}

// ────────────────────────────────────────────────────────────────────────
// 专辑 / 歌手 / 歌单
// ────────────────────────────────────────────────────────────────────────

/** 专辑详情 + 全部曲目。55 KB。三档前缀全部不校验。 */
export async function getAlbum(albumId) {
  const r = await req("GET", "/luna/albums/" + albumId);
  return unwrap(r, "getAlbum");
}

/**
 * 歌手详情。58 KB，含 hot_tracks（5 首）+ hot_albums（10 张）+ artist_info。
 * 基础前缀 /luna/artists/{id} 返回空，必须用 /luna/pc/ 或 /luna/h5/（两者等价）。
 */
export async function getArtist(artistId) {
  const r = await req("GET", "/luna/pc/artists/" + artistId);
  return unwrap(r, "getArtist");
}

/**
 * 歌手全部曲目。
 *
 * 用 GET + query（不是 POST body）。实测：
 *   GET  ?cursor=&count=100    498,860 B  n=100   ★
 *   GET  ?cursor=&count=50     250,078 B  n=50
 *   GET  ?cursor=&count=10     250,078 B  n=50    （count 最小 50）
 *   GET  ?cursor=                   161 B  1000004 （count 必填）
 *   POST body {cursor:"",count:"100"}     0 B  ← 服务端空响应，不可用
 *
 * sortType: 0=Hot, 1=CopyrightStartTime, 2=CollectionCount
 */
export async function getArtistTracks(artistId, opts = {}) {
  const query = {
    cursor: opts.cursor ?? "",
    count: String(opts.count ?? 50),
  };
  if (opts.sortType !== undefined) query.sort_type = String(opts.sortType);
  const r = await req("GET", "/luna/artists/" + artistId + "/tracks", { query });
  return unwrap(r, "getArtistTracks");
}

/**
 * 歌手全部专辑。cursor 走 query，同样必填且首页传 ""。
 * 传 cursor="0" 或省略 → 1000004 ERR_INVALID_PARAM。
 */
export async function getArtistAlbums(artistId, opts = {}) {
  const r = await req("GET", "/luna/artists/" + artistId + "/albums", {
    query: { cursor: opts.cursor ?? "", count: String(opts.count ?? 50) },
  });
  return unwrap(r, "getArtistAlbums");
}

export async function getPlaylist(playlistId) {
  const r = await req("POST", "/luna/playlist/detail", {
    body: { playlist_id: String(playlistId) },
  });
  return unwrap(r, "getPlaylist");
}

// ────────────────────────────────────────────────────────────────────────
// 搜索
// ────────────────────────────────────────────────────────────────────────

/**
 * 搜索。字段名是 q，不是 keyword。
 * type: all | track | album | artist | playlist | ...
 * 返回 { result_groups: [{id, data:[{meta, entity}], has_more}] }
 */
export async function search(q, opts = {}) {
  const type = opts.type || "all";
  const r = await req("POST", "/luna/search/" + type, {
    body: {
      q,
      cursor: opts.cursor ?? "",
      search_id: opts.searchId ?? "",
      search_method: opts.searchMethod ?? "",
      search_scene: opts.searchScene ?? "",
    },
  });
  return unwrap(r, "search");
}

/** 搜索联想。字段名同样是 q。 */
export async function suggest(q, opts = {}) {
  const r = await req("GET", "/luna/sug", {
    query: { q, sug_scene: opts.scene ?? "normal", sug_search_id: opts.searchId ?? "" },
  });
  return unwrap(r, "suggest");
}

export async function searchCategories() {
  const r = await req("POST", "/luna/search-categories", { body: {} });
  return unwrap(r, "searchCategories");
}

// ────────────────────────────────────────────────────────────────────────
// 歌词
// ────────────────────────────────────────────────────────────────────────

/**
 * 歌词对象（含 content 逐字时间轴正文）。
 * 走 /luna/track，不需要 includes —— lyric 默认就在返回里。
 * 曲目本身无歌词时 content 为空（前端同样显示"暂无歌词，请欣赏"）。
 */
export async function getLyric(trackId) {
  const j = await getTrack(trackId);
  return j.lyric ?? null;
}

/**
 * 解析汽水逐字时间轴歌词。
 *
 * 实测格式（因为爱情，3,360 B）：
 *   [48910,2290]<0,310,0>给<310,280,0>你<590,300,0>一<920,330,0>张...
 *
 *   [行起始ms,行时长ms] 后跟 N 个 <字偏移ms,字时长ms,保留>字
 *   字偏移相对行起点；第三个数实测恒为 0
 *
 * @param content      lyric.content
 * @param translations lyric.translations?.cn（同 \n 分行，] 之后是正文）
 * @returns [{startTime, duration, text, translation, chars:[{char,startTime,duration}]}]
 */
export function parseLyric(content, translations) {
  if (!content) return [];
  const lines = String(content).split("\n");
  const transLines = translations ? String(translations).split("\n") : [];
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    const hm = raw.match(/^\[(\d+),(\d+)\]/);
    if (!hm) {
      out.push({
        startTime: -1, duration: -1, text: raw, translation: "",
        chars: [...raw].map(c => ({ char: c, startTime: -1, duration: -1 })),
      });
      continue;
    }
    const lineStart = Number(hm[1]);
    const lineDur = Number(hm[2]);
    const body = raw.slice(hm[0].length);

    const chars = [];
    const re = /<(-?\d+),(-?\d+)(?:,-?\d+)?>([^<]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const ch = m[3];
      if (ch === "") continue;
      chars.push({ char: ch, startTime: lineStart + Number(m[1]), duration: Number(m[2]) });
    }
    if (!chars.length) {
      const txt = body.replace(/<[^>]*>/g, "");
      for (const c of [...txt]) chars.push({ char: c, startTime: lineStart, duration: -1 });
    }

    let translation = "";
    if (transLines[i]) {
      const t = transLines[i];
      const ti = t.indexOf("]");
      translation = (ti >= 0 ? t.slice(ti + 1) : t).trim();
    }

    out.push({
      startTime: lineStart,
      duration: lineDur,
      text: chars.map(c => c.char).join(""),
      translation,
      chars,
    });
  }
  return out;
}

/** 逐字时间轴 → 标准 LRC 文本（[mm:ss.xx]正文），供外部播放器使用。 */
export function toLRC(lines) {
  const fmt = (ms) => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(cs).padStart(2, "0");
  };
  return lines.filter(l => l.startTime >= 0).map(l => "[" + fmt(l.startTime) + "]" + l.text).join("\n");
}

/** 一次取齐：歌词正文 + 解析后的行 + LRC 文本。 */
export async function resolveLyric(trackId) {
  const ly = await getLyric(trackId);
  if (!ly || !ly.content) {
    return { hasLyric: false, type: ly ? ly.type : null, raw: null, lines: [], lrc: "" };
  }
  const lines = parseLyric(ly.content, ly.translations && ly.translations.cn);
  return {
    hasLyric: true,
    type: ly.type || "lrc",
    raw: ly.content,
    lines,
    lrc: toLRC(lines),
    charCount: lines.reduce((s, l) => s + l.chars.length, 0),
    translations: ly.translations || null,
  };
}

/** seo_track 的完整返回（含 track_player / album_tracks / artist_tracks / comments）。 */
export async function getSeoTrack(trackId) {
  const r = await req("GET", "/luna/h5/seo_track", {
    query: { track_id: String(trackId) },
    timeout: 40000,
  });
  return unwrap(r, "getSeoTrack");
}

// ────────────────────────────────────────────────────────────────────────
// 推荐流
// ────────────────────────────────────────────────────────────────────────

/** 推荐流。61 KB。 */
export async function feedSongTab(opts = {}) {
  const r = await req("POST", "/luna/pc/feed/song-tab", {
    body: {
      count: opts.count ?? 10,
      cursor: opts.cursor ?? 0,
      played_tracks: [],
      played_media: [],
    },
  });
  return unwrap(r, "feedSongTab");
}

export async function feedMode() {
  const r = await req("GET", "/luna/feed/mode");
  return unwrap(r, "feedMode");
}

// ────────────────────────────────────────────────────────────────────────
// 音频 URL 解析 + 下载 + 解密
// ────────────────────────────────────────────────────────────────────────

export const QUALITY_ORDER = ["highest", "higher", "medium", "low", "lowest"];

/** 歌手作品排序：0 热门 / 1 版权上线时间 / 2 收藏数。 */
export const ARTIST_TRACK_SORT = { Hot: 0, CopyrightStartTime: 1, CollectionCount: 2 };

/**
 * 从 track_player 取出可播放的音频直链。
 * video_model 是 JSON 字符串（内嵌），含 video_list。
 *
 * @param player  track_player 或 player_info
 * @param prefer  期望码率：highest|higher|medium|low|lowest，默认 highest
 * @returns {{url, backup, quality, bitrate, size, codec, sampleRate, expireAt}}
 */
export function pickAudioUrl(player, prefer = "highest") {
  if (!player || !player.video_model) throw new Error("player.video_model 缺失");
  let vm;
  try { vm = JSON.parse(player.video_model); } catch (e) { throw new Error("video_model 不是合法 JSON: " + e.message); }
  const list = vm.video_list || [];
  if (!list.length) throw new Error("video_list 为空（可能无版权或需登录）");

  const rank = (q) => {
    const i = QUALITY_ORDER.indexOf(q);
    return i < 0 ? QUALITY_ORDER.length : i;
  };
  const target = prefer;
  let best = list.find(it => it.video_meta && it.video_meta.quality === target);
  if (!best) {
    // 取最接近的：优先不低于目标，其次任意最高
    const sorted = [...list].filter(it => it.video_meta)
      .sort((a, b) => rank(a.video_meta.quality) - rank(b.video_meta.quality));
    best = sorted.find(it => rank(it.video_meta.quality) >= rank(target)) || sorted[sorted.length - 1] || list[0];
  }
  const m = best.video_meta || {};
  return {
    url: best.main_url,
    backup: best.backup_url || null,
    quality: m.quality,
    bitrate: m.bitrate,
    size: m.size,
    codec: m.codec_type,
    sampleRate: m.audio_sample_rate,
    fileHash: m.file_hash,
    encryptInfo: best.encrypt_info || null,
    expireAt: vm.url_expire,
  };
}

/** 一次取齐：曲目元数据 + 全部可用码率。 */
export async function resolveTrack(trackId, prefer = "highest") {
  const j = await getTrack(trackId);
  const tr = j.track || {};
  const out = {
    id: tr.id,
    name: tr.name,
    duration: tr.duration,
    vid: tr.vid,
    artists: (tr.artists || []).map(a => ({ id: a.id, name: a.name })),
    album: tr.album ? { id: tr.album.id, name: tr.album.name, cover: tr.album.url_cover } : null,
    stats: j.track_stats || tr.stats || null,
    bitRates: tr.bit_rates || [],
    qualifiers: null,
    audio: null,
    audioDuration: null,
    urlExpire: null,
    segment: null,
    encrypted: false,
    spade: null,
    kid: null,
    encryptionMethod: null,
    labels: null,
    vocal: null,
    isInstrumental: false,
    error: null,
    errorKind: null,
  };
  try {
    out.audio = pickAudioUrl(j.track_player, prefer);
    const vm = JSON.parse(j.track_player.video_model);
    out.qualifiers = vm.video_list.filter(x => x.video_meta)
      .map(x => ({ quality: x.video_meta.quality, bitrate: x.video_meta.bitrate, size: x.video_meta.size }));

    // 实际音频时长（≠ track.duration，后者是完整曲目时长）
    out.audioDuration = vm.video_duration;
    out.urlExpire = vm.url_expire;

    // 片段信息：汽水曲库大量条目是 UGC 上传的片段，playable_range 标出其在原曲中的位置
    const pr = tr.playable_range;
    if (pr && (pr.start > 0 || (pr.duration > 0 && tr.duration > 0 && pr.duration < tr.duration * 0.9))) {
      out.segment = {
        startMs: pr.start || 0,
        durationMs: pr.duration,
        fullDurationMs: tr.duration,
        isFullTrack: false,
      };
    } else {
      out.segment = { startMs: 0, durationMs: vm.video_duration * 1000, fullDurationMs: tr.duration, isFullTrack: true };
    }

    // 加密标记 + spade_a
    const item = vm.video_list.find(x => x.video_meta && x.video_meta.quality === out.audio.quality)
      || vm.video_list.find(x => x.main_url === out.audio.url);
    if (item && item.encrypt_info && item.encrypt_info.encrypt) {
      out.encrypted = true;
      out.spade = item.encrypt_info.spade_a;
      out.kid = item.encrypt_info.kid;
      out.encryptionMethod = item.encrypt_info.encryption_method;
    }

    // 商业标记：实测**不阻止下发**，仅作元信息
    const li = tr.label_info || {};
    out.labels = {
      vipDownload: !!li.only_vip_download,
      vipPlayable: !!li.only_vip_playable,
      vipQualities: li.quality_only_vip_can_download || [],
      isOriginal: !!li.is_original,
    };
    out.vocal = tr.vocal;
    out.isInstrumental = tr.vocal === 2;
  } catch (e) {
    out.error = e.message;
    out.errorKind = classifyAudioError(e, j);
  }
  return out;
}

/**
 * 归类「拿不到音频」的原因。
 *
 * 实测结论（30 首样本）：汽水几乎不返回空的 video_list ——
 * VIP / 试听 / 片段标记都只是元数据，不影响下发。真正拿不到源的常见原因只有几类。
 */
export function classifyAudioError(err, resp) {
  const msg = String((err && err.message) || err || "");
  if (/video_list 为空/.test(msg)) return "EMPTY_SOURCE";
  if (/video_model 缺失/.test(msg)) return "NO_PLAYER";
  if (/不是合法 JSON/.test(msg)) return "BAD_PLAYER";
  if (/bdturing|滑块/.test(msg)) return "RISK_CONTROL";
  if (/code=\d+/.test(msg)) return "BIZ_ERROR";
  if (/响应非 JSON/.test(msg)) return "EMPTY_RESPONSE";
  if (resp && resp.track && resp.track.vocal === 2) return "INSTRUMENTAL";
  return "UNKNOWN";
}

/** 给用户看的说明 */
export function explainAudioError(kind) {
  return {
    EMPTY_SOURCE: "该曲目没有可用的音频源（可能无版权或已下架）",
    NO_PLAYER: "该曲目未返回播放信息（可能需登录或地区限制）",
    BAD_PLAYER: "播放信息格式异常",
    RISK_CONTROL: "触发风控滑块验证，稍后重试",
    BIZ_ERROR: "业务错误",
    EMPTY_RESPONSE: "服务端返回空响应（签名或风控拦截）",
    INSTRUMENTAL: "纯音乐，无歌词",
    UNKNOWN: "未知原因",
  }[kind] || "未知原因";
}

// ────────────────────────────────────────────────────────────────────────
// 下载 + 解密
// ────────────────────────────────────────────────────────────────────────
