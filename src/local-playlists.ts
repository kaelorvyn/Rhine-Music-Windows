// 本地歌单的前端客户端（对照参考行为本地歌单能力）。
//
// 上游把本地歌单和平台歌单放在**同一个**歌单视图里，只多一个「本地」来源
// （playlist.platform.local = 上游）。所以这里不另建视图，而是把本地歌单
// 规范化成和平台歌单一样的一行，交给现有的聚合视图去展示。
//
// 关键点：本地歌单里的歌是**元数据快照**，不是可播放的 MusicTrack —— 播放时
// 需要按 provider + onlineSourceId 重新走平台的 prepare 取址。这样做是为了
// 让歌单在登录态变化、平台换 hash 之后依然能放出来。
import type { MusicTrack } from './music-types';
import { qualityTierOf, qualityTierWeight, type QualityTier } from './quality-tier';

/** 歌单来源：平台 id 或本地伪来源。 */
export type PlaylistSource = import('./music-platform').MusicProvider | 'local';

/** 与后端 local-playlists.mjs 的 summary() 对齐。 */
export interface LocalPlaylistSummary {
  id: string;
  name: string;
  count: number;
  favorites: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 与后端 normalizeSong() 对齐的曲目快照。 */
export interface LocalSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  provider: string;
  onlineSourceId: string;
  addedAt: number;
  playCount: number;
  duration?: number;
  qualityRank?: number;
}

/** 排序规则（对齐上游 playlist.sort.*）。 */
export const localSortKeys = {
  default: '默认排序',
  addedAt: '按添加时间',
  artist: '按艺术家',
  playCount: '按播放次数',
  name: '按名称',
  platform: '按平台',
  quality: '按最高音质',
} as const;
export type LocalSortKey = keyof typeof localSortKeys;

/** 音质档位 → 排序权重（按最高音质用），与 quality-tier.ts 的 7 级权重同源。 */
const tierRank: Record<QualityTier, number> = qualityTierWeight;

/** 把一首快照变成可展示的 MusicTrack（**不含** audioUrl，播放时再取址）。 */
export function localSongToTrack(song: LocalSong): MusicTrack {
  const provider = song.provider as import('./music-platform').MusicProvider;
  return {
    id: song.id,
    albumId: `local-${song.album || 'unknown'}`,
    title: song.title || '未知歌曲',
    artist: song.artist || '未知艺术家',
    duration: song.duration ?? 0,
    format: '在线',
    browserPlayable: true,
    audioUrl: '',
    relativePath: '',
    onlineSource: {
      provider,
      id: song.onlineSourceId || song.id,
      albumTitle: song.album || '',
      pageUrl: '',
 // 付费/试听状态不参与展示（用户要求不标注），但仍要传下去：
 // 播放器据此决定是否去找全曲。
      fee: 0,
    },
  };
}

/** 从曲目算音质权重，供「按最高音质」排序。 */
export function qualityRankOf(track: MusicTrack): number {
  return tierRank[qualityTierOf(track)] ?? 0;
}

/** 把要写进本地歌单的曲目压成快照。 */
export function trackToLocalSong(track: MusicTrack): LocalSong {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.onlineSource?.albumTitle ?? '',
    provider: track.onlineSource?.provider ?? 'netease',
    onlineSourceId: track.onlineSource?.id ?? '',
    addedAt: Date.now(),
    playCount: 0,
    ...(track.duration ? { duration: track.duration } : {}),
    qualityRank: qualityRankOf(track),
  };
}

const base = '/api/playlists';
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body?.error || '本地歌单操作失败。');
  return body;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** 本地歌单读写。视图只读它，写操作由歌单面板的动作触发。 */
export class LocalPlaylists {
  private cache: LocalPlaylistSummary[] | null = null;

  async list(force = false): Promise<LocalPlaylistSummary[]> {
    if (this.cache && !force) return this.cache;
    const body = await request<{ playlists: LocalPlaylistSummary[] }>(`${base}/local`);
    this.cache = body.playlists ?? [];
    return this.cache;
  }

  async create(name: string) {
    const body = await request<{ playlist: { id: string; name: string } }>(`${base}/local`, json('POST', { name }));
    this.cache = null;
    return body.playlist;
  }

  async rename(id: string, name: string) {
    const body = await request<{ playlist: { id: string; name: string } }>(`${base}/local/${encodeURIComponent(id)}`, json('PATCH', { name }));
    this.cache = null;
    return body.playlist;
  }

  async remove(id: string) {
    await request(`${base}/local/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.cache = null;
  }

 /** 取曲目；排序在服务端做，保证与磁盘上的手工次序解耦。 */
  async songs(id: string, options: { offset?: number; limit?: number; sort?: LocalSortKey; direction?: 'ascending' | 'descending' } = {}) {
    const query = new URLSearchParams({
      offset: String(options.offset ?? 0),
      limit: String(options.limit ?? 500),
      sort: options.sort ?? 'default',
      direction: options.direction ?? 'ascending',
    });
    return request<{ tracks: LocalSong[]; total: number }>(`${base}/local/${encodeURIComponent(id)}?${query}`);
  }

  async addSongs(id: string, tracks: MusicTrack[]) {
    const body = await request<{ added: number; skipped: number; total: number; allExist: boolean }>(
      `${base}/local/${encodeURIComponent(id)}/songs`, json('POST', { songs: tracks.map(trackToLocalSong) }));
    this.cache = null;
    return body;
  }

  async removeSongs(id: string, ids: string[]) {
    const body = await request<{ removed: number; total: number }>(
      `${base}/local/${encodeURIComponent(id)}/songs`, json('DELETE', { ids }));
    this.cache = null;
    return body;
  }

  async reorder(id: string, ids: string[]) {
    await request(`${base}/local/${encodeURIComponent(id)}/order`, json('POST', { ids }));
    this.cache = null;
  }

  async countPlay(id: string, songId: string) {
    await request(`${base}/local/${encodeURIComponent(id)}/play`, json('POST', { songId })).catch(() => {});
  }

  async favorite(track: MusicTrack) {
    const body = await request<{ favorited: boolean; existed: boolean; total: number }>(
      `${base}/favorites`, json('POST', { song: trackToLocalSong(track) }));
    this.cache = null;
    return body;
  }

  async unfavorite(songId: string) {
    const body = await request<{ favorited: boolean; removed: number; total: number }>(
      `${base}/favorites/${encodeURIComponent(songId)}`, { method: 'DELETE' });
    this.cache = null;
    return body;
  }

 /** 收藏状态：从收藏歌单的曲目里查（收藏曲目通常不多，一次取回即可）。 */
  async favorites(): Promise<LocalSong[]> {
    const { tracks } = await this.songs('favorites');
    return tracks;
  }

  async isFavorite(songId: string) {
    return (await this.favorites()).some(song => song.id === songId);
  }

 /** 视图缓存失效：本地改动后让聚合视图重新拉一次。 */
  invalidate() { this.cache = null; }
}
