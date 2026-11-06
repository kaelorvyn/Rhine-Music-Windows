import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MB = 1024 * 1024;
const namePattern = /^[a-f0-9]{64}\.webp$/;
export const coverCacheLimit = value => Number.isFinite(Number(value))
  ? Math.min(2048, Math.max(512, Math.round(Number(value) / 64) * 64)) : 512;

/** App-owned thumbnails only; source images and account credentials never enter this store. */
export class CoverCache {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.limitMb = 512;
    this.location = '';
    this.entries = new Map();
    this.bytes = 0;
    this.tail = Promise.resolve();
    this.ready = null;
  }
  get directory() { return path.join(this.location || this.dataDir, 'cover-thumbnails-v1'); }
  exclusive(run) {
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'cover-cache-config.json'), 'utf8'));
        this.limitMb = coverCacheLimit(saved.limitMb);
        this.location = typeof saved.location === 'string' ? saved.location : '';
      } catch { /* New installation; retain defaults. */ }
      await this.scan();
    })().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async scan() {
    const directory = this.directory;
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('封面缓存目录不能是链接。');
    this.entries.clear(); this.bytes = 0;
    for (const name of await fs.readdir(directory)) {
      if (!namePattern.test(name)) continue;
      const stat = await fs.lstat(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      this.entries.set(name, { bytes: stat.size, at: stat.mtimeMs }); this.bytes += stat.size;
    }
  }
  async configure({ limitMb, location } = {}) {
    await this.init();
    return this.exclusive(async () => {
      const nextLocation = typeof location === 'string' ? location.trim() : this.location;
      const previous = this.location;
      this.location = nextLocation;
      try { if (previous !== nextLocation) await this.scan(); }
      catch (error) { this.location = previous; await this.scan(); throw error; }
      if (limitMb !== undefined) this.limitMb = coverCacheLimit(limitMb);
      await fs.mkdir(this.dataDir, { recursive: true });
      const config = path.join(this.dataDir, 'cover-cache-config.json');
      const temporary = config + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ limitMb: this.limitMb, location: this.location }));
      await fs.rename(temporary, config);
      await this.prune();
      return this.usage();
    });
  }
  async catalog(key, value) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Object.assign(new Error('无效的封面索引。'), { status: 400 });
    await this.init();
    const file = path.join(this.directory, key + '.json');
    if (value === undefined) {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * MB) return { urls: [] };
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch { return { urls: [] }; }
    }
    if (!Array.isArray(value.urls) || value.urls.length > 100000 || value.urls.some(url => typeof url !== 'string' || url.length > 8192 || !/^(https?:\/\/|\/api\/)/i.test(url)))
      throw Object.assign(new Error('无效的封面索引。'), { status: 400 });
    const covers = Array.isArray(value.covers) ? value.covers : [];
    if (covers.length > 100000 || covers.some(item => !Array.isArray(item) || item.length !== 3 ||
      typeof item[0] !== 'string' || item[0].length > 128 || !Number.isInteger(item[1]) || item[1] < 0 ||
      typeof item[2] !== 'string' || item[2].length > 8192 || !/^(https?:\/\/|\/api\/)/i.test(item[2])))
      throw Object.assign(new Error('无效的歌曲封面索引。'), { status: 400 });
    const text = JSON.stringify({ urls: [...new Set(value.urls)], covers });
    if (Buffer.byteLength(text) > 8 * MB) throw Object.assign(new Error('封面索引过大。'), { status: 413 });
    return this.exclusive(async () => {
      const temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, text, { flag: 'wx' }); await fs.rename(temporary, file);
      return { ok: true };
    });
  }
  async get(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    await this.init(); await this.tail;
    const name = key + '.webp', entry = this.entries.get(name);
    if (!entry) return null;
    const file = path.join(this.directory, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const bytes = await fs.readFile(file);
      const now = Date.now();
      if (now - entry.at > 60000) { entry.at = now; void fs.utimes(file, new Date(), new Date()).catch(() => {}); }
      return bytes;
    } catch { return null; }
  }
  async put(key, bytes) {
    if (!/^[a-f0-9]{64}$/.test(key) || bytes.length < 16 || bytes.length > 2 * MB ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
      throw Object.assign(new Error('无效的封面缓存。'), { status: 400 });
    }
    await this.init();
    return this.exclusive(async () => {
      const name = key + '.webp', file = path.join(this.directory, name);
      const temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, file);
      this.bytes += bytes.length - (this.entries.get(name)?.bytes || 0);
      this.entries.set(name, { bytes: bytes.length, at: Date.now() });
      await this.prune();
    });
  }
  async prune() {
    if (this.bytes <= this.limitMb * MB) return;
    for (const [name, entry] of [...this.entries].sort((a, b) => a[1].at - b[1].at)) {
      if (this.bytes <= this.limitMb * MB) break;
      const file = path.join(this.directory, name);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) await fs.unlink(file);
      this.entries.delete(name); this.bytes -= entry.bytes;
    }
  }
  usage() { return { files: this.entries.size, bytes: this.bytes, limitBytes: this.limitMb * MB, cacheDir: this.directory }; }
  async clear() {
    await this.init();
    return this.exclusive(async () => {
      let files = 0, bytes = 0;
      for (const [name, entry] of this.entries) {
        const file = path.join(this.directory, name), stat = await fs.lstat(file).catch(() => null);
        if (stat?.isFile() && !stat.isSymbolicLink()) { await fs.unlink(file); files++; bytes += entry.bytes; }
      }
      this.entries.clear(); this.bytes = 0;
      return { ...this.usage(), freed: { files, bytes } };
    });
  }
}
