// Aggregate search UX: results enter the ordinary 3D browse pipeline as the
// "搜索结果" virtual album (selectedAlbum → articles → trackList), and the online
// song detail carries the migrated info area (source badge, quality tier, 原唱
// tag, alias, watch-only MV). Full-app harness with hermetic provider mocks
// and synthetic fixtures.
//
// 两条规则：
// 1. 用户不能自己换源 —— per-row 换源菜单，音源由后端决定。
// 2. 平台切换行只在搜索出结果之后出现（search-platform-row）。
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-search-ui-'));
let base;
const track = (provider, id, title, artist, format, extra = {}) => ({
  id: `${provider}-${id}`, albumId: `${provider}-album-${id}`, title, artist, duration: 200, format,
  browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider, id: String(id), albumTitle: `专辑 ${id}`, fee: 0, pageUrl: `https://example.test/${provider}/${id}`,
 // Distinct decodable covers per song (SVG data URIs: hermetic, no network).
    coverUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#333"/><text x="0" y="3">${provider}-${id}</text></svg>`)}`, ...extra },
});
const catalogs = {
 // 网易云 4 首：顺序 = **平台原序**（不重排）。
 // capabilities 用来驱动多枚徽章（t10 的 qualityBadges 消费同一份字段）。
  netease: [track('netease', 101, '夜曲', '测试歌手', 'FLAC', { aliases: ['Nocturne'], capabilities: { levels: ['lossless', 'hires'] } }),
    track('netease', 102, '晴天', '测试歌手', '320k', { original: true, qualityLabel: '高品', mv: { id: '777' } }),
    track('netease', 103, '七里香', '测试歌手', '128k MP3', { fee: 1 }),
 // 一行三枚徽章：母带 + HiFi + 无损（一行可同时出现多枚）。
    track('netease', 104, '風の住む街', '测试歌手', 'FLAC', { capabilities: { levels: ['lossless', 'hifi', 'master'] } })],
  qq: [track('qq', 201, '夜曲', '测试歌手', 'Hi-Res'),
    track('qq', 202, '搁浅', '测试歌手', 'Hi-Res', { mv: { url: '/synthetic-mv.mp4' } })],
  bodian: [track('bodian', 301, '夜曲', '测试歌手', '128k MP3')],
  kugou: [track('kugou', 401, '青花瓷', '测试歌手', 'FLAC', { qualityLabel: '无损' })],
  kuwo: [track('kuwo', 501, '青花瓷', '测试歌手', '320k', { qualityLabel: '高品' })],
  joox: [track('joox', 601, '稻香 <img src=x onerror="alert(1)">', '测试歌手', '320k', { qualityLabel: '高品' })],
};
const searchCalls = [];
const pageOf = (provider, q, offset, tracks) => ({ provider, query: q, offset, limit: 20, total: tracks.length, hasMore: true, tracks });
// 试听用例：一首**全网独有**的曲（标题/歌手独一份）→ 备用音源找不到候选，
// 片段按设计留在原地播放（界面上不标任何付费/来源字样）。
const trialTrack = track('kugou', 999, '试听独占曲', '独占歌手', '128k MP3');
const catalogMock = provider => ({
  search: async (q, offset) => {
    searchCalls.push({ provider, q, offset });
 // 'trial' 查询只在酷狗有这首独占曲 —— 别的平台查不到，于是
 // findPlayableVariant 找不到全曲候选，片段按设计留在原地播放。
    if (q === 'trial') return pageOf(provider, q, offset, provider === 'kugou' ? [trialTrack] : []);
    return pageOf(provider, q, offset, q === 'none' ? [] : catalogs[provider] ?? []);
  },
 // 后端 prepare 的形态：试听曲回 { audioUrl, trial, fee }，其余回全曲。
  prepare: async id => String(id) === '999'
    ? { audioUrl: `${base}/short.wav`, trial: { start: 0, end: 60 }, fee: 1 }
    : { audioUrl: `${base}/short.wav` },
  songInfo: async id => ({ track: (id === '999' ? trialTrack : catalogs[provider]?.find(item => item.onlineSource.id === id)) ?? catalogs[provider]?.[0],
    album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '[00:00]第一句', translated: '', instrumental: false, unavailable: false } }),
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
});
// 网易云 is the `online` service; the other providers are platform catalogs.
// 关掉备用音源（第三方解析接口），测试才能完全自洽、不依赖外网：
// 否则酷狗试听曲会被真实备用音源解析成全曲，试听链路就测不到了。
await fs.writeFile(path.join(directory, 'backup-sources-config.json'), JSON.stringify({ enabled: false }));
// 同时关掉 LX 音源插件：开着的话服务端会在 listening 之后跑一次**真实联网**的
// 64 个音源自检（budgetMs 180s），前端加载页要等它才会放行 —— 这个门禁就会被
// 外网拖死（本机首次跑时卡在「1 / 64　可用 0」）。本用例的音源全部是 mock，
// 关掉插件不影响任何断言。
await fs.writeFile(path.join(directory, 'lx-config.json'), JSON.stringify({ enabled: false }));
const { server } = await createMusicServer({ dataDir: directory, autoScan: false, online: {
  search: async (q, offset) => {
    searchCalls.push({ provider: 'netease', q, offset });
    return pageOf('netease', q, offset, q === 'none' ? [] : catalogs.netease);
  },
  prepare: async () => ({ audioUrl: `${base}/short.wav` }),
  songInfo: async id => ({ track: catalogs.netease.find(item => item.onlineSource.id === id) ?? catalogs.netease[0],
    album: { title: '合成专辑', artist: '测试歌手' }, lyrics: { original: '[00:00]第一句', translated: '', instrumental: false, unavailable: false } }),
  auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
  playlists: async () => ({ playlists: [], hasMore: false }),
  playlistTracks: async () => ({ playlistId: '', offset: 0, tracks: [], total: 0, hasMore: false }),
}, catalogs: {
  qq: catalogMock('qq'), bodian: catalogMock('bodian'),
  kugou: catalogMock('kugou'), kuwo: catalogMock('kuwo'), joox: catalogMock('joox'),
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let app;
try {
  app = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
  app.setDefaultTimeout(45000);
  const waitForFunction = app.waitForFunction.bind(app);
  app.waitForFunction = (fn, arg, options) => waitForFunction(fn, arg, { polling: 100, ...options });
  await app.addInitScript(() => localStorage.setItem('rhine-music-preferences', JSON.stringify({ volume: 0, bgm: false, sound: false, reduced: true, arrayMode: 'realistic', quality: 'performance', renderQuality: { scale: 40, pixelRatio: 1, antialias: 'off', shadows: 0, aoSamples: 0, aoResolution: .5, depthOfField: 0, transmission: 0, anisotropy: 1 } })));
  app.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  const samples = 8000 * 120, audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  await app.route('**/short.wav', route => route.fulfill({ contentType: 'audio/wav', body: audio }));
  await app.route('**/synthetic-mv.mp4', route => route.fulfill({ contentType: 'video/mp4', body: Buffer.from('not-a-real-video') }));
  await app.route('**/api/online/*/mv/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '777', url: '/synthetic-mv.mp4' }) }));
  const musicRoot = path.join(directory, 'synthetic-library');
  const localAlbum = path.join(musicRoot, '本地专辑'); await fs.mkdir(localAlbum, { recursive: true });
  await fs.writeFile(path.join(localAlbum, '合成静音.wav'), audio);
  const post = (route, value) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  await app.goto(`${base}/?lab=0`);
  await app.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await app.waitForFunction(() => window.rhineMusic.stats()?.triangles > 0);
  await post('/api/config', { roots: [musicRoot] }); await post('/api/library/scan', {});
  await app.waitForFunction(() => window.rhineMusic.library?.albums?.length === 1, undefined, { timeout: 60000 });

 // The search panel keeps the 网络搜索/本地音乐 switch and lists every source as a tab.
  await app.locator('[data-action="search"]').click();
  assert.equal(await app.locator('[data-search-source="network"]').getAttribute('aria-pressed'), 'true', 'network search stays the default');
 // search-platform-row：平台切换行只在搜索出结果之后出现，
 // 搜索框底下不放任何平台选择。
  assert.equal(await app.locator('.online-source-tabs').isHidden(), true,
    '：搜索之前不显示平台切换行');
  assert.deepEqual(await app.locator('[data-source-tab]').allTextContents(),
    ['网易云音乐', 'QQ音乐', '酷我音乐', '酷狗音乐'],
    '平台页签 = 4 个搜索平台，文案用 exe 的 display 原文（顺序对齐 iC 数组）');
  assert.equal(await app.locator('[data-source-tab="all"]').count(), 0,
    '：没有「全部」聚合页签');
  assert.equal(await app.locator('[data-source-tab="kuwo"]').getAttribute('aria-selected'), 'true',
    '默认平台是酷我（searchSource 初值 useState("Kuwo")）');

 // 单平台搜索：一次只请求一个平台，结果保持**平台原序**。
 // `search_songs(keyword,source,page,pageSize)` 就是这个形态，
 // 它不做 5 路并发聚合、也没有聚合去重。
  const searchesBefore = searchCalls.length;
  await app.locator('#online-search').fill('测试'); await app.locator('#online-search').press('Enter');
  await app.locator('.online-search-results .unified-song').first().waitFor({ timeout: 60000 });
  assert.equal(await app.locator('.online-source-tabs').isHidden(), false,
    '：搜索之后才显示平台切换行');
  assert.deepEqual([...new Set(searchCalls.slice(searchesBefore).map(call => call.provider))], ['kuwo'],
    '只打一个平台：没有「全部」聚合的 5 路并发');
 // 酷我目录只有 1 首（青花瓷）—— 不再是「5 平台去重成 6 条」。
  assert.equal(await app.locator('.online-search-results .unified-song').count(), 1,
    '酷我页签只显示酷我自己的结果');
 // 行结构：序号 | 封面 | 标题+徽章 | 歌手 | 专辑 | 时长 | 操作。
  const kuwoRow = app.locator('.online-search-results .unified-song').first();
  assert.equal(await kuwoRow.locator('.unified-song-index').textContent(), '01',
    '序号列：两位补零，从 01 起（String(index+1).padStart(2,"0")）');
  assert.equal(await kuwoRow.locator('.unified-song-duration').textContent(), '03:20',
    '时长列：mm:ss（duration=200s）');
  assert.equal(await kuwoRow.locator('.unified-song-album').textContent(), '专辑 501',
    '右侧专辑名列');
  assert.equal(await kuwoRow.locator('.unified-song-cover').count(), 1, '每行有自己的封面');
  assert.equal(await kuwoRow.locator('.unified-song-artist').textContent(), '测试歌手', '歌手列');
 // Remote text still cannot inject markup.
  assert.equal(await app.locator('.online-search-results script, .online-search-results iframe').count(), 0,
    'remote titles cannot inject markup');
 // The restored list panel renders results inline instead of injecting a
 // search-results album into the 3D wall.
  assert.equal(await app.evaluate(() => window.rhineMusic.selectedAlbum?.id === 'search-results'), false,
    'the list panel keeps results out of the 3D album pipeline');
 // Status and paging live in the panel (no more 聚合 N 个音源 wording).
  await app.locator('.online-search-status').filter({ hasText: '找到 1 首歌曲' }).waitFor();
  assert.equal(await app.locator('.online-search-results .unified-song-copy strong').count(), 1,
    'every row renders its title as text');
  assert.equal(await app.locator('[data-online-page="20"]').count(), 1, 'paging renders under the results');
  await fs.mkdir('artifacts/search-ui', { recursive: true });
  await app.screenshot({ path: 'artifacts/search-ui/network-search-panel.png' });

 // 人气 / 最新 排序切换（search-song-order-options）：
 // 只重排当前这批结果，**不重新请求**。
  assert.deepEqual(await app.locator('[data-song-order]').allTextContents(), ['人气', '最新'],
    '排序切换 = 人气 / 最新');
  assert.equal(await app.locator('[data-song-order="hot"]').getAttribute('aria-selected'), 'true',
    '默认按人气');
  const beforeSort = searchCalls.length;
  await app.locator('[data-song-order="time"]').click();
  assert.equal(await app.locator('[data-song-order="time"]').getAttribute('aria-selected'), 'true',
    '点「最新」后切换选中');
  assert.equal(await app.locator('.online-song-order').evaluate(el => el.classList.contains('is-time-active')), true,
    '滑块移到「最新」（.is-time-active:before{transform}）');
  assert.equal(searchCalls.length, beforeSort, '切排序不重新搜（ct() 只重排本地结果）');
  await app.locator('[data-song-order="hot"]').click();
  assert.equal(await app.locator('[data-song-order="hot"]').getAttribute('aria-selected'), 'true', '可以切回人气');
  assert.equal(searchCalls.length, beforeSort, '切回人气也不重新搜');

 // 切到「网易云」页签做元数据/徽章检查（该页签才有 夜曲/晴天/七里香/无题）。
  await app.locator('[data-source-tab="netease"]').click();
  await app.locator('.online-search-status').filter({ hasText: '找到 4 首歌曲' }).waitFor({ timeout: 60000 });
  assert.equal(await app.locator('.online-search-results .unified-song').count(), 4,
    '网易云页签显示这 4 条，顺序 = 平台原序（不再被 rank() 重排）');
 // 平台原序：mock 返回的数组顺序原样出现（不做自定义排序）。
  assert.deepEqual(await app.locator('.online-search-results .unified-song-copy strong').allTextContents(),
    ['夜曲', '晴天', '七里香', '風の住む街'], '平台原序：不重排、不把无损提前');
  assert.deepEqual(await app.locator('.online-search-results .unified-song-index').allTextContents(),
    ['01', '02', '03', '04'], '序号列按显示位置两位补零');

 // Clicking a result row plays it with the whole collection as the queue and
 // opens the play detail (the queue cards carry the same songs). The row must
 // be clicked while the panel is open — closing it unmounts the list.
  await app.locator('.online-search-results .unified-song').first().locator('[data-online-track]').click();
  await app.waitForFunction(() => window.rhineMusic.player.currentTrack?.id === 'netease-101' && window.rhineMusic.player.playing, undefined, { timeout: 60000 });
  assert.equal(await app.evaluate(() => window.rhineMusic.player.queue.length), 4, 'the search collection enters the temp queue');
  await app.waitForFunction(() => window.rhineMusic.selectedAlbum?.playback?.trackId === 'netease-101', undefined, { timeout: 60000 });

 // The list panel carries cover, quality badges, original tag, alias, MV.
 // 用户明确要求：**不标来源、不标付费** ——「它付不付费我都需要听，你都要给我放出来」。
  const firstRow = app.locator('.online-search-results .unified-song').first();
  assert.equal(await firstRow.locator('.unified-song-quality-tag').count(), 2, '夜曲有 2 枚徽章（Hi-Res + 无损）');
  assert.deepEqual(await firstRow.locator('.unified-song-quality-tag').allTextContents(), ['Hi-Res', '无损'],
    '多枚徽章按档位从高到低排列');
  assert.ok(((await firstRow.locator('.unified-song-quality-tag').first().getAttribute('class')) ?? '').includes('is-quality-hires'),
    '徽章用真实类名（Hi-Res → is-quality-hires，不是我们以前猜的 quality-hires）');
  assert.ok(((await firstRow.locator('.unified-song-quality-tag').last().getAttribute('class')) ?? '').includes('is-quality-sq'),
    '无损 → is-quality-sq（原文类名，不是 quality-lossless）');
  assert.match(await firstRow.locator('.unified-song-alias').textContent(), /Nocturne/);
  assert.equal(await firstRow.locator('.unified-song-original-tag').count(), 0, 'no 原唱 mark when the provider omits it');
  assert.equal(await firstRow.locator('[data-mv]').count(), 0, 'MV only appears when the provider exposes one');
  assert.equal(await firstRow.locator('.unified-song-cover').count(), 1, 'each row shows its own cover');
  assert.equal(await firstRow.locator('.source-badge').count(), 0, '不显示来源平台徽标');
  assert.equal(await firstRow.locator('.fee-tag').count(), 0, '不显示付费/试听标签');
  await fs.mkdir('artifacts/search-ui', { recursive: true });
  await app.screenshot({ path: 'artifacts/search-ui/search-panel-metadata.png' });

 // 多枚徽章 + 原唱 tag 按行渲染（母带/HiFi/无损 三枚并排，和一样）。
  const badgeRow = app.locator('.online-search-results .unified-song').filter({ hasText: '風の住む街' }).first();
  assert.deepEqual(await badgeRow.locator('.unified-song-quality-tag').allTextContents(), ['母带', 'HiFi', '无损'],
    '一行可以同时挂母带 + HiFi + 无损（一行多枚 pill）');
  const badgeClasses = await badgeRow.locator('.unified-song-quality-tag').evaluateAll(nodes => nodes.map(node => node.className));
  assert.deepEqual(badgeClasses.map(name => name.split(' ').at(-1)), ['is-master', 'is-hires', 'is-quality-sq'],
    '三枚徽章分别用is-master / is-hires / is-quality-sq');
 // 原唱 tag and per-row quality；付费曲也不带任何付费标记。
  const originalRow = app.locator('.online-search-results .unified-song').filter({ hasText: '晴天' }).first();
  assert.equal(await originalRow.locator('.unified-song-original-tag').textContent(), '原唱');
  assert.equal(await originalRow.locator('.unified-song-quality-tag').textContent(), '高品');
  assert.equal(await originalRow.locator('[data-mv]').count(), 1, 'the MV affordance appears on the row that has one');
  const feeRow = app.locator('.online-search-results .unified-song').filter({ hasText: '七里香' }).first();
  assert.equal(await feeRow.locator('.fee-tag').count(), 0, '付费曲也不标付费');

 // Watch-only MV: the row opens the overlay; only close exists.
  await originalRow.locator('[data-mv]').click();
  await app.locator('.mv-overlay').waitFor();
  assert.match(await app.locator('.mv-overlay video').getAttribute('src'), /synthetic-mv\.mp4/);
  assert.equal(await app.locator('.mv-overlay button').count(), 1, 'watch-only: the MV overlay has no download affordance');
  await app.keyboard.press('Escape');
  assert.equal(await app.locator('.mv-overlay').count(), 0, 'Escape closes the MV overlay');

 // ：用户不能自己换源。per-row 的「换源」下拉，
 // 它的 search-platform-tab 是「换平台重新搜这首歌」，由后端决定音源。
  const switchRow = app.locator('.online-search-results .unified-song').filter({ hasText: '夜曲' }).first();
  assert.equal(await switchRow.locator('[data-source-switch]').count(), 0,
    '：结果行没有换源按钮');
  assert.equal(await switchRow.locator('.source-switch-menu').count(), 0,
    '：结果行没有换源菜单');

 // Opening the MV overlay closed the search panel; reopen it for the row checks.
  await app.locator('[data-action="search"]').click();
  await app.locator('.online-search-results .unified-song').first().waitFor({ timeout: 60000 });
 // 每行保留：播放、MV（有才显示）、查看来源；音质徽标在 badges 里。
  const reopened = app.locator('.online-search-results .unified-song').filter({ hasText: '夜曲' }).first();
  assert.equal(await reopened.locator('[data-online-track]').count(), 1, '每行可播放');
  assert.ok(await reopened.locator('.unified-song-quality-tag').count() >= 1, '每行标注音质');
  assert.equal(await reopened.locator('.source-badge').count(), 0, '每行都不标来源');

 // The playing song keeps its mark when it appears in the current results.
  assert.equal(await app.locator('.online-search-results [data-online-track][aria-pressed="true"]').count(), 1,
    'the playing row is marked in the list');
  assert.equal(await app.evaluate(() => document.querySelector('.online-search-results [data-online-track][aria-pressed="true"]')
    ?.closest('.unified-song')?.querySelector('.unified-song-copy strong')?.textContent?.trim()), '夜曲',
    'the mark lands on the song that is actually playing');

 // The 酷狗 tab narrows the list to that platform only（换平台 = 重新搜）。
  await app.locator('[data-source-tab="kugou"]').click();
  await app.locator('.online-search-status').filter({ hasText: '找到 1 首歌曲' }).waitFor({ timeout: 60000 });
  assert.equal(await app.locator('.online-search-results .unified-song').count(), 1, 'the 酷狗 tab shows only 酷狗 rows');
  assert.equal(await app.locator('.online-search-results .unified-song').first().locator('.unified-song-quality-tag').textContent(), '无损',
    '酷狗那行是无损（不标平台名，靠页签体现）');
  assert.equal(await app.locator('.online-search-results .unified-song').first().locator('.unified-song-duration').textContent(), '03:20');

 // No results stays honest and keeps the panel open.
  await app.locator('#online-search').fill('none'); await app.locator('#online-search').press('Enter');
  await app.locator('.online-search-status').filter({ hasText: '没有找到歌曲' }).waitFor();
  assert.equal(await app.locator('.online-search-results .unified-song').count(), 0, 'the empty state renders no rows');

 // 试听片段：后端判定为残片后，前端会**静默**去其他源找全曲（用户要求不提示、
 // 不标注，只管放出来）。这里断言链路真的走了：播放器拿到 trial 证据，
 // 且界面**不出现**任何付费/来源/试听字样。
 // 「试听独占曲」只在酷狗目录里，所以要先切到酷狗页签（单平台搜索）。
  await app.locator('[data-source-tab="kugou"]').click();
  await app.locator('#online-search').fill('trial'); await app.locator('#online-search').press('Enter');
  await app.locator('.online-search-results [data-online-track]').first().waitFor({ timeout: 60000 });
  const trialRowCount = await app.locator('.online-search-results [data-online-track]').count();
  assert.ok(trialRowCount >= 1, `试听用例有结果行（实际 ${trialRowCount}）`);
 // 点该行的播放按钮（列表里点行本身不触发播放，播放按钮才是入口）。
  await app.locator('.online-search-results [data-online-track]').first().click();
  await app.waitForFunction(() => window.rhineMusic.player.currentTrack?.title === '试听独占曲', undefined, { timeout: 60000 });
  const playingTitle = await app.evaluate(() => window.rhineMusic.player.currentTrack?.title);
  assert.equal(playingTitle, '试听独占曲', `播放的是试听曲（实际「${playingTitle}」）`);
 // 后端确实回过 trial（前端据此触发全曲解析）。
  await app.waitForFunction(() => window.rhineMusic.player.trial?.end > 0, undefined, { timeout: 20000 })
    .catch(async () => {
      const diag = await app.evaluate(() => ({ transport: window.rhineMusic.player.transport, title: window.rhineMusic.player.currentTrack?.title, trial: window.rhineMusic.player.trial, error: window.rhineMusic.player.error, prep: window.__prepCalls ?? [] }));
      throw new Error('等待 trial 超时，实际状态: ' + JSON.stringify(diag));
    });
  const trial = await app.evaluate(() => window.rhineMusic.player.trial);
  assert.ok(Math.abs(trial.end - 60) < 1, `播放器拿到真实试听时长（实际 ${trial.end}s）`);
 // 界面上不出现任何付费/试听/来源字样：列表行里已经验证过；这里再确认
 // 详情页的在线信息区（#song-online）在渲染时也不含这些标记。
  const detailLabels = await app.evaluate(() => {
    const online = document.querySelector('#song-online');
    return { text: online?.textContent ?? '', fee: online?.querySelectorAll('.fee-tag').length ?? 0, badge: online?.querySelectorAll('.source-badge').length ?? 0 };
  });
  assert.doesNotMatch(detailLabels.text, /付费|试听|全网仅/, `详情页不标付费/试听（实际「${detailLabels.text.trim()}」）`);
  assert.equal(detailLabels.fee, 0, '详情页没有付费标签');
  assert.equal(detailLabels.badge, 0, '详情页没有来源徽标');

  assert.deepEqual(errors, []);
  await fs.mkdir('artifacts/search-ui', { recursive: true });
  await app.screenshot({ path: 'artifacts/search-ui/results-in-3d.png' });
  console.log('Search list panel: source tabs appear only after a search, merged rows with cover/quality/original/alias/MV, no source/fee labels, no manual source switching, playing-row mark and empty state passed.');
} catch (failure) {
  console.error(failure.message);
  await fs.mkdir('artifacts/search-ui', { recursive: true });
  await app?.screenshot({ path: 'artifacts/search-ui/failure.png', timeout: 3000 }).catch(() => {});
  console.error(await app?.evaluate(() => ({ album: window.rhineMusic?.selectedAlbum?.title, tracks: window.rhineMusic?.selectedAlbum?.tracks?.length, playback: window.rhineMusic?.selectedAlbum?.playback, current: window.rhineMusic?.player?.currentTrack?.id, transport: window.rhineMusic?.player?.transport, error: window.rhineMusic?.player?.error, rows: document.querySelectorAll('.track-row').length, online: document.querySelector('#song-online')?.textContent })).catch(() => ({})));
  throw failure;
} finally {
  await browser?.close();
  const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  await fs.rm(directory, { recursive: true, force: true });
}
