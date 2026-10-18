// LRC 歌词统一获取与匹配管线（自有实现，本项目代码）。
// 匹配思路交叉核对自 chenmozhijin/LDDC（GPL-3.0）：符号统一、相似度、加权评分、
// 时长差 >4s 淘汰、弱标题扣分；酷我歌词协议交叉核对自 sout123/KuwoMusicLRC_API：
// XOR(yeelion) 参数编码、zlib、gb18030、LRCX 逐字/翻译转换。均写为自有实现，
// 见 NOTICE.md 署名。零新依赖：node:zlib + TextDecoder('gb18030')。
import { inflateSync, deflateSync } from 'node:zlib';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const gb = () => new TextDecoder('gb18030');

// ---------- 匹配（LDDC 思路的自有实现） ----------
const SYMBOL_MAP = { '（': '(', '）': ')', '：': ':', '！': '!', '？': '?', '／': '/', '＆': '&', '＊': '*', '＠': '@', '＃': '#', '＄': '$', '％': '%', '＼': '\\', '｜': '|', '＝': '=', '＋': '+', '－': '-', '＜': '<', '＞': '>', '［': '[', '］': ']', '｛': '{', '｝': '}', '　': ' ', '·': '・' };

export function unifiedSymbol(text) {
  let out = String(text ?? '').trim();
  for (const [key, value] of Object.entries(SYMBOL_MAP)) out = out.split(key).join(value);
  return out.replace(/\s+/g, ' ');
}

/** difflib ratio 等价：2×匹配字符数 / 总字符数（LCS 动态规划）。 */
export function textDifference(a, b) {
  const s1 = String(a ?? ''), s2 = String(b ?? '');
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const row = new Uint16Array(s2.length + 1);
  for (let i = 1; i <= s1.length; i++) {
    let prev = 0;
    for (let j = 1; j <= s2.length; j++) {
      const up = row[j];
      row[j] = s1[i - 1] === s2[j - 1] ? prev + 1 : Math.max(up, row[j - 1]);
      prev = up;
    }
  }
  return (2 * row[s2.length]) / (s1.length + s2.length);
}

const titleTags = text => {
  const tags = [...text.matchAll(/[([（【][^)\]）】]*[\])）】]/g)].map(m => m[0].toLowerCase());
  return tags.map(t => t.replace(/ver(?:sion)?\.?/g, 'ver').replace(/伴奏|纯音乐|inst\.?(?:rumental)?|off ?vocal(?: ?[Vv]er.)?/g, 'inst').replace(/mixed/g, 'mix').replace(/edited/g, 'edit'));
};

export function titleScore(a, b) {
  const title1 = unifiedSymbol(a).toLowerCase(), title2 = unifiedSymbol(b).toLowerCase();
  if (!title1 || !title2) return 0;
  if (title1 === title2) return 100;
  const score0 = Math.max(textDifference(title1, title2), 0) * 100;
 // 同开头 + 版本标签差异：标签全对上加分，剩余文本按相似度（LDDC 思路简化版）
  let same = '';
  for (let i = 0; i < title1.length && i < title2.length && title1[i] === title2[i]; i++) same += title1[i];
  if (!same || same === title1 || same === title2) return score0;
  const tags1 = titleTags(title1.slice(same.length)), tags2 = titleTags(title2.slice(same.length));
  const rest1 = title1.slice(same.length).replace(/[([（【][^)\]）】]*[\])）】]/g, ''), rest2 = title2.slice(same.length).replace(/[([（【][^)\]）】]*[\])）】]/g, '');
  const kp = same.length / ((rest1.length + rest2.length) / 2 + same.length);
  const score1 = 100 * kp + Math.max(textDifference(rest1, rest2), 0) * 100 * (1 - kp);
  const unmatched = tags1.filter(t => !tags2.includes(t)).length + tags2.filter(t => !tags1.includes(t)).length;
  return unmatched ? score1 : Math.max(score1 * 0.7 + 30, score0);
}

export function artistScore(a, b) {
  const split = value => unifiedSymbol(value).split(/[,、/\\&・]+/).map(s => s.trim()).filter(Boolean);
  const list1 = split(a), list2 = split(b);
  if (!list1.length || !list2.length) return 0;
  if (list1.length === 1 && list2.length === 1) return Math.max(textDifference(list1[0], list2[0]), 0) * 100;
 // 列表最大配对（LDDC list_max_difference 思路）：贪心取最高相似度对
  const scores = [];
  for (const x of list1) for (const y of list2) scores.push([x, y, textDifference(x, y)]);
  scores.sort((p, q) => q[2] - p[2]);
  const usedA = new Set(), usedB = new Set();
  let total = 0;
  for (const [x, y, score] of scores) {
    if (usedA.has(x) || usedB.has(y)) continue;
    usedA.add(x); usedB.add(y); total += score;
    if (usedA.size === list1.length || usedB.size === list2.length) break;
  }
  return (total / Math.max(list1.length, list2.length)) * 100;
}

