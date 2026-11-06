export type CachedCover = { source: CanvasImageSource; width: number; height: number; decodedSize: number; pixels: number };
export type CoverPhase = 'film' | 'preparation' | 'intro' | 'browse';
type Job = { url: string; size: number; urgent: boolean; resolve: (image: CachedCover | undefined) => void;
  promise: Promise<CachedCover | undefined>; blob?: Blob; cached?: boolean; key?: string; attempts: number };

/** Decoded pixels are available independently of the bounded, low-priority disk writer. */
class CoverResources {
  enabled = false;
  private phase: CoverPhase = 'film';
  private downloads = 0;
  private decodes = 0;
  private blobBytes = 0;
  private pixels = 0;
  private jobs = new Map<string, Job>();
  private downloading: Job[] = [];
  private remotePending: Job[] = [];
  private decoding: Job[] = [];
  private writes: { canvas: HTMLCanvasElement; key: string; generation: number }[] = [];
  private writing = false;
  private images = new Map<string, CachedCover>();
  private failures = new Map<string, number>();
  private attempts = 0;
  private hits = 0;
  private completed = 0;
  private failed = 0;
  private generation = 0;
  private controllers = new Set<AbortController>();
  private pixelLimit = 96 * 1024 * 1024;
  private warmSize = 256;
  configureLowMemory(low: boolean) { this.pixelLimit = (low ? 32 : 96) * 1024 * 1024; this.warmSize = low ? 128 : 256; this.trim(); }
  private trim() {
    while (this.pixels > this.pixelLimit || this.images.size > 2048) {
      const oldest = this.images.keys().next().value!;
      this.pixels -= this.images.get(oldest)!.pixels; this.images.delete(oldest);
    }
  }

