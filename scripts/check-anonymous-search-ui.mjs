// Actual search component: direct anonymous Kuwo and recovery from other platforms' failures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { KuwoCatalog } from './kuwo-protocol.mjs';

const live = process.argv.includes('--live'), calls = [], errors = [];
const catalog = new KuwoCatalog({ fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) });
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {OnlineMusicSearch} from './src/online-music-search.ts';
const view=new OnlineMusicSearch(()=>{});view.mount(document.querySelector('main'));
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = await fs.readFile('src/online-music-search.css', 'utf8');
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<style>[hidden]{display:none!important}</style><div class="music-app"><main></main></div>'); return; }
    if (url.pathname.startsWith('/api/')) {
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/online/netease/search') { json(401, { error: '请先登录网易云音乐。' }); return; }
      if (url.pathname === '/api/online/kuwo/search') {
        const q = url.searchParams.get('q'), offset = Number(url.searchParams.get('offset') || 0);
        const value = live ? await catalog.search(q, offset) : { provider: 'kuwo', query: q, offset, limit: 20, total: 40, hasMore: offset === 0,
          tracks: [{ id: 'kuwo-' + offset, title: '青花瓷 ' + offset, artist: '测试歌手', duration: 200,
            onlineSource: { provider: 'kuwo', id: String(offset), albumTitle: '测试专辑', pageUrl: 'https://www.kuwo.cn/' } }] };
        json(200, value); return;
      }
      json(503, { error: '模拟平台暂时不可用' }); return;
    }
    response.writeHead(404); response.end();
  } catch (error) { json(502, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  assert.ok(await page.locator('[data-source-tab="kuwo"]').isHidden(), 'platforms stay hidden before submitting a search');
  assert.equal(await page.locator('[data-source-tab="netease"]').getAttribute('aria-selected'), 'true', 'default remains NetEase');
  await page.locator('#online-search').fill('青花瓷');
  assert.ok(await page.locator('[data-source-tab="kuwo"]').isHidden(), 'typing alone does not reveal platforms');
  assert.equal(calls.length, 0);
  await page.locator('#online-search').press('Enter');
  await page.locator('[data-online-retry]').waitFor();
  assert.match(await page.locator('.online-search-status').innerText(), /登录网易云/);
  assert.ok(await page.locator('[data-source-tab="kuwo"]').isVisible(), 'a failed default search must not hide anonymous platforms');
  await page.locator('[data-source-tab="kuwo"]').click();
  await page.locator('.unified-song').first().waitFor();
  const firstPage = await page.locator('.unified-song').count();
  assert.ok(firstPage > 0); assert.equal(await page.locator('[data-source-tab="kuwo"]').getAttribute('aria-selected'), 'true');
  await page.locator('[data-online-page="20"]').click();
  await page.waitForFunction(() => !document.querySelector('main').hasAttribute('aria-busy'));
  assert.ok(await page.locator('.unified-song').count() > 0, 'anonymous second page');
  await page.locator('[data-source-tab="qishui"]').click(); await page.locator('[data-online-retry]').waitFor();
  assert.ok(await page.locator('[data-source-tab="kuwo"]').isVisible());
  assert.equal(await page.locator('[data-source-tab="qishui"]').getAttribute('aria-selected'), 'true', 'failed tab remains selected');
  await page.locator('[data-source-tab="kuwo"]').click(); await page.locator('.unified-song').first().waitFor();
  assert.ok(!calls.some(url => url.includes('/auth/')), 'search never asks for login');
  assert.ok(calls.some(url => url.includes('/kuwo/search?') && url.includes('offset=20')));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, liveKuwo: live, firstPage, anonymous: true, authenticationRequests: 0, pagination: true, recoveryAfterFailure: true, errors }));
} finally { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
