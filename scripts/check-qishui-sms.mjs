import test from 'node:test';
import assert from 'node:assert/strict';
import { QishuiSmsAuth, QishuiSmsProtocol, qishuiVerificationUrl } from './qishui-sms.mjs';
import { passportSignature, PASSPORT_UA } from './qishui-passport-signature.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const phone = '13800000000';
const credential = { sessionid: 'synthetic-sessionid' };
const profile = { userId: '123', nickname: '测试账号' };
function fixture(transport = {}) {
  let saved = {}, clock = 1000000;
  const store = { file: 'synthetic.dpapi', load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = {}; } };
  const auth = new QishuiSmsAuth({ store, now: () => clock, transport: { sendSms: async () => ({ sent: true }), loginSms: async () => ({ credential, profile }), profile: async () => profile, ...transport } });
  return { auth, store, saved: () => saved, advance: ms => { clock += ms; } };
}
test('SMS protocol matches encoded official form fields without an unrelated mobile ticket', async () => {
  const calls = [];
  const protocol = new QishuiSmsProtocol(async (url, init) => {
    if (String(url).includes('/region/')) return Response.json({}, { headers: { 'x-ms-token': 'synthetic-ms-token-bootstrap', 'set-cookie': 'reg-store-region=cn; Path=/' } });
    calls.push({ url: new URL(url), init, form: new URLSearchParams(init.body) });
    if (String(url).includes('/send_code/')) return Response.json({ message: 'success', data: { mobile_ticket: 'synthetic-ticket' } }, { headers: { 'set-cookie': 'passport_csrf_token=csrf-fixture; Path=/' } });
    if (String(url).includes('/sms_login/')) return Response.json({ message: 'success', data: {} }, { headers: { 'set-cookie': `sessionid=${credential.sessionid}; Path=/` } });
    return Response.json({ my_info: { id: profile.userId, nickname: profile.nickname } });
  });
  const challenge = { phone, controller: new AbortController(), sdkReady: true, msToken: 'synthetic-ms-token-bootstrap', cookie: 'reg-store-region=cn' };
  await protocol.sendSms(challenge);
  const send = calls[0];
  assert.equal(send.url.origin, 'https://api.qishui.com');
  assert.equal(send.url.searchParams.get('aid'), '386088');
  const unmix = value => Buffer.from(value, 'hex').map(byte => byte ^ 5).toString();
  assert.equal(unmix(send.form.get('mobile')), '+86 ' + phone);
  assert.equal(send.init.body, 'is6Digits=1&mix_mode=1&mobile=2e3d332534363d3535353535353535&type=3731&fixed_mix_mode=1');
  assert.equal(unmix(send.form.get('type')), '24');
  assert.equal(send.form.get('fixed_mix_mode'), '1');
  assert.equal(send.form.get('is6Digits'), '1');
  assert.equal(send.init.headers['X-Helios'], undefined); assert.equal(send.init.headers['X-Medusa'], undefined);
  assert.equal(send.init.headers['user-agent'], PASSPORT_UA);
  assert.match(send.url.searchParams.get('a_bogus'), /^[A-Za-z0-9/=-]{44}$/);
  assert.equal(send.url.searchParams.get('msToken'), 'synthetic-ms-token-bootstrap');
  assert.equal(send.url.searchParams.get('device_platform'), 'PC');
  assert.equal(send.url.searchParams.get('device_id'), send.url.searchParams.get('did'));
  assert.match(send.init.headers.Cookie, /reg-store-region=cn/);
  challenge.sdkReady = true;
  const result = await protocol.loginSms(challenge, '123456');
  const login = calls[1];
  assert.equal(login.form.get('login_only'), 'false');
  assert.equal(login.form.get('fixed_mix_mode'), '1');
  assert.equal(unmix(login.form.get('code')), '123456');
  assert.equal(login.init.body, 'mobile=2e3d332534363d3535353535353535&code=343736313033&login_only=false&mix_mode=1&fixed_mix_mode=1');
  assert.equal(login.init.headers['x-ss-stub'], '074DD21A88782B237A898F570C384F34');
  assert.deepEqual([...login.form.keys()], ['mobile', 'code', 'login_only', 'mix_mode', 'fixed_mix_mode']);
  assert.equal(login.form.has('mobile_ticket'), false);
  assert.match(login.init.headers.Cookie, /passport_csrf_token=csrf-fixture/);
  assert.deepEqual(result.credential, credential); assert.deepEqual(result.profile, profile);
});
test('phone/code validation, explicit send, cooldown and persistence', async () => {
  let sends = 0;
  const state = fixture({ sendSms: async () => { sends++; return { sent: true }; } });
  const { auth } = state;
  await auth.status(); assert.equal(sends, 0);
  await assert.rejects(auth.sendCode({ phone: '123' }), /手机号/);
  await assert.rejects(auth.sendCode({ phone, countryCode: '1' }), /手机号/);
  const sent = await auth.sendCode({ phone }); assert.equal(sends, 1);
  assert.equal(sent.retryAfter, 60); assert.equal(sent.phone, undefined);
  await assert.rejects(auth.sendCode({ phone }), error => error.status === 429);
  await assert.rejects(auth.smsLogin({ id: sent.id, code: '123' }), /6 位/);
  const account = await auth.smsLogin({ id: sent.id, code: '123456' });
  assert.equal(account.loggedIn, true); assert.equal(account.credential, undefined);
  assert.deepEqual(state.saved(), { credential });
  const restored = new QishuiSmsAuth({ store: state.store, transport: { profile: async () => profile } });
  assert.equal((await restored.status()).loggedIn, true);
  await restored.logout(); assert.deepEqual(state.saved(), {});
  await assert.rejects(auth.start(), /不支持扫码/); await assert.rejects(auth.poll(), /过期/);
});
test('official security verification stays private and merges only scoped cookies', async () => {
  let sends = 0;
  const { auth } = fixture({ sendSms: async challenge => {
    sends++; if (sends === 1) { challenge.cookie = 'passport_csrf_token=initial'; challenge.verificationUrl = 'https://verify.snssdk.com/captcha'; return { verification: true }; }
    assert.match(challenge.cookie, /passport_csrf_token=updated/); return { sent: true };
  } });
  const result = await auth.sendCode({ phone });
  assert.deepEqual(Object.keys(result).sort(), ['id', 'state']);
  const context = auth.verificationContext(result.id);
  assert.equal(context.cookies[0].value, 'initial');
  auth.completeVerification(result.id, [{ name: 'passport_csrf_token', value: 'updated', domain: '.qishui.com' }, { name: 'sessionid', value: 'evil', domain: 'evil.test' }, { name: 'unknown', value: 'x', domain: '.qishui.com' }], context.nonce);
  assert.doesNotMatch(auth.challenge.cookie, /evil/);
  assert.match(auth.challenge.cookie, /unknown=x/);
  assert.equal((await auth.sendCode({ phone, id: result.id })).state, 'sent');
});
test('foreign verification URLs and redirects rejected; risk/error responses are not successful sends', async () => {
  for (const url of ['http://api.qishui.com/', 'https://qishui.com.evil.test/', 'https://user@api.qishui.com/', 'https://api.qishui.com:4430/']) assert.equal(qishuiVerificationUrl(url), undefined);
  assert.ok(qishuiVerificationUrl('https://verify.snssdk.com/captcha'));
  const challenge = () => ({ phone, controller: new AbortController(), sdkReady: true, msToken: 'synthetic-ms-token-bootstrap' });
  const protocol = body => new QishuiSmsProtocol(async url => String(url).includes('/region/') ? Response.json({}, { headers: { 'x-ms-token': 'synthetic-ms-token-bootstrap' } }) : Response.json(body));
  assert.equal((await protocol({ message: 'error', data: { error_code: 2046, captcha: JSON.stringify({ security_url: 'https://verify.snssdk.com/captcha' }) } }).sendSms(challenge())).verification, true);
  await assert.rejects(protocol({ message: 'error', data: { error_code: 2046, captcha: '{}' } }).sendSms(challenge()), error => /2046/.test(error.message) && !/验证地址/.test(error.message));
  await assert.rejects(protocol({ message: 'error', data: { error_code: 7 } }).sendSms(challenge()), error => error.status === 429);
  await assert.rejects(protocol({ message: 'error', data: { error_code: 1105 } }).sendSms(challenge()), /验证码校验未通过/);
});
test('passport web signatures match independent native vectors, including changed body and timestamp', () => {
  const samples = [
    ['aid=386088', 'mix_mode=1', 1793520000000, 'DfsmXOg/Msm1OmKWlhkz9bIWO1g0YW4ngZEN1gXNCtLS'],
    ['a=one%20two&b=3', 'mobile=000000&type=3731', 1793520000001, 'Df0mXOg/Msm1fG5Wlhkz9JwHO1g0YW4rgZEN1gXLk0wg'],
    ['', '', 1793520001000, 'O6sQXcg/Msm1gfVWlhkz9CimO1m0YW55gZEN1gXqbtwg'],
  ];
  for (const [query, body, milliseconds, expected] of samples) assert.equal(passportSignature(query, body, milliseconds), expected);
  assert.throws(() => passportSignature('', '', NaN), /无效/);
});

