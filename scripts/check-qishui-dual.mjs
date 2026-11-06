import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { QishuiSmsAuth, QishuiSmsProtocol } from './qishui-sms.mjs';

const phone = '13800000000', token = 'synthetic-browser-sdk-token';
function fixture() {
  let saved, clock = Date.now();
  const protocol = new QishuiSmsProtocol(async () => { throw Error('Passport must not use Node fetch'); }, { browserRequests: true });
  protocol.profile = async () => ({ userId: '123', nickname: '测试账号' });
  const auth = new QishuiSmsAuth({ transport: protocol, now: () => clock, store: { load: async () => ({}), save: async value => { saved = value; }, clear: async () => {} } });
  const complete = (id, data, cookies = []) => {
    const context = auth.passportContext(id), url = new URL(context.request.url);
    url.searchParams.set('a_bogus', 'A'.repeat(44)); url.searchParams.set('msToken', token);
    const result = { operationId: context.request.operationId, status: 200, body: JSON.stringify({ message: 'success', data }), url: url.href };
    auth.completePassport(id, context.nonce, result, cookies);
    assert.equal(auth.passportReady(id, context.nonce, result.operationId).ready, true);
    return { context, result };
  };
  const qr = { token: 'synthetic-qr-token', qrcode_index_url: 'https://api.qishui.com/passport/web/get_qrcode/?token=synthetic-index-token' };
  return { auth, complete, qr, saved: () => saved, advance: duration => { clock += duration; } };
}

test('QR and SMS share a browser session without sending SMS on open', async () => {
  const state = fixture(), initial = await state.auth.start();
  assert.deepEqual(Object.keys(initial).sort(), ['id', 'state']); assert.equal(initial.state, 'request');
  const first = state.complete(initial.id, state.qr);
  assert.equal(first.context.request.action, 'get_qrcode'); assert.equal(first.context.request.method, 'GET');
  const image = await state.auth.start(undefined, initial.id); assert.match(image.image, /^data:image\/png;base64,/);
  assert.equal(state.auth.context(initial.id).sent, undefined);
  assert.equal((await state.auth.sendCode({ id: initial.id, phone })).state, 'request');
  const sms = state.complete(initial.id, {}); assert.equal(sms.context.nonce, first.context.nonce);
  assert.equal(sms.context.request.action, 'send_code'); assert.equal((await state.auth.sendCode({ id: initial.id, phone })).state, 'sent');
  assert.equal(state.auth.context(initial.id).token, 'synthetic-qr-token');
  assert.equal((await state.auth.smsLogin({ id: initial.id, code: '123456' })).state, 'request');
  state.complete(initial.id, {}, [{ name: 'sessionid', value: 'synthetic-new-session', domain: 'api.qishui.com' }]);
  assert.equal((await state.auth.smsLogin({ id: initial.id, code: '123456' })).loggedIn, true);
  assert.equal(state.saved().credential.sessionid, 'synthetic-new-session');
});

test('expired QR and QR refresh preserve an already-sent SMS', async () => {
  const state = fixture(), initial = await state.auth.start(); state.complete(initial.id, state.qr); await state.auth.start(undefined, initial.id);
  await state.auth.sendCode({ id: initial.id, phone }); state.complete(initial.id, {}); await state.auth.sendCode({ id: initial.id, phone });
  state.advance(121000); assert.equal((await state.auth.poll(initial.id)).state, 'expired'); assert.equal(state.auth.context(initial.id).sent, true);
  await state.auth.start(undefined, initial.id); state.complete(initial.id, state.qr); await state.auth.start(undefined, initial.id);
  assert.equal(state.auth.context(initial.id).sent, true);
  assert.equal((await state.auth.smsLogin({ id: initial.id, code: '123456' })).state, 'request');
});

test('QR confirmation needs a scoped credential and persists the authorized account', async () => {
  const state = fixture(), initial = await state.auth.start(); state.complete(initial.id, state.qr); await state.auth.start(undefined, initial.id);
  assert.equal((await state.auth.poll(initial.id)).state, 'request');
  state.complete(initial.id, { status: '3', session_cookie: 'sessionid=synthetic-qr-session; sessionid_ss=synthetic-qr-session' });
  assert.equal((await state.auth.poll(initial.id)).state, 'authorized'); assert.equal(state.saved().credential.sessionid, 'synthetic-qr-session');
});

