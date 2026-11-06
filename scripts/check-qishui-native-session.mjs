import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { QishuiSmsAuth, QishuiSmsProtocol, qishuiVerificationUrl } from './qishui-sms.mjs';

const source = await fs.readFile('src-tauri/src/qishui_webview.js', 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function webview(kind, { pageType = 'text/html', failed = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const callbacks = [], requests = [], errors = [];
  await page.exposeFunction('nativeCallbackFixture', address => {
    const url = new URL(address); if (!url.pathname.endsWith('/page-ready')) callbacks.push(url);
  });
  await page.addInitScript(() => Object.defineProperty(window, '__nativeNavigate', { set: address => { void window.nativeCallbackFixture(address); } }));
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.pathname.startsWith('/rhine-callback/')) { if (!url.pathname.endsWith('/page-ready')) callbacks.push(url); await route.abort(); return; }
    if (url.hostname === 'mssdk.bytedance.com') {
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'https://api.qishui.com', 'access-control-expose-headers': 'x-ms-token', 'x-ms-token': 'synthetic-sdk-generated-token' }, body: '{}' }); return;
    }
    if (url.pathname.endsWith('/sdk-glue.js')) {
      await route.fulfill({ status: failed ? 503 : 200, contentType: 'text/javascript', body: 'window._SdkGlueInit=()=>{const request=new XMLHttpRequest();request.open("POST","https://mssdk.bytedance.com/web/common");request.send("synthetic-sdk-telemetry");}' }); return;
    }
    if (url.pathname.endsWith('/captcha.js')) {
      await route.fulfill({ contentType: 'text/javascript', body: 'window.verifySDK={initVerifyOptions(options){window.testOptions=options},autoRender(data){window.testData=data}}' }); return;
    }
    await route.fulfill({ contentType: kind === 'page' ? pageType : 'application/json', body: kind === 'page' ? '<!doctype html><html><body><p>验证成功</p><script>window.verifySDK={initVerifyOptions(options){window.testOptions=options}};window.verifySDK.initVerifyOptions({captchaOptions:{successCb(){window.originalCalled=true}}});</script></body></html>' : '{}' });
  });
  const settings = { nonce: 'synthetic-window-nonce', kind, origin: 'https://api.qishui.com', deviceId: '1000000000000000', installId: '2000000000000000', verifyData: { synthetic: true } };
  await page.addInitScript({ content: source.replace('__RHINE_QISHUI_CONTEXT__', JSON.stringify(settings)).replaceAll('rhine-qishui://', 'https://api.qishui.com/rhine-callback/').replaceAll('location.href =', 'window.__nativeNavigate =') });
  await page.goto('https://api.qishui.com/verification-fixture');
  return { context, page, callbacks, requests, errors };
}

test('native session obtains a token only from the SDK response, without sending SMS', async () => {
  const state = await webview('session');
  try {
    await assert.doesNotReject(async () => { for (let count = 0; !state.callbacks.length && count < 50; count++) await state.page.waitForTimeout(20); });
    assert.equal(state.callbacks.length, 1);
    assert.equal(state.callbacks[0].searchParams.get('token'), 'synthetic-sdk-generated-token');
    assert.equal(state.callbacks[0].searchParams.get('nonce'), 'synthetic-window-nonce');
    assert.ok(state.requests.some(url => url.hostname === 'mssdk.bytedance.com'));
    assert.ok(state.requests.every(url => !/send_code|sms_login/.test(url.pathname)));
    assert.equal(await state.page.getByRole('button').count(), 0);
    assert.deepEqual(state.errors, []);
  } finally { await state.context.close(); }
});

test('structured verification waits for the official SDK success callback', async () => {
  const state = await webview('sdk');
  try {
    await state.page.waitForFunction(() => window.testOptions && window.testData);
    await state.page.evaluate(() => { window.postMessage({ success: true, ticket: 'unrelated' }, '*'); document.body.append('验证成功'); });
    await state.page.waitForTimeout(80); assert.equal(state.callbacks.length, 0);
    await state.page.evaluate(() => window.testOptions.captchaOptions.successCb());
    for (let count = 0; !state.callbacks.length && count < 50; count++) await state.page.waitForTimeout(20);
    assert.equal(state.callbacks[0]?.pathname, '/rhine-callback/verified');
    assert.deepEqual(state.errors, []);
  } finally { await state.context.close(); }
});

