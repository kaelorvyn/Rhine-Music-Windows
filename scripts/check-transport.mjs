// 顶栏验证 —— 用户定：把我加过的时间/音量/切歌/队列删回去，
// 顶栏回到原样（歌名 + 播放/暂停，下面歌词 + 进度条）；音量在播放详情页。
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-transport-'));
// hermetic：关掉音源插件与第三方备用站，别让 UI 测试走真网络（会被慢源拖到超时）
await fs.writeFile(path.join(directory, 'lx-config.json'), JSON.stringify({ enabled: false }))
await fs.writeFile(path.join(directory, 'backup-sources-config.json'), JSON.stringify({ enabled: false }))
let base, server;
const browser = await chromium.launch();
const app = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
app.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });

try {
  const samples = 8000 * 60, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  const musicRoot = path.join(directory, 'lib');
  await fs.mkdir(path.join(musicRoot, '专辑A'), { recursive: true });
  for (const name of ['第一首', '第二首', '第三首']) await fs.writeFile(path.join(musicRoot, '专辑A', `${name}.wav`), audio);
  ({ server } = await createMusicServer({ dataDir: directory, autoScan: false }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await app.route('**/*.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  const post = (r, v) => fetch(`${base}${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
  await app.goto(`${base}/?lab=0`);
  await app.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await post('/api/config', { roots: [musicRoot] }); await post('/api/library/scan', {});
// 扫描结果由界面主动拉取（不再靠外部 POST 触发实时推送）：扫描后重载一次再断言。
await app.reload();
await app.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await app.waitForFunction(() => window.rhineMusic.library?.albums?.length === 1, undefined, { timeout: 60000 });

 // ── 1. 顶栏 = 歌名 + 播放/暂停（+ 头像），下面只有歌词 + 进度条。
 // 我加过的时间/音量/上下首/队列角标全部删回去了。
  assert.equal(await app.locator('#play-pause').count(), 1, '顶栏有播放/暂停');
  assert.equal(await app.locator('#transport-track').count(), 1, '顶栏有歌名（定位当前歌曲）');
  assert.equal(await app.locator('#mini-playback-below [data-mini-lyric]').count(), 1, '歌词跑马');
  assert.equal(await app.locator('#mini-playback-below .playback-seek').count(), 1, '进度条');
  for (const [sel, what] of [['.minimal-transport [data-elapsed]', '时间'], ['.minimal-transport .song-time', '时间行'],
    ['.minimal-transport .volume-range', '音量'], ['#transport-queue', '队列按钮'], ['#transport-queue-count', '队列角标'],
    ['.minimal-transport [data-action="playing-prev"]', '上一首'], ['.minimal-transport [data-action="playing-next"]', '下一首']]) {
    assert.equal(await app.locator(sel).count(), 0, `顶栏没有${what}（${sel}）`);
  }
  console.log('① 顶栏 = 歌名 + 播放/暂停 + 歌词 + 进度条；没有时间、音量、切歌、队列');

 // ── 2. 播放 / 暂停照常 ─────────────────────────────────────────
 // 3D 画布持续重绘会让 Playwright 的可操作性检查超时，这里用页面内 dispatch click。
  const clickInPage = selector => app.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('找不到 ' + sel);
    el.click();
  }, selector);
  await clickInPage('#play-pause');
  await app.waitForFunction(() => window.rhineMusic.player.transport !== 'idle', undefined, { timeout: 60000 });
  await clickInPage('#play-pause');
  await app.waitForFunction(() => window.rhineMusic.player.transport === 'paused', undefined, { timeout: 30000 });
  console.log('② 播放 / 暂停照常');

 // ── 3. 队列走「歌单」按钮；行带 ♥ 收藏 ─────────────────────────
  await clickInPage('#my-playlists-button');
  await app.waitForFunction(() => !!document.querySelector('#panel-body .queue-row'), undefined, { timeout: 30000 });
// 「清空队列」按钮已移除（逐项移除 + 收藏即可），不再断言它。
  assert.ok(await app.locator('[data-queue-remove]').count() >= 1, '队列面板可逐项移除');
  assert.ok(await app.locator('[data-action="song-favorite"]').count() >= 1, '队列行带 ♥ 收藏');
  console.log('③ 队列面板（歌单按钮）：逐项移除 / ♥ 收藏齐全');

  assert.deepEqual(errors, []);
  console.log('\n顶栏（歌名 + 播放/暂停 + 歌词 + 进度条，音量在详情页）验证通过。');
} catch (failure) {
  await fs.mkdir('artifacts/transport', { recursive: true });
  await app?.screenshot({ path: 'artifacts/transport/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await app?.evaluate(() => ({ track: window.rhineMusic?.player?.currentTrack?.id, transport: window.rhineMusic?.player?.transport, error: window.rhineMusic?.player?.error })).catch(() => ({})));
  throw failure;
} finally {
  await browser?.close();
  if (server) { const c = new Promise(r => server.close(r)); server.closeAllConnections?.(); await c; }
  await fs.rm(directory, { recursive: true, force: true });
}