  setPhase(value: CoverPhase) { this.phase = value; this.pump(); }
  peek(url?: string) {
    if (!url) return undefined;
    const image = this.images.get(url);
    if (image) { this.images.delete(url); this.images.set(url, image); }
    return image;
  }
  load(url: string, size = 256, urgent = false): Promise<CachedCover | undefined> {
    const image = this.peek(url);
    if (image && image.decodedSize >= size) return Promise.resolve(image);
    const id = `${size}:${url}`, existing = this.jobs.get(id);
    if (existing) {
      if (urgent && !existing.urgent) {
        existing.urgent = true;
        for (const queue of [this.downloading, this.remotePending, this.decoding]) {
          const index = queue.indexOf(existing); if (index > 0) queue.unshift(queue.splice(index, 1)[0]);
        }
      }
      this.pump(); return existing.promise;
    }
    if ((this.failures.get(id) || 0) > Date.now()) return Promise.resolve(undefined);
    let resolve!: Job['resolve'];
    const promise = new Promise<CachedCover | undefined>(done => { resolve = done; });
    const job: Job = { url, size, urgent, resolve, promise, attempts: 0 };
    this.jobs.set(id, job); urgent ? this.downloading.unshift(job) : this.downloading.push(job); this.pump();
    return promise;
  }
  warm(url?: string) { if (url) void this.load(url, this.warmSize); }
  warmAll(urls: Iterable<string | undefined>) {
    const iterator = urls[Symbol.iterator](), generation = this.generation;
    const batch = () => {
      if (generation !== this.generation) return;
      for (let i = 0; i < 32; i++) { const next = iterator.next(); if (next.done) return; this.warm(next.value); }
      setTimeout(batch, 0);
    };
    batch();
  }
  private pump() {
    const browsing = this.phase === 'browse';
    while (this.downloads < (browsing ? 4 : 2)) {
      const room = this.blobBytes < 16 * 1024 * 1024;
      const cacheIndex = this.downloading.findIndex(job => room || job.urgent);
      const remoteIndex = this.remotePending.findIndex(job => (browsing || job.size <= 256) &&
        (room || (job.urgent && job.size <= 256)));
      const remote = remoteIndex >= 0 && (cacheIndex < 0 || this.remotePending[remoteIndex].urgent);
      if (!remote && cacheIndex < 0) break;
      const job = remote ? this.remotePending.splice(remoteIndex, 1)[0] : this.downloading.splice(cacheIndex, 1)[0];
      this.downloads++;
      void this.download(job, remote).finally(() => { this.downloads--; this.pump(); });
    }
    while (this.decodes < (browsing ? 2 : 1)) {
      const index = this.decoding.findIndex(job =>
        (job.cached || browsing || (job.urgent && job.size <= 256)) &&
        (job.cached || this.writes.length + this.decodes < 8) && (!this.decodes || job.urgent));
      if (index < 0) break;
      const job = this.decoding.splice(index, 1)[0]; this.decodes++;
      void this.decode(job).finally(() => { this.decodes--; this.pump(); });
    }
    if (!this.writing && this.writes.length) void this.persist();
  }
  private async key(url: string, size: number) {
    const source = new URL(url, location.href);
    if (source.hostname.endsWith('.music.126.net')) source.searchParams.delete('param');
    const absolute = source.origin === location.origin ? source.pathname + source.search : source.href;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cover-v1:${size}:${absolute}`));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  private async read(response: Response) {
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw new Error('cover unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty cover');
    const chunks: Uint8Array<ArrayBuffer>[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('cover too large'); }
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  }
  private async download(job: Job, remote = false) {
    const generation = this.generation, controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      let cached: Response | null = null;
      if (!remote) {
        this.attempts++; job.attempts++;
        job.key = await this.key(job.url, job.size);
        cached = await fetch(`/api/covers/cache/${job.key}`, { signal: controller.signal, cache: 'no-store' }).catch(() => null);
        if (!cached?.ok && job.size === 128) {
          const larger = await this.key(job.url, 256);
          cached = await fetch(`/api/covers/cache/${larger}`, { signal: controller.signal, cache: 'no-store' }).catch(() => null);
        }
        if (generation !== this.generation) return;
        job.cached = cached?.ok === true;
        if (job.cached) this.hits++;
        else { job.urgent ? this.remotePending.unshift(job) : this.remotePending.push(job); return; }
      }
      const source = new URL(job.url, location.href);
      const response = job.cached ? cached! : await fetch(source.href, {
        signal: controller.signal, cache: 'force-cache', mode: 'cors',
        credentials: source.origin === location.origin ? 'same-origin' : 'omit',
      });
      const blob = await this.read(response);
      if (generation !== this.generation) return;
      job.blob = blob; this.blobBytes += blob.size; job.urgent ? this.decoding.unshift(job) : this.decoding.push(job);
    } catch {
      if (generation !== this.generation) return;
      if (job.attempts < 2) {
        setTimeout(() => { if (generation === this.generation) { this.downloading.push(job); this.pump(); } }, 30000);
      } else this.finish(job);
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async decode(job: Job) {
    const generation = this.generation;
    try {
      await new Promise<void>(resolve => setTimeout(resolve, job.urgent ? 0 : 24));
      if (generation !== this.generation || !job.blob) return;
      const bitmap = await createImageBitmap(job.blob, { resizeWidth: job.size, resizeQuality: 'high' });
      if (generation !== this.generation) { bitmap.close(); return; }
      const scale = Math.min(1, job.size / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0, width, height); bitmap.close();
      if (generation !== this.generation) return;
      const image: CachedCover = { source: canvas, width, height, decodedSize: Math.max(width, height), pixels: width * height };
      const previous = this.images.get(job.url);
      if (!previous || previous.decodedSize <= image.decodedSize) {
        this.images.delete(job.url); this.images.set(job.url, image);
        this.pixels += image.pixels - (previous?.pixels || 0);
      }
      this.trim();
      if (!job.cached) this.writes.push({ canvas, key: job.key!, generation });
      this.completed++; this.finish(job, image);
    } catch {
      if (generation !== this.generation) return;
      if (job.cached) {
        // A corrupt disk thumbnail must not permanently hide the remote cover.
        job.cached = false;
        this.remotePending.unshift(job); return;
      }
      this.finish(job);
    } finally {
      if (!this.decoding.includes(job)) {
        if (generation === this.generation) this.blobBytes = Math.max(0, this.blobBytes - (job.blob?.size || 0));
        job.blob = undefined;
      }
    }
  }
  private async persist() {
    this.writing = true;
    const write = this.writes.shift()!;
    try {
      await new Promise<void>(resolve => setTimeout(resolve, this.phase === 'browse' || this.phase === 'preparation' ? 0 : 64));
      if (write.generation !== this.generation) return;
      const encoded = await new Promise<Blob | null>(resolve => write.canvas.toBlob(resolve, 'image/webp', 0.86));
      if (encoded?.type === 'image/webp' && write.generation === this.generation)
        await fetch(`/api/covers/cache/${write.key}`, { method: 'PUT', body: encoded, signal: AbortSignal.timeout(10000) });
    } catch { /* A disk failure cannot delay or hide decoded art. */ }
    finally { this.writing = false; this.pump(); }
  }
  private finish(job: Job, image?: CachedCover) {
    this.jobs.delete(`${job.size}:${job.url}`);
    if (!image) { this.failed++; this.failures.set(`${job.size}:${job.url}`, Date.now() + 30000); }
    job.resolve(image);
  }
  stats() { return { queued: this.jobs.size, downloads: this.downloads, decodes: this.decodes, phase: this.phase,
    pendingWrites: this.writes.length, writing: this.writing,
    cachedImages: this.images.size, cachedBytes: this.pixels * 4, cacheLimitBytes: this.pixelLimit * 4, stagedBytes: this.blobBytes,
    requests: this.attempts, diskHits: this.hits, completed: this.completed, failed: this.failed }; }
  reset() {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    for (const job of this.jobs.values()) job.resolve(undefined);
    this.jobs.clear(); this.downloading.length = 0; this.remotePending.length = 0; this.decoding.length = 0; this.writes.length = 0;
    this.images.clear(); this.failures.clear(); this.pixels = this.blobBytes = 0;
  }
}
export const coverResources = new CoverResources();