/** query/candidate: { title, artist, album?, duration(秒) }。返回 0-100；<0 = 时长淘汰。 */
export function matchScore(query, candidate) {
  const qd = Number(query.duration), cd = Number(candidate.duration);
  if (qd > 0 && cd > 0 && Math.abs(qd - cd) > 4) return -1; // LDDC：时长差 >4s 直接淘汰
  const ts = titleScore(query.title, candidate.title);
  const as = query.artist && candidate.artist ? artistScore(query.artist, candidate.artist) : null;
  const als = query.album && candidate.album ? Math.max(textDifference(query.album.toLowerCase(), candidate.album.toLowerCase()) * 100, 0) : null;
  let score;
  if (as !== null) score = als !== null ? Math.max(ts * 0.5 + as * 0.5, ts * 0.5 + as * 0.35 + als * 0.15) : ts * 0.5 + as * 0.5;
  else if (als) score = Math.max(ts * 0.7 + als * 0.3, ts * 0.8);
  else score = ts;
  return ts < 30 ? Math.max(0, score - 35) : score;
}

export function pickBestMatch(query, candidates, minScore = 60) {
  let best = null;
  for (const candidate of candidates) {
    const score = matchScore(query, candidate);
    if (score >= minScore && (!best || score > best.score)) best = { candidate, score };
  }
  return best;
}

// ---------- 酷我歌词协议（KuwoMusicLRC_API 协议的自有实现） ----------
const KW_KEY = Buffer.from('yeelion');

const xorYeelion = input => {
  const output = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) output[i] = input[i] ^ KW_KEY[i % KW_KEY.length];
  return output;
};

/** rid + 明文参数 → newlyric.kuwo.cn 查询串（XOR+base64）。测试可复用做回环。 */
export function encodeKuwoParams(rid, lrcx = true) {
  let params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${String(rid).replace(/\D/g, '')}`;
  if (lrcx) params += '&lrcx=1';
  return xorYeelion(Buffer.from(params, 'utf8')).toString('base64');
}

/** tp=content 响应 → 原始（逐字）歌词文本；lrcx 需二次 XOR+base64 解码。 */
export function decodeKuwoLyrics(buf, lrcx = true) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (raw.toString('utf8', 0, 10) !== 'tp=content') return '';
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const inflated = inflateSync(body);
  if (!lrcx) return gb().decode(inflated);
  return gb().decode(xorYeelion(Buffer.from(inflated.toString(), 'base64')));
}

/** 酷我逐字格式（[mm:ss.mmm]<o1,o2>词 … / <0,0>翻译行）→ 标准 LRC 对（原文+翻译）。 */
export function convertKuwoLrc(rawLrc) {
  const lines = String(rawLrc).split(/\r\n|\r|\n/);
  const tag = String(rawLrc).match(/\[kuwo:(\d+)\]/);
  const parsed = tag ? parseInt(tag[1], 8) : 0;
  const offset = Math.trunc(parsed / 10) || 1, offset2 = (parsed % 10) || 1;
  const stamp = ms => {
    const t = Math.max(0, Math.round(ms));
    return `[${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}]`;
  };
  const original = [], translated = [];
  let awaitingTranslation = false;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\[(\d{2}:\d{2}\.\d{3})\](.*)$/);
    if (!match) continue;
    const [, time, content] = match;
    const start = Number(time.slice(0, 2)) * 60000 + Number(time.slice(3, 5)) * 1000 + Number(time.slice(6));
    const words = [...content.matchAll(/<(-?\d+),(-?\d+)>([^<]*)/g)];
    if (!words.length) {
      if (content.trim()) { original.push(`${stamp(start)}${content.trim()}`); awaitingTranslation = true; }
      continue;
    }
    const text = words.map(w => w[3]).join('').trim();
    if (!text) continue;
 // 词段含非零偏移 = 原文；全 <0,0> 段 = 紧随原文的翻译行，否则为独立原文行
    const allZero = words.every(w => w[1] === '0' && w[2] === '0');
    if (!allZero || !awaitingTranslation) {
      original.push(`${stamp(start)}${text}`);
      awaitingTranslation = true;
    } else {
      translated.push(`${stamp(start)}${text}`);
      awaitingTranslation = false;
    }
  }
  return { original: original.join('\n'), translated: translated.join('\n') };
}

// ---------- 各平台歌词口 ----------
export async function kuwoLyrics(rid, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://newlyric.kuwo.cn/newlyric.lrc?${encodeKuwoParams(rid, true)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(error => { throw failure(`酷我歌词请求失败：${error.message}`); });
  if (!response.ok) throw failure(`酷我歌词请求失败：HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  const lrcx = decodeKuwoLyrics(raw, true) || decodeKuwoLyrics(raw, false);
  if (!lrcx.trim()) return { original: '', translated: '', instrumental: false, unavailable: true };
  const pair = convertKuwoLrc(lrcx);
  return { ...pair, instrumental: false, unavailable: !pair.original };
}

