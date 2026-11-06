import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoverCache, coverCacheLimit } from './cover-cache.mjs';
import { AudioDecoder } from './music-audio.mjs';

const image = () => Buffer.from('RIFF\x08\x00\x00\x00WEBPVP8 fake-cover');
const key = 'a'.repeat(64);

test('disk thumbnails, account catalog and configured limit survive a new process/store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-cover-persist-'));
  const store = new CoverCache({ dataDir: dir });
  await store.configure({ limitMb: 1536 });
  await store.put(key, image());
  await store.catalog(key, { urls: ['https://example.test/one.jpg', '/api/artwork/two'] });
  const restored = new CoverCache({ dataDir: dir }); await restored.init();
  assert.deepEqual(await restored.get(key), image());
  assert.equal(restored.usage().limitBytes, 1536 * 1024 ** 2);
  assert.equal(restored.usage().files, 1);
  assert.deepEqual((await restored.catalog(key)).urls, ['https://example.test/one.jpg', '/api/artwork/two']);
  await fs.writeFile(path.join(restored.directory, 'keep-user-file.txt'), 'keep');
  const cleared = await restored.clear();
  assert.equal(cleared.freed.files, 1); assert.equal(await restored.get(key), null);
  assert.equal(await fs.readFile(path.join(restored.directory, 'keep-user-file.txt'), 'utf8'), 'keep');
});

test('limits clamp at 512..2048 MiB; audio upper bound is 16384 MiB', async () => {
  assert.equal(coverCacheLimit(0), 512); assert.equal(coverCacheLimit(9999), 2048);
  assert.equal(coverCacheLimit('bad'), 512);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-cover-limits-'));
  const audio = new AudioDecoder({ dataDir: dir });
  assert.equal(audio.configure({ limitMb: 16384 }).limitMb, 16384);
  assert.equal(audio.configure({ limitMb: 20000 }).limitMb, 16384);
  const store = new CoverCache({ dataDir: dir }); await store.init();
  await assert.rejects(store.put('../escape', image()));
  await assert.rejects(store.put(key, Buffer.from('not a picture')));
  await assert.rejects(store.catalog(key, { urls: ['javascript:alert(1)'] }));
});

test('LRU eviction touches only this cache and uses disk accounting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-cover-lru-'));
  const store = new CoverCache({ dataDir: dir }); await store.init();
  const older = 'b'.repeat(64) + '.webp', newer = 'c'.repeat(64) + '.webp';
  await fs.writeFile(path.join(store.directory, older), image());
  await fs.writeFile(path.join(store.directory, newer), image());
  // Synthetic accounting exercises a 512 MiB crossing without writing gigabytes.
  store.entries.set(older, { bytes: 400 * 1024 ** 2, at: 1 });
  store.entries.set(newer, { bytes: 400 * 1024 ** 2, at: 2 });
  store.bytes = 800 * 1024 ** 2;
  await store.prune();
  assert.equal(await fs.stat(path.join(store.directory, older)).catch(() => null), null);
  assert.ok(await fs.stat(path.join(store.directory, newer)));
  assert.equal(store.bytes, 400 * 1024 ** 2);
});

test('HTTP thumbnail roundtrip, limits, catalog and clear use separate audio/cover stores', async () => {
  const { createMusicServer } = await import('./music-server.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-cover-http-'));
  await fs.writeFile(path.join(dir, 'lx-config.json'), JSON.stringify({ enabled: false }));
  await fs.writeFile(path.join(dir, 'backup-sources-config.json'), JSON.stringify({ enabled: false }));
  const { server } = await createMusicServer({ dataDir: dir, defaultRoots: [], autoScan: false });
  server.removeAllListeners('listening');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configure = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    assert.equal((await fetch(`${base}/api/covers/cache/${key}`)).status, 404);
    assert.equal((await fetch(`${base}/api/covers/cache/${key}`, { method: 'PUT', body: image() })).status, 200);
    assert.deepEqual(Buffer.from(await fetch(`${base}/api/covers/cache/${key}`).then(r => r.arrayBuffer())), image());
    assert.equal((await configure('/api/covers/cache/configure', { limitMb: 2048 })).limitBytes, 2048 * 1024 ** 2);
    assert.equal((await configure('/api/audio/cache/configure', { limitMb: 16384 })).limitBytes, 16384 * 1024 ** 2);
    const catalog = await fetch(`${base}/api/covers/catalog/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: ['https://example.test/cover'] }) });
    assert.equal(catalog.status, 200);
    assert.equal((await fetch(`${base}/api/covers/catalog/${key}`).then(r => r.json())).urls.length, 1);
    assert.equal((await configure('/api/covers/cache/clear', {})).freed.files, 1);
    assert.equal((await fetch(`${base}/api/audio/cache`).then(r => r.json())).limitBytes, 16384 * 1024 ** 2);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