test('upstream rejection starts a cooldown, never auto-retries, and preserves the same session for a manual retry', async () => {
  let sends = 0;
  const state = fixture({ sendSms: async challenge => {
    sends++;
    if (sends === 1) { challenge.msToken = 'rotated-synthetic-ms-token'; challenge.cookie = 'reg-store-region=cn'; throw Object.assign(new Error('synthetic frequency rejection'), { status: 429, retryAfter: 120 }); }
    assert.equal(challenge.msToken, 'rotated-synthetic-ms-token'); assert.equal(challenge.cookie, 'reg-store-region=cn'); return { sent: true };
  } });
  await assert.rejects(state.auth.sendCode({ phone }), error => error.retryAfter === 120);
  assert.equal(sends, 1);
  await assert.rejects(state.auth.sendCode({ phone }), error => error.status === 429 && error.retryAfter === 120);
  assert.equal(sends, 1);
  const previous = state.auth.challenge;
  state.advance(120001); const result = await state.auth.sendCode({ phone });
  assert.equal(result.id, previous.id); assert.equal(sends, 2);
});

test('signed requests require a fresh official SDK initialization, never a region token alone', async () => {
  const requests = [];
  const protocol = new QishuiSmsProtocol(async (url, init) => {
    const target = new URL(url); requests.push(target.pathname);
    assert.match(init.headers.Cookie, /passport_csrf_token=csrf-first/);
    assert.equal(target.searchParams.get('msToken'), 'synthetic-ms-token-first');
    return Response.json({ message: 'success', data: {} }, { headers: { 'x-ms-token': 'synthetic-ms-token-rotated' } });
  });
  const challenge = { phone, controller: new AbortController(), msToken: 'synthetic-region-token' };
  assert.deepEqual(await protocol.sendSms(challenge), { initialization: true });
  assert.deepEqual(requests, []);
  challenge.sdkReady = true; challenge.msToken = 'synthetic-ms-token-first'; challenge.cookie = 'passport_csrf_token=csrf-first';
  await protocol.sendSms(challenge);
  assert.deepEqual(await protocol.sendSms(challenge), { initialization: true });
  assert.equal(challenge.msToken, 'synthetic-ms-token-rotated');
  assert.deepEqual(requests, ['/passport/web/send_code/']);
});