test('browser result rejects wrong signature, nonce, operation and cancelled work', async () => {
  const state = fixture(), initial = await state.auth.start(), context = state.auth.passportContext(initial.id);
  const result = { status: 200, operationId: context.request.operationId, body: '{}', url: context.request.url };
  assert.throws(() => state.auth.completePassport(initial.id, context.nonce, result, []), /签名/);
  assert.throws(() => state.auth.completePassport(initial.id, 'wrong', result, []), /失效/);
  const finished = state.complete(initial.id, state.qr);
  assert.throws(() => state.auth.completePassport(initial.id, context.nonce, finished.result, []), /失效/);
  await state.auth.start(undefined, initial.id); await state.auth.poll(initial.id); state.auth.cancel(initial.id);
  assert.throws(() => state.auth.completePassport(initial.id, context.nonce, finished.result, []), /过期/);
  assert.equal(state.saved(), undefined);
});

test('QR secondary business fields can only resume the current QR request', async () => {
  const state = fixture(), initial = await state.auth.start(); state.complete(initial.id, state.qr); await state.auth.start(undefined, initial.id); await state.auth.poll(initial.id);
  const context = state.auth.passportContext(initial.id);
  const retry = state.auth.passportRetry(initial.id, context.nonce, context.request.operationId, { verify_ticket: 'synthetic-business-ticket' });
  assert.equal(new URL(retry.url).searchParams.get('isResend'), 'true'); assert.equal(new URLSearchParams(retry.body).get('token'), 'synthetic-qr-token');
  assert.equal(new URLSearchParams(retry.body).get('verify_ticket'), 'synthetic-business-ticket'); assert.match(retry.headers['x-ss-stub'], /^[0-9A-F]{32}$/);
  assert.throws(() => state.auth.passportRetry(initial.id, 'wrong', context.request.operationId, {}), /失效/);
});

