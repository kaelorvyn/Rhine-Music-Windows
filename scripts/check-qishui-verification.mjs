import test from 'node:test';
import assert from 'node:assert/strict';
import { QishuiSmsProtocol, QishuiSmsAuth } from './qishui-sms.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const challenge = () => ({ controller: new AbortController(), phone: '13800000000', sdkReady: true, msToken: 'synthetic-verification-token' });
const fixture = value => new QishuiSmsProtocol(async url => String(url).includes('/region/')
  ? Response.json({}, { headers: { 'x-ms-token': 'synthetic-verification-token' } }) : Response.json(value));
test('top-level official verification URL is not lost when error code lives inside data', async () => {
  const current = challenge();
  const result = await fixture({ message: 'error', securityURL: 'https://verify.snssdk.com/captcha?synthetic=1', data: { error_code: 20028 } }).passport('sms_login', {}, current);
  assert.equal(result.verification, true); assert.match(current.verificationUrl, /^https:\/\/verify.snssdk.com\//);
});
test('nested and JSON-encoded challenge URL is read without accepting an arbitrary origin', async () => {
  const current = challenge();
  const result = await fixture({ message: 'error', data: { error_code: 20028, captcha: JSON.stringify({ data: { security_url: 'https://verify.zijieapi.com/captcha' } }) } }).passport('sms_login', {}, current);
  assert.equal(result.verification, true);
  await assert.rejects(fixture({ message: 'error', securityURL: 'https://verify.snssdk.com.evil.test/captcha', data: { error_code: 20028 } }).passport('sms_login', {}, challenge()), error => error.status !== 409 && /20028/.test(error.message));
});
test('an empty captcha marker does not turn an ordinary official error into a missing-verification-URL error', async () => {
  for (const marker of ['{}', '0', 'false', {}, false]) {
    await assert.rejects(fixture({ message: 'error', data: { error_code: 1105, description: '验证码错误，请重新输入', captcha: marker } }).passport('sms_login', {}, challenge()), error => /1105/.test(error.message) && /验证码错误/.test(error.message) && !/验证地址|验证入口/.test(error.message));
  }
});
test('2046 is reported with the actual code and official description, not guessed to be a captcha', async () => {
  await assert.rejects(fixture({ message: 'error', data: { error_code: 2046, description: '本次登录请求未通过', captcha: '{}' } }).passport('sms_login', {}, challenge()), error => /2046/.test(error.message) && /本次登录请求未通过/.test(error.message) && !/验证地址|验证入口/.test(error.message));
});

test('SDK parameters use the official renderer, not a nested script URL', async () => {
  const current = challenge();
  const result = await fixture({ message: 'error', data: { error_code: 2046, captcha: JSON.stringify({ verify_center_decision_conf: JSON.stringify({ detail: 'synthetic-private-challenge' }), url: 'https://verify.snssdk.com/sdk.js' }) } }).passport('sms_login', {}, current);
  assert.equal(result.verification, true); assert.equal(current.verificationUrl, undefined);
  assert.deepEqual(current.verificationData, { detail: 'synthetic-private-challenge' });
});

test('1203 with empty challenge does not open a verification window', async () => {
  const current = challenge();
  await assert.rejects(fixture({ message: 'error', data: { error_code: 1203, captcha: '', description: '错误次数过多或验证码过期，请稍后重试' } }).passport('sms_login', {}, current), /1203.*验证码过期/);
  assert.equal(current.verificationUrl, undefined); assert.equal(current.verificationData, undefined);
});
test('official verification without a usable URL keeps the current SMS challenge alive', async () => {
  const auth = new QishuiSmsAuth({ store: { load: async () => ({}), save: async () => {}, clear: async () => {} }, transport: {
    sendSms: async () => ({ sent: true }), loginSms: async () => fixture({ message: 'error', data: { error_code: 20028 } }).passport('sms_login', {}, challenge()),
  } });
  const sent = await auth.sendCode({ phone: '13800000000' });
  await assert.rejects(auth.smsLogin({ id: sent.id, code: '123456' }), error => error.status !== 409 && /20028/.test(error.message));
  assert.equal(auth.context(sent.id).sent, true);
});
test('failure diagnostics record only codes and schema, never phone, code, cookies, token or challenge URL', async () => {
  const dataDir = path.resolve('../../work/qishui-verify-joox-20261101/diagnostic-fixture');
  const protocol = new QishuiSmsProtocol(async url => String(url).includes('/region/')
    ? Response.json({}, { headers: { 'x-ms-token': 'synthetic-secret-ms-token', 'set-cookie': 'sessionid=synthetic-secret-cookie' } })
    : Response.json({ message: 'error', data: { error_code: 20028, securityURL: 'https://verify.snssdk.com/captcha?ticket=synthetic-secret-ticket', description: '手机号 13800000000 验证码 123456' } }), { dataDir });
  assert.equal((await protocol.passport('sms_login', { code: '123456', mobile: '13800000000' }, challenge())).verification, true);
  const text = await fs.readFile(path.join(dataDir, 'qishui-login-diagnostic.json'), 'utf8');
  const value = JSON.parse(text); assert.equal(value.errorCode, 20028); assert.equal(value.trustedVerificationUrl, true);
  assert.doesNotMatch(text, /13800000000|123456|synthetic-secret|https:\/\//);
});
