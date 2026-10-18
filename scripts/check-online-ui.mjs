import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'online-test-page', configureServer(server) { server.middlewares.use((request, response, next) => {
  if (request.url !== '/online-ui-test') return next();
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<html><head><style>:root{--line:#ccc;--ink:#222;--surface:#fff;--muted:#777;--accent:#ca6734}body{margin:30px;font:14px sans-serif}#online-results{width:500px}button{cursor:pointer}</style></head><body><section class="netease-login" id="login-entry"></section><div id="online-results"></div><script type="module">import {OnlineSearchPanel} from '/src/online-search-panel.ts';import {NeteaseLogin} from '/src/netease-login.ts';window.results=[];window.login=new NeteaseLogin(()=>{});window.login.mount(document.querySelector('#login-entry'));window.panel=new OnlineSearchPanel(result=>window.results.push(result));window.panel.mount(document.querySelector('#online-results'));window.ready=true;</script></body></html>`);
}); } }] });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = []; let releaseSlow;
  let account = { loggedIn: false }, qrState = 'waiting', authPolls = 0;
  await page.route('**/api/online/netease/auth/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    let value = account;
    if (action === 'start') value = { id: 'synthetic-challenge', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 };
    if (action === 'poll') { authPolls++; if (qrState === 'authorized') account = { loggedIn: true, profile: { nickname: '<测试用户>' } }; value = { state: qrState, ...account }; }
    if (action === 'logout') value = account = { loggedIn: false };
    if (action === 'cancel') value = { state: 'cancelled' };
    await route.fulfill({ json: value });
  });
  const result = (query, offset = 0) => ({ provider: 'netease', query, offset, limit: 20, total: 41, hasMore: offset < 40,
    tracks: [{ id: 'netease-123', albumId: 'netease-album-456', title: `${query} <img src=x onerror="alert(1)">`, artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, localDecodable: false, audioUrl: '', relativePath: '',
      onlineSource: { provider: 'netease', id: '123', albumTitle: '测试专辑', fee: 1, pageUrl: 'https://music.163.com/#/song?id=123' } }] });
  await page.route('**/api/online/netease/search?*', async route => {
    const url = new URL(route.request().url()); const q = url.searchParams.get('q'), offset = Number(url.searchParams.get('offset')); calls.push({ q, offset });
    if (q === 'slow') await new Promise(resolve => releaseSlow = resolve);
    try { await route.fulfill(q === 'failure' ? { status: 502, json: { error: '网易云请求超时，请重试。' } } : { json: result(q, offset) }); } catch {}
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/online-ui-test`);
  await page.waitForFunction(() => window.ready); assert.equal(calls.length, 0);
  await page.getByRole('button', { name: '扫码登录', exact: true }).click(); await page.getByAltText('网易云音乐登录二维码').waitFor();
  qrState = 'scanned'; await page.locator('.netease-auth-status').filter({ hasText: '已扫码' }).waitFor();
  qrState = 'authorized'; await page.locator('.netease-account').filter({ hasText: '<测试用户>' }).waitFor();
  assert.equal(await page.locator('.netease-account img').count(), 0);
  assert.equal(await page.locator('.netease-qr').count(), 0);
  await page.getByRole('button', { name: '退出登录' }).click(); await page.locator('.netease-auth-status').filter({ hasText: '已退出' }).waitFor();
  qrState = 'waiting'; await page.getByRole('button', { name: '扫码登录', exact: true }).click(); await page.getByAltText('网易云音乐登录二维码').waitFor();
  assert.equal(await page.getByRole('button', { name: '取消登录', exact: true }).count(), 0);
  await page.evaluate(() => { window.panel.dispose(); window.login.dispose(); });
  const before = authPolls; await page.waitForTimeout(2100); assert.equal(authPolls, before, 'cancelling login stops polling');
  await page.evaluate(() => {
    const previous = document.querySelector('#online-results'), next = previous.cloneNode(false);
    previous.replaceWith(next); window.panel.mount(next); window.login.dispose(); window.login.mount(document.querySelector('#login-entry'));
  });
  qrState = 'expired'; await page.getByRole('button', { name: '扫码登录', exact: true }).click(); await page.locator('.netease-auth-status').filter({ hasText: '已过期' }).waitFor();
  assert.equal(await page.locator('.netease-qr').count(), 0);
 // The search box carries the platform selector (搜索平台) alongside the query.
  assert.deepEqual(await page.locator('#online-search-source option').allTextContents(),
    ['全部', '网易云', 'QQ', '波点', '酷狗', '酷我', 'JOOX']);
  assert.equal(await page.locator('#online-results .netease-login, #online-results .netease-account, #online-results .netease-auth-status').count(), 0,
    'the search panel shows no account/login state (login lives in the avatar entry)');
  await page.locator('#online-search-source').selectOption('netease');
  const input = page.getByRole('searchbox');
  const search = async query => { await input.fill(query); await input.press('Enter'); };
  await search('中文歌手'); await page.locator('.online-search-status').filter({ hasText: '找到 41' }).waitFor();
  assert.deepEqual(calls[0], { q: '中文歌手', offset: 0 });
 // The panel hands the raw merged rows to the app's 3D pipeline (rendering
 // safety is asserted where the rows render — check-search-ui).
  assert.equal((await page.evaluate(() => window.results[0].rows[0].track.id)), 'netease-123');
  assert.equal((await page.evaluate(() => window.results[0].rows[0].track.title)).includes('<img'), true);
  assert.equal((await page.evaluate(() => window.results[0].source)), 'netease');
  await page.getByRole('button', { name: '下一页 →' }).click(); await page.locator('.online-search-status').filter({ hasText: '第 2 页' }).waitFor();
  assert.deepEqual(calls.at(-1), { q: '中文歌手', offset: 20 });
  await search('slow'); await page.waitForFunction(() => document.querySelector('#online-results').getAttribute('aria-busy') === 'true');
  while (!releaseSlow) await page.waitForTimeout(10);
  await search('fast'); await page.waitForFunction(() => window.results.at(-1)?.query === 'fast');
  releaseSlow(); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.results.at(-1).query), 'fast', 'a slow earlier search cannot overwrite a faster one');
  await search('failure'); await page.locator('.online-search-status').filter({ hasText: '请求超时' }).waitFor();
  await page.getByRole('button', { name: '重新搜索 ↻' }).click(); await page.waitForTimeout(100);
  assert.deepEqual(calls.at(-1), { q: 'failure', offset: 0 });
  await search('中文歌手'); await page.locator('.online-search-status').filter({ hasText: '找到 41' }).waitFor();
  await fs.mkdir('artifacts/online-ui', { recursive: true });
  await page.screenshot({ path: 'artifacts/online-ui/search-panel.png' });
  await page.evaluate(() => window.panel.dispose());
  assert.deepEqual(errors, []);
  console.log('Online UI: QR scan/confirm/login/logout/cancel/expiry and Chinese search, platform selector, pagination, results hand-off, stale requests and retry passed.');
} finally { await browser.close(); await server.close(); }
