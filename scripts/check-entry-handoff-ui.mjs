// Production app and scene, instrumented only in this in-memory test bundle.
// No diagnostic hooks or per-frame allocations are added to the shipped UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CoverCache } from './cover-cache.mjs';

const scenario = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) || 'cached';
const navigationOnly = process.argv.includes('--navigation-only');
assert.ok(['cached', 'mixed', 'failed'].includes(scenario));
const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : '')); await fs.mkdir(out, { recursive: true });
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import './src/music-app.ts';
import * as THREE from 'three';
import { ArchiveScene } from './src/scene.ts';
import { NeteasePlaylists } from './src/netease-playlists.ts';
import { MusicPlayer } from './src/music-player.ts';
import { records } from './src/data.ts';
window.continuity = { frames: [], faults: [], reloads: [], stops: [], first: null, seen: new Map(), roiSeen: false };
const update = ArchiveScene.prototype.update;
ArchiveScene.prototype.update = function(...args) {
  const value = update.apply(this, args), state = window.continuity;
  if (state.navigation) return value;
  if (!this.loaded || this.disposed || document.querySelector('.music-app')?.dataset.musicBoot !== 'done' || args[2] === false) return value;
  const now = performance.now(), listed = new Set(this.instanceBudget.visibleSlots);
  const coverStats = this.covers.getStats();
  let readyDrops = 0, hidden = 0, absent = 0, inView = 0;
  for (let slot = 0; slot < this.cells.length; slot++) {
    const cell = this.cells[slot]; if (!this.actualCell(cell)) continue;
    if (cell.lane === this.selectedCell.lane && cell.row === this.selectedCell.row) continue;
    const m = new THREE.Matrix4().fromArray(this.instanceBudget.pool, slot * 16);
    const point = new THREE.Vector3(.17, 1.85, .027).applyMatrix4(m).project(this.camera);
    if (point.z <= -1 || point.z >= 1 || Math.abs(point.x) > .9 || Math.abs(point.y) > .9) continue;
    inView++;
    const record = this.recordAtCell(cell), key = cell.lane + ':' + cell.row;
    const owner = this.covers.recordIdentity(record).owner, previous = state.seen.get(key);
    const ready = this.covers.sourceReady[slot] === 1;
    if (m.getMaxScaleOnAxis() < .00001) hidden++;
    if (!listed.has(slot)) absent++;
    if (previous?.owner === owner && previous.ready && !ready) readyDrops++;
    state.seen.set(key, { owner, ready });
  }
  const gl = this.renderer.getContext(), w = this.renderer.domElement.width, h = this.renderer.domElement.height;
  const target = this.cells.findIndex(c => c.lane === this.selectedCell.lane && c.row === this.selectedCell.row - 1);
  let roi;
  if (target >= 0 && listed.has(target)) {
    const m = new THREE.Matrix4().fromArray(this.instanceBudget.pool, target * 16);
    const p = new THREE.Vector3(.17, 3.05, .027).applyMatrix4(m).project(this.camera);
    const x = Math.round((p.x + 1) * w / 2) - 4, y = Math.round((p.y + 1) * h / 2) - 4;
    if (x >= 0 && y >= 0 && x + 8 <= w && y + 8 <= h) {
      const pixels = new Uint8Array(8 * 8 * 4), background = new Uint8Array(4);
      gl.readPixels(4, h - 5, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, background);
      gl.readPixels(x, y, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let coverage = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.max(Math.abs(pixels[i] - background[0]), Math.abs(pixels[i+1] - background[1]), Math.abs(pixels[i+2] - background[2])) > 12) coverage++;
      roi = coverage;
      if (coverage >= 48) state.roiSeen = true;
      if (state.roiSeen && coverage === 0) state.faults.push({ at: now, reason: 'tracked-region-became-background' });
    }
  }
  if (hidden || absent || readyDrops) state.faults.push({ at: now, hidden, absent, readyDrops });
  const frame = { at: now, records: records.length, inView, prints: coverStats.visiblePrints, images: coverStats.visibleImages,
    ready: coverStats.visibleReady, uploaded: coverStats.uploadedTiles, hidden, absent, readyDrops, roi };
  if (!state.first) state.first = frame;
  state.frames.push(frame); return value;
};
const load = NeteasePlaylists.prototype.load;
NeteasePlaylists.prototype.load = function(...args) {
  const before = this.albums().length, operation = load.apply(this, args);
  continuity.reloads.push({ at: performance.now(), before, after: this.albums().length, keep: args[0]?.keepSnapshot === true });
  return operation;
};
const stop = MusicPlayer.prototype.stop;
MusicPlayer.prototype.stop = function(...args) { continuity.stops.push({ at: performance.now(), phase: document.querySelector('.music-app')?.dataset.musicBoot }); return stop.apply(this, args); };
` }, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'empty' },
  define: { 'import.meta.env.BASE_URL': JSON.stringify('/'), 'import.meta.env.DEV': 'false' } });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const generator = await browser.newPage();
const images = await generator.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d'); context.fillStyle = '#278abb'; context.fillRect(0, 0, 256, 256);
  context.fillStyle = '#f0df6a'; context.fillRect(20, 20, 216, 40);
  return { png: canvas.toDataURL('image/png').split(',')[1], webp: canvas.toDataURL('image/webp', .86).split(',')[1] };
}); await generator.close();
const store = new CoverCache({ dataDir: await fs.mkdtemp(path.join(out, 'cache-')) });
const cached = scenario === 'cached' ? 200 : scenario === 'mixed' ? 50 : 0;
for (let i = 0; i < cached; i++) await store.put(createHash('sha256').update(`cover-v1:256:/cover/${i}`).digest('hex'), Buffer.from(images.webp, 'base64'));
let releaseCovers, home = false, origins = 0, catalogs = 0;
const coverGate = new Promise(resolve => { releaseCovers = resolve; });
const root = path.resolve('dist');
const styles = (await fs.readdir(path.join(root, 'assets'))).filter(name => /^(music-app|audio)-.*\.css$/.test(name))
  .map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('');
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture'), route = url.pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  try {
    if (route === '/') { response.setHeader('Content-Type', 'text/html'); response.end(`<meta charset="utf-8">${styles}<main id="viewport"><div id="stage"></div></main>`); return; }
    if (route === '/api/library') { await new Promise(resolve => setTimeout(resolve, 700)); json({ version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false }); return; }
    if (route.includes('/auth/status')) {
      if (route.includes('/netease/')) await new Promise(resolve => setTimeout(resolve, 150));
      json(/\/(qq|netease)\//.test(route) ? { loggedIn: true, profile: { userId: 'fixture', nickname: 'Fixture' } } : { loggedIn: false }); return;
    }
    if (route === '/api/playlists/local') { json({ playlists: [] }); return; }
    if (route === '/api/online/netease/playlists') { response.writeHead(503); json({ error: 'fixture platform unavailable' }); return; }
    if (route === '/api/online/qq/playlists') { catalogs++; await new Promise(resolve => setTimeout(resolve, home ? 300 : 5)); json({ playlists: [{ id: 'test', name: 'Test', trackCount: 200 }], hasMore: false }); return; }
    if (route === '/api/online/qq/playlists/test/tracks') {
      const offset = Number(url.searchParams.get('offset') || 0);
      await new Promise(resolve => setTimeout(resolve, home ? 250 : 5));
      json({ total: 200, tracks: Array.from({ length: Math.min(50, 200 - offset) }, (_, i) => ({ id: 's' + (offset + i), title: 'Song ' + (offset + i),
        artist: 'Fixture', album: 'Test', duration: 120, onlineSource: { provider: 'qq', id: 's' + (offset + i), coverUrl: '/cover/' + (offset + i) } })) }); return;
    }
    const cache = /^\/api\/covers\/cache\/([a-f0-9]{64})$/.exec(route);
    if (cache) {
      if (request.method === 'PUT') { const chunks = []; for await (const chunk of request) chunks.push(chunk); await store.put(cache[1], Buffer.concat(chunks)); json({}); }
      else { const bytes = await store.get(cache[1]); response.writeHead(bytes ? 200 : 404, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }); response.end(bytes || ''); }
      return;
    }
    if (route.startsWith('/cover/')) {
      origins++; if (scenario === 'mixed') await coverGate;
      if (scenario === 'failed') { response.writeHead(404); response.end(); }
      else { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from(images.png, 'base64')); } return;
    }
    if (route.startsWith('/api/covers/catalog/')) {
      json({ urls: Array.from({ length: 200 }, (_, i) => '/cover/' + i), covers: Array.from({ length: 200 }, (_, i) => ['test', i, '/cover/' + i]) }); return;
    }
    if (route.startsWith('/api/covers/cache')) { json(store.usage()); return; }
    if (route.startsWith('/api/audio/cache')) { json({ bytes: 0, files: 0, limitBytes: 2048 * 1024 ** 2, cacheDir: 'fixture' }); return; }
    if (route.startsWith('/api/')) { json({}); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(route)); if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
    const mime = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(await fs.readFile(file));
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const page = await browser.newPage({ viewport: { width: 1680, height: 960 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(navigation => localStorage.setItem('rhine-music-preferences', JSON.stringify({ quality: 'balanced', qualityMode: 'manual',
  qualityPipelineVersion: 5, frameRate: 60, bgm: false, sound: false, arrayMode: navigation ? 'realistic' : 'filled' })), navigationOnly);
try {
  const started = Date.now(); await page.goto(`http://127.0.0.1:${server.address().port}/?scheduler=1${scenario === 'cached' && !navigationOnly ? '' : '&scene=archive'}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => document.querySelector('.music-app')?.dataset.musicBoot === 'done', null, { timeout: 90000 });
  home = true; releaseCovers(); console.log(scenario + (navigationOnly ? ': checking loop navigation' : ': observing 30 seconds without input'));
  await page.screenshot({ path: path.join(out, 'first-home.png') });
  await page.waitForTimeout(navigationOnly ? 1500 : 30500);
  let navigation;
  if (navigationOnly) {
    await page.evaluate(() => { continuity.navigation = true; });
    const mode = await page.evaluate(() => window.rhineMusic.stats().arrayMode);
    assert.equal(mode, 'filled', 'a saved finite-album preference cannot change the playlist wall after entry');
    await page.mouse.move(500, 500); await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 199, null, { timeout: 10000 });
    const last = await page.evaluate(() => window.rhineMusic.stats().selectedCell);
    await page.waitForTimeout(500); await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 0, null, { timeout: 10000 });
    const first = await page.evaluate(() => window.rhineMusic.stats().selectedCell);
    assert.equal(last.row, 11); assert.equal(first.row, 12);
    navigation = { mode, last, first, firstToLast: true, lastToFirst: true };
  }
  const result = await page.evaluate(() => ({ frames: continuity.frames, faults: continuity.faults, reloads: continuity.reloads, stops: continuity.stops,
    first: continuity.first, roiSeen: continuity.roiSeen, selected: window.rhineMusic.selectedAlbum?.id, loading: window.rhineMusic.coverLoading() }));
  await page.screenshot({ path: path.join(out, 'settled-home.png') });
  const report = { scenario, navigation, seconds: (Date.now() - started) / 1000, errors, origins, catalogs, ...result };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []); assert.ok(result.frames.length > (navigationOnly ? 5 : 300));
  if (!navigationOnly) assert.ok(result.frames.at(-1).at - result.first.at >= 30000);
  assert.deepEqual(result.faults, [], 'the same on-screen entities retain geometry and uploaded prints');
  assert.ok(result.roiSeen, 'a tracked previously-pending card has actual non-background GPU pixels');
  assert.ok(result.reloads.some(item => item.keep), 'startup prepares its foreground playlist view without clearing existing data');
  assert.equal(result.stops.filter(item => item.phase === 'done').length, 0, 'same-account completion cannot stop playback');
  console.log(JSON.stringify({ scenario, frames: result.frames.length, observedSeconds: (result.frames.at(-1).at - result.first.at) / 1000,
    faults: result.faults.length, first: result.first, last: result.frames.at(-1), reloads: result.reloads, roiSeen: result.roiSeen, navigation, errors }));
} finally { releaseCovers(); await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
