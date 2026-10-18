// 歌单平台选择器 end to end: the nav selector between 歌单 and 设置 filters the
// account playlist view — 全部 aggregates every logged-in platform, one platform
// shows only its own playlists — and switching keeps the 3D scene alive (the
// established reveal, no hard refresh). Synthetic data, hermetic page.route
// mocks for every auth/playlist endpoint — no real traffic.
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-playlist-platform-'));
const emptyCatalog = provider => ({
  search: async () => ({ provider, query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
});
const { server } = await createMusicServer({
  dataDir: directory, autoScan: false,
  online: {
    search: async () => ({ provider: 'netease', query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
    prepare: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
    playlists: async () => ({ playlists: [], hasMore: false }),
    playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  },
  catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: emptyCatalog('kuwo'), joox: emptyCatalog('joox') },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  await page.addInitScript(() => { window.__alive = 1; localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } })); });
 // Evaluate-driven polling: rAF-based waitForFunction starves under the
 // headless 3D loop in this harness.
  const until = async (probe, label, timeoutMs = 20000) => {
    const start = Date.now();
    for (;;) {
      if (await page.evaluate(probe)) return;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
      await page.waitForTimeout(200);
    }
  };
 // Login sessions: 网易云 + QQ logged in; kugou logs in mid-test via the QR flow.
  let kugouLoggedIn = false, kugouPolls = 0;
  await page.route('**/api/online/*/auth/status', route => {
    const provider = new URL(route.request().url()).pathname.split('/')[3];
    const loggedIn = provider === 'netease' || provider === 'qq' || (provider === 'kugou' && kugouLoggedIn);
    return route.fulfill({ json: loggedIn ? { loggedIn: true, profile: { nickname: `${provider}用户` } } : { loggedIn: false } });
  });
  await page.route('**/api/online/kugou/auth/start', route => route.fulfill({ json: {
    id: 'synthetic-kugou-challenge', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 } }));
  await page.route('**/api/online/kugou/auth/poll', route => {
    kugouPolls++;
    return route.fulfill({ json: kugouLoggedIn ? { state: 'authorized', loggedIn: true, profile: { nickname: '酷狗用户' } } : { state: 'waiting' } });
  });
  const track = (provider, playlist, index) => ({ id: `${provider}-${playlist}-t${index}`, albumId: `${provider}-${playlist}-album`, title: `${provider}曲${playlist}${index}`, artist: '测试歌手', duration: 8, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '' });
  const listTracks = { n1: [track('netease', 'n1', 1), track('netease', 'n1', 2)], n2: [track('netease', 'n2', 1)], q1: [track('qq', 'q1', 1)], k1: [track('kugou', 'k1', 1)] };
  const listPlaylists = { netease: [{ id: 'n1', name: '网易云歌单一', trackCount: 2, owned: true }, { id: 'n2', name: '网易云歌单二', trackCount: 1, owned: true }], qq: [{ id: 'q1', name: 'QQ 歌单', trackCount: 1, owned: true }], kugou: [{ id: 'k1', name: '酷狗歌单', trackCount: 1, owned: true }] };
  await page.route('**/api/online/*/playlists?*', route => {
    const provider = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ json: { playlists: listPlaylists[provider] || [], hasMore: false } });
  });
  await page.route('**/api/online/*/playlists/*/tracks?*', route => {
    const url = new URL(route.request().url()); const id = url.pathname.split('/')[5];
    const tracks = listTracks[id] || [];
    return route.fulfill({ json: { tracks, total: tracks.length } });
  });
  await page.goto(`${base}/?lab=0`);
  await until(() => !!window.rhineMusic && !document.querySelector('#music-loading'), 'app boot', 45000);
  await until(() => window.rhineMusic.stats()?.triangles > 0, '3D scene ready', 45000);

 // The selector sits between 歌单 and 设置. 「莱茵音乐」= 本地歌单，永远在列表里
 // （不登录也能用，对齐本地的本地歌单）；平台歌单按登录态追加。
  const selector = page.locator('#playlist-platform');
  await until(() => { const el = document.querySelector('#playlist-platform'); return !!el && el.getClientRects().length > 0; }, 'playlist selector visible', 45000);
  assert.deepEqual(await selector.locator('option').allTextContents(), ['全部', '莱茵音乐', '网易云音乐', 'QQ 音乐'],
    '本地歌单恒在，平台歌单只列已登录的');
  const navOrder = await page.evaluate(() => [...document.querySelector('.music-topnav').children].map(el => el.id || el.dataset.action));
  assert.ok(navOrder.indexOf('my-playlists-button') < navOrder.indexOf('playlist-platform')
    && navOrder.indexOf('playlist-platform') < navOrder.indexOf('settings'), 'the selector sits right of 歌单 and left of 设置');
 // 顶栏有 280ms 的显隐过渡；等它走完再操作，避免「元素不稳定」的偶发失败。
  await page.waitForTimeout(700);

 // 全部 = 每个已登录平台的歌单 + 本地歌单（用户要求：莱茵/本地排最后）。
  await until(() => window.rhineMusic.accountPlaylists.filter(p => p.provider !== 'local').length === 3, 'aggregate playlists load');
  assert.deepEqual(await page.evaluate(() => window.rhineMusic.accountPlaylists.filter(p => p.provider !== 'local').map(p => p.provider)), ['netease', 'netease', 'qq']);
  assert.ok(await page.evaluate(() => window.rhineMusic.accountPlaylists.some(p => p.provider === 'local' && p.favorites)),
    '「莱茵歌单」在全部视图里');
  await until(() => /ALL \/ \d+ PLAYLISTS/.test(document.querySelector('#library-count')?.textContent ?? ''), 'aggregate count');

 // Selecting one platform shows only that platform's playlists.
  await selector.selectOption('qq');
  await until(() => window.rhineMusic.accountPlaylists.length === 1, 'qq filter');
  assert.deepEqual(await page.evaluate(() => window.rhineMusic.accountPlaylists.map(p => ({ id: p.id, provider: p.provider }))), [{ id: 'q1', provider: 'qq' }], 'selecting a platform shows only its playlists');
  await until(() => document.querySelector('#library-count')?.textContent === 'QQ / 1 PLAYLISTS', 'qq count');
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单 · QQ 音乐', 'filtered heading');

 // 选「莱茵音乐」只看本地歌单（不登录也有内容）。
  await selector.selectOption('local');
  await until(() => window.rhineMusic.accountPlaylists.length > 0
    && window.rhineMusic.accountPlaylists.every(p => p.provider === 'local'), 'local filter');
  assert.ok(await page.evaluate(() => window.rhineMusic.accountPlaylists.some(p => p.favorites)), '本地视图含莱茵歌单');
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单 · 莱茵音乐', 'local heading');

 // 切回「全部」恢复。
  await selector.selectOption('all');
  await until(() => window.rhineMusic.accountPlaylists.filter(p => p.provider !== 'local').length === 3, 'restore');
  await until(() => /ALL \/ \d+ PLAYLISTS/.test(document.querySelector('#library-count')?.textContent ?? ''), 'restore count');
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单', 'restore heading');

 // Smooth switching: the 3D scene never reloads and keeps filtering.
  assert.equal(await page.evaluate(() => window.__alive), 1, 'switching never reloads the page');
  assert.ok(await page.evaluate(() => window.rhineMusic.stats().triangles > 0), 'the 3D scene stays alive through the switch');
  await selector.selectOption('netease');
  await until(() => window.rhineMusic.accountPlaylists.length === 2
    && window.rhineMusic.accountPlaylists.every(p => p.provider === 'netease'), 'netease filter');
  await until(() => document.querySelector('#library-count')?.textContent === 'NETEASE / 2 PLAYLISTS', 'netease count');
  await selector.selectOption('all');
  await until(() => window.rhineMusic.accountPlaylists.filter(p => p.provider !== 'local').length === 3, 'restore again');

 // The account playlist overview opens on the filtered view (its heading names
 // the platform filter) and the scene stays alive through the reveal.
  await page.locator('[data-action="overview"]').click();
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单', 'overview heading');
  assert.ok(await page.evaluate(() => window.rhineMusic.stats().triangles > 0), 'the overview reveal keeps the 3D scene');
 // 扫码登录后同步：登录前酷狗不在选择器；QR 登录后选择器出现酷狗、歌单拉取、
 // 过滤标题/计数更新，overview 歌曲上墙播放且 playlistCell 语义保持。
  assert.ok(!(await selector.locator('option').allTextContents()).includes('酷狗音乐'), 'kugou hidden before login');
  assert.ok((await selector.locator('option').allTextContents()).includes('莱茵音乐'), '本地歌单不受登录影响');
  await page.keyboard.press('Escape'); // leave the overview so the account button is interactive
  await until(() => !document.querySelector('#netease-login-button')?.inert, 'account button interactive');
  await page.locator('#netease-login-button').click();
  await page.locator('[data-login-provider="kugou"]').click();
  await page.locator('.dedicated-login [data-netease-auth="start"]').click();
  const pollStart = Date.now();
  while (kugouPolls === 0) {
    if (Date.now() - pollStart > 20000) throw new Error('timeout: kugou QR polling starts');
    await page.waitForTimeout(200);
  }
  kugouLoggedIn = true; // user scans the synthetic QR
  await until(() => (document.querySelector('.netease-account small')?.textContent ?? '').includes('已登录'), 'kugou login lands', 30000);
  await page.locator('[data-action="close-panel"]').click();
  await until(() => [...document.querySelectorAll('#playlist-platform option')].some(option => option.textContent === '酷狗音乐'), 'selector gains kugou after login');
  await selector.selectOption('kugou');
  await until(() => window.rhineMusic.accountPlaylists.length === 1
    && window.rhineMusic.accountPlaylists[0].provider === 'kugou', 'kugou playlists load after login');
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单 · 酷狗音乐', 'kugou filtered heading');
  await until(() => document.querySelector('#library-count')?.textContent === 'KUGOU / 1 PLAYLISTS', 'kugou count');
  await page.locator('[data-action="overview"]').click();
  await until(() => document.querySelector('.overview-heading h2')?.textContent === '我的歌单 · 酷狗音乐', 'overview shows the kugou playlist');
  await page.keyboard.press('Escape'); // leave the overview, open the playlist wall
  await page.locator('#my-playlists-button').click();
  await until(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === 'k1', 'kugou playlist wall renders with playlistCell semantics');
  const cell = await page.evaluate(() => window.rhineMusic.selectedAlbum?.playlistCell ?? null);
  assert.equal(cell?.playlistName, '酷狗歌单', `playlistCell semantics survive login sync (got ${JSON.stringify(cell)})`);
  assert.deepEqual(errors, []);
  console.log('Playlist platform selector: position, logged-in options, per-platform filtering, 全部 restore and the 3D overview reveal all passed.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/playlist-platform', { recursive: true });
  await page?.screenshot({ path: 'artifacts/playlist-platform/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await page?.evaluate(() => ({
    playlists: JSON.stringify(window.rhineMusic?.accountPlaylists),
    count: document.querySelector('#library-count')?.textContent,
    heading: document.querySelector('.overview-heading h2')?.textContent,
    selector: JSON.stringify([...(document.querySelectorAll('#playlist-platform option') || [])].map(o => o.textContent)),
  })).catch(() => 'page gone'));
  throw failure;
} finally {
  await browser.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fs.rm(directory, { recursive: true, force: true });
}
