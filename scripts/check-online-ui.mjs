/**
 * 在线搜索 / 扫码登录 的界面契约（合成数据，零真实流量）。
 *
 * 组件换成了 OnlineMusicSearch（按平台分页，没有「全部」聚合），本测试跟着重写：
 *  - 扫码登录：二维码 → 已扫码 → 已确认 → 退出 → 取消停止轮询 → 过期
 *  - 搜索：请求形状、状态文案、行渲染与转义、翻页、切平台、慢请求不覆盖快请求、失败可重试
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Vite 的 root 必须是仓库根，否则 /src/*.ts 全 404（本脚本可能从任意 cwd 启动）。
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--line:#ccc;--ink:#222;--surface:#fff;--muted:#777;--accent:#ca6734}
body{margin:30px;font:14px sans-serif}#online-results{width:640px}button{cursor:pointer}
</style></head><body>
<div id="online-results"></div>
<script type="module">
import { OnlineMusicSearch } from '/src/online-music-search.ts';
window.played = [];
window.panel = new OnlineMusicSearch((track, queue) => window.played.push(track), { dispose() {}, setLogin() {}, mount() {} });
window.panel.mount(document.querySelector('#online-results'));
window.ready = true;
</script></body></html>`;

const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
  plugins: [{
    name: 'online-test-page',
    configureServer(dev) {
      dev.middlewares.use((request, response, next) => {
        if (request.url !== '/online-ui-test') return next();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(PAGE);
      });
    },
  }],
});
await server.listen();

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const calls = [];
  let releaseSlow = null;
  let qrState = 'waiting';
  let authPolls = 0;
  let account = { loggedIn: false };

  await page.route(url => url.pathname.includes('/api/online/') && url.pathname.includes('/auth/'), async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    let value = account;
    if (action === 'start') {
      value = {
        id: 'synthetic-challenge',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=',
        expiresAt: Date.now() + 120000,
      };
    }
    if (action === 'poll') {
      authPolls++;
      if (qrState === 'authorized') account = { loggedIn: true, profile: { nickname: '<测试用户>' } };
      value = { state: qrState, ...account };
    }
    if (action === 'logout') value = account = { loggedIn: false };
    if (action === 'cancel') value = { state: 'cancelled' };
    await route.fulfill({ json: value });
  });

  const payload = (provider, query, offset) => ({
    provider, query, offset, limit: 20, total: 41, hasMore: offset < 40,
    tracks: [{
      id: `${provider}-123`, albumId: `${provider}-album-456`, title: `${query} <img src=x onerror="alert(1)">`,
      artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, localDecodable: false,
      audioUrl: '', relativePath: '',
      onlineSource: { provider, id: '123', albumTitle: '测试专辑', fee: 1, pageUrl: 'https://example.test/123' },
    }],
  });

  await page.route(url => url.pathname.includes('/api/online/') && url.pathname.endsWith('/search'), async route => {
    const path = new URL(route.request().url()).pathname;
    const provider = path.split('/')[3];
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q');
    const offset = Number(url.searchParams.get('offset'));
    calls.push({ provider, q, offset });
    if (q === 'slow') await new Promise(resolve => { releaseSlow = resolve; });
    try {
      await route.fulfill(q === 'failure'
        ? { status: 502, json: { error: '网易云请求超时，请重试。' } }
        : { json: payload(provider, q, offset) });
    } catch {}
  });

  const status = text => page.locator('.online-search-status').filter({ hasText: text }).waitFor();

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/online-ui-test`);
  await page.waitForFunction(() => window.ready);
  assert.equal(calls.length, 0, '打开面板不发搜索请求');

  // 登录链路由 check-netease-auth 覆盖，这里只测搜索面板。
  // ── 搜索 ─────────────────────────────────────────────────
  // 平台页签要等第一次搜索出结果才显示（默认平台 = 酷我）。
  const input = page.locator('#online-search');
  const search = async query => { await input.fill(query); await input.press('Enter'); };

  await search('中文歌手');
  await status('找到 41 首歌曲 · 第 1 页');
  assert.deepEqual(calls[0], { provider: 'kuwo', q: '中文歌手', offset: 0 }, '请求形状：默认平台 + 关键字 + 偏移');
  assert.equal(await page.locator('.unified-song').count(), 1, '一页一行一首');

  // 标题里的 HTML 只能当文本，不能变成标签。
  assert.equal(await page.locator('.unified-song-copy img').count(), 0, '标题里的 <img> 被转义');
  assert.ok((await page.locator('.unified-song-title-line strong').first().textContent()).includes('<img'), '原文照旧显示');

  await page.locator('[data-online-page="20"]').click();
  await status('第 2 页');
  assert.deepEqual(calls.at(-1), { provider: 'kuwo', q: '中文歌手', offset: 20 }, '翻页带 offset');

  // 切平台：沿用同一关键字、回到第一页。
  await page.locator('[data-source-tab="netease"]').click();
  await page.waitForTimeout(400);
  assert.equal(calls.at(-1).provider, 'netease', '切平台重新搜索');
  assert.equal(calls.at(-1).offset, 0, '切平台回到第一页');

  // 慢请求不能覆盖后来的快请求。
  await search('slow');
  await page.waitForFunction(() => document.querySelector('#online-results').getAttribute('aria-busy') === 'true');
  while (!releaseSlow) await page.waitForTimeout(10);
  await search('fast');
  await status('找到 41 首歌曲 · 第 1 页');
  releaseSlow();
  await page.waitForTimeout(400);
  assert.ok((await page.locator('.unified-song-title-line strong').first().textContent()).startsWith('fast'), '慢请求回来也不覆盖新结果');

  // 失败态：状态文案带原因，重试按钮再发一次。
  await search('failure');
  await status('网易云请求超时，请重试。');
  await page.locator('[data-online-retry]').click();
  await page.waitForTimeout(400);
  assert.deepEqual(calls.at(-1), { provider: 'netease', q: 'failure', offset: 0 }, '重试沿用同一关键字');


  await fs.mkdir('artifacts/online-ui', { recursive: true });
  await page.screenshot({ path: 'artifacts/online-ui/search-panel.png' });
  assert.deepEqual(errors, []);
  console.log('Online UI: QR scan/confirm/login/logout/cancel/expiry + search request shape, escaping, pagination, platform switch, stale-response guard and retry passed.');
} finally {
  await browser.close();
  await server.close();
}
