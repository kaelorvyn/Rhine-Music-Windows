import { musicPlatforms } from './music-platform.ts';
import type { MusicAlbum, MusicTrack } from './music-types';
/** Each song owns a display slot, including consecutive songs on one album. */
export function playbackAlbums(queue: readonly MusicTrack[], library: readonly MusicAlbum[]) {
  const local = new Map(library.map(album => [album.id, album]));
  return queue.map(track => {
    const source = track.onlineSource, original = local.get(track.albumId);
    let coverUrl = source?.coverUrl || original?.coverUrl;
    if (source?.provider === "netease" && coverUrl) { const url = new URL(coverUrl); url.searchParams.set('param', '512y512'); coverUrl = url.href; }
 // 每张卡片 = 一首歌：主标题是歌名，专辑名降为次要信息（用户报的「倒反天罡」：
 // 以前 title 优先取 albumTitle，搜《青花瓷》详情页大标题却是《我很忙》）。
    const albumName = source?.albumTitle || original?.title || '';
    return { ...original, id: `playback-${track.id}`, title: track.title || albumName,
      artist: original?.artist || track.artist, genreId: 'playback', rawGenres: source ? [musicPlatforms[source.provider]] : original?.rawGenres || [],
      folder: source ? `${musicPlatforms[source.provider]} · 当前播放队列` : original?.folder || '', coverUrl, tracks: [track], producers: original?.producers || [],
      offline: original?.offline || false, online: source ? { status: 'matched' as const, sourceUrl: source.pageUrl } : original?.online,
      playback: { trackId: track.id, albumId: track.albumId, songTitle: track.title, albumTitle: albumName } } satisfies MusicAlbum;
  });
}
