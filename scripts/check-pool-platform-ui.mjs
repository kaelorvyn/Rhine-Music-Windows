import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = await fs.readFile('src/music-app.ts', 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const render = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runPoolConnectivity');
assert.ok(render);
const code = ts.transpileModule(`const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');const musicPlatforms={netease:'网易云音乐',qq:'QQ 音乐',kugou:'酷狗音乐',kuwo:'酷我音乐',qishui:'汽水音乐',joox:'JOOX'};${render.getText(tree)};window.probe=runPoolConnectivity;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const server = http.createServer((_req, res) => res.end('<!doctype html><button data-action="pool-connectivity">检测连通性 ↗</button><div id="pool-connectivity"></div>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const calls = [];
  await page.route('**/api/**', route => {
    calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { results: [], upstreams: ['netease','qq','kugou','kuwo','qishui','joox'].map(platform => ({ platform, ok: platform !== 'joox', latency_ms: platform === 'joox' ? null : 123, detail: '当前模块不支持检测，请重新导入新版模块' })) } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addScriptTag({ content: code });
  await page.evaluate(() => window.probe());
  assert.equal(await page.locator('#pool-connectivity li').count(), 6);
  assert.match(await page.locator('#pool-connectivity').textContent(), /汽水音乐123ms.*JOOX当前模块不支持检测/);
  assert.equal(await page.locator('button').isDisabled(), false);
  assert.deepEqual(calls, ['/api/pool/lines/probe']);
  await page.unroute('**/api/**');
  await page.route('**/api/**', route => route.fulfill({ json: { results: [], upstreams: [{ platform: 'qishui', ok: false, latency_ms: 9500, detail: '检测超时，请重试' }] } }));
  await page.evaluate(() => window.probe());
  assert.match(await page.locator('#pool-connectivity').textContent(), /汽水音乐检测超时，请重试/);
  assert.equal(await page.locator('button').isDisabled(), false);
  console.log(JSON.stringify({ passed: true, sixRows: true, qishuiAndJoox: true, legacyModuleHint: true, noBackupTestRequests: true }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
