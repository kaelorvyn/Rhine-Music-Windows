import { parseWordLyrics, validWords, type WordLine, type Word } from "../scripts/word-lyrics.mjs";
export interface LyricLine { time: number; text: string; translation?: string; words?: Word[] }

/** Standard LRC: multiple timestamps, decimal precision, offsets and untimed text. */
export function parseLyrics(source: string, translated = '', wordLines?: WordLine[]): LyricLine[] {
  const parse = (input: string) => {
    const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(input)?.[1] || 0) / 1000;
    const result: LyricLine[] = [];
    for (const raw of input.slice(0, 200000).split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      if (!text) continue;
      for (const stamp of stamps) {
        const time = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || 0}`) - offset;
        if (Number(stamp[2]) < 60 && Number.isFinite(time)) result.push({ time: Math.max(0, Math.round(time * 1000) / 1000), text });
      }
      if (result.length >= 4000) break;
    }
    return result.sort((a, b) => a.time - b.time).slice(0, 4000);
  };
  const raw = parseWordLyrics(source);
  const lines = raw.length ? raw : parse(source), translations = parse(translated);
  const timed = new Map((Array.isArray(wordLines) ? wordLines : raw).slice(0, 4000).filter(line => line && typeof line.text === "string" && Number.isFinite(line.time)).map(line => [Math.round(line.time * 1000), line]));
  const byTime = new Map(translations.map(line => [Math.round(line.time * 100), line.text]));
  return lines.map(line => {
    const candidate = timed.get(Math.round(line.time * 1000));
    return { ...line, ...(candidate && validWords(line.text, candidate.words, line.time) ? { words: candidate.words } : {}), translation: byTime.get(Math.round(line.time * 100)) };
  });
}

export function lyricIndex(lines: readonly LyricLine[], time: number) {
  let left = 0, right = lines.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (lines[middle].time <= time) left = middle + 1; else right = middle;
  }
  return left - 1;
}

export function untimedLyrics(source: string) {
  return source.slice(0, 200000).split(/\r?\n/).filter(line => !/^\[(?:ar|ti|al|by|offset|re|ve):/i.test(line))
    .map(line => line.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean).slice(0, 4000).join('\n');
}

/** Cross-source lyrics backfill: /api/lyrics matches 歌名+歌手+时长 across
 * providers when the song's own source has no usable lyrics (missing /
 * unavailable / error). Returns the fill on success, or null when nothing
 * usable was found so the caller keeps its honest "暂无歌词". Injectable
 * fetcher keeps the contract unit-testable. */
export async function backfillLyrics(
  track: { title: string; artist: string; duration: number; onlineSource?: { provider: string; id: string } },
  fetcher: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (url) => fetch(url),
): Promise<{ original: string; translated: string; instrumental: boolean; unavailable: boolean; wordLines?: WordLine[] } | null> {
  const query = new URLSearchParams({ title: track.title, artist: track.artist, duration: String(Math.round(track.duration) || 0) });
  const source = track.onlineSource;
  if (source) { query.set('provider', source.provider); query.set('id', source.id); }
  try {
    const response = await fetcher(`/api/lyrics?${query}`);
    if (!response.ok) return null;
    const value = await response.json() as { original?: string; translated?: string; instrumental?: boolean; wordLines?: WordLine[] } | null;
    if (value?.instrumental) return { original: '', translated: '', instrumental: true, unavailable: false };
    if (value?.original) return { ...(Array.isArray(value.wordLines) ? { wordLines: value.wordLines } : {}), original: value.original, translated: value.translated || '', instrumental: false, unavailable: false };
    return null;
  } catch { return null; }
}