/** 网易云公开歌词口（NeteaseCloudMusicApi module/lyric 同源契约）。 */
export async function neteaseLyrics(id, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }).catch(error => { throw failure(`网易云歌词请求失败：${error.message}`); });
  if (!response.ok) throw failure(`网易云歌词请求失败：HTTP ${response.status}`);
  const data = await response.json();
  const text = value => typeof value === 'string' ? value.slice(0, 200000) : '';
  return {
    original: text(data.lrc?.lyric), translated: text(data.tlyric?.lyric),
    instrumental: data.nolyric === true, unavailable: data.uncollected === true || !text(data.lrc?.lyric),
  };
}

/** 酷狗歌词口（m.kugou.com krc.php，与 kugou-protocol 同口）。 */
export async function kugouLyrics(hash, durationMs = 0, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://m.kugou.com/app/i/krc.php?cmd=100&hash=${encodeURIComponent(hash)}&timelength=${Math.round(durationMs) || 0}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://www.kugou.com/' } }).catch(error => { throw failure(`酷狗歌词请求失败：${error.message}`); });
  if (!response.ok) throw failure(`酷狗歌词请求失败：HTTP ${response.status}`);
  const original = (await response.text()).trim().slice(0, 200000);
  return { original, translated: '', instrumental: false, unavailable: !original };
}

// ---------- 跨源解析管线 ----------
const DIRECT = { kuwo: (id, opts) => kuwoLyrics(id, opts), netease: (id, opts) => neteaseLyrics(id, opts), kugou: (id, opts, query) => kugouLyrics(id, (Number(query.duration) || 0) * 1000, opts) };

async function providerLyrics(provider, id, query, options) {
 // catalog 优先（带登录态/可注入 mock），直连口兜底（免登录平台）
  const catalog = options.catalogs?.[provider];
  if (catalog?.songInfo) {
    const info = await catalog.songInfo(id);
    return info?.lyrics ?? null;
  }
  const direct = DIRECT[provider];
  if (direct) return direct(id, options, query);
  return null;
}

/**
 * 歌词解析：本源优先；缺歌词时跨源按 歌名+歌手+时长 匹配（LDDC 思路）。
 * query: { title, artist, duration(秒), provider?, id? }。
 * 返回 { original, translated, instrumental, unavailable, source, score?, error? }。
 */
export async function resolveLyrics(query, options = {}) {
  const { fetchImpl = fetch, catalogs = {}, lookupOrder = ['kuwo', 'kugou', 'netease', 'qq'], minScore = 60 } = options;
  const settings = { fetchImpl, catalogs };
  const own = query.provider && query.id ? await providerLyrics(query.provider, query.id, query, settings).catch(error => ({ unavailable: true, original: '', translated: '', instrumental: false, error: error.message })) : null;
  if (own && (own.instrumental || (own.original && !own.unavailable))) return { ...own, source: query.provider, score: 100 };
  for (const provider of lookupOrder) {
    if (provider === query.provider) continue;
    const catalog = catalogs[provider];
    if (!catalog?.search) continue;
    try {
      const results = await catalog.search(`${query.title} ${query.artist ?? ''}`.trim());
      const candidates = (results?.tracks ?? []).map(track => ({ track, title: track.title, artist: track.artist, album: track.onlineSource?.albumTitle, duration: track.duration }));
      const best = pickBestMatch(query, candidates, minScore);
      if (!best) continue;
      const lyrics = await providerLyrics(provider, best.candidate.track.onlineSource?.id ?? best.candidate.track.id, query, settings);
      if (lyrics && (lyrics.instrumental || (lyrics.original && !lyrics.unavailable))) return { ...lyrics, source: provider, score: Math.round(best.score) };
    } catch { /* 单源失败继续下一源，全败才如实返回 */ }
  }
  return { original: '', translated: '', instrumental: false, unavailable: true, source: null, error: own?.error };
}