test('client identity stays stable across restarts and does not overwrite existing login sessions', async () => {
  const dataDir = path.resolve('../../work/qishui-sms-frequency-20261101/identity-fixture');
  await fs.mkdir(dataDir, { recursive: true });
  const beforeSession = Buffer.from('synthetic existing encrypted login');
  await fs.writeFile(path.join(dataDir, 'qishui-session.dpapi'), beforeSession);
  const fetcher = async url => Response.json({}, { headers: String(url).includes('/region/') ? { 'x-ms-token': 'synthetic-ms-token-first' } : {} });
  const first = new QishuiSmsProtocol(fetcher, { dataDir });
  await first.sendSms({ phone, controller: new AbortController() });
  const second = new QishuiSmsProtocol(fetcher, { dataDir });
  await second.sendSms({ phone, controller: new AbortController() });
  assert.deepEqual(second.identity, first.identity);
  assert.ok((await fs.readFile(path.join(dataDir, 'qishui-session.dpapi'))).equals(beforeSession));
});

test('cancel/expiry/logout prevent stale completion and preserve committed account', async () => {
  let finish;
  const state = fixture({ loginSms: () => new Promise(resolve => { finish = resolve; }) });
  const sent = await state.auth.sendCode({ phone });
  const pending = state.auth.smsLogin({ id: sent.id, code: '123456' });
  state.auth.cancel(sent.id); finish({ credential, profile });
  await assert.rejects(pending, /过期/); assert.deepEqual(state.saved(), {});
  state.advance(60001); const again = await state.auth.sendCode({ phone });
  state.advance(300001); await assert.rejects(state.auth.smsLogin({ id: again.id, code: '123456' }), /过期/);
});
test('cancel during encrypted save restores previous account instead of persisting stale SMS login', async () => {
  const state = fixture(); const sent = await state.auth.sendCode({ phone });
  let writing, release;
  const entered = new Promise(resolve => { writing = resolve; });
  const originalSave = state.store.save;
  state.store.save = async value => { writing(); await new Promise(resolve => { release = resolve; }); await originalSave(value); };
  const pending = state.auth.smsLogin({ id: sent.id, code: '123456' });
  await entered; state.auth.cancel(sent.id); release(); await pending;
  assert.deepEqual(state.saved(), {}); assert.equal(state.auth.snapshot().loggedIn, false);
});
test('concurrent send cannot discard an in-flight challenge', async () => {
  let finish;
  const { auth } = fixture({ sendSms: () => new Promise(resolve => { finish = resolve; }) });
  const pending = auth.sendCode({ phone }); await auth.ready; await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(auth.sendCode({ phone: '13900000000' }), error => error.status === 429);
  finish({ sent: true }); assert.equal((await pending).state, 'sent');
});
