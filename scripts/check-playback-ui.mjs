import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-playback-ui-'));
let base;
let account = { loggedIn: false }, qrState = 'waiting', authPolls = 0;
const queue = Array.from({ length: 80 }, (_, index) => ({ id: `netease-${1000 + index}`, albumId: `album-${Math.floor(index / 3)}`, title: `合成歌曲 ${index + 1}`, artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'netease', id: String(1000 + index), albumTitle: `合成专辑 ${Math.floor(index / 3) + 1}`, fee: 0, pageUrl: 'https://music.163.com/', coverUrl: undefined } }));
const playlistSongs = Array.from({ length: 120 }, (_, index) => queue[index] || { ...queue[0], id: `netease-${1000 + index}`, title: `合成歌曲 ${index + 1}`, onlineSource: { ...queue[0].onlineSource, id: String(1000 + index) } });
const playlists = [{ id: '901', name: '<我的长歌单>', trackCount: 120, owned: true }, { id: '902', name: '短歌单', trackCount: 3, owned: false }, { id: '903', name: '空歌单', trackCount: 0, owned: true }];
const songPages = [];
// Hermetic platform catalogs: the defaults would hit the real networks (the
// anonymous kuwo search leaks live rows into the synthetic queue otherwise).
const emptyCatalog = provider => ({
  search: async () => ({ provider, query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
});
const { server } = await createMusicServer({ dataDir: directory, autoScan: false, catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: emptyCatalog('kuwo') }, online: {
  search: async () => ({ provider: 'netease', query: 'test', tracks: queue, offset: 0, limit: 20, total: 80, hasMore: false }),
  prepare: async () => ({ audioUrl: `${base}/synthetic.wav` }), auth: {
    status: async () => account,
    start: async () => ({ id: 'synthetic-challenge', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 }),
    poll: async () => { authPolls++; if (qrState === 'authorized') account = { loggedIn: true, profile: { nickname: '<测试用户>' } }; return { state: qrState, ...account }; },
    cancel: async () => ({ state: 'cancelled' }), logout: async () => account = { loggedIn: false },
  },
  songInfo: async id => ({ track: playlistSongs.find(track => track.onlineSource.id === id),
    album: { title: '合成专辑', artist: '合成歌手', published: '2020-01-02', company: '合成唱片' },
    lyrics: { original: '[00:00]第一句\n[00:50]第二句\n[01:10]第三句', translated: '', instrumental: false, unavailable: false } }),
  playlists: async () => ({ playlists, hasMore: false }),
  playlistTracks: async (id, offset) => { songPages.push({ id, offset }); const songs = id === '901' ? playlistSongs : id === '902' ? playlistSongs.slice(0, 3) : []; return { playlistId: id, offset, total: songs.length, tracks: songs.slice(offset, offset + 50), hasMore: offset + 50 < songs.length }; },
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
  const musicRoot = path.join(directory, 'synthetic-library');
  for (const album of ['本地专辑一', '本地专辑二']) { const folder = path.join(musicRoot, album); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, '合成静音.wav'), audio); }
  const post = (route, value) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await page.waitForFunction(() => window.rhineMusic.stats()?.triangles > 0);
  const empty = await page.evaluate(() => ({ stats: window.rhineMusic.stats(), selected: window.rhineMusic.selectedAlbum, intro: document.querySelector('#music-empty'), headerLibrary: document.querySelector('.music-header [data-action="library"]'), headerTheme: document.querySelector('.music-header [data-theme]') }));
  assert.equal(empty.stats.blankArchive, true); assert.equal(empty.stats.albumCovers, false);
  assert.equal(empty.stats.modelVisible, true); assert.equal(empty.stats.arrayVisible, true);
  assert.equal(empty.stats.visibleAlbumCells, 0); assert.equal(empty.selected, undefined);
  assert.equal(empty.intro, null); assert.equal(empty.headerLibrary, null); assert.equal(empty.headerTheme, null);
  await fs.mkdir('artifacts/playback-ui', { recursive: true });
  await page.screenshot({ path: 'artifacts/playback-ui/empty-archive-day.png' });
  await page.locator('#netease-login-button').click(); await page.getByAltText('网易云音乐登录二维码').waitFor();
  await page.locator('[data-action="close-panel"]').click(); const before = authPolls;
  await page.waitForTimeout(2100); assert.equal(authPolls, before, 'closing the dedicated login panel stops polling');
  qrState = 'authorized'; await page.locator('#netease-login-button').click();
  await page.locator('#netease-login-button[data-auth="in"]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#netease-login-button img')].every(img => img.src.startsWith('data:'))), true, 'header avatar is local data only, never a platform image');
  await page.locator('[data-action="close-panel"]').click();
 // 本地歌单（我喜欢的音乐）排在最前，平台歌单从索引 1 开始 —— 保持行为一致。
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '901' && window.rhineMusic.selectedAlbum?.tracks.length === 1, undefined, { timeout: 90000 });
  console.log('Playlist grid ready; moving along one playlist');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 1);
  await page.evaluate(() => { for (let i = 0; i < 99; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 100);
  const cell = await page.evaluate(() => window.rhineMusic.stats().selectedCell); assert.equal(cell.row, 112); assert.equal(cell.lane, 3);
  assert.ok(songPages.some(page => page.id === '901' && page.offset === 100));
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false, 'browsing songs does not start audio');
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Space');
  await page.waitForFunction(() => window.rhineMusic.player.playing && window.rhineMusic.player.currentTrack?.id === 'netease-1100');
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playlistCell.playlistId), '901', 'playback retains the playlist grid');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue[0].id), 'netease-1050');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '902');
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playlistCell.songIndex), 1, 'short playlists wrap using their own song count');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack.id), 'netease-1100', 'switching parallel playlists preserves current playback');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '903');
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.tracks.length), 0);
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playlistCell.total), 0);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === 'favorites');
  assert.equal(await page.evaluate(() => window.rhineMusic.stats().selectedCell.lane), 6, 'last playlist moves forward to the first without reversing the physical strip');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '903');
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !window.rhineMusic.player.playing);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.transport), 'paused', 'the single transport button pauses instead of stopping');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack?.id), 'netease-1100', 'pause keeps the current track');
assert.equal(await page.locator('#transport-track').isVisible(), true, 'pause keeps the homepage now-playing display');
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playlistCell.playlistId), '903', 'pause retains own playlists');
  await page.locator('.music-view-toggle').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'true');
  assert.equal(await page.locator('.music-panel').count(), 0, 'the overview toggle opens the real overview camera without a picker dialog');
  await page.locator('button.overview-column-label[aria-controls="overview-playlist-3"]').hover();
  await page.locator('[data-overview-playlist-toggle="3"]').click();
  await page.locator('.overview-playlist-detail:not([hidden]) [data-action="overview-play-song"]').first().waitFor();
  assert.equal(await page.locator('.overview-column[data-playlist="true"] .overview-enter:enabled').count(), 0);
  assert.equal(await page.locator('[data-action="overview-list-page"]').count(), 0, 'playlist uses continuous scrolling');
  await page.locator('.overview-playlist-detail:not([hidden]) .overview-playlist-tracks').evaluate(list => { list.scrollTop = 50 * 56; });
  await page.locator('[data-action="overview-play-song"][data-song-index="50"]:enabled').waitFor();
  await page.locator('[data-action="overview-play-song"][data-song-index="50"]').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'false');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 50);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false, 'song-list selection locates the model without starting playback');
  await page.locator('.music-view-toggle').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'true');
  await page.locator('button.overview-column-label[aria-controls="overview-playlist-3"]').hover();
  await page.locator('[data-overview-playlist-toggle="3"]').click();
  await page.locator('[data-overview-playlist-toggle="3"]').click();
  assert.equal(await page.locator('.overview-anchor[data-playlist-expanded="true"]').count(), 0, 'the drawer folds back to the playlist name');
  await page.locator('.overview-return').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'false');
  await page.locator('.music-view-toggle').click();
  await page.waitForFunction(() => document.querySelector('#stage').dataset.overview === 'true');
  await page.locator('button.overview-column-label[aria-controls="overview-playlist-3"]').hover();
  await page.locator('[data-overview-playlist-toggle="3"]').click();
  await page.locator('[data-action="overview-play-song"][data-song-index="0"]:enabled').click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '901' && window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 0);
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 119);
  const endRow = await page.evaluate(() => window.rhineMusic.stats().selectedCell.row);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.songIndex === 0);
  assert.equal(await page.evaluate(() => window.rhineMusic.stats().selectedCell.row), endRow + 1, 'song seam keeps one-step motion');
  assert.ok(songPages.some(page => page.id === '901' && page.offset === 100));
  const duplicates = await page.evaluate(() => window.rhineMusic.stats());
  assert.ok(duplicates.visibleAlbumCells > duplicates.uniqueAlbumCells, 'the model repeats short playlists to fill the original display pool');
  await page.locator('.open-album').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail');
  assert.equal(await page.locator('.music-back').textContent(), '← 返回歌单');
  assert.equal(await page.locator('#album-detail-content .music-tabs, #album-detail-content .track-list').count(), 0);
  await page.waitForFunction(() => window.rhineMusic.player.playing && window.rhineMusic.player.currentTrack.id === 'netease-1000');
  await page.locator('#song-lyrics .current').waitFor();
  assert.equal(await page.locator('#song-info').isVisible(), false);
  assert.equal(await page.locator('#song-toggle-play').textContent(), '暂停播放');
  assert.equal(await page.locator('.lyric-transport button').count(), 3, 'the playbar carries the mode, effects and download buttons');
  assert.equal(await page.locator('#song-transport-status').count(), 0);
  assert.equal(await page.locator('#song-view [data-action="playing-prev"]').textContent(), '上一首');
  assert.equal(await page.locator('#song-view [data-action="playing-next"]').textContent(), '下一首');
  assert.equal(await page.locator('#song-view .song-step-buttons svg').count(), 2);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !window.rhineMusic.player.playing);
  const seek = page.locator('#song-view .playback-seek'); await seek.waitFor(); assert.equal(await seek.isEnabled(), true);
  const seekBox = await seek.boundingBox();
  await page.mouse.move(seekBox.x + 2, seekBox.y + seekBox.height / 2); await page.mouse.down();
  await page.mouse.move(seekBox.x + seekBox.width / 2, seekBox.y + seekBox.height / 2, { steps:8 }); await page.mouse.up();
  await page.waitForFunction(() => window.rhineMusic.player.currentTime > 50 && window.rhineMusic.player.currentTime < 70);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false, 'seek keeps the pause state');
  await page.waitForFunction(() => document.querySelector('#song-lyrics .current')?.textContent === '第二句');
  await page.locator('#song-lyrics [data-lyric-time="0"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.currentTime < 1);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false, 'clicking a lyric preserves pause');
  await page.locator('#play-pause').click(); await page.waitForFunction(() => window.rhineMusic.player.playing);
  await page.screenshot({ path:'artifacts/playback-ui/playlist-song-transport.png' });
  await page.locator('#song-toggle-play').click(); await page.waitForFunction(() => window.rhineMusic.player.transport === 'paused');
  assert.equal(await page.locator('#song-toggle-play').textContent(), '继续播放');
  assert.equal(await seek.isEnabled(), true, 'pause keeps the seek bar usable');
  assert.equal(await page.locator('#song-lyric-view').isVisible(), true, 'pause keeps the lyrics view');
  assert.equal(await page.locator('#song-info').isVisible(), false);
assert.equal(await page.locator('#song-view').isVisible(), true, 'pause keeps the detail now-playing display');
 // A blank-area click opens song details; another returns to lyrics.
  await page.locator('#song-lyrics').evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => !document.querySelector('#song-info').hidden);
  assert.ok((await page.locator('#song-facts').textContent()).includes('合成唱片'), 'blank-area click opens song details');
  await page.locator('#song-facts').evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => !document.querySelector('#song-lyric-view').hidden);
  assert.equal(await page.locator('#song-lyric-view').isVisible(), true, 'blank-area click returns to lyrics');
  await page.locator('.music-back').click(); await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'archive');
  await page.waitForFunction(() => window.rhineMusic.stats().musicArchiveReady && window.rhineMusic.stats().selectionPhase === 'settled');
 // Only the raised top of the selected cover is visible above the next card.
  const modelCenter = await page.evaluate(() => window.rhineMusic.stats().projectedCoverTop);
  await page.mouse.click(modelCenter[0], modelCenter[1]);
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail' && window.rhineMusic.player.playing);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack.id), 'netease-1000', 'clicking the selected raised model opens song details and starts audio');
  await page.locator('.music-back').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'archive');
