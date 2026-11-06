import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMusicServer } from './music-server.mjs';
import { QishuiSmsAuth } from './qishui-sms.mjs';

const dataDir = path.resolve('../../work/qishui-sms-20261101/http-fixture');
await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'lx-config.json'), '{"enabled":false}');
let risk = true;
const auth = new QishuiSmsAuth({ store: { load: async () => ({}), save: async () => {}, clear: async () => {} }, transport: {
  sendSms: async challenge => { if (risk) { challenge.verificationUrl = 'https://verify.snssdk.com/captcha'; challenge.cookie = 'passport_csrf_token=private-fixture'; return { verification: true }; } return { sent: true }; },
  loginSms: async () => ({ credential: { sessionid: 'private-fixture-session' }, profile: { userId: '123', nickname: '测试账号' } }),
} });
const app = await createMusicServer({ dataDir, defaultRoots: [], autoScan: false, platformAuth: { qishui: auth }, catalogs: {} });
app.server.removeAllListeners('listening'); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
async function call(action, body) {
  const response = await fetch(base + '/api/online/qishui/auth/' + action, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); assert.ok(!JSON.stringify(value).includes('private-fixture')); return { status: response.status, retryAfterHeader: response.headers.get('retry-after'), ...value };
}
try {
  assert.equal((await call('status')).loggedIn, false);
  assert.equal((await call('start', {})).status, 400);
  assert.equal((await call('send-code', { phone: '123' })).status, 400);
  const result = await call('send-code', { phone: '13800000000' });
  assert.equal(result.state, 'verification'); assert.equal(result.url, undefined); assert.equal(result.cookies, undefined);
  const privateContext = app.qishuiVerification('verification-context', { id: result.id });
  assert.equal(privateContext.cookies[0].value, 'private-fixture');
  const exposed = await fetch(base + '/api/online/qishui/auth/verification-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: result.id }) });
  assert.equal(exposed.status, 404);
  app.qishuiVerification('verification-result', { id: result.id, cookies: [], nonce: privateContext.nonce }); risk = false;
  assert.equal((await call('send-code', { phone: '13800000000', id: result.id })).state, 'sent');
  const limited = await call('send-code', { phone: '13800000000', id: result.id });
  assert.equal(limited.status, 429); assert.equal(limited.retryAfter, 60); assert.equal(limited.retryAfterHeader, '60');
  assert.equal((await call('sms-login', { id: result.id, code: '123456' })).loggedIn, true);
  assert.equal((await call('logout', {})).loggedIn, false);
  console.log(JSON.stringify({ passed: true, httpRoutes: true, privateVerificationPipeOnly: true, cookiesNotExposed: true, noRealSms: true }));
} finally { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
