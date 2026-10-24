// 【P1 · 静默换源，去黑框/去快闪】端到端证据。
//
// 契约：
// 1. 播放链路内（重试、换源、备用源、池子回落）一律不写 state.error、不 notify
// 2. 只有用户可见的最终失败才提示，且只提示一次
// 3. 换源全程静默（UI 仍显示 loading，不暴露内部换源过程）
// 4. 失败文案里没有「（已自动重试 N 次）」
// 另外：`#music-toast` 不再是黑底白字的黑框。
//
// 合成数据、零音量、hermetic 夹具：不碰真实网络（LX 插件与备用音源都关掉，
// 与 check-search-ui.mjs 同一套做法 —— 开着的话服务端会跑一次真实联网的
// 64 音源自检，前端加载页要等它 180s 才放行，本用例会被外网拖死）。
//
// 构建目录可用 RHINE_DIST_DIR 指定：`npm run build` 的产物是共享的 `dist/`，
// 多个人并发构建会互相覆盖（我编出来的可能不是我刚改的源码）。跑证据时先
// `vite build --outDir .t12-dist` 再 `RHINE_DIST_DIR=$PWD/.t12-dist node …`，
// 就把自己那份产物钉死了，不跟别人抢。
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const distDir = process.env.RHINE_DIST_DIR ? path.resolve(process.env.RHINE_DIST_DIR) : undefined;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-silent-rescue-'));
await fs.writeFile(path.join(directory, 'backup-sources-config.json'), JSON.stringify({ enabled: false }));
await fs.writeFile(path.join(directory, 'lx-config.json'), JSON.stringify({ enabled: false }));
let base;
const twin = (provider, id, { title = '合成换源曲', fee = 0 } = {}) => ({ id: `${provider}-${id}`, albumId: `${provider}-album`, title, artist: '测试歌手', duration: 8,
  format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider, id: String(id), albumTitle: '合成专辑', fee, pageUrl: `https://example.test/${provider}/${id}` } });
