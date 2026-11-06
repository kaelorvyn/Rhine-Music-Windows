import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { QishuiSmsAuth, QishuiSmsProtocol, qishuiSecondaryScriptUrl, qishuiVerificationRequestUrl } from './qishui-sms.mjs';

const component = 'https://lf-rc1.yhgfb-cn-static.com/obj/account/second-verify.js';
const source = await fs.readFile('src-tauri/src/qishui_webview.js', 'utf8');
const phone = '13800000000';
const store = () => ({ load: async () => ({}), save: async () => {}, clear: async () => {} });
const decision = () => ({ verify_from: 'verify_center', verify_ticket: 'synthetic-private-ticket', biz_params: 'synthetic-private-business', event_params: '{"verify_scene":"sms_login"}' });

test('APK-shaped 2046 decisions stay private, retain portrait and continue the original login', async () => {
  const portraitHeaders = [], codes = [];
  let logins = 0;
  const protocol = new QishuiSmsProtocol(async (url, init) => {
    portraitHeaders.push(init.headers['x-tt-passport-verify-portrait']);
    if (String(url).includes('sms_login')) {
      codes.push(new URLSearchParams(init.body).get('code'));
      if (++logins === 1) return Response.json({ message: 'error', ...decision(), data: { error_code: 2046 } });
      return Response.json({ message: 'success', data: {} }, { headers: { 'set-cookie': 'sessionid=synthetic-account-cookie' } });
    }
    return Response.json({ message: 'success', data: {} });
  });
  protocol.profile = async () => ({ userId: '123', nickname: '测试用户' });
  const auth = new QishuiSmsAuth({ transport: protocol, store: store() });
  const initial = await auth.sendCode({ phone });
  const initialize = () => { const context = auth.sessionContext(initial.id); auth.completeSession(initial.id, [], context.nonce, 'synthetic-sdk-session-token'); };
  initialize(); await auth.sendCode({ phone, id: initial.id });
  assert.equal((await auth.smsLogin({ id: initial.id, code: '123456' })).state, 'initialization');
  initialize(); const risk = await auth.smsLogin({ id: initial.id, code: '123456' });
  assert.deepEqual(Object.keys(risk).sort(), ['id', 'state']); assert.equal(risk.state, 'verification');
  const context = auth.verificationContext(initial.id);
  assert.equal(context.kind, 'secondary'); assert.equal(context.decision.biz_params, 'synthetic-private-business');
  assert.equal(context.decision.verify_portrait_id, portraitHeaders[0]); assert.equal(auth.context(initial.id).sent, true);
  assert.throws(() => auth.completeVerification(initial.id, [], 'wrong', 'synthetic-sdk-session-token'), /上下文/);
  const result = auth.completeVerification(initial.id, [
    { name: 'synthetic_verification_cookie', value: 'private-proof', domain: 'api.qishui.com' },
    { name: 'synthetic_untrusted_cookie', value: 'must-not-merge', domain: 'evil.test' },
  ], context.nonce, 'synthetic-sdk-session-token');
  assert.match(auth.context(initial.id).cookie, /synthetic_verification_cookie=private-proof/);
  assert.doesNotMatch(auth.context(initial.id).cookie, /must-not-merge/);
  assert.equal(result.readyToResume, true); assert.doesNotMatch(JSON.stringify(result), /private|portrait|token/);
  assert.throws(() => auth.completeVerification(initial.id, [], context.nonce), /当前没有/);
  assert.equal((await auth.smsLogin({ id: initial.id, code: '123456' })).loggedIn, true);
  assert.equal(new Set(portraitHeaders).size, 1); assert.deepEqual(codes, ['343736313033', '343736313033']);
});

test('secondary component and private relay cannot access arbitrary URLs', () => {
  assert.equal(qishuiSecondaryScriptUrl(component), component);
  for (const url of ['http://lf-rc1.yhgfb-cn-static.com/x.js', 'https://yhgfb-cn-static.com.evil.test/x.js', 'https://user@yhgfb-cn-static.com/x.js', 'https://yhgfb-cn-static.com:8443/x.js', 'https://yhgfb-cn-static.com/x.json']) assert.equal(qishuiSecondaryScriptUrl(url), undefined);
  for (const url of ['https://mssdk.bytedance.com/web/common', 'https://verify.snssdk.com/captcha/verify', 'https://vcs.zijieapi.com/vc/setting']) assert.equal(qishuiVerificationRequestUrl(url), url);
  for (const url of ['http://127.0.0.1/', 'https://api.qishui.com/passport/web/sms_login/', 'https://mssdk.bytedance.com/other', 'https://vcs.zijieapi.com.evil.test/vc/', 'https://user@vcs.zijieapi.com/vc/']) assert.equal(qishuiVerificationRequestUrl(url), undefined);
});

