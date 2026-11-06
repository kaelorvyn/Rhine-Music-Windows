import type { MusicTrack, NeteasePlaylist } from './music-types';
import type { PlaylistSource } from './music-platform.ts';
import { localSongToTrack, type LocalPlaylistSummary, type LocalSong, type LocalSortKey } from './local-playlists.ts';
import type { PlaylistEntry } from './netease-playlists.ts';
import { coverResources } from './cover-resources.ts';

type RequestJob = { provider: PlaylistSource; url: string; foreground: boolean; version: number;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void };
const pending = new Map<string, Promise<unknown>>();
const cached = new Map<string, { at: number; value: unknown }>();
const versions = new Map<PlaylistSource, number>();
const controllers = new Map<PlaylistSource, Set<AbortController>>();
const queue: RequestJob[] = [];
let active = 0, background = 0, cacheEpoch = 0;

function pump() {
  while (active < 2) {
    const index = queue.findIndex(job => job.foreground || background === 0);
    if (index < 0) return;
    const job = queue.splice(index, 1)[0]; active++; if (!job.foreground) background++;
    const controller = new AbortController(), set = controllers.get(job.provider) || new Set();
    controllers.set(job.provider, set); set.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    void (async () => {
      if (job.version !== (versions.get(job.provider) || 0)) throw new DOMException('Account changed', 'AbortError');
      const response = await fetch(job.url, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '歌单暂时不可用');
      if (job.version !== (versions.get(job.provider) || 0)) throw new DOMException('Account changed', 'AbortError');
      return body;
    })().then(job.resolve, job.reject).finally(() => {
      clearTimeout(timer); set.delete(controller); active--; if (!job.foreground) background--; pump();
    });
  }
}

export function invalidatePlaylistPages(provider?: PlaylistSource) {
  if (provider) versions.set(provider, (versions.get(provider) || 0) + 1);
  cacheEpoch++; cached.clear();
}