test('HTML verification preserves its SDK callback and ignores success text or messages', async () => {
  const state = await webview('page');
  try {
    assert.equal(state.callbacks.length, 0);
    await state.page.evaluate(() => window.postMessage({ ret: 0, ticket: 'unrelated' }, '*'));
    await state.page.waitForTimeout(80); assert.equal(state.callbacks.length, 0);
    const originalCalled = await state.page.evaluate(() => { window.testOptions.captchaOptions.successCb(); return window.originalCalled; });
    for (let count = 0; !state.callbacks.length && count < 50; count++) await state.page.waitForTimeout(20);
    assert.equal(state.callbacks[0]?.pathname, '/rhine-callback/verified');
    assert.equal(originalCalled, true);
  } finally { await state.context.close(); }
});

test('official secondary-verification completion is also single-use', async () => {
  const state = await webview('sdk');
  try {
    await state.page.waitForFunction(() => window.testOptions && window.testData);
    await state.page.evaluate(() => { window.testOptions.secondVerifyWebOptions.callBack(); window.testOptions.captchaOptions.successCb(); });
    for (let count = 0; !state.callbacks.length && count < 50; count++) await state.page.waitForTimeout(20);
    assert.equal(state.callbacks.length, 1); assert.equal(state.callbacks[0].pathname, '/rhine-callback/verified');
  } finally { await state.context.close(); }
});

test('non-HTML verification and SDK loading failure cannot report success', async () => {
  for (const [kind, options, expected] of [['page', { pageType: 'text/javascript' }, 'invalid-page'], ['session', { failed: true }, 'failed']]) {
    const state = await webview(kind, options);
    try {
      for (let count = 0; !state.callbacks.length && count < 100; count++) await state.page.waitForTimeout(20);
      assert.equal(state.callbacks[0]?.pathname, '/rhine-callback/' + expected);
      assert.equal(state.callbacks.length, 1);
    } finally { await state.context.close(); }
  }
});

test('source links and data endpoints are never verification pages', () => {
  for (const suffix of ['/sdk/index.umd.production.js', '/captcha/get', '/captcha/verify', '/passport/web/sms_login/', '/image.webp', '/config.json']) assert.equal(qishuiVerificationUrl('https://verify.snssdk.com' + suffix), undefined);
});

test('native session requires a matching single-use nonce and never exposes the token over HTTP results', async () => {
  let calls = 0;
  const protocol = new QishuiSmsProtocol(async () => { calls++; return Response.json({ message: 'success', data: {} }); });
  const auth = new QishuiSmsAuth({ transport: protocol, store: { load: async () => ({}), save: async () => {}, clear: async () => {} } });
  const initial = await auth.sendCode({ phone: '13800000000' });
  assert.equal(initial.state, 'initialization'); assert.equal(calls, 0);
  const context = auth.sessionContext(initial.id);
  assert.throws(() => auth.completeSession(initial.id, [], 'wrong-nonce', 'synthetic-sdk-token'), /上下文/);
  const result = auth.completeSession(initial.id, [], context.nonce, 'synthetic-sdk-token');
  assert.equal(result.sessionReady, true); assert.doesNotMatch(JSON.stringify(result), /synthetic-sdk-token/);
  assert.throws(() => auth.completeSession(initial.id, [], context.nonce, 'synthetic-sdk-token'), /未初始化成功/);
  assert.equal((await auth.sendCode({ phone: '13800000000', id: initial.id })).state, 'sent'); assert.equal(calls, 1);
  assert.equal((await auth.smsLogin({ id: initial.id, code: '123456' })).state, 'initialization'); assert.equal(calls, 1);
  const next = auth.sessionContext(initial.id); auth.cancel(initial.id);
  assert.throws(() => auth.completeSession(initial.id, [], next.nonce, 'synthetic-sdk-token'), /过期/);
});
