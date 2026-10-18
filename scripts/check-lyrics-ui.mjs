// Lyrics UI wiring: the song detail must show 跨源回填/翻译两行/纯音乐/暂无歌词
// (display semantics) driven by GET /api/lyrics — synthetic fixtures only.
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-ui-'));
let base;
// Case A: own source has no lyrics → cross-source backfill (kuwo mock) with translation.
// Case B: instrumental → 纯音乐. Case C: nobody has lyrics → honest 暂无歌词.
const cases = {
  '1001': { original: '', translated: '', instrumental: false, unavailable: true },
  '1002': { original: '', translated: '', instrumental: true, unavailable: false },
  '1003': { original: '', translated: '', instrumental: false, unavailable: true },
};
const trackOf = (id, title) => ({ id: `netease-${id}`, albumId: 'album-1', title, artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'netease', id, albumTitle: '合成专辑', fee: 0, pageUrl: 'https://music.163.com/', coverUrl: undefined } });
const queue = [trackOf('1001', '合成歌曲 A'), trackOf('1002', '合成歌曲 B'), trackOf('1003', '合成歌曲 C')];
const kuwoVariant = { ...trackOf('9001', '合成歌曲 A'), id: 'kuwo-9001', onlineSource: { provider: 'kuwo', id: '9001', albumTitle: '合成专辑', fee: 0, pageUrl: 'https://www.kuwo.cn/' } };

const emptyCatalog = provider => ({
  search: async () => ({ provider, query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
});
const kuwoCatalog = {
  ...emptyCatalog('kuwo'),
  search: async query => ({ provider: 'kuwo', query, tracks: query.includes('合成歌曲 A') ? [kuwoVariant] : [], offset: 0, limit: 20, total: 0, hasMore: false }),
  songInfo: async () => ({ track: kuwoVariant, album: { title: '合成专辑', artist: '测试歌手' },
    lyrics: { original: '[00:01]跨源第一句\n[00:02]跨源第二句', translated: '[00:01]Translation one\n[00:02]Translation two', instrumental: false, unavailable: false } }),
  prepare: async () => ({ audioUrl: `${base}/synthetic.wav` }),
};
const { server } = await createMusicServer({ dataDir: directory, autoScan: false,
  catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: kuwoCatalog, joox: emptyCatalog('joox') },
  online: {
    search: async () => ({ provider: 'netease', query: 'test', tracks: queue, offset: 0, limit: 20, total: 3, hasMore: false }),
    prepare: async () => ({ audioUrl: `${base}/synthetic.wav` }),
    songInfo: async id => ({ track: queue.find(track => track.onlineSource.id === id),
      album: { title: '合成专辑', artist: '测试歌手' }, lyrics: cases[id] ?? { original: '', translated: '', instrumental: false, unavailable: true } }),
    auth: { status: async () => ({ loggedIn: false }), start: async () => { throw Object.assign(new Error('合成夹具未登录。'), { status: 400 }); },
      poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ ok: true }) },
  } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(45000);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, arg, options) => waitForFunction(fn, arg, { polling: 100, ...options });
  await page.addInitScript(() => localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } })));
  const samples = 8000 * 30, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  await page.route('**/synthetic.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));

  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
 // One entry per case: the row list is replaced by the play detail after a
 // click, so each case re-enters through search (deterministic, no nav guessing).
  const openCase = async id => {
    await page.locator('[data-action="search"]').click();
    await page.locator('#online-search').fill('合成');
    await page.locator('#online-search').press('Enter');
    await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
    await page.locator(`.track-row[data-track="netease-${id}"]`).waitFor({ timeout: 20000 });
    await page.evaluate(trackId => document.querySelector(`.track-row[data-track="netease-${trackId}"]`).click(), id);
    await page.waitForFunction(trackId => window.rhineMusic.player.currentTrack?.id === `netease-${trackId}`, id, { timeout: 60000 });
  };

  const lyricText = () => page.evaluate(() => document.querySelector('#song-lyrics')?.textContent ?? '');

 // Case A: cross-source backfill renders timed lines + translation pairs.
  await openCase('1001');
  await page.waitForFunction(() => document.querySelectorAll('#song-lyrics .lyric-line').length === 2, undefined, { timeout: 30000 });
  const lines = await page.evaluate(() => [...document.querySelectorAll('#song-lyrics .lyric-line')].map(line => ({
    text: line.querySelector('span')?.textContent, translation: line.querySelector('small')?.textContent ?? null })));
  assert.deepEqual(lines.map(line => line.text), ['跨源第一句', '跨源第二句'], 'backfilled lyrics render as timed lines');
  assert.deepEqual(lines.map(line => line.translation), ['Translation one', 'Translation two'], 'translation pairs render on its own row line');
  console.log('Case A ok: 跨源回填 + 翻译两行');

 // Case B: instrumental shows the 纯音乐 label (no lines).
  await openCase('1002');
  await page.waitForFunction(() => (document.querySelector('#song-lyrics')?.textContent ?? '').includes('纯音乐'), undefined, { timeout: 30000 });
  console.log('Case B ok: 纯音乐');

 // Case C: no source has lyrics → honest 暂无歌词, never a stale document.
  await openCase('1003');
  await page.waitForFunction(() => (document.querySelector('#song-lyrics')?.textContent ?? '').includes('暂无歌词'), undefined, { timeout: 30000 });
  assert.ok(!(await lyricText()).includes('跨源'), 'case C must not inherit case A lyrics');
  console.log('Case C ok: 暂无歌词');
  console.log('check:lyrics-ui — all four display states pass');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
