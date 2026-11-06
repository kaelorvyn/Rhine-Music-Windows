import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractMeta, LxSourceRuntime } from './lx-source-loader.mjs';

test('new built-in source is unique and initializes without a live service', async () => {
  const root = new URL('./lx-sources/', import.meta.url);
  const files = (await fs.readdir(root)).filter(name => name.endsWith('.js'));
  assert.equal(files.length, 21);
  const names = await Promise.all(files.map(async name => extractMeta(await fs.readFile(new URL(name, root), 'utf8')).name));
  assert.equal(names.filter(name => name === '独家音源').length, 1);
  const source = await fs.readFile(new URL('lx-music-source-v7.js', root), 'utf8');
  assert.equal(extractMeta(source).version, '7');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-source-v7-'));
  await fs.writeFile(path.join(fixture, 'lx-music-source-v7.js'), source);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const runtime = new LxSourceRuntime({ guardRejections: false });
    await runtime.loadDirectory(fixture);
    assert.equal(runtime.plugins.size, 1);
    const plugin = [...runtime.plugins.values()][0];
    assert.equal(plugin.builtin, true);
    assert.equal(typeof plugin.handlers.request, 'function');
    assert.ok(plugin.sources.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('module timeout and untested states are rendered without exposing raw errors', async () => {
  const source = await fs.readFile(new URL('./shared-pool.mjs', import.meta.url), 'utf8');
  const facade = await import(`data:text/javascript;base64,${Buffer.from(source.replace(/import \{[^\n]+from '\.\/pool-module\.mjs'/, `
    const moduleStatus=()=>({configured:true});
    const loadModule=()=>true, closeModule=()=>{};
    const callModule=async()=>({upstreams:[
      {platform:'qishui',ok:false,detail:'timeout',latency_ms:9500},
      {platform:'joox',ok:false,detail:'budget_exhausted'},
      {platform:'qq',ok:false,detail:'PRIVATE_RESPONSE'},
      {platform:'netease',ok:true,latency_ms:10}
    ]});
  `)).toString('base64')}`);
  const result = await facade.probeUpstreams();
  assert.equal(result.upstreams.find(row => row.platform === 'qishui').detail, '检测超时，请重试');
  assert.equal(result.upstreams.find(row => row.platform === 'joox').detail, '本轮未检测，请重试');
  assert.equal(result.upstreams.find(row => row.platform === 'qq').detail, '不可用');
  assert.equal(result.upstreams.find(row => row.platform === 'netease').ok, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESPONSE'));
});