assert.equal(await page.locator('#transport-track').isVisible(), true, 'pause keeps the homepage now-playing display');
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !window.rhineMusic.player.playing);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.transport), 'paused', 'pause never clears playback');
  await page.screenshot({ path: 'artifacts/playback-ui/playlist-grid-corrected.png' });
  console.log('Authenticated Three.js UI: parallel playlists, songs in depth, rapid 100-song navigation/paging, ordered muted playback, unequal/empty strips, pause semantics and overview playlist navigation passed.');
  await page.locator('[data-action="settings"]').click();
 // 「管理音乐库」在本地歌单这一页；「外观主题」在个性化页（第五步重排后的分类）。
  await page.locator('[data-action="settings-category"][data-category="local"]').click();
  await page.locator('[data-action="library"]').click(); await page.locator('#music-roots').waitFor();
  await page.getByRole('button', { name: '← 返回本地歌单设置' }).click();
  await page.locator('[data-action="settings-category"][data-category="personalization"]').click();
  await page.locator('[data-theme="night"]').click();
  assert.equal(await page.locator('.music-app').getAttribute('data-theme'), 'night');
  await page.locator('[data-action="close-panel"]').click();
  await page.screenshot({ path: 'artifacts/playback-ui/empty-archive-night.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.music-app').dataset.layout === 'portrait');
  const bounds = await page.locator('#netease-login-button').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await page.locator('#netease-login-button #account-avatar').isVisible(), true);
  await page.screenshot({ path: 'artifacts/playback-ui/empty-archive-portrait.png' });
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log('Empty glass array, direct header QR login, safe nickname, cancel polling, settings library/theme and portrait controls passed.');
  await post('/api/config', { roots: [musicRoot] }); await post('/api/library/scan', {});
  for (let i = 0; i < 100; i++) { const library = await (await fetch(`${base}/api/library`)).json(); if (!library.scan.running) { assert.equal(library.albums.length, 2); break; } await new Promise(resolve => setTimeout(resolve, 50)); }
  await page.goto(`${base}/?scene=archive&lab=0`);
  console.log('Full UI opened; preparing Three.js');
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  console.log('Three.js ready');
  await page.locator('#netease-login-button[data-auth="in"]').waitFor();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playlistCell?.playlistId === '901' && window.rhineMusic.selectedAlbum.tracks.length === 1, undefined, { timeout: 90000 });
  await page.locator('#netease-login-button').click(); await page.getByRole('button', { name: '退出登录' }).click();
  await page.locator('#netease-login-button[data-auth="out"]').waitFor({ state: 'attached' });
  await page.locator('[data-action="close-panel"]').click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="settings-category"][data-category="audio"]').click();
  await page.locator('#volume').evaluate(field => { field.value = '0'; field.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const id of ['bgm-setting', 'sound-setting']) await page.locator(`#${id}`).uncheck();
  await page.locator('[data-action="close-panel"]').click();
  await page.locator('[data-action="search"]').click();
  assert.equal(await page.locator('[data-search-source="network"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
 // Results stay in the list panel (the restored search no longer injects a
 // 搜索结果 album into the 3D pipeline); row 48 keeps the loop-pool boundary song.
  await page.waitForSelector('.online-search-results [data-online-track="netease-1047"]', { timeout: 90000 });
  console.log('Synthetic song 48 selected');
  await page.locator('.online-search-results [data-online-track="netease-1047"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'netease-1047' && window.rhineMusic.player.playing, undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.player.volume), 0);
 // 点击歌曲打开播放详情: the list panel plays without leaving the panel, so close
 // it first, then open the detail from the transport (same gesture as the queue).
  if (await page.locator('[data-action="close-panel"]').count()) await page.locator('[data-action="close-panel"]').click();
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail', undefined, { timeout: 60000 });
  await page.locator('#song-view [data-action="playing-next"]').waitFor({ timeout: 60000 });
  await page.locator('#song-view [data-action="playing-next"]').click();
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'netease-1048', undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue.length), 80);
  await page.evaluate(() => document.querySelector('#song-toggle-play').click());
  await page.waitForFunction(() => !window.rhineMusic.player.playing);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack?.id), 'netease-1048');
  await page.locator('[data-action="search"]').click(); await page.locator('[data-search-source="local"]').click();
  await page.locator('#album-search').fill('本地专辑二');
  await page.locator('[data-album]').filter({ hasText: '本地专辑二' }).first().click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.title === '本地专辑二' && !window.rhineMusic.selectedAlbum?.playback);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue.length), 80, 'browsing the catalog does not replace playback');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.playing), false);
