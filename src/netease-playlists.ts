import type { MusicAlbum, MusicTrack, NeteasePlaylist } from './music-types';
import { playbackAlbums } from './playback-albums.ts';
import { wrap } from './archive-loop.ts';
import { playlistSourceName, type MusicProvider, type PlaylistSource } from './music-platform.ts';
import { fetchOnline } from './online-debug.ts';
import { localSongToTrack, type LocalPlaylistSummary, type LocalSong, type LocalSortKey } from './local-playlists.ts';
/** One account playlist row tagged with its platform, so several platforms can
 * share one aggregated browse view (歌单平台选择器：全部 / 单平台 / 本地). */
export type PlaylistEntry = NeteasePlaylist & { provider: PlaylistSource; favorites?: boolean };
export class NeteasePlaylists {
  playlists: PlaylistEntry[] = [];
  loading = false;
  error = '';
  revision = 0;
  providers: PlaylistSource[] = ['netease'];
  private generation = 0;
  private controller = new AbortController();
  private pages = new Map<string, (MusicTrack | null)[]>();
  private albumsRevision = -1;
  private albumsView: MusicAlbum[] = [];
  private albumCache = new Map<string, { track: MusicTrack | null; album: MusicAlbum }>();
  private pending = new Map<string, Promise<void>>();
  private jobs: { key: string; start: () => void }[] = [];
  private active = 0;
  private windowEpoch = 0;
  private titlePrefetchEpoch = 0;
  private titlePrefetchKey = '';
  private changed: () => void;
  provider: PlaylistSource = 'netease';
 /** 本地歌单的排序（对照参考行为 playlist.sort.*）；平台歌单不适用。 */
  localSort: { key: LocalSortKey; direction: 'ascending' | 'descending' } = { key: 'default', direction: 'ascending' };
  constructor(changed: () => void) { this.changed = changed; }
  setLocalSort(key: LocalSortKey, direction: 'ascending' | 'descending') {
    if (this.localSort.key === key && this.localSort.direction === direction) return;
    this.localSort = { key, direction };
 // 排序变了，已缓存的分页全部作废。
    this.dispose();
  }
  setProvider(provider: PlaylistSource) { this.setProviders([provider]); }
  setProviders(providers: PlaylistSource[]) {
    const next = providers.length ? [...new Set(providers)] : ['netease' as PlaylistSource];
    const same = next.length === this.providers.length && next.every((provider, index) => provider === this.providers[index]);
    if (!same) { this.dispose(); this.providers = next; this.provider = next[0]; }
  }
  private async request<T>(provider: PlaylistSource, url: string): Promise<T> {
 // 本地歌单不经在线诊断管线（不是平台请求），直接走本机 API。
    const response = provider === 'local'
      ? await fetch(url, { signal: this.controller.signal })
      : await fetchOnline(provider, url.includes('/tracks?') ? 'playlistTracks' : 'playlists', url, { signal: this.controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `${playlistSourceName(provider)}歌单暂时不可用。`);
    return body;
  }
  dispose() {
    this.generation++; this.windowEpoch++; this.titlePrefetchEpoch++; this.titlePrefetchKey = ''; this.controller.abort(); this.controller = new AbortController();
 // Queued jobs still run their cancellation checks and settle callers.
    this.pages.clear(); this.pending.clear(); this.playlists = []; this.loading = false; this.error = ''; this.revision++;
    this.albumsRevision = -1; this.albumsView = []; this.albumCache.clear();
  }
  async load() {
    this.dispose(); const generation = this.generation;
    this.loading = true; this.changed();
    try {
      const playlists: PlaylistEntry[] = [];
      for (const provider of this.providers) {
        try {
          if (provider === 'local') {
 // 本地歌单一次取完（数量小），没有分页。
            const page = await this.request<{ playlists: LocalPlaylistSummary[] }>('local', '/api/playlists/local');
            if (generation !== this.generation) return;
            playlists.push(...page.playlists.map(item => ({
              id: item.id, name: item.name, trackCount: item.count,
              owned: !item.favorites, provider: 'local' as const,
              ...(item.favorites ? { favorites: true } : {}),
            })));
            continue;
          }
          for (let offset = 0; offset <= 5000; offset += 100) {
            const page = await this.request<{ playlists: NeteasePlaylist[]; hasMore: boolean }>(provider, `/api/online/${provider}/playlists?offset=${offset}`);
            if (generation !== this.generation) return;
            playlists.push(...page.playlists.map(item => ({ ...item, provider })));
            if (!page.hasMore) break;
            if (offset === 5000) this.error = '当前显示前 5100 个歌单。';
          }
        } catch (failure) {
 // One unreachable platform must not discard the other platforms' playlists.
          if (generation !== this.generation) return;
          if (!this.controller.signal.aborted) this.error = (failure as Error).message;
        }
      }
      this.playlists = [...new Map(playlists.map(item => [`${item.provider}:${item.id}`, item])).values()]; this.revision++;
      this.changed();
      if (this.playlists.length) await this.ensure(0, 0);
    } catch (failure) { if (generation === this.generation && !this.controller.signal.aborted) this.error = (failure as Error).message; }
    finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
  }
  private run(task: () => Promise<void>, key: string, priority: boolean) {
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        this.active++;
        void task().then(resolve, reject).finally(() => { this.active--; this.jobs.shift()?.start(); });
      };
      if (this.active < 2) start(); else if (priority) this.jobs.unshift({ key, start }); else this.jobs.push({ key, start });
    });
  }
 /** 作废某个歌单已缓存的曲目页，让下一次 ensure() 真正重新请求。
 *
 * 收藏/取消收藏会改变「莱茵歌单」的曲目集合与 total，但分页缓存不会自己失效，
 * `ensure()` 命中缓存就直接返回（见下方 cached 分支），于是墙上还留着刚取消的
 * 那首歌。收藏动作后必须显式调用这里。 */
  invalidatePlaylist(row: number) {
    const playlist = this.playlists[row];
    if (!playlist) return;
    const prefix = `${playlist.provider}:${playlist.id}:`;
    for (const key of [...this.pages.keys()]) if (key.startsWith(prefix)) this.pages.delete(key);
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.pending.delete(key);
  }
  async ensure(row: number, song: number, priority = false) {
    const playlist = this.playlists[row]; if (!playlist || !playlist.trackCount) return;
    const offset = Math.floor(Math.max(0, Math.min(playlist.trackCount - 1, song)) / 50) * 50;
    const key = `${playlist.provider}:${playlist.id}:${offset}`, cached = this.pages.get(key);
    if (cached) { this.pages.delete(key); this.pages.set(key, cached); return; }
    if (this.pending.has(key)) {
      if (priority) {
        const index = this.jobs.findIndex(job => job.key === key);
        if (index > 0) this.jobs.unshift(this.jobs.splice(index, 1)[0]);
      }
      return this.pending.get(key);
    }
    const generation = this.generation;
    const operation = this.run(async () => {
      if (generation !== this.generation) return;
 // 本地歌单的曲目是元数据快照，播放时再按 provider+onlineSourceId 取址。
      const page = playlist.provider === 'local'
        ? await this.localSongs(playlist.id, offset)
        : await this.request<{ tracks: (MusicTrack | null)[]; total: number }>(playlist.provider, `/api/online/${playlist.provider}/playlists/${playlist.id}/tracks?offset=${offset}`);
      if (generation !== this.generation) return;
      playlist.trackCount = page.total; this.pages.set(key, page.tracks);
      while (this.pages.size > 96) this.pages.delete(this.pages.keys().next().value!);
      this.error = ''; this.revision++; this.changed();
    }, key, priority).finally(() => { if (generation === this.generation) this.pending.delete(key); });
    this.pending.set(key, operation); return operation;
  }
 /** 本地歌单的一页：把快照转成可展示的 MusicTrack。 */
  private async localSongs(id: string, offset: number) {
    const query = new URLSearchParams({
      offset: String(offset), limit: '50',
      sort: this.localSort.key, direction: this.localSort.direction,
    });
    const page = await this.request<{ tracks: LocalSong[]; total: number }>('local',
      `/api/playlists/local/${encodeURIComponent(id)}?${query}`);
    return { tracks: page.tracks.map(localSongToTrack), total: page.total };
  }
  async window(row: number, song: number) {
    const generation = this.generation, windowEpoch = ++this.windowEpoch;
    if (!this.playlists.length) return;
 // Resolve the chosen song before speculative neighbouring playlists.
    try { await this.ensure(row, wrap(song, Math.max(1, this.playlists[row]?.trackCount || 0)), true); }
    catch (failure) { if (generation === this.generation) { this.error = (failure as Error).message; this.changed(); } return; }
    if (generation !== this.generation || windowEpoch !== this.windowEpoch) return;
    const nearby = [...new Set([0,-1,1,-2,2,-3,3,-4,4].map(offset => wrap(row + offset, this.playlists.length)))];
    let cursor = 0;
    const worker = async () => {
      while (cursor < nearby.length && generation === this.generation && windowEpoch === this.windowEpoch) {
        const playlist = nearby[cursor++], total = this.playlists[playlist].trackCount;
 // Enumerate the visible depth so different lengths and both loop seams are covered.
        const positions = [...new Set(Array.from({ length: 49 }, (_, index) => Math.floor(wrap(song + index - 24, Math.max(1, total)) / 50) * 50))];
        for (const position of positions) {
          if (generation !== this.generation || windowEpoch !== this.windowEpoch) return;
          await this.ensure(playlist, position);
        }
      }
    };
    const results = await Promise.allSettled([worker(), worker()]);
    if (generation !== this.generation) return;
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { this.error = failed.reason.message; this.changed(); }
  }
  track(row: number, song: number) {
    const playlist = this.playlists[row]; if (!playlist) return undefined;
    return this.pages.get(`${playlist.provider}:${playlist.id}:${Math.floor(song / 50) * 50}`)?.[song % 50];
  }
  position(row: number, trackId: string) {
    const playlist = this.playlists[row];
    if (!playlist) return undefined;
    for (const [key, tracks] of this.pages) {
      const [provider, id, offset] = key.split(':');
      if (provider !== playlist.provider || id !== playlist.id) continue;
      const index = tracks.findIndex(track => track?.id === trackId);
      if (index >= 0) return Number(offset) + index;
    }
    return undefined;
  }
 /** Warm the visible title bar plus one neighbouring page on either side.
 * One worker, two shared HTTP slots, page de-duplication and account epochs. */
  prefetchTitles(row: number, first: number, last: number) {
    const playlist = this.playlists[row]; if (!playlist?.trackCount) return;
    const start = Math.max(0, Math.floor(first / 50) * 50 - 50);
    const end = Math.min(playlist.trackCount - 1, Math.floor(last / 50) * 50 + 50);
    const key = `${playlist.provider}:${playlist.id}:${start}:${end}`;
    if (this.titlePrefetchKey === key) return;
    this.titlePrefetchKey = key;
    const epoch = ++this.titlePrefetchEpoch, generation = this.generation;
    const positions = [Math.floor(Math.max(0, first) / 50) * 50];
    for (let offset = start; offset <= end; offset += 50) if (!positions.includes(offset)) positions.push(offset);
    void (async () => {
      try {
        for (const offset of positions) {
          if (generation !== this.generation || epoch !== this.titlePrefetchEpoch) return;
 // Rapid scrolling may replace a worker while its prior page is still
 // queued. Cap speculative admission; hover/selection can still ask
 // for their page with foreground priority.
          const pageKey = `${playlist.provider}:${playlist.id}:${offset}`;
          if (this.pending.size >= 8 && !this.pending.has(pageKey) && !this.pages.has(pageKey)) {
            this.titlePrefetchKey = ''; return;
          }
          await this.ensure(row, offset, true);
        }
      } catch {
 // Hover can retry a failed page; a speculative failure never overwrites
 // the current playback status or becomes an unhandled rejection.
        if (generation === this.generation && epoch === this.titlePrefetchEpoch) this.titlePrefetchKey = '';
      }
    })();
  }
  async queue(row: number, song: number) {
    const playlist = this.playlists[row]; if (!playlist) return [];
    const offset = Math.floor(song / 50) * 50;
    await Promise.all([Math.max(0, offset - 50), offset, offset + 50].filter((value, index, all) => value < playlist.trackCount && all.indexOf(value) === index).map(index => this.ensure(row, index)));
    return Array.from({ length: Math.min(playlist.trackCount, offset + 100) - Math.max(0, offset - 50) }, (_, index) => this.track(row, Math.max(0, offset - 50) + index)).filter((track): track is MusicTrack => !!track);
  }
  albums(): MusicAlbum[] {
    if (this.albumsRevision === this.revision) return this.albumsView;
    const grouped = new Map<string, { song: number; track: MusicTrack | null }[]>();
    for (const [key, tracks] of this.pages) {
      const [provider, id, start] = key.split(':'), loaded = grouped.get(`${provider}:${id}`) || [];
      const offset = Number(start);
      tracks.forEach((track, index) => loaded.push({ song: offset + index, track }));
      grouped.set(`${provider}:${id}`, loaded);
    }
    const nextCache = new Map<string, { track: MusicTrack | null; album: MusicAlbum }>();
    this.albumsView = this.playlists.flatMap((playlist, row) => {
      const loaded = grouped.get(`${playlist.provider}:${playlist.id}`) || [];
      if (!loaded.length) loaded.push({ song: 0, track: null });
      return loaded.sort((a, b) => a.song - b.song).map(({ song, track }) => {
        const id = `playlist-${playlist.provider}-${playlist.id}-${song}`, cached = this.albumCache.get(id);
        const cell = cached?.album.playlistCell;
        if (cached && cached.track === track && cell?.total === playlist.trackCount &&
          cell.playlistIndex === row && cell.playlistName === playlist.name) {
          nextCache.set(id, cached); return cached.album;
        }
        const album: MusicAlbum = track ? playbackAlbums([track], [])[0] : { id: '', title: playlist.name, artist: playlistSourceName(playlist.provider), genreId: '', rawGenres: [], folder: '', tracks: [], producers: [], offline: false };
        delete album.playback;
        const prepared = { ...album, id, title: track?.title || playlist.name,
          genreId: `playlist-${playlist.id}`, folder: `${playlistSourceName(playlist.provider)} · ${playlist.name}`,
          playlistCell: { playlistId: playlist.id, playlistName: playlist.name, playlistIndex: row, songIndex: song, total: playlist.trackCount, provider: playlist.provider, ...(playlist.favorites ? { favorites: true } : {}) } };
        nextCache.set(id, { track, album: prepared }); return prepared;
      });
    });
 // Evicted pages and old accounts never remain in the prepared view cache.
    this.albumCache = nextCache; this.albumsRevision = this.revision;
    return this.albumsView;
  }
}
