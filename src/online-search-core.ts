import type { MusicTrack, OnlineSearchResults } from './music-types.ts';
import { musicPlatforms, type MusicProvider } from './music-platform.ts';
import { fetchOnline } from './online-debug.ts';

/** 搜索平台页签顺序：网易云音乐 → QQ音乐 → 酷我音乐 → 酷狗音乐。
 *
 * 搜索平台行只在这 4 个里出现。
 * JOOX / 波点不出现在搜索平台行 —— 它们只在歌单来源下拉里可选。
 * 上游没有「全部」聚合页签，所以这里也不提供。 */
export type SearchSource = Exclude<MusicProvider, 'bodian' | 'joox'>;
export const providerOrder: SearchSource[] = ['netease', 'qq', 'kuwo', 'kugou'];
export const searchSourceNames: Record<SearchSource, string> = {
  netease: '网易云音乐', qq: 'QQ音乐', kuwo: '酷我音乐', kugou: '酷狗音乐',
};
/** 每页固定 20 条。 */
export const SEARCH_PAGE_SIZE = 20;

export interface SearchRow {
  key: string;
  track: MusicTrack;
  variants: MusicTrack[];
  variantsLoaded: boolean;
}
export interface SearchOutcome {
  rows: SearchRow[];
  total: number;
  hasMore: boolean;
  sources: number;
 /** Provider failures joined for the status line; empty when every source answered. */
  failure: string;
}

