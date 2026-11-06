import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let reply;
mock.module('./pool-module.mjs', { namedExports: {
  callModule: async method => { assert.equal(method, 'probeUpstreams'); if (reply instanceof Error) throw reply; return reply; },
  loadModule: async () => true, closeModule: () => {}, moduleStatus: () => ({ configured: true }),
} });
const { probeUpstreams } = await import('./shared-pool.mjs');
test('legacy DLL keeps four real results and reports unsupported Qishui/JOOX honestly', async () => {
  reply = { upstreams: ['netease', 'qq', 'kugou', 'kuwo'].map(platform => ({ platform, ok: true, latency_ms: 123 })) };
  const result = await probeUpstreams();
  assert.equal(result.upstreams.length, 6);
  assert.equal(result.upstreams[0].latency_ms, 123);
  for (const row of result.upstreams.slice(4)) { assert.equal(row.tested, false); assert.equal(row.ok, false); assert.equal(row.latency_ms, null); assert.match(row.detail, /重新导入/); }
});
test('new DLL includes all six independent test results', async () => {
  reply = { upstreams: ['netease', 'qq', 'kugou', 'kuwo', 'qishui', 'joox'].map((platform, index) => ({ platform, ok: index !== 4, latency_ms: 100 + index })) };
  const { upstreams } = await probeUpstreams();
  assert.ok(upstreams.every(row => row.tested)); assert.equal(upstreams[4].ok, false); assert.equal(upstreams[5].ok, true); assert.equal(upstreams[5].latency_ms, 105);
});
test('failed DLL request does not make the platform rows disappear', async () => {
  reply = new Error('private-fixture'); const { upstreams } = await probeUpstreams();
  assert.equal(upstreams.length, 6); assert.ok(upstreams.every(row => !row.tested && !row.ok && row.latency_ms === null));
  assert.ok(upstreams.every(row => !row.detail.includes('private-fixture')));
});
