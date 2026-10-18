import type { MusicTrack, OnlineSearchResults } from './music-types.ts';
import type { MusicProvider } from './music-platform.ts';
import { fetchOnline } from './online-debug.ts';
import { matchRank, matchSong, normKey, titleParts, type SongMatch } from './online-search-core.ts';
import { qualityTierOf, qualityTierWeight } from './quality-tier.ts';

/** Same song across sources: normalised title|artist (exported so fallback
 * guards key on the song, not on one source's variant id). The implementation
 * lives in online-search-core now — re-exported here so imports keep working. */
export { normKey };

/** 智能切换的来源优先级：可开关、可排序的换源查找顺序。 */
export interface SourcePriority {
 /** lookup order; providers missing here fall back to DEFAULT_SOURCE_PRIORITY */
  order: MusicProvider[];
 /** disabled providers are never queried during fallback */
  disabled: MusicProvider[];
}

/** 换源查找顺序 —— 换源查找顺序：
 * 酷我音乐 → 网易云音乐 → QQ音乐 → 酷狗音乐 → 波点音乐 → JOOX → 汽水音乐
 * 按用户要求去掉波点、汽水（波点搜索页也已移除，汽水本就没接），其余保持
 * 上游的原始次序。 */
export const DEFAULT_SOURCE_PRIORITY: MusicProvider[] = ['kuwo', 'netease', 'qq', 'kugou', 'joox'];

export const defaultSourcePriority = (): SourcePriority => ({
  order: [...DEFAULT_SOURCE_PRIORITY], disabled: [],
});

/** Resolve the effective fallback lookup order: user order first, then the
 * remaining defaults; disabled and excluded (usually the failed source) drop. */