export const normKey = (track: MusicTrack) =>
  `${track.title}|${track.artist}`.toLowerCase().replace(/[\s\u3000·・\-,.'"“”‘’()（）[\]]/g, '');
export const rowKey = (track: MusicTrack) => `${track.onlineSource!.provider}_${track.onlineSource!.id}`;

/** 版本词表 (落了白 案例): rendition descriptors stripped for base-name matching. */
const VERSION_WORDS = ['降调', '减速', '加速', '升调', '变调', '翻唱', 'cover', 'remix', 'dj', 'live', 'demo', '伴奏', '纯音乐', '铃声', '弹唱', '对唱', '合唱', '男声', '女声', '烟嗓', '戏腔', '氛围', '治愈', '抒情', '电音', '节奏', '弹跳', '卡点', '片段', '高潮', '剪辑', '抖音', '宿命', '完整版'];
const SYMBOLS = /[\s\u3000·・\-,.'"“”‘’()（）[\]]/g;
export interface SongParts { base: string; versions: string[] }
/**
 *
 * 真实翻车现场（用户实测《酒醉的蝴蝶》只放得出 60 秒试听）：
 *
 * 酷狗返回的曲目 title = "崔伟立 - 酒醉的蝴蝶" artist = "崔伟立"
 * 酷我返回的曲目 title = "酒醉的蝴蝶" artist = "崔伟立"
 *
 * 这首歌在酷我/网易云/QQ 上**都有全曲**（酷我甚至是 flac 无损），可我方
 * `matchSong` 拿 `titleParts(wanted.title)` 算 base，得到的是
 * `"崔伟立 - 酒醉的蝴蝶"`（只去了空白和标点，`-` 也在 SYMBOLS 里被删，
 * 于是变成 `"崔伟立酒醉的蝴蝶"`），而候选的 base 是 `"酒醉的蝴蝶"`
 * —— 两者永远不相等，`matchSong` 一律返回 null。
 *
 * 后果不是"少一个候选"，而是 `gatherCandidates` 一条候选都收不到 →
 * `findPlayableVariant`/`findFallbackTrack` 全部返回 null → 前端只能播
 * 酷狗那份试听片段，或干脆报"放不出来"。用户看到的就是"明明有别的音源，
 * 却只给我 60 秒"。
 *
 * 修法：剥掉标题开头「<某段> - 」形态的演唱者前缀。只在**开头**剥、且要求
 * 分隔符两侧都有内容，避免误伤「酒醉的蝴蝶 - Live」这类真·歌名片段。
 * 前缀段还必须出现在 artist 里（或本身够短），否则不剥 —— 防止把
 * 「周杰伦的床边故事」这种歌名本身当前缀切掉。
 */
const ARTIST_SEPARATOR = /(?:\s+[-–—]\s*|\s*[-–—]\s+)/
/** 剥掉标题首尾的歌手名。**首尾都要剥**，不只是开头。
 *
 * 《雨爱》的真实翻车现场：
 *
 * 酷狗 title = "杨丞琳 - 雨爱 - 杨丞琳" artist = "杨丞琳"
 * 网易云 title = "雨爱" artist = "杨丞琳"
 *
 * 旧实现只剥开头那一段，于是 base 算成 `"雨爱杨丞琳"`（尾巴那个歌手名
 * 跟着粘上了），跟网易云的 `"雨爱"` 依然对不上，`matchSong` 还是 null，
 * 跨源兜底再次失明 —— 日志里就是「酷狗失败 3712ms，6 秒后网易云才算成功」，
 * 但那次成功是用户重新搜索得来的，不是兜底换来的。
 *
 * 所以现在首尾各剥一次，最多两轮（覆盖「歌手 - 歌名 - 歌手」这种首尾重复）。
 * 每次都要求：被剥掉的那段确实是歌手名、且剥完还得剩下非版本词的内容。
 */
function stripArtistPrefix(title: string, artist: string): string {
  let text = title.trim()
  const members = artistMembers(artist)
  const isArtist = (segment: string) => {
    const key = segment.trim().toLowerCase().replace(SYMBOLS, '')
    if (!key) return false
    return members.some((name) => name === key || key.includes(name) || name.includes(key))
  }
 /** 剥完只剩版本词就没有意义了（`崔伟立 - Live`），那种情况不剥。 */
  const hasRealTitle = (segment: string) => {
    let probe = segment.toLowerCase().replace(SYMBOLS, '')
    for (const word of VERSION_WORDS) probe = probe.split(word).join('')
    return !!probe.replace(/版$/, '')
  }
  for (let round = 0; round < 2; round += 1) {
    let changed = false
    const head = ARTIST_SEPARATOR.exec(text)
    if (head) {
      const rest = text.slice(head.index + head[0].length)
      if (rest.trim() && hasRealTitle(rest) && isArtist(text.slice(0, head.index))) {
        text = rest
        changed = true
      }
    }
    const tail = new RegExp('^(.*?)' + ARTIST_SEPARATOR.source + '(.+)$').exec(text)
    if (tail) {
      const headPart = tail[1]
      if (headPart.trim() && hasRealTitle(headPart) && isArtist(tail[2])) {
        text = headPart
        changed = true
      }
    }
    if (!changed) break
  }
  return text
}
/** Split a title into its base name and its rendition descriptors. */
export function titleParts(title: string, artist = ''): SongParts {
  const cleaned = stripArtistPrefix(title, artist)
  const versions: string[] = []
 /**
 *
 * 真实翻车现场（用户 实测，一首都放不出来）：
 *
 * 酷狗 "蔡萝莉 - 霍元甲 (琵琶版) - 蔡萝莉" → base 曾算成 "霍元甲琵琶"
 * 酷狗 "崔伟立 - 酒醉的蝴蝶 (Remix)(DJ何鹏版) - 崔伟立" → base 曾算成 "酒醉的蝴蝶何鹏"
 * 酷狗 "任贤齐 - 天涯 (《笑傲江湖》电视剧片尾曲) - 任贤齐" → base 曾算成 "天涯《笑傲江湖》…"
 *
 * 原因是 SYMBOLS 把括号当普通标点**删掉**，副标题于是被拼进歌名，
 * 跟别的平台的干净歌名（`霍元甲` / `酒醉的蝴蝶` / `天涯`）永远对不上。
 *
 * 括号里的内容分两种，处理方式不同：
 * · 版本描述（琵琶版/DJ版/Remix/纯音乐）→ 提取成 version 标记，正文丢弃
 * · 说明性文字（影视剧原声说明、原曲出处）→ 直接丢弃，不参与匹配
 * 两种都从 base 里拿掉，base 只留真正的歌名。
 */
  const bracket = /[(（[【]([^)）\]】]*)[)）\]】]/g
  let stripped = cleaned.replace(bracket, (_whole, inner: string) => {
    const text = inner.toLowerCase()
    for (const word of VERSION_WORDS) {
      if (text.includes(word)) { versions.push(word); break }
    }
    return ''
  })
  let text = stripped.toLowerCase().replace(SYMBOLS, '')
  for (const word of VERSION_WORDS) {
    if (!text.includes(word)) continue
    if (!versions.includes(word)) versions.push(word)
    text = text.split(word).join('')
  }
  return { base: text.replace(/版$/, ''), versions }
}
/** Multi-artist lists (「甲 / 乙」) match by member, like other open-source players do. */
export function artistMembers(artist: string): string[] {
  return artist.toLowerCase().split(/\s*[\/、,，&]\s*/).map(name => name.replace(SYMBOLS, '')).filter(Boolean);
}
export interface SongMatch { level: 1 | 2 | 3; sameVersion: boolean; versionless: boolean; durationDelta?: number }
/**
 *
 * 用户实测：酷狗搜《可能》，点第一个（程响，3:38 原唱），放出来却是 DJ 版。
 *
 * 原因不是匹配错，而是**同名版本在标题上完全无法区分**：
 *
 * 酷狗 1. 可能 - 程响 217 秒 ← 用户点的原唱
 * 酷狗 2. 可能 (DJ翊轩版) - 程响 213 秒
 * 酷狗 4. 可能 (DJ阿卓、DJ阿龙版) - 程响 167 秒
 *
 * 酷我 1. 可能 - 程响 217 秒
 * 酷我 2. 可能 - 程响 213 秒 ← 标题里没有 DJ 字样！
 * 酷我 4. 可能 - 程响 167 秒 ← 同样的歌名
 *
 * 酷我把 DJ 版的标题也写成了「可能」，三个版本 base 完全相同，
 * `matchSong` 一律判 level=1 rank=0，排序时无法区分谁是谁，
 * 于是跨源换到了同名但不同版本的音频 —— 用户听到的就是串歌。
 *
 * 唯一可靠的判别信号是**时长**：原唱 217 秒，DJ 版 213/167 秒。
 * 所以这里在匹配结果里带出时长差，排序时优先选时长接近的。
 *
 * 容差取 5 秒：
 * · 太严（≤1 秒）会让正常的不同编码版本互相排斥（同一首歌不同平台
 * 常有 1~3 秒的前后静音差），反而找不到候选；
 * · 太松（>10 秒）就分不开 217 和 213 这种只差 4 秒的 DJ 版。
 */
const DURATION_TOLERANCE_SECONDS = 5;

/** 时长差（**秒**）。任一方缺时长就返回 NaN —— 表示「无法判断」，不当成吻合。
 *
 * ⚠️ `duration` 字段的单位是**秒**（实测 API 返回 `217` 表示 3 分 37 秒），
 * 不是毫秒。第一版按毫秒写，导致 217 vs 213 只差 4「毫秒」，永远在容差内，
 * 时长兜底完全没生效 —— 修的时候差点又被这个坑过去。
 */
function durationDelta(candidate: MusicTrack, wanted: MusicTrack): number {
  const a = Number(candidate.duration) || 0;
  const b = Number(wanted.duration) || 0;
  if (!a || !b) return Number.NaN;
  return Math.abs(a - b);
}

export function matchSong(candidate: MusicTrack, wanted: MusicTrack): SongMatch | null {
  const delta = durationDelta(candidate, wanted);
  if (normKey(candidate) === normKey(wanted)) return { level: 1, sameVersion: true, versionless: true, durationDelta: delta };
 // artist 必须传进去：部分平台的标题自带「歌手 - 」前缀（酷狗就是），
 // 不剥掉的话 base 永远对不上，跨源匹配会全盘失效（详见 titleParts 注释）。
  const wantedParts = titleParts(wanted.title, wanted.artist);
  const wantedArtists = artistMembers(wanted.artist);
  const sameArtist = (artist: string) => artistMembers(artist).some(member => wantedArtists.includes(member));
  const sharesVersion = (versions: string[]) => versions.some(word => wantedParts.versions.includes(word));
  const parts = titleParts(candidate.title, candidate.artist);
  if (sameArtist(candidate.artist) && parts.base && parts.base === wantedParts.base) {
    return { level: 2, sameVersion: sharesVersion(parts.versions), versionless: !parts.versions.length, durationDelta: delta };
  }
  const aliases = (candidate.onlineSource?.aliases ?? []).map(alias => titleParts(alias, candidate.artist));
  if (sameArtist(candidate.artist) && aliases.some(alias => alias.base && alias.base === wantedParts.base)) {
    return { level: 3, sameVersion: aliases.some(alias => sharesVersion(alias.versions)), versionless: false, durationDelta: delta };
  }
  return null;
}
/** Lower is better: exact → same-version rendition → plain original → other
 * rendition → alias forms.
 *
 * 时长差超过容差要**重罚**：标题判不出来是哪个版本时，时长是最后的依据。
 * 加重罚（+10）而不是直接判 null，是为了在只有错版本可用时仍能播放，
 * 只是排在所有时长吻合的候选之后。
 */
const DURATION_PENALTY = 10;
export function matchRank(match: SongMatch): number {
  const base = match.level === 1 ? 0
    : match.level === 2 ? (match.sameVersion ? 1 : match.versionless ? 2 : 3)
      : (match.sameVersion ? 4 : 5);
  const delta = match.durationDelta;
 // ⚠️ NaN 的比较结果恒为 false —— 直接写 `delta > 容差` 会让「缺时长」的候选
 // 被当成吻合，和真原唱并列第一。必须显式排除。
  const off = delta === undefined || Number.isNaN(delta) ? 0
    : delta > DURATION_TOLERANCE_SECONDS ? DURATION_PENALTY : 0;
  return base + off;
}

/** One row per distinct song; later sources become switchable variants. */
export function mergeRows(tracks: MusicTrack[], variantsLoaded: boolean): SearchRow[] {
  const rows: SearchRow[] = [], byKey = new Map<string, SearchRow>();
  for (const track of tracks) {
    const key = normKey(track);
    const existing = byKey.get(key);
    if (existing) existing.variants.push(track);
    else {
      const row: SearchRow = { key: rowKey(track), track, variants: [], variantsLoaded };
      byKey.set(key, row); rows.push(row);
    }
  }
  return rows;
}

type Fetcher = typeof fetchOnline;

async function fetchSource(provider: MusicProvider, query: string, offset: number, signal: AbortSignal, fetcher: Fetcher): Promise<SearchOutcome> {
  const response = await fetcher(provider, 'search', `/api/online/${provider}/search?q=${encodeURIComponent(query)}&offset=${offset}`, { signal });
  const value = await response.json() as OnlineSearchResults & { error?: string };
  if (!response.ok) throw new Error(value.error || `${musicPlatforms[provider]}搜索暂时不可用。`);
  if (value.provider !== provider) throw new Error('搜索平台已变化，请重新搜索。');
  return { rows: mergeRows(value.tracks, true), total: value.total, hasMore: value.hasMore, sources: 1, failure: '' };
}

/** Single-platform search, provider 原序（上游行为）。
 * 上游前端一次只向**一个**平台要数据（`search_songs(keyword,source,page,pageSize)`），
 * 拿到什么顺序就显示什么顺序 —— 它不做跨平台聚合，也不重新排序。
 * 我们照做：不再有「全部」聚合，也就没有聚合去重那一步。 */
export async function searchOnline(query: string, source: SearchSource, offset: number, signal: AbortSignal, fetcher: Fetcher = fetchOnline): Promise<SearchOutcome> {
  return fetchSource(source, query, offset, signal, fetcher);
}

/** Cross-provider lookup so 单曲换源 also works on single-source tabs. */
export async function lookupVariants(track: MusicTrack, signal?: AbortSignal, fetcher: Fetcher = fetchOnline): Promise<MusicTrack[]> {
  const others = providerOrder.filter(provider => provider !== track.onlineSource!.provider);
  const found = await Promise.all(others.map(async provider => {
    try {
      const response = await fetcher(provider, 'search', `/api/online/${provider}/search?q=${encodeURIComponent(track.title)}&offset=0`, signal ? { signal } : undefined);
      const value = await response.json() as OnlineSearchResults & { error?: string };
      if (!response.ok) return [];
      return value.tracks.filter(variant => !!matchSong(variant, track));
    } catch { return []; }
  }));
  return found.flat();
}