const source = await fs.readFile('src-tauri/src/qishui_webview.js', 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
test('browser runtime signs and sends multiple operations in one SDK instance', async () => {
  const page = await browser.newPage(), sent = [], results = [], callbacks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('nativeFixture', address => callbacks.push(address));
  await page.addInitScript(() => Object.defineProperty(window, '__nativeNavigate', { set: address => { void window.nativeFixture(address); } }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('sdk-glue.js')) return route.fulfill({ contentType: 'text/javascript', body: `window.glueLoads=(window.glueLoads||0)+1;window._SdkGlueInit=()=>{window.bdms={};window._sdkGlueVersionMap={bdmsVersion:'fixture'};const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,value,...rest){const url=new URL(value);if(url.hostname==='api.qishui.com'&&url.pathname.includes('/passport/'))url.searchParams.set('a_bogus','A'.repeat(44));return open.call(this,method,url.href,...rest)};const request=new XMLHttpRequest();request.open('POST','https://mssdk.bytedance.com/web/common');request.send('fixture');};` });
    if (url.hostname === 'rhine-qishui-http.localhost') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': 'https://api.qishui.com', 'Access-Control-Expose-Headers': 'x-ms-token', 'x-ms-token': token }, body: '{}' });
    if (url.hostname === 'rhine-qishui-result.localhost') { results.push(route.request().postDataJSON()); return route.fulfill({ body: '{}' }); }
    if (url.pathname.includes('/get_qrcode/') || url.pathname.includes('/send_code/')) { sent.push({ url, body: route.request().postData() }); return route.fulfill({ json: { message: 'success', data: {} } }); }
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  const context = { id: '11111111-1111-4111-8111-111111111111', nonce: '22222222-2222-4222-8222-222222222222', origin: 'https://api.qishui.com', kind: 'passport', deviceId: '1000000000000000', installId: '2000000000000000', request: { operationId: 'first', action: 'get_qrcode', method: 'GET', url: 'https://api.qishui.com/passport/web/get_qrcode/?aid=386088', headers: {}, body: '' } };
  await page.addInitScript({ content: source.replace('__RHINE_QISHUI_CONTEXT__', JSON.stringify(context)).replaceAll('location.href =', 'window.__nativeNavigate =') });
  try {
    await page.goto('https://api.qishui.com/passport/web/region/?aid=386088');
    for (let count = 0; results.length < 1 && count < 100; count++) await page.waitForTimeout(20);
    assert.equal(results.length, 1); assert.match(results[0].url, /a_bogus=/);
    assert.equal(sent[0].url.searchParams.get('msToken'), token); assert.ok(sent[0].url.searchParams.get('account_sdk_source_info'));
    const next = { ...context, request: { ...context.request, action: 'send_code', operationId: 'second', method: 'POST', url: 'https://api.qishui.com/passport/web/send_code/?aid=386088', body: 'synthetic-form' } };
    await page.evaluate(async next => { await window.__rhineQishuiPassport(next); }, next);
    assert.equal(results.length, 2); assert.equal(results[1].operationId, 'second'); assert.equal(sent[1].body, 'synthetic-form');
    assert.equal(await page.evaluate(() => window.glueLoads), 1); assert.equal(callbacks.filter(value => value.includes('request-ready')).length, 2); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const action of ['sms_login', 'check_qrconnect']) test(`browser ${action} resumes once after official secondary verification in the same window`, async () => {
  const page = await browser.newPage(), posts = [], results = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('nativeFixture', () => {});
  await page.addInitScript(() => Object.defineProperty(window, '__nativeNavigate', { set: address => { void window.nativeFixture(address); } }));
  const context = { id: '11111111-1111-4111-8111-111111111111', nonce: '22222222-2222-4222-8222-222222222222', origin: 'https://api.qishui.com', kind: 'passport', deviceId: '1000000000000000', installId: '2000000000000000', verifyPortraitId: 'synthetic-portrait', request: { operationId: 'fixture-operation', action, method: 'POST', url: `https://api.qishui.com/passport/web/${action}/?aid=386088`, headers: {}, body: action === 'sms_login' ? 'mobile=fixture&code=343736313033&login_only=false&mix_mode=1&fixed_mix_mode=1' : 'token=synthetic-qr-token' } };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('sdk-glue.js')) return route.fulfill({ contentType: 'text/javascript', body: `window.glueLoads=(window.glueLoads||0)+1;window._SdkGlueInit=()=>{window.bdms={};window._sdkGlueVersionMap={bdmsVersion:'fixture'};const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,value,...rest){const url=new URL(value);if(url.hostname==='api.qishui.com')url.searchParams.set('a_bogus','A'.repeat(44));return open.call(this,method,url.href,...rest)};const request=new XMLHttpRequest();request.open('POST','https://mssdk.bytedance.com/web/common');request.send('fixture');};` });
    if (/react-dom.*\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: 'window.ReactDOM={}' });
    if (/react.*\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: 'window.React={}' });
    if (url.pathname.endsWith('second-verify.js')) return route.fulfill({ contentType: 'text/javascript', body: 'window.ucWebSecondVerify=options=>{window.componentOptions=options}' });
    if (url.hostname === 'rhine-qishui-http.localhost') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': 'https://api.qishui.com', 'Access-Control-Expose-Headers': 'x-ms-token', 'x-ms-token': token }, body: '{}' });
    if (url.hostname === 'rhine-qishui-result.localhost') {
      if (url.pathname === '/retry') { const retry = request.postDataJSON(); assert.equal(retry.params.verify_ticket, 'synthetic-ticket'); return route.fulfill({ json: { ...context.request, url: context.request.url + '&isResend=true', body: context.request.body + '&verify_ticket=synthetic-ticket', headers: { 'x-ss-stub': 'A'.repeat(32) } } }); }
      results.push(request.postDataJSON()); return route.fulfill({ body: '{}' });
    }
    if (url.pathname.includes('/pack_verify_ways_data/')) return route.fulfill({ json: { message: 'success', data: { url: 'https://lf-rc1.yhgfb-cn-static.com/obj/account/second-verify.js' } } });
    if (url.pathname.includes(`/${action}/`)) {
      posts.push({ url, body: request.postData() });
      return route.fulfill({ json: posts.length === 1 ? { message: 'error', data: { error_code: 2046, verify_from: 'verify_center', biz_params: '{"verify_ticket":"synthetic-ticket"}' } } : { message: 'success', data: {} } });
    }
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript({ content: source.replace('__RHINE_QISHUI_CONTEXT__', JSON.stringify(context)).replaceAll('location.href =', 'window.__nativeNavigate =') });
  try {
    await page.goto('https://api.qishui.com/passport/web/region/?aid=386088'); await page.waitForFunction(() => window.componentOptions);
    assert.equal(posts.length, 1); assert.equal(results.length, 0);
    await page.evaluate(() => window.componentOptions.verifyFinishCallback({ status: true }));
    for (let count = 0; !results.length && count < 100; count++) await page.waitForTimeout(20);
    assert.equal(posts.length, 2); assert.equal(results.length, 1); assert.equal(await page.evaluate(() => window.glueLoads), 1);
    if (action === 'sms_login') assert.equal(posts[0].body, posts[1].body);
    else assert.equal(posts[1].url.searchParams.get('isResend'), 'true');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