test('nested and JSON secondary decisions retain fields; oversized decisions fail safely', async () => {
  for (const data of [{ error_code: 2046, ...decision() }, { error_code: 2046, captcha: JSON.stringify(decision()) }]) {
    const protocol = new QishuiSmsProtocol(async () => Response.json({ message: 'error', data }));
    const current = { controller: new AbortController(), sdkReady: true, msToken: 'synthetic-sdk-session-token' };
    assert.equal((await protocol.passport('sms_login', {}, current)).verification, true);
    assert.equal(current.secondaryDecision.verify_from, 'verify_center');
    assert.equal(current.secondaryDecision.biz_params, 'synthetic-private-business');
  }
  const protocol = new QishuiSmsProtocol(async () => Response.json({ data: { error_code: 2046, ...decision(), biz_params: 'x'.repeat(65537) } }));
  await assert.rejects(protocol.passport('sms_login', {}, { controller: new AbortController(), sdkReady: true, msToken: 'synthetic-sdk-session-token' }), /过大/);
});

async function relayFixture(fetcher) {
  const transport = { fetcher, sendSms: async current => { current.secondaryDecision = decision(); return { verification: true }; } };
  const auth = new QishuiSmsAuth({ store: store(), transport });
  const result = await auth.sendCode({ phone }), context = auth.verificationContext(result.id);
  const request = { url: 'https://mssdk.bytedance.com/web/common?a_bogus=synthetic-signature', method: 'POST', body: 'synthetic-telemetry', headers: { 'Content-Type': 'text/plain', Cookie: 'do-not-forward', Authorization: 'do-not-forward' } };
  return { auth, context, request, call: (change = {}) => auth.verificationHttp(result.id, context.nonce, { ...request, ...change }) };
}

test('private relay preserves signed URL, bytes and SDK headers but not account cookies', async () => {
  const state = await relayFixture(async (url, init) => {
    assert.match(url, /a_bogus=synthetic-signature/); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers['content-type'], 'text/plain'); assert.equal(init.body, 'synthetic-telemetry');
    return new Response(Uint8Array.from([0, 255, 128, 1]), { headers: { 'x-ms-token': 'synthetic-sdk-updated-token', 'set-cookie': 'do-not-export', 'content-type': 'application/octet-stream' } });
  });
  const result = await state.call(); assert.deepEqual([...Buffer.from(result.bodyBase64, 'base64')], [0, 255, 128, 1]);
  assert.equal(result.headers['x-ms-token'], 'synthetic-sdk-updated-token'); assert.equal(result.headers['set-cookie'], undefined);
  await assert.rejects(state.call({ url: 'https://localhost/' }), /不支持/);
  await assert.rejects(state.call({ method: 'DELETE' }), /不支持/);
  await assert.rejects(state.call({ body: 'x'.repeat(65537) }), /不支持/);
  await assert.rejects(state.call({ headers: { 'content-type': 'bad\r\nheader' } }), /请求头/);
  state.auth.completeVerification(state.context.id, [], state.context.nonce);
  await assert.rejects(state.call(), /失效/);
});

test('private relay rejects redirects, large responses and stale in-flight results', async () => {
  for (const response of [() => new Response(null, { status: 302 }), () => new Response(Buffer.alloc(2097153))]) {
    const state = await relayFixture(async () => response()); await assert.rejects(state.call(), /跳转|过大/);
  }
  let finish;
  const state = await relayFixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = state.call(); state.auth.cancel(state.context.id); finish(new Response('{}'));
  await assert.rejects(pending, /过期|失效/);
});

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function renderer({ badComponent = false, packFailure = false, fallback = false, expand = true } = {}) {
  const page = await browser.newPage(), callbacks = [], requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('nativeFixture', address => callbacks.push(new URL(address)));
  await page.addInitScript(() => Object.defineProperty(window, '__nativeNavigate', { set: address => { void window.nativeFixture(address); } }));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ url, method: request.method(), body: request.postData(), headers: request.headers() });
    if (fallback && url.hostname === 'unpkg.com') return route.abort();
    let script;
    if (/react\.production\.min\.js/.test(url.pathname)) script = 'window.React={fixture:true}';
    else if (/react-dom\.production\.min\.js/.test(url.pathname)) script = 'window.ReactDOM={fixture:true}';
    else if (url.pathname.endsWith('sdk-glue.js')) script = `window._SdkGlueInit=()=>{window.bdms={};window._sdkGlueVersionMap={bdmsVersion:'fixture'}; const request=new XMLHttpRequest();request.open('POST','https://mssdk.bytedance.com/web/common?signed=fixture');request.setRequestHeader('Content-Type','text/plain');request.send('fixture-body');};`;
    else if (url.pathname.endsWith('second-verify.js')) script = 'window.ucWebSecondVerify=options=>{window.componentOptions=options}';
    if (script) return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.hostname === 'rhine-qishui-http.localhost') return route.fulfill({ headers: { 'access-control-allow-origin': 'https://api.qishui.com', 'access-control-expose-headers': 'x-ms-token', 'x-ms-token': 'synthetic-updated-sdk-token' }, body: '{}' });
    if (url.pathname.includes('pack_verify_ways_data')) return route.fulfill({ json: packFailure ? { message: 'error', data: { error_code: 1 } } : { message: 'success', data: { url: badComponent ? 'https://evil.test/untrusted.js' : component, verify_ticket: 'synthetic-expanded-ticket' } } });
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  const settings = { id: '11111111-1111-4111-8111-111111111111', nonce: '22222222-2222-4222-8222-222222222222', kind: 'secondary', origin: 'https://api.qishui.com', deviceId: '1000000000000000', installId: '2000000000000000', msToken: 'synthetic-initial-sdk-token', decision: { ...decision(), verify_from: expand ? 'verify_center' : 'verify', url: component, verify_portrait_id: 'synthetic-portrait', is_login: true } };
  await page.addInitScript({ content: source.replace('__RHINE_QISHUI_CONTEXT__', JSON.stringify(settings)).replaceAll('location.href =', 'window.__nativeNavigate =') });
  await page.goto('https://api.qishui.com/passport/web/region/?aid=386088');
  await page.waitForFunction(() => window.componentOptions || document.querySelector('[role="status"]'));
  return { page, requests, callbacks, errors };
}

