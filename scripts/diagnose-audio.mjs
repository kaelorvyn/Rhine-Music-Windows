// One-shot audio diagnosis: boot the built app with synthetic fixtures, play a
// song, then dump every value that can silence the song path (element volume,
// song gain, AudioContext state, chain gains, backend/device). Mirrors the
// check-playback-ui bootstrap but reads state instead of asserting behavior.
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-diagnose-'));
let base;
let fixtureBase;
// Real 440Hz tone at half amplitude: the DSP RMS probe needs actual signal — a
// zero-filled fixture is digital silence and would fake "processing passes nothing".
const samples = 8000 * 120, fixtureAudio = Buffer.alloc(44 + samples * 2);
fixtureAudio.write('RIFF'); fixtureAudio.writeUInt32LE(fixtureAudio.length - 8, 4); fixtureAudio.write('WAVEfmt ', 8); fixtureAudio.writeUInt32LE(16, 16); fixtureAudio.writeUInt16LE(1, 20); fixtureAudio.writeUInt16LE(1, 22); fixtureAudio.writeUInt32LE(8000, 24); fixtureAudio.writeUInt32LE(16000, 28); fixtureAudio.writeUInt16LE(2, 32); fixtureAudio.writeUInt16LE(16, 34); fixtureAudio.write('data', 36); fixtureAudio.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) fixtureAudio.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 0.5 * 32767), 44 + i * 2);
const queue = Array.from({ length: 3 }, (_, index) => ({ id: `netease-${1000 + index}`, albumId: 'album-1', title: `合成歌曲 ${index + 1}`, artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'netease', id: String(1000 + index), albumTitle: '合成专辑', fee: 0, pageUrl: 'https://music.163.com/', coverUrl: undefined } }));
const variantTrack = { id: 'kuwo-9001', albumId: 'album-9', title: '合成歌曲 1', artist: '测试歌手', duration: 120, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'kuwo', id: '9001', albumTitle: '合成专辑', fee: 0, pageUrl: 'https://www.kuwo.cn/', coverUrl: undefined } };
const kuwoCatalog = {
  search: async () => ({ provider: 'kuwo', query: '', tracks: [variantTrack], offset: 0, limit: 20, total: 1, hasMore: false }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
  prepare: async () => ({ audioUrl: `${fixtureBase}/synthetic.wav` }),
};
const emptyCatalog = provider => ({
  search: async () => ({ provider, query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
  songInfo: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
  prepare: async () => { throw Object.assign(new Error('合成夹具未提供该平台。'), { status: 404 }); },
});
const { server } = await createMusicServer({ dataDir: directory, autoScan: false, catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: kuwoCatalog, joox: emptyCatalog('joox') }, online: {
  search: async () => ({ provider: 'netease', query: 'test', tracks: queue, offset: 0, limit: 20, total: 3, hasMore: false }),
 // Track 1000 serves only a 2s trial fragment: proactive resolution must pick
 // the free kuwo variant BEFORE playback — the trial never starts, no trial
 // notice appears, and playback passes the 2s trial end by a wide margin.
  prepare: async id => (String(id) === '1000'
    ? { audioUrl: `${fixtureBase}/synthetic.wav`, trial: { start: 0, end: 2 } }
    : { audioUrl: `${fixtureBase}/synthetic.wav` }),
  auth: { status: async () => ({ loggedIn: false }), start: async () => ({ id: 'x', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', expiresAt: Date.now() + 120000 }), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
  songInfo: async id => ({ track: queue.find(t => t.onlineSource.id === id), album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
// The upstream fixture is served over real HTTP: the native DSP route makes the
// SERVER fetch it (Playwright's page.route cannot intercept server-side reads).
const fixtureServer = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': fixtureAudio.length });
  response.end(fixtureAudio);
});
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'], timeout: 15000 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(45000);
 // The user's exact persisted config (dumped from their WebView2 profile):
 // volume 0.65, browser backend, quality ultra + manual pipeline, pop preset.
  await page.addInitScript(() => {
    localStorage.setItem('rhine-music-preferences', JSON.stringify({ theme: 'day', sortMode: 'genre', arrayMode: 'filled', rememberColumnPosition: true, audioBackend: 'browser', outputDeviceId: 'default', quality: 'ultra', qualityPipelineVersion: 5, qualityMode: 'manual', reduced: false, volume: 0.65, songTransition: 'fade-in-out', bgm: true, bgmVolume: 0.18, sound: true, soundVolume: 0.22, renderQuality: { scale: 150, pixelRatio: 2, antialias: 'smaa', shadows: 4096, aoSamples: 64, aoResolution: 1, depthOfField: 100, transmission: 1, anisotropy: 1 }, arrayBudget: 0 }));
    localStorage.setItem('rhine-music-effects', JSON.stringify({ enabled: true, eqEnabled: true, eqBands: [2, 2, 1, 0, -1, 0, 1, 2, 2, 1], bassEnabled: false, bassGain: 0, bassFreq: 120, trebleGain: 0, clarityGain: 0, compressor: 0, balance: 0, reverbEnabled: false, reverbMix: 0, widenEnabled: false, widenWidth: 100, surroundEnabled: false, surroundSpeed: 0.15, preampDb: -3, limiterEnabled: true }));
  });
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
 // Real play path: search, then click a result row (the same flow a user takes).
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('测试');
  await page.locator('#online-search').press('Enter');
  await page.waitForFunction(() => window.rhineMusic.selectedAlbum?.id === 'search-results', undefined, { timeout: 60000 });
  await page.locator('.track-row').first().waitFor({ timeout: 20000 });
 // Record whether trial state or a trial notice EVER appears (the hook player
 // is a state projection, so sample it): proactive resolution plays the full
 // variant directly, so neither may be observed.
  await page.evaluate(() => {
    window.__trialSeen = false; window.__trialNoticeSeen = false;
    setInterval(() => {
      const state = window.rhineMusic.player;
      if (state.trial) window.__trialSeen = true;
      if (state.transitionWarning && /试听片段/.test(state.transitionWarning)) window.__trialNoticeSeen = true;
    }, 50);
  });
  await page.evaluate(() => document.querySelector('.track-row[data-track="netease-1000"]').click());
 // The full-song variant must be the playing track — no trial-first hand-off.
  await page.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'kuwo-9001' && window.rhineMusic.player.playing, undefined, { timeout: 60000 });
  await page.waitForTimeout(6000);
  const dump = await page.evaluate(() => ({
    ...window.rhineMusic.audioDiagnostics,
    currentTrackId: window.rhineMusic.player.currentTrack?.id ?? null,
    playing: window.rhineMusic.player.playing,
    currentTime: window.rhineMusic.player.currentTime,
    trial: window.rhineMusic.player.trial,
    trialSeen: window.__trialSeen,
    trialNoticeSeen: window.__trialNoticeSeen,
    transitionWarning: window.rhineMusic.player.transitionWarning,
  }));
  console.log(JSON.stringify(dump, null, 2));
 // Real-signal DSP check: a -6dB preamp must halve the RMS of the served audio
 // versus the raw fixture — proves the server truly processes the samples.
  const rawBytes = Buffer.from(await (await fetch(`${fixtureBase}/synthetic.wav`)).arrayBuffer());
  const processedBytes = Buffer.from(await (await fetch(`${base}/api/audio/processed-online/kuwo/9001?preamp=-6`)).arrayBuffer());
  const rms = buffer => {
    const marker = buffer.indexOf('data', 12);
    const begin = marker >= 0 ? marker + 8 : 44;
    let sum = 0, count = 0;
    for (let offset = begin; offset + 1 < buffer.length; offset += 2) {
      const value = buffer.readInt16LE(offset); sum += value * value; count++;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const dspRatio = rms(processedBytes) / rms(rawBytes);
  console.log(`DSP RMS ratio (expect ≈0.50 for -6dB): ${dspRatio.toFixed(3)}`);
 // Regression guards: the native DSP source is what plays (Web Audio retired),
 // gains healthy, the trial fragment never enters playback, and currentTime
 // runs well past the 2s trial end (no residual trial clamping).
  const healthy = dump.effectsEnabled === true
    && dump.songSrc && dump.songSrc.includes('/api/audio/processed-online/kuwo/9001')
    && dump.songVolume > 0 && dump.songGain > 0.5
    && dump.playing === true && dump.currentTime > 3
    && dump.currentTrackId === 'kuwo-9001'
    && dump.trial === null && dump.trialSeen === false && dump.trialNoticeSeen === false
    && dspRatio > 0.4 && dspRatio < 0.6;
  if (!healthy) {
    console.error('AUDIO PATH UNHEALTHY — see dump above');
    process.exitCode = 1;
  } else {
    console.log(`audio path healthy: native DSP source playing (RMS ratio ${dspRatio.toFixed(3)}), proactive full-song variant, no trial residue`);
  }
} finally {
  await browser.close();
  server.close();
  fixtureServer.close();
}
