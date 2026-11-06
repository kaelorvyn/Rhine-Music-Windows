import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const bundle = await build({ stdin: { contents: `import { QishuiLogin } from './src/qishui-login.ts';window.login=new QishuiLogin(a=>window.account=a);await window.login.status();window.login.mount(document.querySelector('main'),true);`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const css = await fs.readFile('src/online-music-search.css', 'utf8');
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><main class="netease-login"></main></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const errors = [], output = path.resolve('../../work/qishui-dual-20261102');
const fixtureQr = await QRCode.toDataURL('https://example.invalid/synthetic-login-fixture', { width: 240, margin: 2 });
try {
  for (const width of [360, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    let loggedIn = false, risk = false, limited = false, failLogin = false, id = '11111111-1111-4111-8111-111111111111';
    const calls = [];
    await page.route('**/api/online/qishui/auth/*', route => {
      const request = route.request(), action = new URL(request.url()).pathname.split('/').at(-1);
      calls.push({ action, body: request.postDataJSON() });
      if (action === 'send-code' && limited) return route.fulfill({ status: 429, json: { error: '汽水拒绝了本次请求（错误码 7）', retryAfter: 120 } });
      if (action === 'sms-login' && failLogin) return route.fulfill({ status: 502, json: { error: '汽水登录未成功（错误码 2046）：本次登录请求未通过' } });
      return route.fulfill({ json: action === 'status' ? { loggedIn } : action === 'send-code' ? { state: risk ? 'verification' : 'sent', id, retryAfter: 60 }
        : action === 'start' ? { id, state: 'waiting', image: fixtureQr, expiresAt: Date.now() + 120000 }
        : action === 'poll' ? { state: 'waiting' }
        : action === 'sms-login' ? (loggedIn = true, { loggedIn, profile: { userId: '123', nickname: '测试账号' } })
        : action === 'logout' ? (loggedIn = false, { loggedIn }) : { state: 'cancelled' } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addStyleTag({ content: `:root{--ink:#292b2c;--line:#ddd;--panel:#fff;--surface:#f5f5f5;--accent:#497552}body{margin:16px;font:14px sans-serif}main{max-width:460px}.text-button{padding:8px 12px;background:transparent;border:0;color:var(--ink);font:inherit}.text-button:disabled{opacity:.5}` + css });
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = { invoke: async (...args) => { window.nativeRequest = args; } }; });
    await page.addScriptTag({ content: bundle.outputFiles[0].text, type: 'module' });
    await page.getByRole('button', { name: '获取验证码', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-sms-action="send-code"]').disabled);
    assert.equal(calls.filter(c => c.action === 'status').length, 2, 'startup status works before mount');
    await page.locator('.netease-qr img').waitFor({ state: 'visible' });
    assert.ok(calls.every(c => ['status', 'start'].includes(c.action)), 'mount requests QR but never sends SMS');
    assert.equal(await page.locator('img').count(), 1);
    const phone = page.getByRole('textbox', { name: '手机号', exact: true });
    const code = page.getByRole('textbox', { name: '验证码', exact: true });
    await phone.fill('13800000000');
    await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await page.getByText('验证码已发送，请查看手机短信。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /秒后重发/ }).isDisabled(), true);
    await code.fill('123456');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `sms-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.account.loggedIn), true);
    assert.equal(await page.locator('form').isVisible(), false, 'logged-in form is hidden');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByText('已退出汽水音乐登录。', { exact: true }).waitFor();
    await page.evaluate(() => window.login.mount(document.querySelector('main')));
    await page.waitForFunction(() => !document.querySelector('[data-sms-action="send-code"]').disabled);
    await phone.fill('13900000000'); risk = true;
    await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await page.waitForFunction(() => window.nativeRequest?.[0] === 'desktop_qishui_verify' && window.nativeRequest?.[1].purpose === 'verification');
    assert.equal(await page.evaluate(() => window.nativeRequest[1].id), id);
    assert.equal(await phone.isDisabled(), true);
    risk = false;
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('rhine-qishui-verification', { detail: { id, success: true, purpose: 'verification' } })), id);
    await page.getByText('验证码已发送，请查看手机短信。', { exact: true }).waitFor();
    assert.equal(calls.filter(c => c.action === 'send-code').length, 3, 'one explicit verification retry');
    failLogin = true; await code.fill('123456');
    await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    await page.getByText('汽水登录未成功（错误码 2046）：本次登录请求未通过', { exact: true }).waitFor();
    assert.equal(await code.inputValue(), '123456');
    assert.equal(await page.getByRole('button', { name: '验证码登录', exact: true }).isDisabled(), false);
    assert.equal(calls.filter(c => c.action === 'send-code').length, 3, 'business failure keeps the current SMS instead of resending');
    await page.evaluate(() => window.login.dispose()); await page.waitForTimeout(30);
    assert.equal(calls.at(-1).action, 'cancel');
    await page.evaluate(() => window.login.mount(document.querySelector('main')));
    await page.waitForFunction(() => !document.querySelector('[data-sms-action="send-code"]').disabled);
    await phone.fill('13700000000'); limited = true;
    await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await page.getByText('汽水拒绝了本次请求（错误码 7）', { exact: true }).waitFor();
    const count = calls.filter(call => call.action === 'send-code').length;
    assert.equal(await page.getByRole('button', { name: /秒后重发/ }).isDisabled(), true);
    await page.waitForTimeout(1100); assert.equal(calls.filter(call => call.action === 'send-code').length, count);
    await page.evaluate(() => window.login.dispose());
    assert.ok(calls.some(c => c.action === 'start'));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, widths: [360, 1280], startupAccountRead: true, noAutomaticSms: true, countdown: true, loginLogout: true, nativeVerificationRetry: true, disposeCancels: true, actualSmsSent: false }));
} finally { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