export function resolveLookupOrder(
  priority: SourcePriority | null | undefined,
  available: MusicProvider[],
  exclude?: MusicProvider,
): MusicProvider[] {
  const order = priority?.order?.length ? priority.order : DEFAULT_SOURCE_PRIORITY;
  const disabled = new Set(priority?.disabled ?? []);
  const seen = new Set<string>();
  const resolved: MusicProvider[] = [];
  for (const provider of [...order, ...DEFAULT_SOURCE_PRIORITY]) {
    if (provider === exclude || disabled.has(provider) || !available.includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    resolved.push(provider);
  }
  return resolved;
}

interface Candidate { track: MusicTrack; match: SongMatch; providerIndex: number }

/** 落了白 案例 · 跨源候选池: L1 exact → L2 base name (version words stripped)
 * → L3 alias matching in one place. Ranked so same-version renditions beat
 * plain originals beat other renditions; search-level fee=0 is a tiebreaker
 * only — prepare-level evidence decides playability. */
async function gatherCandidates(track: MusicTrack, providers: MusicProvider[], signal?: AbortSignal): Promise<Candidate[]> {
  const found: Candidate[] = [];
 /**
 *
 * 这里原来直接拿 `track.title` 去别的平台搜。但有些平台返回的标题是脏的：
 *
 * 酷狗 "蔡萝莉 - 霍元甲 (琵琶版) - 蔡萝莉"
 * 酷狗 "崔伟立 - 酒醉的蝴蝶 (Remix)(DJ何鹏版) - 崔伟立"
 *
 * 拿这串去网易云搜，返回的都是些不相干的翻唱，`matchSong` 一条也认不出，
 * 候选仍然是 0。必须用剥干净的歌名去搜。
 *
 * 优先用 `titleParts().base`（歌名主干）；剥空了就退回原题，别把搜索搞坏。
 * 命中判定仍用完整 `track` 走 `matchSong`，语义没变。
 */
  const wantedBase = titleParts(track.title, track.artist).base
  const query = wantedBase || track.title
  for (const [providerIndex, provider] of providers.entries()) {
    if (signal?.aborted) return found;
    try {
      const response = await fetchOnline(provider, 'search',
        `/api/online/${provider}/search?q=${encodeURIComponent(query)}&offset=0`, { signal });
      const value = await response.json() as OnlineSearchResults;
      if (!response.ok || value.provider !== provider) continue;
      for (const candidate of value.tracks) {
        const match = matchSong(candidate, track);
        if (match) found.push({ track: candidate, match, providerIndex });
      }
    } catch { /* an unreachable source just moves to the next one */ }
  }
 //
 //
 // 用户的原话是「能把歌完整的放出来优先，其次音质从高到低」。旧排序只有
 // 「匹配度 → 是否免费 → 平台顺序」，**音质完全没参与**：同一首歌在酷我是
 // flac 无损、在 QQ 是 mflac、在网易是 MP3，旧逻辑会按平台顺序先试 QQ，
 // 拿到 mflac 就收工，用户拿不到本该拿到的无损。
 //
 // 新排序（逐级 tie-break，越靠前越优先）：
 // ① 匹配度 —— 同版本 > 无版本词 > 其他版本 > 别名
 // ② 免费 —— fee=0 优先（fee>0 往往只给试听，见 findPlayableVariant）
 // ③ **音质** —— qualityTierWeight 降序（母带 > 环绕 > HiFi > HiRes > 无损 > 高品 > 标准）
 // ④ 平台顺序 —— 上游的既有优先级（酷我 → 网易 → QQ → 酷狗 …）
 //
 // ②在③之前是刻意的：一首 fee=1 的母带常常只发 60 秒试听，而 fee=0 的
 // 无损能整首放完。「完整放出来」是用户的第一诉求，压过音质。
 //
 // 同名不同版本在标题上可能完全一样 ——
 // 酷我把「可能」的 DJ 版也写成「可能」，matchRank 三者都是 0，分不出谁是谁。
 // 唯一可靠信号是时长：原唱 217 秒、DJ 版 213/167 秒。时长差小的排前面，
 // 避免「点原唱却放成 DJ 版」（用户实测的串歌）。
 //
 // NaN 表示缺时长（无法判断），排在「明确吻合」之后、「明确不吻合」之前。
  const deltaOf = (m: { durationDelta?: number }) => {
    const d = m.durationDelta;
    return d === undefined || Number.isNaN(d) ? Number.POSITIVE_INFINITY : d;
  };
  found.sort((a, b) => matchRank(a.match) - matchRank(b.match)
    || deltaOf(a.match) - deltaOf(b.match)
    || Number(!!a.track.onlineSource?.fee) - Number(!!b.track.onlineSource?.fee)
    || qualityTierWeight[qualityTierOf(b.track)] - qualityTierWeight[qualityTierOf(a.track)]
    || a.providerIndex - b.providerIndex);
  return found;
}

/** VIP / 版权换源兜底: after one source refuses playback or serves only a
 * trial fragment, look the same song up on the other providers in lookup
 * order. A free (fee=0) match wins immediately anywhere in that order; only
 * when no free match exists does the first fee>0 match get returned. */
export async function findFallbackTrack(
  track: MusicTrack,
  providers: MusicProvider[],
  signal?: AbortSignal,
): Promise<MusicTrack | null> {
  const found = await gatherCandidates(track, providers, signal);
  let paidMatch: MusicTrack | null = null;
  for (const { track: candidate } of found) {
    if (signal?.aborted) return null;
    if (!candidate.onlineSource?.fee) return candidate;
    if (!paidMatch) paidMatch = candidate;
  }
  return paidMatch;
}

/** 试听根治 · 预备式全曲解析: before any audio starts, look the same song up on
 * the other providers in lookup order and verify at prepare level — search-level
 * fee=0 alone is not proof, a "free" row can still serve a trial clip, and
 * VIP-marked rows on some platforms serve full tracks. Every ranked candidate
 * gets its prepare turn; the first one whose prepare yields a real audioUrl
 * with no trial fragment wins. Null means every match is trial-only and the
 * fragment may play, honestly labelled.
 *
 * 备用音源模块的兜底时机：平台 prepare 拿不到全曲时，还要再问
 * 一次备用音源（/api/backup/resolve），而不是就此放弃。少了这一步，平台只给
 * 试听片段的歌就永远放不出全曲 —— 这是「有些歌放不了」的直接原因。 */
export async function findPlayableVariant(
  track: MusicTrack,
  providers: MusicProvider[],
  signal?: AbortSignal,
): Promise<MusicTrack | null> {
  const found = await gatherCandidates(track, providers, signal);
  for (const { track: candidate } of found) {
    if (signal?.aborted) return null;
    if (!candidate.onlineSource) continue;
    const provider = candidate.onlineSource.provider;
    try {
 // ① 平台 prepare：能直接给全曲就赢。
      const prepared = await fetchOnline(provider, 'playback',
        `/api/online/${provider}/prepare/${encodeURIComponent(candidate.onlineSource.id)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
      const result = await prepared.json().catch(() => null) as
        { audioUrl?: string; trial?: { start: number; end: number } } | null;
      if (prepared.ok && result?.audioUrl && !result.trial) return candidate;
 // ② 平台只给试听/拒绝时，问上游的备用音源要全曲。
      const rescued = await fetch('/api/backup/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          provider, songId: candidate.onlineSource.id,
          quality: '320k', title: candidate.title, artist: candidate.artist,
        }),
      }).then(async response => response.ok ? await response.json().catch(() => null) : null)
        .catch(() => null) as { audioUrl?: string; trial?: unknown } | null;
      if (rescued?.audioUrl && !rescued.trial) {
 // 备用音源给出全曲：把地址挂到 onlineSource.rescuedUrl，播放器会直接用它，
 // 不再走平台 prepare（否则只会再拿一次试听片段）。
        return {
          ...candidate,
          onlineSource: { ...candidate.onlineSource, fee: 0, rescuedUrl: rescued.audioUrl },
        };
      }
    } catch { /* the next ranked candidate gets its turn */ }
  }
  return null;
}
