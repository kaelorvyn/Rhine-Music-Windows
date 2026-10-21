// Download manager: queueing, atomic writes, retry, naming, settings
// validation and download_tasks.json persistence (synthetic HTTP fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadManager, renderFileName, namingPatterns } from './downloads.mjs';

/** 合成一段「看得懂」的 MP3 载荷：帧同步 `ff fb` 开头，其余填充。
 * 下载器现在会在落盘前校验魔数（拒绝加密/垃圾文件），所以夹具必须是
 * 真实可识别的音频头，否则会被正确地拒绝。 */
const mp3Payload = (size, fill) => {
  const buffer = Buffer.alloc(size, fill);
  buffer[0] = 0xff; buffer[1] = 0xfb; buffer[2] = 0x90; buffer[3] = 0x64;
  return buffer;
};

const fixture = http.createServer((request, response) => {
  if (request.url === '/ok.mp3') {
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '4096' });
    response.end(mp3Payload(4096, 7));
  } else if (request.url === '/retry.mp3' && fixture.failures > 0) {
    fixture.failures -= 1;
    response.writeHead(503).end('busy');
  } else if (request.url === '/retry.mp3') {
    response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    response.end(mp3Payload(128, 9));
  } else response.writeHead(500).end('nope');
});
fixture.failures = 0;

test('download flow writes atomically and records the task', async (t) => {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-downloads-'));
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });

  const settingsDir = path.join(directory, 'music');
  const manager = new DownloadManager({ dataDir: path.join(directory, 'data'), concurrency: 0 });
  await manager.ready;

 // 没显式配置时**不再报错**：默认落到系统的「音乐」文件夹（defaultDownloadDirectory）。
 // 这是用户要求的行为 —— 什么都不填也能直接下载。
  assert.equal(manager.settings.directory, path.join(os.homedir(), 'Music'), 'unconfigured downloads fall back to ~/Music');
  assert.equal(manager.snapshot().settings.directoryIsDefault, true, 'fallback is reported as default, not as a user choice');
  const configured = await manager.configure({ directory: settingsDir, quality: 'lossless', naming: '{artist} - {title}' });
  assert.equal(configured.settings.directory, settingsDir);
  assert.equal(configured.settings.directoryIsDefault, false);
  await assert.rejects(() => manager.configure({ directory: '相对路径' }), /绝对路径/);
  await assert.rejects(() => manager.configure({ quality: 'super' }), /音质/);
 // 传空 = 回到默认目录（用户清空输入框的语义），而不是报「需要绝对路径」。
  const reset = await manager.configure({ directory: '' });
  assert.equal(reset.settings.directory, path.join(os.homedir(), 'Music'));
  assert.equal(reset.settings.directoryIsDefault, true);
  await manager.configure({ directory: settingsDir, quality: 'lossless', naming: '{artist} - {title}' });

  let snapshot = await manager.add({ url: `${base}/ok.mp3`, title: '夜曲', artist: '周杰伦' });
  const task = snapshot.tasks[0];
  assert.equal(task.fileName, undefined, 'the snapshot keeps the summary surface small');
  assert.equal(task.status, 'queued');
  await manager.run(manager.tasks[0]); // deterministic: run in place
  const done = manager.snapshot().tasks[0];
  assert.equal(done.status, 'done');
  assert.equal(done.bytes, 4096);
  assert.equal(done.error, null);
  const saved = await fs.readFile(path.join(settingsDir, '周杰伦 - 夜曲.mp3'));
  assert.equal(saved.length, 4096);
  assert.deepEqual((await fs.readdir(settingsDir)).filter(name => name.endsWith('.part')), [], 'atomic rename leaves no partial file');

 // Naming patterns and sanitization.
  assert.equal(renderFileName('{title}', { title: 'A/B:C', artist: 'X' }), 'A B C.mp3');
  assert.equal(renderFileName('不存在的模板', { title: 'T', artist: 'A' }), 'A - T.mp3', 'unknown patterns fall back to the default');
  assert.equal(namingPatterns.length, 3);

 // Retry after a failure succeeds and keeps the same task identity.
  fixture.failures = 1;
  snapshot = await manager.add({ url: `${base}/retry.mp3`, title: '重试曲', artist: '测试' });
  const retried = snapshot.tasks[0];
  await manager.run(manager.tasks[0]);
  assert.equal(manager.snapshot().tasks[0].status, 'failed');
  assert.match(manager.snapshot().tasks[0].error, /HTTP 503|失败/);
  await manager.retry(retried.id);
  await manager.run(manager.tasks[0]);
  const recovered = manager.snapshot().tasks.find(item => item.id === retried.id);
  assert.equal(recovered.status, 'done');

 // Removal and persistence across restarts.
  const removed = await manager.remove(retried.id);
  assert.equal(removed.tasks.some(item => item.id === retried.id), false);
  const restarted = new DownloadManager({ dataDir: path.join(directory, 'data'), concurrency: 0 });
  await restarted.ready;
  assert.equal(restarted.settings.quality, 'lossless');
  assert.equal(restarted.snapshot().tasks[0].status, 'done');

 // An interrupted task resumes as an honest retry candidate.
  const stale = new DownloadManager({ dataDir: path.join(directory, 'data2'), directory: settingsDir, concurrency: 0 });
  await stale.ready;
  stale.tasks.push({ id: 'x', url: 'https://example.test/a.mp3', title: 'T', artist: 'A', fileName: 'a.mp3', status: 'downloading', bytes: 0, createdAt: 1 });
  await stale.save();
  const restored = new DownloadManager({ dataDir: path.join(directory, 'data2'), concurrency: 0 });
  await restored.ready;
  assert.equal(restored.snapshot().tasks[0].status, 'failed');
  assert.match(restored.snapshot().tasks[0].error, /未完成/);
});
