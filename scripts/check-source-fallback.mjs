// VIP / 版权换源兜底 end to end: when one source refuses playback, the app
// looks the same song up on the other providers and switches automatically
// (synthetic data, zero-volume audio, hermetic mocks — no real traffic).
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-fallback-ui-'));
let base;
const twin = (provider, id, { title = '合成换源曲', fee = 0 } = {}) => ({ id: `${provider}-${id}`, albumId: `${provider}-album`, title, artist: '测试歌手', duration: 8,
  format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider, id: String(id), albumTitle: '合成专辑', fee, pageUrl: `https://example.test/${provider}/${id}` } });
const neteaseTwin = twin('netease', 1), qqTwin = twin('qq', 2);
// Trial fragments: netease serves a 30 s preview, qq carries the free full song.
const trialTwin = twin('netease', 3, { title: '合成试听曲', fee: 1 }), trialFullTwin = twin('qq', 4, { title: '合成试听曲' });
// Every source serves only a trial fragment.
const bothTrialTwin = twin('netease', 5, { title: '合成全试听曲', fee: 1 }), bothTrialQq = twin('qq', 6, { title: '合成全试听曲' });
// Version-word matching (落了白 案例): bracket/suffix renditions must find each
// other — same-version wins, other renditions degrade honestly, aliases and
// multi-artist lists also match.
const versionTrial = twin('netease', 7, { title: '合成版本曲（减速版）', fee: 1 });
const versionSame = twin('qq', 8, { title: '合成版本曲 降调减速版' });
const versionOther = twin('qq', 9, { title: '合成版本曲（氛围版）' });
const degradeTrial = twin('netease', 14, { title: '合成降级曲（减速版）', fee: 1 });
const degradeOnly = twin('qq', 15, { title: '合成降级曲（氛围版）' });
const aliasTrial = twin('netease', 10, { title: '合成别名曲（减速版）', fee: 1 });
const aliasHit = twin('qq', 11, { title: '合成别名曲2024' });
aliasHit.onlineSource.aliases = ['合成别名曲'];
const artistTrial = { ...twin('netease', 12, { title: '合成多艺人曲（减速版）', fee: 1 }), artist: '甲 / 乙' };
const artistHit = { ...twin('qq', 13, { title: '合成多艺人曲（降调版）' }), artist: '乙' };
// 死循环回归：两个源互相都带付费证据（fee=1）且能互相匹配 —— 曾经会在两边
// 无限乒乓（服务端兜底没清 fee → 播放器判定付费 → 换源 → 那边也带 fee …）。
const pingpongA = twin('netease', 16, { title: '合成乒乓曲', fee: 1 });
const pingpongB = twin('qq', 17, { title: '合成乒乓曲', fee: 1 });
const searchResults = (provider, tracks) => ({ provider, query: 'test', offset: 0, limit: 20, total: tracks.length, hasMore: false, tracks });
const emptyCatalog = { search: async () => searchResults('kugou', []), playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); } };
const { server } = await createMusicServer({ dataDir: directory, autoScan: false,
  online: {
    search: async () => searchResults('netease', [neteaseTwin, trialTwin, bothTrialTwin, versionTrial, degradeTrial, aliasTrial, artistTrial, pingpongA]),
    prepare: async (id) => {
      if (String(id) === '1') throw Object.assign(new Error('网易云未提供这首歌的播放地址，可能需要会员或所在地区的播放权限。'), { status: 403 });
 // 乒乓曲（真实死循环场景）：地址是完整可播的，但 fee 标记仍是 1 ——
 // 播放器看到 fee≠0 就会去换源，换到的那边同样带 fee，于是无限乒乓。
 // 修复前正是这个组合让用户「一直放不出来」。
      if (String(id) === '16') return { audioUrl: `${base}/short.wav`, fee: 1 };
      return { audioUrl: `${base}/short.wav`, trial: { start: 0, end: 30 } }; // freeTrialInfo evidence
    },
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async () => ({ track: neteaseTwin, album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }),
    playlists: async () => ({ playlists: [], hasMore: false }), playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  },
  catalogs: {
    qq: { search: async () => searchResults('qq', [qqTwin, trialFullTwin, bothTrialQq, versionSame, versionOther, degradeOnly, aliasHit, artistHit, pingpongB]),
      prepare: async (id) => String(id) === '6'
        ? { audioUrl: `${base}/short.wav`, trial: { start: 0, end: 30 } }
 // 乒乓曲的 qq 侧：同样是「完整地址 + fee=1」
        : String(id) === '17'
          ? { audioUrl: `${base}/short.wav`, fee: 1 }
          : { audioUrl: `${base}/short.wav` },
      playlists: async () => ({ playlists: [], hasMore: false }), playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
      songInfo: async () => ({ track: qqTwin, album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }) },
    bodian: { ...emptyCatalog, search: async () => searchResults('bodian', []) },
    kugou: { ...emptyCatalog, search: async () => searchResults('kugou', []) },
    kuwo: { ...emptyCatalog, search: async () => searchResults('kuwo', []) },
    joox: { ...emptyCatalog, search: async () => searchResults('joox', []) },
  },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
  page.setDefaultTimeout(30000);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, arg, options) => waitForFunction(fn, arg, { polling: 100, ...options });
  await page.addInitScript(() => { localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } })); window.__trialToasts = []; new MutationObserver(() => { for (const el of document.querySelectorAll('#music-toast')) { const text = el.textContent || ''; if (/(仅试听|试听片段|只能听)/.test(text) && !window.__trialToasts.includes(text)) window.__trialToasts.push(text); } }).observe(document, { childList: true, subtree: true }); });
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  const samples = 8000 * 120, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  await page.route('**/short.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await page.waitForFunction(() => window.rhineMusic.stats()?.triangles > 0);

 // Aggregate search merges the provider twins of each song into one row.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.selectedAlbum.tracks.length), 13, 'each song keeps one row across sources');

 // Playing the refused source triggers the automatic cross-source fallback.
 // Click in page context: rows re-render on every playback state emit, which
 // stalls Playwright's actionability confirmation.
  await page.waitForSelector('.track-row[data-track="netease-1"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-1"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-2' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });
  const settled = await page.evaluate(() => ({ provider: window.rhineMusic.player.currentTrack?.onlineSource?.provider, id: window.rhineMusic.player.currentTrack?.id }));
  assert.equal(settled.provider, 'qq', 'playback settles on the source that can serve the song');
  assert.equal(settled.id, 'qq-2');

 // A trial fragment is resolved BEFORE playback: the free full-song variant is
 // what plays from the start — the trial never enters playback.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-3"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-3"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-4' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.player.trial), null, 'the trial fragment never enters playback');
  await page.waitForSelector('#song-view');
  await page.evaluate(() => document.querySelector('#song-view').click());
  await page.locator('#song-online .source-badge').waitFor();
  assert.equal(await page.locator('#song-online .source-badge').textContent(), 'QQ 音乐', 'proactive resolution plays the free full-song source');
  assert.equal(await page.locator('#song-online .fee-tag').textContent(), '在线', 'the full song replaces the trial badge');

 // When every source serves only a trial fragment, the original plays its
 // fragment once — no switching loop, no toast spam, one honest inline label.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-5"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-5"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'netease-5' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.rhineMusic.player.currentTrack?.id), 'netease-5', 'all-trial songs play the original fragment, no switching loop');
  assert.deepEqual(await page.evaluate(() => window.__trialToasts), [], 'trial truth is an inline label, never a toast');
  await page.waitForSelector('#song-view');
  await page.evaluate(() => document.querySelector('#song-view').click());
  await page.locator('#song-online .fee-tag').waitFor();
  assert.equal(await page.locator('#song-online .fee-tag').textContent(), '全网仅试听 0:30', 'the playing fragment is labelled with its evidence-backed length');
 // The labelled fragment must really play: progress advances inside the window
 // and any media failure is visible, never silent (落了白 案例).
  const fragment = await page.evaluate(() => ({ time: window.rhineMusic.player.currentTime, playing: window.rhineMusic.player.playing, error: window.rhineMusic.player.error }));
  assert.ok(fragment.time > 0.5, `all-trial fragment really plays (currentTime=${fragment.time})`);
  assert.equal(fragment.error, null, 'fragment playback failure must be visible, never silent');

 // Version-word matching (L2): the「减速版」rendition finds the same-version
 // free full song on another source even though the titles differ verbatim
 // (「（减速版）」 vs 「降调减速版」).
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-7"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-7"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-8' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.rhineMusic.player.trial), null, 'same-version L2 match plays the free full song');

 // L2 same-version outranks other renditions (qq-9「氛围版」also exists; had
 // the ranking preferred it the settle above would land on qq-9).

 // Other renditions degrade honestly when nothing closer exists.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-14"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-14"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-15' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });

 // L3 alias matching: the qq entry carries the wanted title as an alias.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-10"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-10"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-11' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });

 // Multi-artist lists match by member: wanted「甲 / 乙」pairs with「乙」.
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-12"]');
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-12"]').click());
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'qq-13' && window.rhineMusic.player.playing, undefined, { timeout: 30000 });

 // 死循环回归（用户实测）：每个源都带付费证据、且互相都能匹配到时，播放
 // 必须稳定落在一首歌上，绝不能在音源之间来回乒乓。做法是记录 currentTrack
 // 的变化序列，断言它在 8 秒内收敛（切换次数极少），且最终真的在播。
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('test'); await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.waitForSelector('.track-row[data-track="netease-16"]');
  await page.evaluate(() => {
    window.__switchLog = [];
    const sample = () => {
      const id = window.rhineMusic.player.currentTrack?.id ?? null;
      if (window.__switchLog[window.__switchLog.length - 1] !== id) window.__switchLog.push(id);
    };
    window.__switchTimer = setInterval(sample, 100);
  });
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-16"]').click());
  await page.waitForTimeout(8000);
  const pingpong = await page.evaluate(() => {
    clearInterval(window.__switchTimer);
    return { log: window.__switchLog, playing: window.rhineMusic.player.playing, track: window.rhineMusic.player.currentTrack?.id };
  });
  assert.ok(pingpong.log.length <= 3,
    `paid-everywhere songs must settle instead of ping-ponging (switches: ${pingpong.log.join(' → ')})`);
  assert.ok(pingpong.playing, `the settled song must actually play (track=${pingpong.track})`);

  assert.deepEqual(errors, []);
  console.log('VIP/source fallback: refused songs switch sources reactively; trial fragments resolve proactively to free full songs; all-trial songs play their fragment with one honest inline label.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/source-fallback', { recursive: true });
  await page?.screenshot({ path: 'artifacts/source-fallback/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await page?.evaluate(() => ({
    current: window.rhineMusic?.player?.currentTrack?.id,
    provider: window.rhineMusic?.player?.currentTrack?.onlineSource?.provider,
    transport: window.rhineMusic?.player?.transport,
    error: window.rhineMusic?.player?.error,
    album: window.rhineMusic?.selectedAlbum?.title,
    albumId: window.rhineMusic?.selectedAlbum?.id,
    selected: window.rhineMusic?.selectedAlbum ? 'yes' : 'no',
    tracks: window.rhineMusic?.selectedAlbum?.tracks?.map(track => track.id),
    status: document.querySelector('.online-search-status')?.textContent,
    detailHidden: document.querySelector('#music-detail')?.hidden,
    songView: JSON.stringify(document.querySelector('#song-view')?.dataset),
    presentation: JSON.stringify(window.rhineMusic?.presentation),
  })));
  throw failure;
} finally {
  await browser.close(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fs.rm(directory, { recursive: true, force: true });
}