const refused = twin('netease', 1);            // 播放被拒 → 必须静默换到 qq-2
const twinHit = twin('qq', 2);
const hopeless = twin('netease', 90, { title: '合成无源曲' }); // 全网都没有 → 只提示一次
const searchResults = (provider, tracks) => ({ provider, query: 'test', offset: 0, limit: 20, total: tracks.length, hasMore: false, tracks });
const emptyCatalog = provider => ({ search: async () => searchResults(provider, []), playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); } });
const { server } = await createMusicServer({ dataDir: directory, autoScan: false, ...(distDir ? { distDir } : {}),
  online: {
    search: async () => searchResults('netease', [refused, hopeless]),
 // 网易云拒绝：这就是用户点那首歌后播放器拿到的第一个失败。
    prepare: async () => { throw Object.assign(new Error('网易云未提供这首歌的播放地址，可能需要会员或所在地区的播放权限。'), { status: 403 }); },
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async id => ({ track: id === '90' ? hopeless : refused, album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }),
    playlists: async () => ({ playlists: [], hasMore: false }), playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  },
  catalogs: {
 // qq 能供「合成换源曲」，供不了「合成无源曲」（跨源同曲找不到）。
    qq: { search: async query => searchResults('qq', /无源/.test(String(query)) ? [] : [twinHit]),
      prepare: async () => ({ audioUrl: `${base}/short.wav` }),
      playlists: async () => ({ playlists: [], hasMore: false }), playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
      songInfo: async () => ({ track: twinHit, album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }) },
    bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: emptyCatalog('kuwo'), joox: emptyCatalog('joox'),
  },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
  page.setDefaultTimeout(45000);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, arg, options) => waitForFunction(fn, arg, { polling: 100, ...options });
 // toast 出现序列：每 40ms 采样一次 `#music-toast` 的「可见 + 文案」，文案变化
 // 就记一条。「快闪」= 这条序列在同一次失败里反复抖动（弹→消→弹）。
 // 注意不能用「MutationObserver + 立刻读 opacity」：`.visible` 加上去的那一帧
 // 过渡还没开始，computed opacity 仍是 0，会漏记。
  await page.addInitScript(() => {
    localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } }));
    window.__notices = [];
    let last = null;
    setInterval(() => {
      const el = document.querySelector('#music-toast');
      if (!el) return;
      const shown = el.classList.contains('visible') && getComputedStyle(el).opacity !== '0';
      const text = shown ? (el.textContent || '') : null;
      if (text && text !== last) { last = text; window.__notices.push(text); }
      if (!shown) last = null;
    }, 40);
  });
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  const samples = 8000 * 120, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  await page.route('**/short.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await page.waitForFunction(() => window.rhineMusic.stats()?.triangles > 0);

 // 采样 transport/error 的每一次跃迁。「快闪」= error 在有值↔空之间抖动。
  const startSampling = () => page.evaluate(() => {
    window.__samples = [];
    window.__sampleTimer = setInterval(() => {
      const player = window.rhineMusic.player;
      const last = window.__samples[window.__samples.length - 1];
      if (!last || last.transport !== player.transport || last.error !== player.error) window.__samples.push({ transport: player.transport, error: player.error, track: player.currentTrack?.id ?? null });
    }, 50);
  });
  const stopSampling = () => page.evaluate(() => { clearInterval(window.__sampleTimer); return window.__samples; });
  const searchFor = async () => {
    if (!await page.locator('#online-search').count()) await page.locator('[data-action="search"]').click();
    await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
    await page.locator('[data-source-tab="netease"]').waitFor();
    await page.locator('[data-source-tab="netease"]').click();
    await page.locator('.online-search-status').filter({ hasText: '首歌曲' }).waitFor({ timeout: 30000 });
  };
  const playRow = id => page.evaluate(trackId => document.querySelector(`.unified-song-play[data-online-track="${trackId}"]`).click(), id);

 // ① 静默换源：netease 拒绝 → 自动换到 qq 播出，全程无提示、无 error。
  await searchFor();
  await startSampling();
  await playRow('netease-1');
  // 换源成功的判定看「真正发声的音源」，不是队列项的 id：视觉身份按用户要求保持不变。
  await page.waitForFunction(() => window.rhineMusic.player.playing && window.rhineMusic.player.currentTrack?.onlineSource?.provider === 'qq', undefined, { timeout: 40000 });
  await page.waitForTimeout(1500);
  const switched = await page.evaluate(() => ({ samples: window.__samples, notices: window.__notices.slice(), error: window.rhineMusic.player.error, transport: window.rhineMusic.player.transport, track: window.rhineMusic.player.currentTrack?.id, provider: window.rhineMusic.player.currentTrack?.onlineSource?.provider }));
  // 用户定：换源是后台的事，画面不许动 —— 队列项视觉 id 保持原曲，只有音源换家。
  assert.equal(switched.track, 'netease-1', '视觉身份保持原曲（不闪封面、不换卡）');
  assert.equal(switched.provider, 'qq', '真正发声的音源已换到 qq');
  assert.equal(switched.transport, 'playing', '换源结束后落在播放态');
  assert.equal(switched.error, null, '静默换源不得写 state.error');
  assert.equal(switched.samples.some(sample => sample.transport === 'error'), false, '换源链路上不得出现 error 传输态');
  assert.equal(switched.samples.filter(sample => sample.error).length, 0, '换源链路上不得出现任何 error 文案');
  assert.deepEqual(switched.notices, [], '换源全程静默：#music-toast 一次都不出现');
  assert.ok(switched.samples.filter(sample => sample.transport === 'loading').length >= 1, '换源期间 UI 仍是 loading（不暴露内部换源过程）');

 // ② 最终失败只提示一次：全网都没有这首歌 → 一条提示，且不含「已自动重试」。
  await page.evaluate(() => { window.__notices.length = 0; });
  const failedSamples = await (async () => { await startSampling(); await playRow('netease-90'); await page.waitForFunction(() => !!window.rhineMusic.player.error, undefined, { timeout: 40000 }); await page.waitForTimeout(2500); return stopSampling(); })();
  const failed = await page.evaluate(samples => {
    const el = document.querySelector('#music-toast');
    const style = getComputedStyle(el);
    return { samples, notices: window.__notices.slice(), error: window.rhineMusic.player.error, transport: window.rhineMusic.player.transport,
      toastStyle: { background: style.backgroundColor, color: style.color, radius: style.borderRadius, borderTop: style.borderTopWidth } };
  }, failedSamples);
  assert.equal(failed.transport, 'error');
  assert.doesNotMatch(failed.error, /已自动重试/, '失败文案不再带「（已自动重试 N 次）」');
  assert.equal(failed.samples.filter(sample => sample.error).length, 1, '整局只出现一次 error（不抖、不快闪）');
  assert.equal(new Set(failed.samples.map(sample => sample.error)).size <= 2, true);
  assert.equal(failed.notices.length, 1, '最终失败只提示一次');

 // 黑框：背景不能再是 --ink（近黑），而是主题面板色；并且有圆角/描边。
  const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim());
  const parsed = failed.toastStyle.background.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = (0.2126 * parsed[0] + 0.7152 * parsed[1] + 0.0722 * parsed[2]) / 255;
  assert.notEqual(failed.toastStyle.background, ink, '#music-toast 不得再用 --ink 黑底');
  assert.ok(luminance > 0.6, `toast 底应为浅色主题面板（实测 ${failed.toastStyle.background}）`);
  assert.equal(failed.toastStyle.radius, '14px', 'toast 用面板圆角');
  assert.equal(failed.toastStyle.borderTop, '1px', 'toast 用 --line 描边而不是整块深色');

 // ③ 用户再点同一首：同一句文案**不重复弹**（黑框不再连着一闪一闪）。
 // 注意这里不能只等固定时长：服务端 prepare 会依次问「共享池 → 备用音源 →
 // 自定义音源」，这一轮真的走网络、要好几秒。等 error 真的再次出现再判定。
  await page.evaluate(() => { window.__notices.length = 0; });
  await page.evaluate(() => { window.rhineMusic.player; });
  await playRow('netease-90');
  await page.waitForFunction(() => window.rhineMusic.player.transport === 'error' && !!window.rhineMusic.player.error, undefined, { timeout: 40000 });
  await page.waitForTimeout(1500);
  const repeated = await page.evaluate(() => {
    const el = document.querySelector('#music-toast');
    return { notices: window.__notices.slice(), error: window.rhineMusic.player.error,
      toastText: el.textContent, toastVisible: el.classList.contains('visible') && getComputedStyle(el).opacity !== '0' };
  });
 // 「只提示一次」= 同一句文案最多弹一次；因为上一句还在屏幕上（5.5s 生命周期），
 // 这次连新的一次「弹」都不会记到，理想值是 0；出现 1 也可接受（先消失再弹同句）。
  assert.ok(repeated.notices.length <= 1, `同一句失败文案不得重复弹（实测 ${repeated.notices.length} 次）`);
  assert.equal(repeated.error, failed.error, '重复点击得到的是同一句最终失败文案');
  assert.ok(repeated.toastVisible && repeated.toastText === failed.error, '界面上仍然只有那一条失败提示');

  assert.deepEqual(errors, []);
  console.log('silent rescue: cross-source switching shows no toast and no error, stays in loading; the only notice is the terminal failure, once, without a retry-count suffix; #music-toast is a light theme panel, not a black box.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/silent-rescue', { recursive: true });
  await page?.screenshot({ path: 'artifacts/silent-rescue/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await page?.evaluate(() => ({
    current: window.rhineMusic?.player?.currentTrack?.id,
    provider: window.rhineMusic?.player?.currentTrack?.onlineSource?.provider,
    transport: window.rhineMusic?.player?.transport,
    error: window.rhineMusic?.player?.error,
    notices: window.__notices, samples: window.__samples,
    status: document.querySelector('.online-search-status')?.textContent,
  })).catch(() => null));
  throw failure;
} finally {
  await browser.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fs.rm(directory, { recursive: true, force: true });
}
// 显式收工：worker 线程/轮询句柄可能让进程挂在事件循环上（CI 里表现为「跑完不退出」）。
process.exit(0);
