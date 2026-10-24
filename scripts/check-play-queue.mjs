// Temporary queue (临时歌单) and the five play modes (): double-click replaces the
// queue, the queue panel lists/edits it, the detail playbar cycles modes, and
// the queue plus mode survive a reload. Natural song ends use a short-audio
// playlist (8 s) so end-of-song behavior is deterministic (synthetic data,
// zero-volume audio).
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-queue-ui-'));
// hermetic：关掉音源插件与第三方备用站，别让 UI 测试走真网络（会被慢源拖到超时）
await fs.writeFile(path.join(directory, 'lx-config.json'), JSON.stringify({ enabled: false }))
await fs.writeFile(path.join(directory, 'backup-sources-config.json'), JSON.stringify({ enabled: false }))
let base;
let account = { loggedIn: false }, qrState = 'waiting';
const tracks = Array.from({ length: 80 }, (_, index) => ({ id: `netease-${1000 + index}`, albumId: `album-${Math.floor(index / 3)}`, title: `合成歌曲 ${index + 1}`, artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'netease', id: String(1000 + index), albumTitle: `合成专辑 ${Math.floor(index / 3) + 1}`, fee: 0, pageUrl: 'https://music.163.com/', coverUrl: undefined } }));
const playlistSongs = Array.from({ length: 120 }, (_, index) => tracks[index] || { ...tracks[0], id: `netease-${1000 + index}`, title: `合成歌曲 ${index + 1}`, onlineSource: { ...tracks[0].onlineSource, id: String(1000 + index) } });
const shortSongs = Array.from({ length: 3 }, (_, index) => ({ ...tracks[0], id: `netease-${2000 + index}`, title: `合成短歌 ${index + 1}`, duration: 8, onlineSource: { ...tracks[0].onlineSource, id: String(2000 + index) } }));
const playlists = [{ id: '901', name: '<我的长歌单>', trackCount: 120, owned: true }, { id: '902', name: '短歌单', trackCount: 3, owned: true }];
const allSongs = [...playlistSongs, ...shortSongs];
const { server } = await createMusicServer({ dataDir: directory, autoScan: false, online: {
  search: async () => ({ provider: 'netease', query: 'test', tracks, offset: 0, limit: 20, total: 80, hasMore: false }),
  prepare: async id => ({ audioUrl: `${base}/${String(id).startsWith('2') ? 'short' : 'synthetic'}.wav` }),
  auth: {
    status: async () => account,
    start: async () => ({ id: 'synthetic-challenge', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 }),
    poll: async () => { if (qrState === 'authorized') account = { loggedIn: true, profile: { nickname: '<测试用户>' } }; return { state: qrState, ...account }; },
    cancel: async () => ({ state: 'cancelled' }), logout: async () => account = { loggedIn: false },
  },
  songInfo: async id => ({ track: allSongs.find(track => track.onlineSource.id === id),
    album: { title: '合成专辑', artist: '合成歌手', published: '2020-01-02', company: '合成唱片' },
    lyrics: { original: '[00:00]第一句\n[00:50]第二句\n[01:10]第三句', translated: '', instrumental: false, unavailable: false } }),
  playlists: async () => ({ playlists, hasMore: false }),
  playlistTracks: async (id, offset) => { const songs = id === '901' ? playlistSongs : shortSongs; return { playlistId: id, offset, total: songs.length, tracks: songs.slice(offset, offset + 50), hasMore: offset + 50 < songs.length }; },
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
  page.setDefaultTimeout(45000);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, arg, options) => waitForFunction(fn, arg, { polling: 100, ...options });
  await page.addInitScript(() => localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } })));
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  const samples = 8000 * 120, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  await page.route('**/synthetic.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  const shortSamples = 8000 * 8, shortAudio = Buffer.alloc(44 + shortSamples * 2);
  audio.copy(shortAudio); shortAudio.writeUInt32LE(shortAudio.length - 8, 4); shortAudio.writeUInt32LE(shortSamples * 2, 40);
  await page.route('**/short.wav', route => route.fulfill({ contentType: 'audio/wav', body: shortAudio }));
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await page.waitForFunction(() => window.rhineMusic.stats()?.triangles > 0);

 // Log in through the synthetic QR challenge.
  await page.locator('#netease-login-button').click();
  await page.getByAltText('网易云音乐登录二维码').waitFor();
  await page.locator('[data-action="close-panel"]').click();
  qrState = 'authorized';
  await page.locator('#netease-login-button').click();
  await page.locator('#netease-login-button[data-auth="in"]').waitFor();
  await page.locator('[data-action="close-panel"]').click();

 // Double-clicking a playlist in the overview replaces the queue and plays song one.
  await page.locator('.music-view-toggle').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'true');
  await page.locator('button.overview-column-label[aria-label="歌单：<我的长歌单>"]').dblclick();
  await page.waitForFunction(() => window.rhineMusic.player.playing && window.rhineMusic.player.queue.length === 120, undefined, { timeout: 30000 });
  const afterReplace = await page.evaluate(() => ({ first: window.rhineMusic.player.queue[0].id, current: window.rhineMusic.player.currentTrack?.id }));
  assert.equal(afterReplace.current, afterReplace.first, 'queue replacement starts at the first song');
  await page.locator('.overview-return').click();

 // The 歌单 button opens the temporary queue panel; rows play and remove.
  await page.locator('#my-playlists-button').click();
  await page.locator('.queue-row').first().waitFor();
  assert.equal(await page.locator('.queue-row').count(), 120, 'the queue panel lists every queued song (full playlist, no 100 cap)');
  assert.match(await page.locator('#panel-body [role="status"]').textContent(), /120 首 · 当前模式：顺序播放/);
  await page.locator('[data-queue-play="5"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === window.rhineMusic.player.queue[5].id && window.rhineMusic.player.playing);
  await page.locator('[data-queue-remove="0"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.queue.length === 119);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack?.id), await page.evaluate(() => window.rhineMusic.player.queue[4].id), 'removing an earlier row keeps the playing song');
  await page.locator('[data-action="close-panel"]').click();

 // The detail playbar button cycles 顺序 → 列表循环 → 单曲循环 → 随机 → 顺序.
  await page.locator('#transport-track').click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '901' && window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 5);
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail');
  await page.locator('#play-mode-button').waitFor();
  assert.equal(await page.locator('#play-mode-button').getAttribute('title'), '播放模式：顺序播放（点击切换）');
 // 5 种播放模式：顺序 / 列表循环 / 单曲循环 / 随机(bag) / 真随机。
 // 第 5 种 shuffle-all 是shuffle —— 每次纯随机、可重复。
  for (const [mode, name] of [['loop', '列表循环'], ['repeat-one', '单曲循环'], ['shuffle', '随机播放'], ['shuffle-all', '真随机'], ['order', '顺序播放']]) {
    await page.locator('#play-mode-button').click();
    assert.equal(await page.evaluate(() => window.rhineMusic.player.mode), mode, `mode cycles to ${mode}`);
    assert.equal(await page.locator('#play-mode-button').getAttribute('title'), `播放模式：${name}（点击切换）`);
  }

 // Switch to the short-audio playlist for deterministic natural song ends.
  await page.locator('.music-back').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'archive');
  await page.locator('.music-view-toggle').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'true');
  await page.locator('button.overview-column-label[aria-label="歌单：短歌单"]').dblclick();
  await page.waitForFunction(() => window.rhineMusic.player.playing && window.rhineMusic.player.queue.length === 3);
  await page.locator('.overview-return').click();
  await page.locator('#transport-track').click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '902');
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail');

 // 单曲循环 replays the same song when it ends naturally.
  await page.locator('#play-mode-button').click(); // → loop
  await page.locator('#play-mode-button').click(); // → repeat-one
  const repeatId = await page.evaluate(() => window.rhineMusic.player.currentTrack?.id);
  await page.waitForFunction((id) => window.rhineMusic.player.currentTrack?.id === id && window.rhineMusic.player.playing && window.rhineMusic.player.currentTime < 4, repeatId, { timeout: 30000 });

 // 列表循环 wraps to the first queued song when the last one ends naturally.
 // 模式顺序（5 种）：order → loop → repeat-one → shuffle → shuffle-all → order。
 // 点 #play-mode-button 直到到达目标模式，避免硬编码点击次数。
  const setMode = async mode => {
    for (let i = 0; i < 6; i++) {
      if (await page.evaluate(() => window.rhineMusic.player.mode) === mode) return;
      await page.locator('#play-mode-button').click();
    }
    throw new Error(`无法切到播放模式 ${mode}`);
  };
  await setMode('loop');
  await page.locator('#my-playlists-button').click();
  await page.locator('[data-queue-play="2"]').click();
  await page.locator('[data-action="close-panel"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === window.rhineMusic.player.queue[0].id && window.rhineMusic.player.playing, undefined, { timeout: 30000 });

 // 随机 never repeats a song back to back on manual skips.
  await setMode('shuffle');
  let previous = await page.evaluate(() => window.rhineMusic.player.currentTrack?.id);
  for (let i = 0; i < 3; i++) {
    await page.locator('.song-step-buttons [data-action="playing-next"]').click();
    await page.waitForFunction((id) => window.rhineMusic.player.currentTrack?.id !== id && !window.rhineMusic.player.loading, previous);
    previous = await page.evaluate(() => window.rhineMusic.player.currentTrack?.id);
  }

 // The queue and the mode survive a reload without auto-playing.
  await page.waitForTimeout(300); // let the change-triggered persistence flush
  const queueLength = await page.evaluate(() => window.rhineMusic.player.queue.length);
  await page.reload();
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.player.mode), 'shuffle', 'the play mode survives a reload');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue.length), queueLength, 'the temporary queue survives a reload');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false, 'restoring the queue never auto-plays');

// 「清空队列」按钮已移除（逐项移除保留），这一段契约作废。
  assert.deepEqual(errors, []);
  console.log('Temporary queue: double-click replacement, panel listing/play/remove/clear, mode cycling, single repeat, loop wrap, shuffle skips and reload persistence passed.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/play-queue', { recursive: true });
  await page?.screenshot({ path: 'artifacts/play-queue/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await page?.evaluate(() => ({ mode: window.rhineMusic?.player?.mode, queue: window.rhineMusic?.player?.queue?.length, current: window.rhineMusic?.player?.currentTrack?.id, currentTime: window.rhineMusic?.player?.currentTime, transport: window.rhineMusic?.player?.transport, overview: document.querySelector('#stage')?.dataset.overview, panel: document.querySelector('.music-panel') ? 'open' : 'closed' })));
  throw failure;
} finally {
  await browser.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fs.rm(directory, { recursive: true, force: true });
}
