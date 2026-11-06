import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { CoverCache } from './cover-cache.mjs';
import { qualityPresets } from '../src/render-quality.ts';

const artifacts = path.resolve('artifacts/render-startup'); await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const generator = await browser.newPage();
const cover = Buffer.from(await generator.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
  const context = canvas.getContext('2d'); context.fillStyle = '#ac8357'; context.fillRect(0, 0, 1024, 1024);
  context.fillStyle = '#eee8dc'; context.fillRect(64, 64, 896, 896);
  context.fillStyle = '#3c4c4c'; context.font = 'bold 120px sans-serif'; context.fillText('RHINE', 210, 510);
  return canvas.toDataURL('image/png').split(',')[1];
}), 'base64'); await generator.close();
const albums = Array.from({ length: 96 }, (_, i) => ({ id: `fixture-${i}`, title: `Album ${i}`, artist: 'Fixture',
  genreId: `genre-${Math.floor(i / 12)}`, coverUrl: `/fixture-cover/${i}.png`, rawGenres: [], folder: '', tracks: [], producers: [], offline: false }));
const library = { version: 1, albums, genres: Array.from({ length: 8 }, (_, i) => ({ id: `genre-${i}`, name: `Genre ${i}` })), roots: [], scan: { running: false }, onlineEnabled: false };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.json': 'application/json', '.ogg': 'audio/ogg' };
const results = [];
const quick = process.argv.includes('--quick');
const playlistCase = process.argv.includes('--playlist');
const blockedCovers = process.argv.includes('--blocked-covers');
const liveCovers = process.argv.includes('--live-covers');
async function measure(label, root) {
  const store = new CoverCache({ dataDir: path.join(artifacts, label + '-cache') });
  let coverDownloads = 0;
  if (liveCovers) {
    const converter = await browser.newPage();
    const webp = Buffer.from(await converter.evaluate(async data => {
      const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      canvas.getContext('2d').drawImage(image, 0, 0, 256, 256); image.close();
      return canvas.toDataURL('image/webp', .86).split(',')[1];
    }, cover.toString('base64')), 'base64');
    await converter.close();
    for (let i = 0; i < 96; i++) await store.put(createHash('sha256').update(`cover-v1:256:/fixture-cover/${i}.png`).digest('hex'), webp);
  }
  const server = http.createServer(async (request, response) => {
    try {
      const route = new URL(request.url, 'http://fixture').pathname;
      const coverFile = /^\/api\/covers\/cache\/([a-f0-9]{64})$/.exec(route);
      const catalog = /^\/api\/covers\/catalog\/([a-f0-9]{64})$/.exec(route);
      if (route.startsWith('/fixture-cover/')) { coverDownloads++; if (blockedCovers) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(cover); return; }
      if (coverFile && request.method === 'PUT') { const chunks = []; for await (const chunk of request) chunks.push(chunk); await store.put(coverFile[1], Buffer.concat(chunks)); response.end('{}'); return; }
      if (coverFile) { const bytes = await store.get(coverFile[1]); response.writeHead(bytes ? 200 : 404, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }); response.end(bytes || ''); return; }
      if (catalog) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ urls: [] })); return; }
      if (route.startsWith('/api/')) {
        let value = {};
        if (route === '/api/library') value = library;
        else if (route.includes('/auth/status')) value = playlistCase && route.includes('/qq/') ? { loggedIn: true, profile: { userId: 'fixture-account', nickname: 'Fixture' } } : { loggedIn: false };
        else if (playlistCase && route === '/api/online/qq/playlists') value = { playlists: [{ id: 'test', name: '200-song playlist', owned: true, trackCount: 200 }], hasMore: false };
        else if (playlistCase && route === '/api/online/qq/playlists/test/tracks') {
          const offset = Number(new URL(request.url, 'http://fixture').searchParams.get('offset') || 0);
          value = { total: 200, tracks: Array.from({ length: 50 }, (_, index) => ({ id: `qq-${offset + index}`, title: `Song ${offset + index}`, artist: 'Fixture', albumId: 'test', album: 'Test', duration: 120,
            onlineSource: { provider: 'qq', id: `song-${offset + index}`, coverUrl: `/fixture-cover/song-${offset + index}.png` } })) };
        }
        else if (route === '/api/playlists/local') value = { playlists: [] };
        else if (route.startsWith('/api/covers/cache')) {
          if (request.method === 'POST' && route.endsWith('configure')) { let text = ''; for await (const chunk of request) text += chunk; value = await store.configure(JSON.parse(text)); }
          else { await store.init(); value = store.usage(); }
        } else if (route.startsWith('/api/audio/cache')) value = { bytes: 0, files: 0, limitBytes: 2048 * 1024 ** 2, cacheDir: 'fixture' };
        else if (route === '/api/audio/capabilities') value = { decoderAvailable: false, nativeAvailable: false, devices: [] };
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); return;
      }
      const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : decodeURIComponent(route)));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 1680, height: 960 }, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(preset => {
    localStorage.setItem('rhine-music-preferences', JSON.stringify({ quality: 'balanced', qualityMode: 'manual', renderQuality: preset,
      qualityPipelineVersion: 5, frameRate: 60, motionSpeed: 1, bgm: false, sound: false }));
    window.samples = { film: [], shelf: [], home: [], longTasks: [] }; let last, lastPhase;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) samples.longTasks.push({ at: entry.startTime, ms: entry.duration }); }).observe({ type: 'longtask', buffered: true });
    function frame(now) {
      const film = document.querySelector('.rhine-loading'), stage = document.querySelector('.music-app');
      const phase = film && !film.hidden && film.dataset.state === 'playing' ? 'film'
        : stage?.dataset.musicBoot === 'running' ? 'shelf' : stage?.dataset.musicBoot === 'done' ? 'home' : null;
      if (phase && last && lastPhase === phase) samples[phase].push(now - last);
      if (phase === 'shelf' && window.rhineMusic && !samples.firstCover) {
        const stats = window.rhineMusic.stats();
        if (stats?.arrayVisible && stats?.covers?.visiblePrints) samples.firstCover = { at: now,
          covers: stats.covers, loading: window.rhineMusic.coverLoading(), preparation: document.querySelector('#three-scene').dataset.startupPreparation };
      }
      last = now; lastPhase = phase; requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, qualityPresets.balanced);
  try {
    const started = Date.now(); await page.goto(`http://127.0.0.1:${server.address().port}/?scheduler=1${quick ? '&scene=archive' : ''}`);
    if (liveCovers) {
      await page.waitForFunction(() => samples.firstCover, null, { timeout: 90000 });
      await page.screenshot({ path: path.join(artifacts, label + '-first-frame.png') });
    }
    await page.waitForFunction(() => document.querySelector('.music-app')?.dataset.musicBoot === 'done', null, { timeout: 90000 });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(150); }
    await page.waitForTimeout(5000);
    const report = await page.evaluate(() => {
      const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { frames: values.length,
        p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1), over50: values.filter(x => x > 50).length }; };
      const stats = window.rhineMusic.stats();
      return { film: summarize(samples.film), shelf: summarize(samples.shelf), home: summarize(samples.home),
        longTasks: samples.longTasks, cpu: JSON.parse(document.querySelector('#three-scene').dataset.frameTiming || '{}'),
        graphics: stats?.graphics, gpu: stats?.gpuTiming, drawCalls: stats?.drawCalls, triangles: stats?.triangles,
        firstCover: samples.firstCover, optimization: stats?.optimization, visibleAlbumCells: stats?.visibleAlbumCells, loading: window.rhineMusic.coverLoading?.(), covers: stats?.covers };
    });
    assert.deepEqual(errors, [], label + ' has no runtime exceptions');
    if (liveCovers) {
      assert.equal(report.firstCover.loading.phase, 'intro');
      assert.equal(report.firstCover.covers.visibleImages, report.firstCover.covers.visiblePrints, 'every first-frame visible print is an uploaded real cover');
      assert.equal(report.firstCover.loading.diskHits, 96);
      assert.equal(report.firstCover.loading.completed, 96);
    }
    if (playlistCase) { assert.ok(report.visibleAlbumCells >= 200); assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playlistCell.total), 200); }
    if (!quick) assert.ok(report.film.frames > 200); assert.ok(report.shelf.frames > 30);
    await page.screenshot({ path: path.join(artifacts, label + '.png') });
    const result = { label, seconds: (Date.now() - started) / 1000, coverDownloads, ...report };
    results.push(result); console.log(JSON.stringify({ label, seconds: result.seconds, film: result.film, shelf: result.shelf,
      cpu: result.cpu, graphics: result.graphics, drawCalls: result.drawCalls }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({ label, errors, state: await page.evaluate(() => ({ film: document.querySelector('.rhine-loading')?.dataset.state,
      phase: document.querySelector('.music-app')?.dataset.musicBoot, loading: document.querySelector('#music-loading')?.textContent,
      presentation: window.rhineMusic?.presentation })) }));
    await page.screenshot({ path: path.join(artifacts, label + '-failure.png') }); throw error;
  } finally { await context.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
try {
  if (!process.argv.includes('--current-only')) await measure('before', path.resolve('release/Rhine-Music-Windows-019-sourcefix/runtime/dist'));
  await measure(liveCovers ? 'live-intro' : playlistCase ? 'playlist-no-covers' : 'after', path.resolve('dist'));
  await fs.writeFile(path.join(artifacts, liveCovers ? 'comparison-live-intro.json' : playlistCase ? 'comparison-playlist.json' : quick ? 'comparison-warm.json' : process.argv.includes('--current-only') ? 'comparison-current.json' : 'comparison.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
