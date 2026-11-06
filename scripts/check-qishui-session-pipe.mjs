import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = path.resolve(process.argv[2] || '.');
const dataDir = path.resolve('../../work/qishui-session-repair-20261101', root.includes('Desktop') ? 'desktop-pipe-fixture' : 'repo-pipe-fixture');
await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'lx-config.json'), '{"enabled":false}');
const node = await fs.stat(path.join(root, 'node.exe')).then(() => path.join(root, 'node.exe')).catch(() => process.execPath);
const child = spawn(node, ['scripts/desktop-server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, MUSIC_DATA_DIR: dataDir, MUSIC_ROOTS: '', RHINE_DESKTOP_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
const replies = new Map(); let sequence = 0, ready;
const started = new Promise(resolve => { ready = resolve; });
const closed = once(child, 'close'); child.stderr.resume();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  if (line.startsWith('RHINE_READY ')) ready(line.slice(12));
  if (line.startsWith('RHINE_VERIFY ')) { const value = JSON.parse(line.slice(13)); replies.get(value.id)?.(value); replies.delete(value.id); }
});
async function privateCall(action, args) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => { replies.set(id, resolve); setTimeout(() => { if (replies.has(id)) { replies.delete(id); reject(Error('private pipe did not answer')); } }, 5000).unref(); });
  child.stdin.write(JSON.stringify({ id, action, args }) + '\n'); return result;
}
try {
  const base = await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(Error('isolated desktop server did not start')), 45000).unref())]);
  const response = await fetch(base + 'api/online/qishui/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13800000000' }) });
  const initial = await response.json(); assert.equal(response.status, 200); assert.equal(initial.state, 'request');
  const context = await privateCall('passport-context', { id: initial.id });
  assert.equal(context.ok, true); assert.equal(context.result.kind, 'passport'); assert.ok(context.result.nonce);
  assert.equal((await fetch(base + 'api/online/qishui/auth/session-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: initial.id }) })).status, 404);
  assert.equal((await privateCall('verification-http', { id: initial.id, nonce: 'invalid', request: { url: 'https://mssdk.bytedance.com/web/common', method: 'GET', headers: {}, body: '' } })).ok, false);
  assert.equal((await fetch(base + 'api/online/qishui/auth/verification-http', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await privateCall('session-result', { id: initial.id, nonce: 'invalid', cookies: [], token: 'synthetic-sdk-pipe-token' })).ok, false);
  const url = new URL(context.result.request.url); url.searchParams.set('a_bogus', 'A'.repeat(44)); url.searchParams.set('msToken', 'synthetic-sdk-pipe-token');
  const completed = await privateCall('passport-result', { id: initial.id, nonce: context.result.nonce, cookies: [], result: { operationId: context.result.request.operationId, status: 200, url: url.href, body: '{"data":{}}' } });
  assert.equal(completed.ok, true); assert.equal(completed.result.accepted, true);
  assert.equal((await privateCall('verification-cancel', { id: initial.id })).ok, true);
  assert.equal((await privateCall('session-context', { id: initial.id })).ok, false);
  console.log(JSON.stringify({ privatePipePassed: true, packaged: root.includes('Desktop'), initializationOnly: true, noSmsSubmission: true, userDataRead: false }));
} finally {
  child.stdin.end('shutdown\n');
  await Promise.race([closed, new Promise(resolve => setTimeout(() => { child.kill(); resolve(); }, 5000).unref())]); lines.close();
}
