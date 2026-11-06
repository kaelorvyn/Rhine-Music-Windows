// Run the production settings functions, event branches and CSS in a real DOM.
// Synthetic HTTP fixtures keep this independent of plugins, credentials and WebGL startup.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';

const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const desktop = await readFile(new URL('../src/desktop.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/html.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(text, name) {
  const parsed = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(parsed) === name));
  assert.ok(node, `Production declaration ${name} exists`);
  return node.getText(parsed).replace(/^export /, '');
}
const clickListener = tree.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(tree) === 'document.addEventListener' && node.expression.arguments[0]?.text === 'click');
const cases = [];
function findCases(node) {
  if (ts.isCaseClause(node) && ['lx-source-test', 'lx-sources-test', 'pool-credential-import', 'pool-connectivity'].includes(node.expression.text)) cases.push(node.getText(tree));
  ts.forEachChild(node, findCases);
}
findCases(clickListener);
assert.equal(cases.length, 4, 'Production click handlers exist');
const lxMarkup = source.match(/<section class="panel-section" id="lx-sources-settings"[\s\S]*?<\/section>/)?.[0];
const poolMarkup = source.match(/<section class="panel-section" data-settings-group="library"><h3>共享音源[\s\S]*?<\/section>/)?.[0];
assert.ok(lxMarkup && poolMarkup, 'Production markup exists');
assert.doesNotMatch(source + desktop, /poolCredentialExportUrl|pool-credential-export|\.rhinekey/);

