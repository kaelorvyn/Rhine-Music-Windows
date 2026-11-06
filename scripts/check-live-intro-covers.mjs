// Real WebGL pixels from the production atlas; delayed network and disk writes
// distinguish decoded art, uploaded art and persistence completion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CoverCache } from './cover-cache.mjs';

const artifacts = path.resolve('artifacts/live-intro-covers');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const generator = await browser.newPage();
const images = await generator.evaluate(() => Object.fromEntries(['red', 'blue', 'green'].map(color => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 256, 256);
  return [color, c.toDataURL('image/png').split(',')[1]];
})));
await generator.close();
const code = await build({ stdin: { contents: `
import * as THREE from 'three';
import { CoverAtlas } from './src/cover-atlas.ts';
import { coverResources } from './src/cover-resources.ts';
window.covers = coverResources; covers.enabled = true;
window.setup = urls => {
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(640, 240); document.body.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-2, 6, 3.7, 0, .1, 30);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const atlas = new CoverAtlas(2, renderer.capabilities.maxTextureSize, 1);
  atlas.setFrameBudget(true); atlas.array.visible = true; scene.add(atlas.array);
  atlas.array.setMatrixAt(0, new THREE.Matrix4());
  atlas.array.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 0, 0));
  atlas.array.instanceMatrix.needsUpdate = true;
  let requests = urls.map((url, slot) => ({ slot, record: { id: url, title: url, album: { id: url, title: url, coverUrl: url } } }));
  atlas.prepareFrame(requests, 2, 1000);
  window.fixture = {
    prepare: () => atlas.prepareVisible(1200),
    change: (urls, newEntities = false) => {
      requests = urls.map((url, slot) => ({ slot, record: { id: (newEntities ? 'new-' : 'slot-') + slot, title: url, album: { id: 'slot-' + slot, title: url, coverUrl: url } } }));
      atlas.prepareFrame(requests, 0, 0);
    },
    paint: () => {
      atlas.prepareFrame(requests, 2, 1000); atlas.flushUploads(renderer, 2);
      renderer.render(scene, camera);
      const gl = renderer.getContext(), pixels = new Uint8Array(8);
      gl.readPixels(174, 120, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels.subarray(0, 4));
      gl.readPixels(494, 120, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels.subarray(4, 8));
      return { pixels: [...pixels], covers: atlas.getStats(), matrices: [...atlas.array.instanceMatrix.array], glError: gl.getError() };
    },
  };
};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const store = new CoverCache({ dataDir: await fs.mkdtemp(path.join(artifacts, 'cache-')) });
let requests = 0, releaseBlue, releaseWrite;
const blueGate = new Promise(resolve => { releaseBlue = resolve; });
const writeGate = new Promise(resolve => { releaseWrite = resolve; });
let holdBlue = false, holdWrite = false;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Live cover handoff</title>'); return; }
    const cache = /^\/api\/covers\/cache\/([a-f0-9]{64})$/.exec(url.pathname);
    if (cache) {
      if (req.method === 'PUT') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        if (holdWrite) await writeGate;
        await store.put(cache[1], Buffer.concat(chunks)); res.end('{}');
      } else {
        const data = await store.get(cache[1]);
        res.writeHead(data ? 200 : 404, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }); res.end(data || '');
      }
      return;
    }
    const color = url.pathname.slice(1);
    requests++;
    if (holdBlue && color === 'blue') await blueGate;
    if (!images[color]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(Buffer.from(images[color], 'base64'));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function pageFor() {
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(base); await page.addScriptTag({ content: code.outputFiles[0].text }); return { context, page };
}
const red = p => p[0] > 150 && p[1] < 50 && p[2] < 50;
const blue = p => p[2] > 150 && p[0] < 50 && p[1] < 50;
try {
  const prime = await pageFor();
  await prime.page.evaluate(async () => { covers.setPhase('browse'); await covers.load('/red', 256, true); });
  await prime.page.waitForFunction(() => !covers.stats().writing && !covers.stats().pendingWrites);
  await prime.context.close();
  const live = await pageFor();
  holdBlue = holdWrite = true;
  await live.page.evaluate(() => { covers.setPhase('film'); covers.warm('/red'); covers.warm('/blue'); });
  await live.page.waitForFunction(() => covers.stats().completed === 1);
  assert.equal(requests, 2, 'red is read from disk while the missing blue request waits');
  await live.page.evaluate(async () => { covers.setPhase('preparation'); setup(['/red', '/blue']); await fixture.prepare(); });
  const first = await live.page.evaluate(() => { covers.setPhase('intro'); return fixture.paint(); });
  await live.page.screenshot({ path: path.join(artifacts, 'first-frame.png') });
  assert.ok(red(first.pixels), 'cached red is real GPU-visible art in the first intro draw');
  assert.equal(first.covers.visibleImages, 1); assert.equal(first.glError, 0);
  await live.page.screenshot({ path: path.join(artifacts, 'first-frame.png') });
  releaseBlue();
  await live.page.waitForFunction(() => covers.stats().completed === 2);
  const middle = await live.page.evaluate(() => fixture.paint());
  assert.ok(blue(middle.pixels.slice(4)), 'new blue is displayed during intro, before its disk write finishes');
  assert.equal(middle.covers.visibleImages, 2);
  assert.deepEqual(middle.matrices, first.matrices, 'cover arrival does not move or reassign boxes');
  assert.equal(await live.page.evaluate(() => covers.stats().writing), true);
  await live.page.screenshot({ path: path.join(artifacts, 'middle-frame.png') });
  const home = await live.page.evaluate(() => { covers.setPhase('browse'); return fixture.paint(); });
  assert.deepEqual(home.pixels, middle.pixels, 'handoff reuses uploaded pixels');
  assert.equal(home.covers.uploadedTiles, middle.covers.uploadedTiles, 'handoff does not upload again');
  releaseWrite();
  await live.page.waitForFunction(() => !covers.stats().writing && !covers.stats().pendingWrites);
  await live.page.evaluate(async () => { covers.setPhase('intro'); fixture.change(['/blue', '/red']); await fixture.prepare(); });
  const swapped = await live.page.evaluate(() => fixture.paint());
  assert.ok(blue(swapped.pixels)); assert.ok(red(swapped.pixels.slice(4)), 'new ordering uses the new identities');
  const beforeHighResolution = requests;
  await live.page.evaluate(() => { window.hq = covers.load('/green', 1024, true); });
  await live.page.waitForTimeout(100);
  assert.equal(requests, beforeHighResolution, 'new high-resolution requests wait until browsing');
  await live.page.evaluate(async () => { covers.setPhase('browse'); await hq; });
  await live.page.waitForFunction(() => !covers.stats().writing && !covers.stats().pendingWrites);
  await live.page.evaluate(async () => { covers.setPhase('intro'); fixture.change(['/green', '/red']); await fixture.prepare(); });
  const changed = await live.page.evaluate(() => fixture.paint());
  assert.ok(changed.pixels[1] > 70 && changed.pixels[0] < 50 && changed.pixels[2] < 50, 'same record ID with a new cover uses green pixels');
  const failureStarted = Date.now();
  await live.page.evaluate(async () => { fixture.change(['/missing-one', '/missing-two']); await fixture.prepare(); });
  const failed = await live.page.evaluate(() => fixture.paint());
  assert.equal(failed.covers.visiblePrints, 2); assert.equal(failed.covers.visibleImages, 2);
  assert.deepEqual(failed.pixels, changed.pixels, 'failed replacement retains the same entities\' existing art');
  assert.ok(Date.now() - failureStarted < 2500, 'all-failed art keeps the preparation deadline');
  assert.equal(failed.glError, 0);
  await live.page.evaluate(async () => { fixture.change(['/missing-one', '/missing-two'], true); await fixture.prepare(); });
  const empty = await live.page.evaluate(() => fixture.paint());
  assert.equal(empty.covers.visiblePrints, 2); assert.equal(empty.covers.visibleImages, 0, 'new entities with failed art have physical placeholders');
  const report = { first, middle, home, swapped, changed, failed, originRequests: requests, scope: 'Production atlas, actual WebGL pixel readback; full app motion is tested separately.' };
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ firstFrameVisibleImages: first.covers.visibleImages, middleVisibleImages: middle.covers.visibleImages,
    uploadsAtHandoff: home.covers.uploadedTiles - middle.covers.uploadedTiles, actualGpuPixels: true, originRequests: requests }));
  await live.context.close();
} finally { releaseBlue(); releaseWrite(); await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