/** Shared page requests reserve one HTTP slot for navigation. Filtering never cancels a full scan. */
export async function playlistPage<T>(provider: PlaylistSource, url: string, signal?: AbortSignal, foreground = true): Promise<T> {
  const key = `${cacheEpoch}:${provider}:${versions.get(provider) || 0}:${url}`;
  const hit = cached.get(key);
  let operation: Promise<unknown>;
  if (hit && Date.now() - hit.at < 300000) operation = Promise.resolve(hit.value);
  else {
    const existing = pending.get(key);
    if (existing) {
      if (foreground) {
        const job = queue.find(job => job.provider === provider && job.url === url);
        if (job) { job.foreground = true; queue.splice(queue.indexOf(job), 1); queue.unshift(job); pump(); }
      }
      operation = existing;
    } else {
      operation = new Promise((resolve, reject) => {
        const job = { provider, url, foreground, version: versions.get(provider) || 0, resolve, reject };
        foreground ? queue.unshift(job) : queue.push(job); pump();
      }).then(value => {
        cached.set(key, { at: Date.now(), value });
        while (cached.size > 96) cached.delete(cached.keys().next().value!);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, operation);
    }
  }
  const result = await operation;
  if (signal?.aborted) throw new DOMException('View changed', 'AbortError');
  return result as T;
}

class PlaylistCoverPreload {
  private accounts = new Map<PlaylistSource, string>();
  private generations = new Map<PlaylistSource, number>();
  private pages = 0;
  private entries = new Map<PlaylistSource, PlaylistEntry[]>();
  private songPages = new Map<string, (MusicTrack | null)[]>();
  snapshot(providers: PlaylistSource[]) {
    const playlists = providers.flatMap(provider => this.entries.get(provider) || []);
    const prefixes = playlists.map(playlist => `${playlist.provider}:${playlist.id}:`);
    return { playlists, pages: [...this.songPages].filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))),
      complete: providers.every(provider => this.entries.has(provider)) };
  }
  private localSort = { key: 'default' as LocalSortKey, direction: 'ascending' as 'ascending' | 'descending' };
  setLocalSort(key: LocalSortKey, direction: 'ascending' | 'descending') {
    if (this.localSort.key === key && this.localSort.direction === direction) return;
    this.localSort = { key, direction };
    if (this.accounts.has('local')) this.setAccount('local', `local:${key}:${direction}`);
  }
  private coverPositions = new Map<PlaylistSource, Map<string, string>>();
  coverAt(provider: PlaylistSource, playlist: string, song: number) { return this.coverPositions.get(provider)?.get(`${playlist}:${song}`); }
  private paused = true;
  private waiters: (() => void)[] = [];
  setPaused(value: boolean) {
    this.paused = value;
    if (!value) for (const resolve of this.waiters.splice(0)) resolve();
  }
  private async yield() {
    if (this.paused) await new Promise<void>(resolve => this.waiters.push(resolve));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  setAccount(provider: PlaylistSource, account?: string) {
    if (this.accounts.get(provider) === account) return;
    versions.set(provider, (versions.get(provider) || 0) + 1);
    for (const controller of controllers.get(provider) || []) controller.abort();
    const generation = (this.generations.get(provider) || 0) + 1;
    this.generations.set(provider, generation);
    this.coverPositions.delete(provider); this.entries.delete(provider);
    for (const key of this.songPages.keys()) if (key.startsWith(provider + ":")) this.songPages.delete(key);
    if (!account) { this.accounts.delete(provider); return; }
    this.accounts.set(provider, account);
    void this.scan(provider, account, generation);
  }
  private async scan(provider: PlaylistSource, account: string, generation: number) {
    const valid = () => this.generations.get(provider) === generation;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`catalog-v1:${provider}:${account}`));
      const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const catalogUrl = `/api/covers/catalog/${key}`;
      const stored = await fetch(catalogUrl).then(response => response.ok ? response.json() : null).catch(() => null);
      if (!valid()) return;
      const positions = new Map<string, string>(); this.coverPositions.set(provider, positions);
      for (const item of Array.isArray(stored?.covers) ? stored.covers : []) {
        if (Array.isArray(item) && item.length === 3 && typeof item[0] === 'string' && Number.isInteger(item[1]) && typeof item[2] === 'string') positions.set(`${item[0]}:${item[1]}`, item[2]);
      }
      coverResources.warmAll(Array.isArray(stored?.urls) ? stored.urls.filter((url: unknown) => typeof url === 'string') : []);
      // Cached covers can warm immediately. Foreground startup owns catalog
      // and visible song requests; the bulk scan must not occupy their slots.
      await this.yield();
      if (!valid()) return;
      const playlists: PlaylistEntry[] = [];
      if (provider === 'local') {
        const page = await playlistPage<{ playlists: LocalPlaylistSummary[] }>('local', '/api/playlists/local', undefined, false);
        playlists.push(...page.playlists.map(item => ({ id: item.id, name: item.name, trackCount: item.count, owned: !item.favorites, provider: 'local' as const, ...(item.favorites ? { favorites: true } : {}) })));
      } else {
        for (let offset = 0; offset < 100000; offset += 100) {
          if (!valid()) return;
          const page = await playlistPage<{ playlists: NeteasePlaylist[]; hasMore: boolean }>(provider, `/api/online/${provider}/playlists?offset=${offset}`, undefined, false);
          playlists.push(...page.playlists.map(playlist => ({ ...playlist, provider })));
          if (!page.hasMore) break;
        }
      }
      if (!valid()) return;
      this.entries.set(provider, playlists);
      const urls = new Set<string>(), covers: [string, number, string][] = []; let complete = true;
      for (const playlist of playlists) {
        for (let offset = 0; offset < playlist.trackCount; offset += 50) {
          if (!valid()) return;
          try {
            const url = provider === 'local'
              ? `/api/playlists/local/${encodeURIComponent(playlist.id)}?offset=${offset}&limit=50&sort=${this.localSort.key}&direction=${this.localSort.direction}`
              : `/api/online/${provider}/playlists/${playlist.id}/tracks?offset=${offset}`;
            const page = await playlistPage<{ tracks: (MusicTrack | LocalSong | null)[]; total: number }>(provider, url, undefined, false);
            if (!valid()) return;
            playlist.trackCount = page.total; this.pages++;
            this.songPages.set(`${provider}:${playlist.id}:${offset}`, page.tracks.map(track => !track ? null
              : provider === 'local' ? localSongToTrack(track as LocalSong) : track as MusicTrack));
            while (this.songPages.size > 96) this.songPages.delete(this.songPages.keys().next().value!);
            for (const [index, track] of page.tracks.entries()) {
              const cover = track && ('onlineSource' in track ? track.onlineSource?.coverUrl : 'cover' in track ? track.cover : undefined);
              if (cover) {
                urls.add(cover); coverResources.warm(cover);
                positions.set(`${playlist.id}:${offset + index}`, cover);
                covers.push([String(playlist.id), offset + index, cover]);
              }
            }
          } catch { complete = false; }
          // First page starts during the film; bulk page processing resumes after the handoff.
          await this.yield();
        }
      }
      if (valid() && complete) await fetch(catalogUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [...urls], covers }) });
    } catch { /* An unavailable account cannot block the film or other providers. */ }
  }
  dispose() {
    for (const provider of [...this.accounts.keys()]) this.setAccount(provider, undefined);
    this.setPaused(false);
  }
  stats() { return { providers: this.accounts.size, scannedPages: this.pages, paused: this.paused }; }
}
export const playlistCoverPreload = new PlaylistCoverPreload();