const runtime = ts.transpileModule(`(() => {
  ${declaration(html, 'escapeHtml')}
  const esc = escapeHtml; const musicPlatforms = {netease:'网易云音乐',qq:'QQ 音乐',kugou:'酷狗音乐',kuwo:'酷我音乐',qishui:'汽水音乐',joox:'JOOX'};
  ${['readPoolCredential', 'importPoolCredential'].map(name => declaration(desktop, name)).join('\n')}
  ${['lxCheckPending', 'lxCheckProgress', 'lxPlugins', 'lxCounts', 'lxPollTimer', 'lxPollGeneration', 'PLATFORM_LABEL',
    'lxCheckRunning', 'syncLxCheckUI', 'renderLxSourcesRows', 'hydrateLxSources', 'lxSourcesRequest', 'testLxSources',
    'runPoolConnectivity', 'refreshPoolCredentialStatus', 'pickPoolCredentialFile', 'handlePoolCredentialFile', 'syncAlbumNavigation', 'stepAlbum']
    .map(name => declaration(source, name)).join('\n')}
  const records = [{ album: { playback: true } }], accountView = false, sortLabel = { column: '流派' };
  const stage = document.querySelector('#stage'), $ = selector => document.querySelector(selector);
  let playerState = { queue: [], currentIndex: 0 }, played;
  const navigationSelection = () => 0;
  const player = { play: id => { played = id; } }, wrap = (index, length) => (index % length + length) % length;
  document.addEventListener('click', event => {
    const target = event.target.closest('button, [data-action]');
    if (!target) return;
    switch (target.dataset.action) { ${cases.join('\n')} }
  });
  document.querySelector('#pool-credential-file').addEventListener('change', event => void handlePoolCredentialFile(event.target));
  window.fixture = {
    hydrate: hydrateLxSources, test: testLxSources,
    render: renderLxSourcesRows, refreshPool: refreshPoolCredentialStatus,
    progress(value) { lxCheckProgress = value; syncLxCheckUI(); },
    navigation(length, index, direction) {
      playerState = { queue: Array.from({ length }, (_, id) => ({ id: String(id) })), currentIndex: index };
      played = undefined; syncAlbumNavigation();
      if (direction !== undefined) stepAlbum(direction);
      return { disabled: [...stage.querySelectorAll('[data-action="prev"], [data-action="next"]')].map(button => button.disabled), played };
    }
  };
})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const server = http.createServer((_request, response) => response.end('<!doctype html><html><head></head><body></body></html>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const requests = [], pollTimes = [], pageErrors = [];
const healthy = { ok: true, ms: 82, quality: '320k', source: 'kw' };
let plugins = [
  { id: 'disabled', name: '停用源 <可测试>', file: 'disabled.js', builtin: false, enabled: false, platforms: ['kw', 'wy'], health: null },
  { id: 'enabled', name: '合成可用源', file: 'enabled.js', builtin: false, enabled: true, platforms: ['kw', 'wy'], health: healthy },
  { id: 'builtin', name: '合成内置源', file: 'builtin.js', builtin: true, enabled: true, platforms: ['kw'], health: null },
];
let progress = { running: false }, progressFails = false, finishCheck, postError = false;
let poolState = { configured: false, poolEnabled: false, expiresAt: null, importedAt: null, note: null };
const payload = () => ({ plugins, counts: { total: plugins.length, loaded: plugins.filter(plugin => plugin.enabled).length } });
const finishedRows = () => { plugins = plugins.map(plugin => ({ ...plugin, testing: false, selfCheckRunning: false })); };
let releaseStatus, holdStatus = false;
async function untilFixture(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const reply = (value, status = 200) => route.fulfill({ status, json: value });
    if (request.method() === 'POST') requests.push({ path: pathname, body: request.postDataJSON() });
    if (pathname === '/api/lx/status') {
      pollTimes.push(Date.now());
      const value = structuredClone(payload());
      if (holdStatus) { holdStatus = false; await new Promise(resolve => { releaseStatus = resolve; }); }
      return reply(value);
    }
    if (pathname === '/api/lx/progress') return reply(progressFails ? {} : progress, progressFails ? 503 : 200);
    if (pathname === '/api/lx/selfcheck') {
      await new Promise(resolve => { finishCheck = resolve; });
      return reply(postError ? { error: '合成自检失败' } : payload(), postError ? 500 : 200);
    }
    if (pathname === '/api/pool/credential/import') {
      poolState = { ...poolState, configured: true, poolEnabled: true };
      return reply(poolState);
    }
    if (pathname === '/api/pool/lines/probe') return reply({ results: [], upstreams: ['netease','qq','kugou','kuwo','qishui','joox'].map(platform => ({ platform, ok: true, latency_ms: 123 })) });
    if (pathname === '/api/pool/credential') return reply(poolState);
    throw new Error(`Unexpected fixture request: ${pathname}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.setContent(`<div class="music-app"><main class="settings-page" id="fixture">${poolMarkup}${lxMarkup}</main>
    <div id="stage"><span class="music-back"></span><div class="music-counter"><span class="music-eyebrow"></span></div>
    <button class="open-album"></button><button data-action="prev"></button><button data-action="next"></button></div></div>`);
  await page.addStyleTag({ content: await readFile(new URL('../src/music.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(new URL('../src/music-settings.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: ':root { --ink:#202421; --muted:#656b66; --line:#ddd; --accent:#578d65; --page-bg:#fafafa; } body { margin:0; padding:20px; background:var(--page-bg); color:var(--ink); font-family:Arial,sans-serif; }' });
  await page.addScriptTag({ content: runtime });
  await page.evaluate(() => { localStorage.setItem('rhine-lx-builtin-open', '1'); return window.fixture.hydrate(); });
  const row = id => page.locator(`.lx-source-row[data-id="${id}"]`);
  const meter = id => row(id).locator('.lx-source-meter');
  const testButtons = page.locator('[data-action="lx-source-test"], [data-action="lx-sources-test"]');
  const progressText = () => page.locator('#lx-sources-progress').textContent();
  const priorProgress = await progressText();
  await page.locator('[data-action="pool-connectivity"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="pool-connectivity"]').disabled);
  assert.deepEqual(requests, [{ path: '/api/pool/lines/probe', body: null }]);
  assert.equal(await progressText(), priorProgress, 'shared probe cannot start or alter backup-source checks');
  assert.equal(await page.locator('#pool-connectivity .pool-target').count(), 6);
  assert.match(await page.locator('#pool-connectivity').textContent(), /汽水音乐.*JOOX/);
  requests.length = 0;
  await page.evaluate(() => window.fixture.progress({ running: true, origin: 'startup', sourceTotal: 1, sourceDone: 0, sourceRemaining: 1, activeSources: ['enabled'] }));
  assert.match(await progressText(), /^启动自检 · 正在检测：/);
  await page.evaluate(() => window.fixture.progress({ running: false }));

  assert.deepEqual(await row('disabled').locator(':scope > *').allTextContents(), ['停用源 <可测试>', '已停用 · 未测', '测试', '启用', '移除']);
  assert.equal(await row('disabled').locator('[data-action="lx-source-test"]').isEnabled(), true);
  assert.equal(await row('builtin').locator('[data-action="lx-source-remove"]').isDisabled(), true);
  assert.equal(await page.locator('#lx-sources-progress').evaluate(node => node.previousElementSibling.className), 'lx-sources-actions');
  assert.equal(await page.locator('#lx-sources-progress').evaluate(node => node.nextElementSibling.id), 'lx-sources-list');

  // Single disabled source: real click branch, no toggle request, immediate prepare state.
  await row('disabled').locator('[data-action="lx-source-test"]').click();
  assert.match(await progressText(), /正在准备.*已检测：0 剩余：1/);
  assert.deepEqual(await testButtons.evaluateAll(buttons => buttons.map(button => button.disabled)), [true, true, true, true]);
  await page.waitForFunction(() => document.querySelector('#lx-sources-progress').textContent.includes('正在准备'));
  plugins[0] = { ...plugins[0], testing: true, selfCheckRunning: true, health: { ok: false, ms: null, quality: null, error: '超时' } };
  progress = { running: true, phase: 'probe', sourceTotal: 1, sourceDone: 0, sourceRemaining: 1, activeSources: ['disabled'] };
  await page.waitForFunction(() => document.querySelector('#lx-sources-progress').textContent.includes('停用源 <可测试>'));
  assert.equal(await meter('disabled').textContent(), '已停用 · 测试中', 'partial platform failures are not all-failed');
  plugins[0].health = healthy;
  progress.activeSources = [{ id: 'disabled', name: '停用源 <可测试>' }];
  await page.waitForFunction(() => document.querySelector('.lx-source-row[data-id="disabled"] .lx-source-meter').textContent.includes('82ms'));
  assert.match(await meter('disabled').textContent(), /已停用 · 82ms.*测试中/, 'healthy interim results remain visible');
  assert.equal(await row('disabled').locator('[data-action="lx-source-test"]').textContent(), '测试');
  assert.ok(pollTimes.at(-1) - pollTimes.at(-2) >= 650, 'status polls use the 700ms cadence');

  // Responsive layout and valid screenshots use the same running synthetic state.
  await mkdir(new URL('../artifacts/lx-settings-ui/', import.meta.url), { recursive: true });
  for (const [name, width] of [['desktop', 1280], ['narrow', 390]]) {
    await page.setViewportSize({ width, height: 1100 });
    const layout = await row('disabled').evaluate(node => {
      const children = [...node.children].map(child => ({ rect: child.getBoundingClientRect().toJSON(), style: getComputedStyle(child) }));
      return { width: node.clientWidth, scroll: node.scrollWidth, buttons: children.slice(2).map(({ rect, style }) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, font: style.fontSize })),
        progressColor: getComputedStyle(document.querySelector('#lx-sources-progress')).color, meterColor: getComputedStyle(node.querySelector('.lx-source-meter')).color };
    });
    assert.ok(layout.scroll <= layout.width + 1, `${name}: row does not overflow`);
    assert.equal(layout.progressColor, layout.meterColor, 'progress uses the existing gray');
    for (const button of layout.buttons) { assert.ok(button.width >= 66 && button.height >= 32); assert.equal(button.font, '13px'); }
    assert.ok(layout.buttons.every(button => button.y === layout.buttons[0].y), `${name}: action buttons stay aligned`);
    assert.ok(layout.buttons[1].x >= layout.buttons[0].x + layout.buttons[0].width, `${name}: actions do not overlap`);
    await page.locator('#fixture').screenshot({ path: fileURLToPath(new URL(`../artifacts/lx-settings-ui/${name}.png`, import.meta.url)) });
  }

  // A late poll snapshot must not replace the completed response or its 1/0 counters.
  holdStatus = true;
  await page.waitForFunction(() => false, undefined, { timeout: 1 }).catch(() => {});
  await untilFixture(() => releaseStatus);
  finishedRows();
  progress = { running: false, phase: 'done', sourceTotal: 1, sourceDone: 1, sourceRemaining: 0, activeSources: [] };
  finishCheck();
  await page.waitForFunction(() => document.querySelector('#lx-sources-status').textContent === '测试完成。');
  releaseStatus();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-action="lx-source-test"], [data-action="lx-sources-test"]')].every(button => !button.disabled));
  assert.equal(await progressText(), '正在检测：无 已检测：1 剩余：0');
  assert.equal(await row('disabled').locator('[data-action="lx-source-toggle"]').textContent(), '启用');
  assert.deepEqual(requests, [{ path: '/api/lx/selfcheck', body: { id: 'disabled' } }]);

  // All-source budget exit preserves unfinished counts, including if the final GET fails.
  finishCheck = undefined;
  await page.locator('[data-action="lx-sources-test"]').click();
  progress = { running: true, phase: 'probe', sourceTotal: 2, sourceDone: 1, sourceRemaining: 1, activeSources: ['enabled'] };
  await page.waitForFunction(() => document.querySelector('#lx-sources-progress').textContent.includes('已检测：1 剩余：1'));
  progressFails = true;
  finishCheck();
  await page.waitForFunction(() => document.querySelector('#lx-sources-status').textContent.includes('未能确认'));
  assert.equal(await progressText(), '正在检测：无 已检测：1 剩余：1');
  assert.deepEqual(requests.at(-1), { path: '/api/lx/selfcheck', body: {} });
  progressFails = false;
  finishCheck = undefined;
  await page.locator('[data-action="lx-sources-test"]').click();
  progress = { ...progress, running: false, phase: 'done' };
  await untilFixture(() => finishCheck);
  finishCheck();
  await page.waitForFunction(() => document.querySelector('#lx-sources-status').textContent.includes('仍有 1 个音源未完成'));
  assert.equal(await progressText(), '正在检测：无 已检测：1 剩余：1');

  // HTTP errors release the controls and preserve the server's message.
  postError = true; finishCheck = undefined;
  await row('disabled').locator('[data-action="lx-source-test"]').click();
  await untilFixture(() => finishCheck);
  finishCheck();
  await page.waitForFunction(() => document.querySelector('#lx-sources-status').textContent === '合成自检失败');
  assert.equal(await row('disabled').locator('[data-action="lx-source-test"]').isEnabled(), true);

  // Binary import uses the real desktop helper, preserving all byte values and the filename.
  assert.equal(await page.locator('#pool-credential-file').getAttribute('accept'), '.dll');
  const bytes = Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0x80, 0x7f, 0x01]);
  await page.locator('#pool-credential-file').setInputFiles({ name: 'synthetic.DLL', mimeType: 'application/octet-stream', buffer: bytes });
  await page.waitForFunction(() => document.querySelector('#pool-credential-status').textContent.includes('已启用'));
  assert.deepEqual(requests.at(-1), { path: '/api/pool/credential/import', body: { data: bytes.toString('base64'), name: 'synthetic.DLL' } });
  const postCount = requests.length;
  await page.locator('#pool-credential-file').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  assert.match(await page.locator('#pool-credential-status').textContent(), /请选择 .dll/);
  assert.equal(requests.length, postCount, 'legacy files are rejected before upload');
  poolState.poolEnabled = false;
  await page.evaluate(() => window.fixture.refreshPool());
  assert.match(await page.locator('#pool-credential-status').textContent(), /已停用/);

  // Playback arrows and the real step function agree at both wrap boundaries.
  for (const length of [0, 1, 2]) {
    const state = await page.evaluate(length => window.fixture.navigation(length, 0), length);
    assert.deepEqual(state.disabled, [length < 2, length < 2]);
  }
  assert.deepEqual(await page.evaluate(() => window.fixture.navigation(3, 0, -1)), { disabled: [false, false], played: '2' });
  assert.deepEqual(await page.evaluate(() => window.fixture.navigation(3, 2, 1)), { disabled: [false, false], played: '0' });
  assert.deepEqual(pageErrors, []);
  console.log('LX settings UI passed: disabled-source checks, progress polling and races, budget/failure states, responsive screenshots, DLL bytes/name, playback wrap.');
} finally {
  finishCheck?.(); releaseStatus?.();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
