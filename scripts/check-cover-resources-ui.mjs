import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CoverCache } from './cover-cache.mjs';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const generator = await browser.newPage();
const png = Buffer.from(await generator.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 32; c.height = 64;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#d79453'; ctx.fillRect(0, 0, 32, 64);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
await generator.close();
const bundle = await build({ stdin: { contents: `import { coverResources } from './src/cover-resources.ts';
  import { playlistCoverPreload } from './src/playlist-cover-preload.ts';
  window.covers=coverResources; window.preload=playlistCoverPreload;`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser' });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-cover-browser-'));
const store = new CoverCache({ dataDir: directory });
let sourceRequests = 0, active = 0, peak = 0, failMetadata = false, metadataActive = 0, metadataPeak = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  try {
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Cover resource fixture</title>'); return; }
    const file = /^\/api\/covers\/cache\/([a-f0-9]{64})$/.exec(url.pathname);
    const catalog = /^\/api\/covers\/catalog\/([a-f0-9]{64})$/.exec(url.pathname);
    if (file && request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      await store.put(file[1], Buffer.concat(chunks)); response.end('{}'); return;
    }
    if (file) {
      const bytes = await store.get(file[1]); response.writeHead(bytes ? 200 : 404, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }); response.end(bytes || ''); return;
    }
    if (catalog) {
      let value;
      if (request.method === 'PUT') { let text = ''; for await (const chunk of request) text += chunk; value = JSON.parse(text); }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await store.catalog(catalog[1], value))); return;
    }
    if (url.pathname.startsWith('/source/')) {
      sourceRequests++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); response.end(png); return;
    }
    if (url.pathname.startsWith('/api/online/qq/')) {
      if (failMetadata) { response.writeHead(503); response.end('{}'); return; }
      metadataActive++; metadataPeak = Math.max(metadataPeak, metadataActive);
      await new Promise(resolve => setTimeout(resolve, 2)); metadataActive--;
      const body = url.pathname.endsWith('/playlists')
        ? { playlists: [{ id: 'one', trackCount: 103 }, { id: 'two', trackCount: 51 }], hasMore: false }
        : { total: url.pathname.includes('/one/') ? 103 : 51, tracks: Array.from({ length: Math.min(50, (url.pathname.includes('/one/') ? 103 : 51) - Number(url.searchParams.get('offset'))) }, (_, i) => ({ onlineSource: { coverUrl: `https://cover.test/${url.pathname.includes('/one/') ? 'one' : 'two'}/${Number(url.searchParams.get('offset')) + i}` } })) };
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); return;
    }
    response.writeHead(404); response.end('{}');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const pageFor = async () => {
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(base); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return { context, page };
};
try {
  const first = await pageFor();
  await first.page.evaluate(() => { covers.enabled = true; for (let i = 0; i < 540; i++) covers.warm(`/source/${i}`); });
  await first.page.waitForFunction(() => covers.stats().requests >= 2);
  const paused = await first.page.evaluate(() => covers.stats());
  assert.equal(paused.decodes, 0); assert.equal(paused.completed, 0); assert.ok(paused.queued > 512);
  await first.page.evaluate(() => covers.setPhase('browse'));
  await first.page.waitForFunction(() => covers.stats().completed === 540, null, { timeout: 90000 });
  assert.equal(sourceRequests, 540); assert.ok(peak <= 4);
  assert.equal((await first.page.evaluate(() => covers.peek('/source/0'))).decodedSize, 256);
  await first.page.evaluate(() => covers.load('/source/0', 1024, true));
  assert.equal(await first.page.evaluate(() => covers.peek('/source/0').decodedSize), 1024, 'selected art upgrades beyond the cached thumbnail');
  assert.equal(sourceRequests, 541);
  await first.page.waitForFunction(() => !covers.stats().writing && !covers.stats().pendingWrites);
  await first.context.close();
  const second = await pageFor();
  await second.page.evaluate(() => {
    covers.enabled = true; covers.configureLowMemory(true); covers.setPhase('film'); window.peakDecodes = 0;
    window.decodeSampler = setInterval(() => peakDecodes = Math.max(peakDecodes, covers.stats().decodes), 2);
    for (let i = 0; i < 540; i++) covers.warm(`/source/${i}`);
  });
  await second.page.waitForFunction(() => covers.stats().completed === 540, null, { timeout: 90000 });
  assert.equal(sourceRequests, 541, 'new browser context reads disk and never re-downloads known covers');
  assert.equal(await second.page.evaluate(() => covers.stats().diskHits), 540);
  assert.equal(await second.page.evaluate(() => covers.stats().phase), 'film');
  assert.equal(await second.page.evaluate(() => peakDecodes), 1, 'film decodes disk hits, one at a time');
  assert.equal(await second.page.evaluate(() => covers.peek('/source/1').decodedSize),128,'low mode resizes the existing 256px disk cache locally');
  assert.equal(await second.page.evaluate(() => covers.stats().cacheLimitBytes),128*1024**2);
  await second.context.close();
  const scan = await pageFor();
  await scan.page.evaluate(() => { window.warmed = new Set(); covers.warm = url => warmed.add(url); preload.setPaused(false); preload.setAccount('qq', 'fixture-account'); });
  await scan.page.waitForFunction(() => warmed.size === 154);
  await scan.page.waitForFunction(async () => {
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('catalog-v1:qq:fixture-account')))].map(x => x.toString(16).padStart(2, '0')).join('');
    const response = await fetch('/api/covers/catalog/' + key); return (await response.json()).urls.length === 154;
  });
  assert.equal(await scan.page.evaluate(() => preload.snapshot(['qq']).playlists.length), 2);
  assert.equal(await scan.page.evaluate(() => preload.coverAt('qq', 'one', 102)), 'https://cover.test/one/102');
  assert.ok(metadataPeak <= 1, 'full scans reserve the other HTTP slot for navigation');
  await scan.context.close(); failMetadata = true;
  const restored = await pageFor();
  await restored.page.evaluate(() => { window.warmed = new Set(); covers.warm = url => warmed.add(url); preload.setAccount('qq', 'fixture-account'); });
  await restored.page.waitForFunction(() => warmed.size === 154);
  await restored.context.close();
  console.log(JSON.stringify({ covers: 540, sourceDownloadsAfterTwoContexts: sourceRequests, diskHitsOnRestart: 540,
    scanSongs: 154, maxBackgroundPages: metadataPeak, pausedDecodes: paused.decodes, cacheDirectory: directory }));
} finally { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
