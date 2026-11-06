import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { platformCover, platformMediaUrl, PlatformCoverStore } from './platform-media.mjs';
import { qishuiTrack } from './qishui-catalog.mjs';

const remote = 'https://p3-luna.douyinpic.com/img/synthetic-cover~tplv-b829550vbb-15.webp';
const bytes = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) });
test('Qishui cover URLs use the bounded local proxy, never an arbitrary image host', () => {
  assert.equal(platformCover('qishui', remote), '/api/online/qishui/cover?url=' + encodeURIComponent(remote));
  assert.equal(platformMediaUrl('qishui', remote), undefined);
  for (const value of ['https://127.0.0.1/cover', 'https://douyinpic.com.evil.test/image', 'https://user@p3-luna.douyinpic.com/image', 'https://p3-luna.douyinpic.com:8443/image', 'file:///image']) assert.equal(platformCover('qishui', value), undefined);
});

test('Qishui proxy reuses image bytes without forwarding account credentials', async () => {
  let calls = 0;
  const store = new PlatformCoverStore(async (url, init) => {
    calls++; assert.equal(url, remote); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Referer, 'https://qishui.com/'); assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers.Authorization, undefined);
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  });
  const images = await Promise.all([store.get('qishui', remote), store.get('qishui', remote)]);
  assert.equal(calls, 1); assert.deepEqual(images[0].bytes, bytes);
  await store.get('qishui', remote); assert.equal(calls, 1);
});

test('normalized Qishui cover can be fetched, decoded and drawn in a browser without CDN CORS', async () => {
  const coverUrl = qishuiTrack({ id: '1', album: { url_cover: { uri: remote } } }).onlineSource.coverUrl;
  const store = new PlatformCoverStore(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/online/qishui/cover') {
      try { const image = await store.get('qishui', url.searchParams.get('url')); response.writeHead(200, { 'Content-Type': image.type }); response.end(image.bytes); }
      catch { response.writeHead(400); response.end(); } return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Cover fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async url => {
      const response = await fetch(url, { mode: 'cors' });
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const drawing = canvas.getContext('2d'); drawing.drawImage(bitmap, 0, 0); const pixels = drawing.getImageData(0, 0, 1, 1).data;
      bitmap.close(); return { status: response.status, width: canvas.width, height: canvas.height, pixelBytes: pixels.length };
    }, coverUrl);
    assert.deepEqual(result, { status: 200, width: 1, height: 1, pixelBytes: 4 });
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
