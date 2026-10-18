import type { MusicTrack, PlayMode } from './music-types.ts';

/** One temporary queue (临时歌单) with its cycle modes. Queue order is the
 * stored play order; shuffle lives inside the player as a bag of indexes.
 *
 * 对齐上游的 5 种播放模式（既有实现）：
 * sequential 顺序播放 → order
 * repeatAll 循环播放 → loop
 * repeatOne 单曲循环 → repeat-one
 * shuffleQueue 随机队列 → shuffle （bag 洗牌，不重复）
 * shuffle 真随机 → shuffle-all （可重复，可连中同一首） */
export const playModes: readonly PlayMode[] = ['order', 'loop', 'repeat-one', 'shuffle', 'shuffle-all'];
export const playModeNames: Record<PlayMode, string> = {
  order: '顺序播放',
  loop: '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
  'shuffle-all': '真随机',
};
export function nextPlayMode(mode: PlayMode): PlayMode {
  return playModes[(playModes.indexOf(mode) + 1) % playModes.length];
}
export function isPlayMode(value: unknown): value is PlayMode {
  return typeof value === 'string' && (playModes as readonly string[]).includes(value);
}

const storageKey = 'rhine-music-playback';
export interface SavedPlayback { mode: PlayMode; tracks: MusicTrack[] }
export function loadSavedPlayback(): SavedPlayback | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedPlayback>;
    if (!isPlayMode(parsed.mode) || !Array.isArray(parsed.tracks)) return null;
    const tracks = parsed.tracks.filter((track): track is MusicTrack =>
      !!track && typeof track.id === 'string' && typeof track.title === 'string' && typeof track.audioUrl === 'string');
    return { mode: parsed.mode, tracks };
  } catch { return null; }
}
export function saveSavedPlayback(value: SavedPlayback): void {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
}
