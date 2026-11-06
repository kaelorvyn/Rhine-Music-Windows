import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import * as THREE from 'three';
import { CoverAtlas } from './src/cover-atlas.ts';
import { coverResources } from './src/cover-resources.ts';
import { NeteasePlaylists } from './src/netease-playlists.ts';
window.run = async () => {
  const result = {}, waiting = new Map();
  const image = color => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 256, 256);
    return { source: canvas, width: 256, height: 256, decodedSize: 256, pixels: 65536 }; };
  const red = image('red'), blue = image('blue');
  coverResources.enabled = true; coverResources.images.set('/art', red);
  coverResources.load = async url => url === '/failed-update' ? undefined : coverResources.peek(url) || new Promise(resolve => waiting.set(url, resolve));
  const renderer = new THREE.WebGLRenderer(), atlas = new CoverAtlas(8, renderer.capabilities.maxTextureSize, 1);
  atlas.setFrameBudget(true);
  const record = (i, full, url = '/art', track = 's' + i) => ({ id: (full ? 'playlist-' : 'pending-') + i,
    title: full ? 'Song ' + i : 'Playlist', album: { coverUrl: url, tracks: full ? [{ id: track }] : [],
      playlistCell: { provider: 'qq', playlistId: 'p', songIndex: i, playlistIndex: 0, total: 8 } } });
  const requests = full => Array.from({ length: 8 }, (_, slot) => ({ slot, record: record(slot, full) }));
  atlas.prepareFrame(requests(false), 8, 10000); atlas.flushUploads(renderer, 8);
  const uploaded = atlas.getStats().uploadedTiles;
  atlas.prepareFrame(requests(true), 2, 10000); atlas.flushUploads(renderer, 1);
  result.metadata = { images: atlas.getStats().visibleImages, extraUploads: atlas.getStats().uploadedTiles - uploaded };
  // Finish outstanding work so the next check isolates replacement behavior.
  atlas.prepareFrame(requests(true), 8, 10000); atlas.flushUploads(renderer, 8);
  const changed = [{ slot: 0, record: record(0, true, '/new-art') }];
  atlas.prepareFrame(changed, 8, 10000); atlas.flushUploads(renderer, 8);
  result.replacement = { beforeArrival: atlas.array.geometry.attributes.coverReady.getX(0), images: atlas.getStats().visibleImages };
  coverResources.images.set('/new-art', blue); waiting.get('/new-art')?.(blue);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  atlas.prepareFrame(changed, 8, 10000); atlas.flushUploads(renderer, 8);
  result.replacement.afterArrival = atlas.array.geometry.attributes.coverReady.getX(0);
  const pixel = new Uint8Array(4), target = new THREE.WebGLRenderTarget(256, 256);
  // copyTextureToTexture already exercised real GPU upload; read the uploaded
  // tile through a separate target rather than treating a CPU paint as display.
  const material = new THREE.MeshBasicMaterial({ map: atlas.array.material.map });
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); scene.add(quad); camera.position.z = 1;
  renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 8, 128, 1, 1, pixel);
  result.replacement.gpuPixel = [...pixel]; renderer.setRenderTarget(null);
  await atlas.select(record(0, true)); await atlas.select(record(0, true, '/failed-update'));
  result.selectedFailure = [...atlas.selectedCanvas.getContext('2d').getImageData(512, 512, 1, 1).data];
  // A new song occupying the same physical slot must hide the prior song's art.
  atlas.prepareFrame([{ slot: 0, record: record(0, true, '/other', 'another-song') }], 0, 10000);
  result.newSongReady = atlas.array.geometry.attributes.coverReady.getX(0);
  waiting.get('/other')?.(undefined);
  atlas.reset(); result.resetImages = atlas.getStats().visibleImages; atlas.dispose();
  target.dispose(); material.dispose(); quad.geometry.dispose(); renderer.dispose(); renderer.forceContextLoss();

  const budget = new CoverAtlas(16, 8192, 1); budget.setFrameBudget(true);
  budget.prepareFrame(Array.from({ length: 16 }, (_, slot) => ({ slot, record: record(slot, true) })), 0, 0);
  const originalNow = performance.now.bind(performance); let elapsed = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  const setSlot = budget.setSlot.bind(budget); budget.setSlot = (...args) => { setSlot(...args); elapsed += 5; };
  try { await budget.prepareVisible(1200); result.prepared = budget.slotKeys.filter(key => key !== undefined).length; }
  finally { Object.defineProperty(performance, 'now', { configurable: true, value: originalNow }); budget.dispose(); }

  const track = i => ({ id: 's' + i, title: 'Song ' + i, artist: 'Fixture', album: 'Fixture', duration: 120,
    onlineSource: { provider: 'qq', id: 's' + i, coverUrl: '/art' } });
  const snapshot = () => ({ playlists: [{ id: 'p', name: 'Playlist', trackCount: 8, provider: 'qq' }],
    pages: [['qq:p:0', Array.from({ length: 8 }, (_, i) => track(i))]], complete: false });
  const oldFetch = window.fetch; let mode = 'success', release;
  window.fetch = async url => {
    if (!String(url).startsWith('/api/online/qq/') && !String(url).startsWith('/api/online/netease/')) return oldFetch(url);
    await new Promise(resolve => setTimeout(resolve, 30));
    if (mode === 'hold') await new Promise(resolve => { release = resolve; });
    if (mode === 'fail' || mode === 'partial' && String(url).includes('/netease/') || mode === 'second-page-fails' && String(url).includes('offset=100'))
      return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(String(url).includes('/tracks?')
      ? mode === 'malformed' ? { total: 0, tracks: null } : { total: 8, tracks: Array.from({ length: 8 }, (_, i) => track(i)) }
      : { playlists: mode === 'empty' ? [] : [{ id: 'p', name: 'Playlist', trackCount: 8 }], hasMore: mode === 'second-page-fails' }), { headers: { 'Content-Type': 'application/json' } });
  };
  const events = [], list = new NeteasePlaylists(() => events.push(list.albums().length));
  list.setProviders(['qq']); list.adoptSnapshot(snapshot());
  const refresh = list.load({ keepSnapshot: true }); result.reloadDuring = list.albums().length; await refresh;
  result.reloadEvents = [...events];
  mode = 'fail'; await list.load({ keepSnapshot: true }); result.failedRefresh = list.albums().length;
  mode = 'empty'; await list.load({ keepSnapshot: true }); result.confirmedEmpty = list.albums().length;
  list.adoptSnapshot(snapshot()); mode = 'malformed'; await list.load({ keepSnapshot: true }); result.malformedPage = list.albums().length;
  mode = 'second-page-fails'; await list.load({ keepSnapshot: true }); result.incompleteCatalog = list.albums().length;
  list.setProviders(['qq', 'netease']);
  const other = snapshot(); other.playlists[0].provider = 'netease'; other.pages[0][0] = 'netease:p:0';
  list.adoptSnapshot({ playlists: [...snapshot().playlists, ...other.playlists], pages: [...snapshot().pages, ...other.pages], complete: true });
  mode = 'partial'; await list.load({ keepSnapshot: true }); result.partialProviders = list.albums().length;
  list.setProviders(['qq']);
  list.adoptSnapshot(snapshot()); mode = 'hold'; const stale = list.load({ keepSnapshot: true });
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  list.dispose(); mode = 'success'; release(); await stale; result.afterDispose = list.albums().length;
  window.fetch = oldFetch; return result;
};` }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Entry continuity regression</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text }); const result = await page.evaluate(() => run());
  const checks = [
    ['metadata keeps all uploaded covers', () => { assert.equal(result.metadata.images, 8); assert.equal(result.metadata.extraUploads, 0); }],
    ['replacement keeps the old cover until upload', () => { assert.equal(result.replacement.beforeArrival, 1); assert.equal(result.replacement.images, 8); assert.equal(result.replacement.afterArrival, 1); assert.ok(result.replacement.gpuPixel[2] > 150); }],
    ['true song replacement cannot show old artwork', () => assert.equal(result.newSongReady, 0)],
    ['selected print survives a failed same-song update', () => { assert.ok(result.selectedFailure[0] > 200); assert.equal(result.selectedFailure[1], 0); }],
    ['reset releases uploaded ownership', () => assert.equal(result.resetImages, 0)],
    ['slow preparation does not skip requests', () => assert.equal(result.prepared, 16)],
    ['refresh retains its snapshot throughout', () => { assert.equal(result.reloadDuring, 8); assert.ok(result.reloadEvents.every(count => count === 8)); }],
    ['failed refresh preserves the last view', () => assert.equal(result.failedRefresh, 8)],
    ['confirmed empty catalog removes its contents', () => assert.equal(result.confirmedEmpty, 0)],
    ['invalid song pages cannot erase the last snapshot', () => assert.equal(result.malformedPage, 8)],
    ['an incomplete catalog cannot delete old entries', () => assert.equal(result.incompleteCatalog, 8)],
    ['one failed platform retains its prior playlists', () => assert.equal(result.partialProviders, 16)],
    ['dispose rejects a stale private response', () => assert.equal(result.afterDispose, 0)],
  ];
  const failures = [];
  for (const [name, check] of checks) { try { check(); console.log('PASS ' + name); } catch (error) { failures.push({ name, error: error.message }); console.log('FAIL ' + name); } }
  const out = path.resolve('artifacts/entry-continuity'); await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'regression.json'), JSON.stringify({ result, failures }, null, 2));
  console.log(JSON.stringify({ result, failures: failures.length }));
  if (failures.length) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
