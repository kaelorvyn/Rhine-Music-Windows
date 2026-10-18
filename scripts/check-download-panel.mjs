// Download panel: task list rendering, retry/remove actions and the
// download-current-song hand-off (synthetic API responses).
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const pageHtml = `<html><head><style>:root{--line:#ccc;--ink:#222;--surface:#fff;--muted:#777;--accent:#ca6734}body{margin:20px;font:14px sans-serif}</style></head><body><div id="host"></div>
<script type="module">
import { DownloadPanel } from '/src/download-panel.ts';
window.calls = []; window.downloaded = 0;
window.panel = new DownloadPanel();
window.openPanel = current => window.panel.open(current, async () => { window.downloaded += 1; });
window.ready = true;
</script></body></html>`;
const tasks = [
  { id: 't1', title: '夜曲', artist: '周杰伦', quality: 'high', status: 'done', error: null, bytes: 4096, target: 'D:/m/周杰伦 - 夜曲.mp3', createdAt: 1 },
  { id: 't2', title: '晴天', artist: '周杰伦', quality: 'lossless', status: 'failed', error: '下载失败（HTTP 503），可重试。', bytes: 0, target: 'D:/m/周杰伦 - 晴天.mp3', createdAt: 2 },
  { id: 't3', title: '七里香', artist: '周杰伦', quality: 'standard', status: 'downloading', error: null, bytes: 1024, target: 'D:/m/周杰伦 - 七里香.mp3', createdAt: 3 },
];
let snapshot = () => ({ settings: { directory: 'D:/m', quality: 'high', naming: '{artist} - {title}' }, tasks: [...tasks] });

const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'download-test-page', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
  if (request.url === '/download-test') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    return response.end(pageHtml);
  }
  if (request.url?.startsWith('/api/downloads')) {
    for await (const _chunk of request) break; // drain the body
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // api downloads …
    let body = snapshot();
    if (parts[2] && parts[3] === 'retry') { tasks.find(task => task.id === parts[2]).status = 'queued'; body = snapshot(); }
    if (parts[2] && parts[3] === 'remove') { tasks.splice(tasks.findIndex(task => task.id === parts[2]), 1); body = snapshot(); }
    if (request.method === 'POST' && parts.length === 2) body = snapshot();
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify(body));
  }
  next();
}); } }] });

let browser; let page;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
  page = await browser.newPage(); const errors = [];
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  await page.goto(`${base}/download-test`);
  await page.waitForFunction(() => window.ready);

 // The dialog lists the current song action and every task with its state.
  await page.evaluate(() => window.openPanel({ title: '搁浅', artist: '周杰伦' }));
  await page.locator('.dl-overlay').waitFor();
  assert.match(await page.locator('[data-dl-current]').textContent() ?? '', /搁浅/, 'the current song is offered');
  assert.equal(await page.locator('.dl-task').count(), 3);
  assert.match(await page.locator('.dl-task.is-failed').textContent() ?? '', /HTTP 503/);
  assert.equal(await page.locator('.dl-task.is-downloading [data-dl-remove]').count(), 0, 'the active task cannot be removed');
  assert.equal(await page.locator('[data-dl-retry]').count(), 1, 'only failed tasks offer retry');

 // Actions write through the API and re-render the list.
  await page.locator('[data-dl-retry]').click();
  await page.waitForFunction(() => !document.querySelector('[data-dl-retry]'));
  assert.match(await page.locator('.dl-task.is-queued').textContent() ?? '', /晴天/, 'retry re-queues the task');
  await page.locator('.dl-task [data-dl-remove]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.dl-task').length === 2);

 // Downloading the current song delegates to the app and confirms.
  await page.locator('[data-dl-current]').click();
  await page.waitForFunction(() => window.downloaded === 1);
  await page.locator('[data-dl-message]').waitFor();
  assert.match(await page.locator('[data-dl-message]').textContent() ?? '', /已加入下载队列/);
  await page.locator('[data-dl-close]').click();
  assert.equal(await page.locator('.dl-overlay').count(), 0, 'close removes the dialog');

  assert.deepEqual(errors, []);
  console.log('Download panel: task list, retry/remove and current-song hand-off passed.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/download-panel', { recursive: true }).catch(() => {});
  await page?.screenshot({ path: 'artifacts/download-panel/failure.png', timeout: 3000 }).catch(() => {});
  throw failure;
} finally {
  await browser?.close(); await server.close();
}
