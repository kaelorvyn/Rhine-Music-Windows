import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import { NeteaseLogin } from './src/netease-login.ts';window.login=new NeteaseLogin(a=>window.account=a,'kuwo');window.login.mount(document.querySelector('main'),true);`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const css = await fs.readFile('src/online-music-search.css', 'utf8');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=';
let loggedIn = false, scanned = false, polls = 0;
const calls = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><main class="netease-login"></main></html>'); return; }
  calls.push(req.url);
  const action = req.url.split('/').at(-1);
  const value = action === 'status' ? { loggedIn } : action === 'start' ? { id: 'fixture-qr', image, expiresAt: Date.now() + 120000 }
    : action === 'poll' ? (polls++, loggedIn ? { state: 'authorized', loggedIn: true, profile: { userId: '123', nickname: '酷我测试用户' } } : { state: scanned ? 'scanned' : 'waiting' })
    : action === 'logout' ? (loggedIn = false, { loggedIn }) : { state: 'cancelled' };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const width of [360, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } }); page.on('pageerror', e => errors.push(e.message));
    loggedIn = false; scanned = false;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addStyleTag({ content: `:root{--ink:#292b2c;--line:#ddd;--panel:#fff;--surface:#f5f5f5}body{margin:16px;font:14px sans-serif}.text-button{min-height:44px}main{max-width:460px}` + css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByAltText('酷我音乐登录二维码').waitFor();
    assert.match(await page.locator('[role="status"]').textContent(), /微信扫码.*酷我账号/);
    assert.equal(await page.locator('input').count(), 0, 'QR only, no phone or password fields');
    assert.ok(await page.locator('[data-netease-auth="start"]').evaluate(e => e.classList.contains('text-button')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    const output = new URL(`../../../work/kuwo-login-20261101/login-${width}.png`, import.meta.url);
    await page.screenshot({ path: fileURLToPath(output), fullPage: true });
    scanned = true; await page.getByText('已扫码，等待确认。', { exact: true }).waitFor();
    loggedIn = true; await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
    assert.equal(await page.locator('.netease-qr').count(), 0); assert.equal(await page.evaluate(() => window.account.loggedIn), true);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '扫码登录', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.account.loggedIn), false);
    await page.evaluate(() => window.login.dispose()); const before = polls;
    await page.waitForTimeout(1900); assert.equal(polls, before, 'dispose stops old polls');
    await page.close();
  }
  assert.deepEqual(errors, []); assert.ok(calls.every(c => c.startsWith('/api/online/kuwo/auth/')));
  console.log(JSON.stringify({ passed: true, widths: [360, 1280], qrOnly: true, authorizedAndLogout: true, disposedPolling: true, errors }));
} finally { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