test('secondary SDK expands official decisions and waits for authoritative success', async () => {
  const state = await renderer({ fallback: true });
  try {
    await state.page.waitForFunction(() => window.componentOptions);
    const options = await state.page.evaluate(() => ({ ticket: window.componentOptions.verify_ticket, host: window.componentOptions.newSecondVerifyWebOptions.host, portrait: window['$$account_verify_portrait_id'], seed: localStorage.xmst, react: !!window.ucSecondVerifyReact, reactDom: !!window.ucSecondVerifyReactDom }));
    assert.deepEqual(options, { ticket: 'synthetic-expanded-ticket', host: 'https://api.qishui.com', portrait: 'synthetic-portrait', seed: 'synthetic-initial-sdk-token', react: true, reactDom: true });
    const pack = state.requests.find(request => request.url.pathname.includes('pack_verify_ways_data'));
    assert.equal(pack.method, 'POST'); assert.equal(pack.headers['x-tt-passport-verify-portrait'], 'synthetic-portrait');
    assert.equal(new URLSearchParams(pack.body).has('is_login'), false); assert.equal(new URLSearchParams(pack.body).get('biz_params'), 'synthetic-private-business');
    const relay = state.requests.find(request => request.url.hostname === 'rhine-qishui-http.localhost');
    assert.equal(relay.method, 'POST'); assert.equal(relay.body, 'fixture-body'); assert.match(relay.url.searchParams.get('url'), /signed=fixture/);
    assert.doesNotMatch(relay.url.href, /fixture-body/);
    await state.page.evaluate(() => { window.postMessage({ status: true }, '*'); document.body.append('验证成功'); });
    await state.page.waitForTimeout(50); assert.equal(state.callbacks.length, 0);
    await state.page.evaluate(() => { window.componentOptions.verifyFinishCallback({ status: true }); window.componentOptions.verifyFinishCallback({ status: true }); });
    await state.page.waitForTimeout(50); assert.equal(state.callbacks.length, 1);
    assert.equal(state.callbacks[0].hostname, 'verified'); assert.equal(state.callbacks[0].searchParams.get('token'), 'synthetic-updated-sdk-token');
    assert.deepEqual(state.errors, []); assert.ok(state.requests.every(request => !/send_code|sms_login/.test(request.url.pathname)));
  } finally { await state.page.close(); }
});

test('false secondary SDK results never continue SMS login; direct decisions skip expansion', async () => {
  const state = await renderer({ expand: false });
  try {
    await state.page.waitForFunction(() => window.componentOptions);
    await state.page.evaluate(() => window.componentOptions.verifyFinishCallback({ status: false }));
    await state.page.waitForTimeout(50); assert.equal(state.callbacks[0]?.hostname, 'failed');
    assert.equal(state.requests.some(request => request.url.pathname.includes('pack_verify_ways_data')), false);
  } finally { await state.page.close(); }
});

test('invalid component and official expansion errors never open source documents or report success', async () => {
  for (const options of [{ badComponent: true }, { packFailure: true }]) {
    const state = await renderer(options);
    try {
      for (let count = 0; count < 100 && !state.callbacks.length; count++) await state.page.waitForTimeout(20);
      assert.equal(state.callbacks[0]?.hostname, 'failed'); assert.equal(await state.page.evaluate(() => !!window.componentOptions), false);
      assert.equal(state.requests.some(request => request.url.hostname === 'evil.test'), false);
    } finally { await state.page.close(); }
  }
});