await page.locator('#transport-track').click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playback?.trackId === 'netease-1048');
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => window.rhineMusic.presentation.phase === 'detail');
  await page.locator('#song-toggle-play').click();
  await page.waitForFunction(() => window.rhineMusic.player.transport === 'paused');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue.length), 80, 'detail pause preserves the full queue');
  await page.locator('#song-view [data-action="playing-prev"]').click();
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.playback?.trackId === 'netease-1047' && window.rhineMusic.player.playing);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => window.rhineMusic.player.transport === 'paused');
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.playback.trackId), 'netease-1047', 'pause keeps the playback album');
  assert.equal(await page.evaluate(() => window.rhineMusic.player.queue.length), 80, 'pause keeps the full queue');
assert.equal(await page.locator('#song-view').isVisible(), true, 'pause keeps the detail now-playing display');
  assert.deepEqual(errors, []);
  console.log('Real Three.js UI: 80-song queue, 48-row boundary, pause, separate local catalog, return to current song, detail playback/previous and pause retention passed (synthetic muted audio).');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/playback-ui', { recursive: true });
  await page?.screenshot({ path: 'artifacts/playback-ui/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await page?.evaluate(() => ({ loading: document.querySelector('#music-loading')?.textContent, album: window.rhineMusic?.selectedAlbum?.title, playlist: window.rhineMusic?.selectedAlbum?.playlistCell, tracks: window.rhineMusic?.selectedAlbum?.tracks.length, hidden: document.hidden, playback: window.rhineMusic?.selectedAlbum?.playback, presentation: window.rhineMusic?.presentation, mode: document.querySelector('.music-app')?.dataset.mode, transport: window.rhineMusic?.player.transport, error: window.rhineMusic?.player.error })));
  throw failure;
} finally {
  await browser.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fs.rm(directory, { recursive: true, force: true });
}
