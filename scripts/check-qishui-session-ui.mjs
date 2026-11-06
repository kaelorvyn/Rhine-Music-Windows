import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import { QishuiLogin } from './src/qishui-login.ts';window.login=new QishuiLogin();window.login.mount(document.querySelector('main'));`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
let server, browser;
before(async () => {
  server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html lang="zh"><main></main></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
async function fixture({ stage = 'login' } = {}) {
  const page = await browser.newPage(); await page.clock.install({ time: new Date('2026-11-01T00:00:00Z') });
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [], loginCodes = []; let sendPhase = 0, loginPhase = 0, repeatRisk = false;
  await page.route('**/api/online/qishui/auth/*', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1); calls.push(action);
    let result = {};
    if (action === 'status') result = { loggedIn: false };
    if (action === 'start') result = { id, state: 'waiting', image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 120000 };
    if (action === 'poll') result = { state: 'waiting' };
    if (action === 'send-code') { sendPhase++; result = { id, state: sendPhase % 2 ? 'initialization' : stage === 'send' && (sendPhase === 2 || repeatRisk) ? 'verification' : 'sent', retryAfter: 60 }; }
    if (action === 'sms-login') { loginCodes.push(route.request().postDataJSON().code); loginPhase++; result = loginPhase >= 4 && !repeatRisk ? { loggedIn: true, nickname: '测试用户', userId: '123' } : { id, state: loginPhase % 2 ? 'initialization' : 'verification' }; }
    await route.fulfill({ json: result });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => { window.nativeRequests = []; window.__TAURI_INTERNALS__ = { invoke: async (...args) => { window.nativeRequests.push(args); } }; });
  await page.addScriptTag({ content: bundle.outputFiles[0].text, type: 'module' });
  await page.waitForFunction(() => !document.querySelector('[data-sms-action="send-code"]')?.disabled);
  await page.waitForFunction(() => !!document.querySelector('.netease-qr img')?.getAttribute('src'));
  const phone = page.getByRole('textbox', { name: '手机号', exact: true }), code = page.getByRole('textbox', { name: '验证码', exact: true });
  const emit = purpose => page.evaluate(({ id, purpose }) => window.dispatchEvent(new CustomEvent('rhine-qishui-verification', { detail: { id, purpose, success: true, retryAfter: purpose === 'verification' ? 45 : 0 } })), { id, purpose });
  const waitNative = (purpose, count) => page.waitForFunction(({ purpose, count }) => window.nativeRequests.filter(call => call[1].purpose === purpose).length === count, { purpose, count });
  const beginVerification = async () => {
    await phone.fill('13800000000'); await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await waitNative('session', 1); assert.equal(calls.filter(action => action === 'send-code').length, 1);
    await emit('session');
    if (stage === 'send') { await waitNative('verification', 1); return; }
    await page.getByText('验证码已发送，请查看手机短信。', { exact: true }).waitFor();
    await code.fill('123456'); await page.getByRole('button', { name: '验证码登录', exact: true }).click();
    await waitNative('session', 2); await emit('session'); await waitNative('verification', 1);
  };
  return { page, calls, loginCodes, phone, code, emit, waitNative, beginVerification, repeatRisk: () => { repeatRisk = true; } };
}

test('login verification resumes the same SMS login once, never sends another SMS', async () => {
  const state = await fixture();
  try {
    await state.beginVerification(); await state.emit('verification'); await state.emit('verification');
    assert.equal(await state.code.inputValue(), '123456'); assert.equal(await state.phone.inputValue(), '13800000000');
    assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
    await state.waitNative('session', 3);
    await state.emit('session'); await state.page.getByText('已登录。', { exact: true }).waitFor();
    assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
    assert.equal(state.calls.filter(action => action === 'sms-login').length, 4);
    assert.deepEqual(state.loginCodes, Array(4).fill('123456'));
    await state.emit('verification'); await state.page.clock.runFor(120000);
    assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
  } finally { await state.page.close(); }
});

test('changing the phone cancels a pending automatic resend and ignores late native completion', async () => {
  const state = await fixture({ stage: 'send' });
  try {
    await state.beginVerification(); await state.emit('verification'); await state.phone.fill('13900000000');
    await state.emit('verification'); await state.page.clock.runFor(120000);
    assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
    assert.equal(state.calls.includes('cancel'), false);
    assert.equal(await state.page.locator('.netease-qr img').isVisible(), true);
    assert.equal(await state.page.getByRole('button', { name: '验证码登录', exact: true }).isDisabled(), true);
  } finally { await state.page.close(); }
});

test('another challenge after one automatic login stops instead of opening an endless verification loop', async () => {
  const state = await fixture();
  try {
    await state.beginVerification(); state.repeatRisk(); await state.emit('verification');
    await state.waitNative('session', 3); await state.emit('session');
    await state.page.getByText('汽水仍要求安全验证，已停止自动登录，请稍后重试。', { exact: true }).waitFor();
    await state.page.clock.runFor(120000);
    assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
    assert.equal(await state.page.evaluate(() => window.nativeRequests.filter(call => call[1].purpose === 'verification').length), 1);
  } finally { await state.page.close(); }
});

test('send verification resumes sending once after cooldown and never submits a login', async () => {
  const state = await fixture({ stage: 'send' });
  try {
    await state.beginVerification(); await state.emit('verification'); await state.emit('verification');
    await state.page.clock.runFor(44000); assert.equal(state.calls.filter(action => action === 'send-code').length, 2);
    await state.page.clock.runFor(1000); await state.waitNative('session', 2); await state.emit('session');
    await state.page.getByText('验证码已发送，请查看手机短信。', { exact: true }).waitFor();
    await state.page.clock.runFor(120000);
    assert.equal(state.calls.filter(action => action === 'send-code').length, 4);
    assert.equal(state.calls.filter(action => action === 'sms-login').length, 0);
  } finally { await state.page.close(); }
});
