// 本地歌单 CRUD 面板（对照参考行为。打开面板 → 新建 → 重命名 → 删除，
// 以及临时歌单的既有行为不被破坏。hermetic：page.route 挡掉在线请求，
// 用真实 createMusicServer 提供 /api/playlists/local。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-local-pl-ui-'));
let base;
const emptyCatalog = provider => ({ provider, tracks: [] });
// 一首在线歌：让详情页能挂出 #song-view，从而能触发「加入歌单」。
const song = { id: 'netease-1', albumId: 'album-1', title: '合成歌曲', artist: '合成歌手', duration: 8, format: '在线音频', browserPlayable: true, audioUrl: '', relativePath: '',
  onlineSource: { provider: 'netease', id: '1', albumTitle: '合成专辑', fee: 0, pageUrl: 'https://music.163.com/' } };
const { server } = await createMusicServer({
  dataDir: directory, autoScan: false,
  online: {
    search: async () => ({ provider: 'netease', query: '', tracks: [song], offset: 0, limit: 20, total: 1, hasMore: false }),
    prepare: async () => ({ audioUrl: `${base}/synthetic.wav` }),
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async () => ({ track: song, album: { title: '合成专辑', artist: '合成歌手' }, lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }),
    playlists: async () => ({ playlists: [], hasMore: false }),
    playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  },
  catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: emptyCatalog('kuwo'), joox: emptyCatalog('joox') },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
let page;
const errors = [];
const start = Date.now();
/** 在页面里轮询一个条件（fn 是浏览器里的函数体字符串或函数）。 */
const until = async (fn, label, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await page.evaluate(fn)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`timeout: ${label}`);
};
/** 在页面里等一个 CSS 选择器出现。 */
const untilSelector = (selector, label, timeoutMs = 30000) =>
  until(`!!document.querySelector('${selector}')`, label, timeoutMs);
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });

 // 打开「歌单」面板：本地歌单区 + 临时歌单区。
  await page.locator('#my-playlists-button').click();
  await page.waitForTimeout(1200);
  await untilSelector('.local-playlist-row', 'local playlist rows');
 // 后端开箱就有 favorites。用户要求莱茵歌单**排在最后一位**（不再抢在自建歌单
 // 前面），所以它只有一行时仍既是第一行也是最后一行；建出自建歌单后必须垫底。
 // 空态文案在建出第一个自建歌单之前不出现。
  assert.equal((await page.locator('.local-playlist-row strong').allTextContents()).at(-1), '莱茵歌单', 'favorites 最后一行');
  assert.match(await page.locator('.local-playlist-row').last().textContent(), /收藏/, 'favorites 标注收藏');

 // 新建：prompt 留空 → 用默认名。
  page.once('dialog', dialog => dialog.accept(''));
  await page.locator('[data-action="local-playlist-create"]').click();
  await until(`document.querySelectorAll('.local-playlist-row').length === 2`, 'favorites + 新建的歌单');
  const rows = await page.locator('.local-playlist-row strong').allTextContents();
  assert.equal(rows.at(-1), '莱茵歌单', 'favorites 固定垫底');
  assert.match(rows[0], /歌单/, '新建歌单有默认名，且排在莱茵歌单之前');

 // 重命名自建歌单（莱茵歌单垫底且不可改名，所以自建的在第 0 位）。
  const secondId = await page.locator('.local-playlist-row').nth(0).getAttribute('data-local-playlist');
  page.once('dialog', dialog => dialog.accept('我的私藏'));
  await page.locator(`[data-action="local-playlist-rename"][data-local-playlist-id="${secondId}"]`).click();
  await until(`[...document.querySelectorAll('.local-playlist-row strong')].map(n => n.textContent)[0] === '我的私藏'`, 'rename');

 // 删除要确认。
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator(`[data-action="local-playlist-remove"][data-local-playlist-id="${secondId}"]`).click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.local-playlist-row').count(), 2, '取消确认不删除');

  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-action="local-playlist-remove"][data-local-playlist-id="${secondId}"]`).click();
  await until(`document.querySelectorAll('.local-playlist-row').length === 1`, 'confirm remove');

 // favorites 不能删：面板里根本没有删除按钮。
  assert.equal(await page.locator('[data-action="local-playlist-remove"]').count(), 0, 'favorites 没有删除按钮');

 // 临时歌单区仍在（回归）。
  assert.match(await page.locator('#panel-body [role="status"]').textContent(), /临时歌单是空的/);

 // 「加入歌单」对话框：先播一首在线歌，再点详情页的「加入歌单」。
  await page.locator('[data-action="close-panel"]').click();
  await page.locator('[data-action="search"]').click();
  await page.locator('#online-search').fill('合成');
  await page.locator('#online-search').press('Enter');
  await page.locator('.online-search-results .unified-song').first().waitFor({ timeout: 60000 });
  await page.locator('.online-search-results .unified-song').first().locator('[data-online-track]').click();
  await until(`window.rhineMusic.player.currentTrack?.id === 'netease-1'`, 'song playing', 45000);
  await page.locator('[data-action="close-panel"]').click();

 // 「加入歌单」对话框：面板工具栏的「加入当前歌曲」。
  await page.locator('#my-playlists-button').click();
  await page.waitForTimeout(1200);
  await untilSelector('.local-playlist-row', 'reopen local playlists');
  await page.locator('[data-action="song-add-to-playlist"]').first().click();
  await untilSelector('[data-add-to-playlist]', 'add-to-playlist dialog');
  assert.match(await page.locator('.add-to-playlist').textContent(), /将选中歌曲添加到歌单/, '对话框标题');
 // 没有自建歌单时只有 favorites 一个目标。
  assert.equal(await page.locator('[data-add-to-playlist]').count(), 1, '目标歌单列表（只有 favorites）');
  await page.locator('[data-action="add-to-playlist-cancel"]').click();
  await until(`!document.querySelector('[data-add-to-playlist]')`, 'dialog closes');

 // 建一个自建歌单后再加一次：目标变两个，且能真的写进去。
 // 取消后面板仍是打开状态（对话框只替换了临时歌单那一块），直接接着操作。
  await untilSelector('[data-action="local-playlist-create"]', 'panel still open');
  page.once('dialog', dialog => dialog.accept('收藏夹'));
  await page.locator('[data-action="local-playlist-create"]').click();
  await until(`document.querySelectorAll('.local-playlist-row').length === 2`, 'create target playlist');
  await page.locator('[data-action="song-add-to-playlist"]').first().click();
  await untilSelector('[data-add-to-playlist]', 'add-to-playlist dialog again');
  assert.equal(await page.locator('[data-add-to-playlist]').count(), 2, '目标歌单列表（favorites + 收藏夹）');
 // 选 favorites 加进去：应关掉对话框并把曲目数变成 1。
  await page.locator('[data-add-to-playlist="favorites"]').click();
  await until(`!document.querySelector('[data-add-to-playlist]')`, 'dialog closes after add');
  await until(`[...document.querySelectorAll('.local-playlist-row')].some(row => row.textContent.includes('1 首'))`, 'favorites count updates');
 // 重复加同一首 → 「所选歌曲已在该歌单中」。
  await page.locator('[data-action="song-add-to-playlist"]').first().click();
  await untilSelector('[data-add-to-playlist]', 'add-to-playlist dialog third');
  await page.locator('[data-add-to-playlist="favorites"]').click();
  await page.waitForTimeout(1200);
 // 结果走 toast（notify），不在面板状态行里。
  assert.match(await page.locator('#music-toast').textContent(), /已在该歌单中|已添加|部分歌曲已存在/, 'duplicate add is reported');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.local-playlist-row')].find(row => row.textContent.includes('莱茵歌单'))?.textContent.includes('1 首')), true, 'favorites 仍是 1 首（去重生效）');

 // 排序控件（对照参考行为。sort.*）：7 条规则 + 升/降序，落在 preferences 里。
  const sortKey = page.locator('#local-playlist-sort-key');
  await sortKey.waitFor();
  assert.deepEqual(await sortKey.locator('option').allTextContents(),
    ['默认排序', '按添加时间', '按艺术家', '按播放次数', '按名称', '按平台', '按最高音质'], '排序规则');
  await sortKey.selectOption('name');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhine-music-preferences')).playlistSort), 'name', '排序写进 preferences');
 // 切降序再确认一次，然后还原默认（避免影响后面的断言）。
  await page.locator('#local-playlist-sort-direction').selectOption('descending');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhine-music-preferences')).playlistSortDirection), 'descending', '排序方向写进 preferences');
  await sortKey.selectOption('default');
  await page.locator('#local-playlist-sort-direction').selectOption('ascending');
  await page.waitForTimeout(400);

 // 多选模式（对照参考行为。selectionMode）：进批量管理 → 全选 → 已选 n 首。
  await page.locator('[data-action="queue-select-mode"]').click();
  await untilSelector('[data-queue-select]', 'selection mode');
  assert.match(await page.locator('.queue-toolbar').textContent(), /已选 0 首/, '初始没有选中');
  await page.locator('[data-action="queue-select-all"]').click();
  assert.match(await page.locator('.queue-toolbar').textContent(), /已选 1 首/, '全选后计数正确');
 // 取消一行 → 计数归零，再勾回来。
  await page.locator('[data-queue-select="0"]').click();
  assert.match(await page.locator('.queue-toolbar').textContent(), /已选 0 首/, '可取消单个');
  await page.locator('[data-queue-select="0"]').click();
  assert.match(await page.locator('.queue-toolbar').textContent(), /已选 1 首/, '可重新勾选');
 // 批量模式下不显示「清空歌单」（避免误清整张单子）。
  assert.equal(await page.locator('[data-action="queue-clear"]').count(), 0, '批量模式隐藏清空歌单');
 // 移出所选 → 队列被清空。
  await page.locator('[data-action="queue-selection-remove"]').click();
  await until(`window.rhineMusic.player.queue.length === 0`, 'selection removed from queue');
  assert.match(await page.locator('#queue-panel [role="status"]').textContent(), /临时歌单是空的/, 'queue emptied');

  assert.deepEqual(errors, []);
  console.log('Local playlist CRUD panel: create, rename, delete, favorites pinned, add-to-playlist dialog, sort rules and multi-select mode all passed.');
} finally {
  await page?.screenshot({ path: 'artifacts/local-playlist-crud.png' }).catch(() => {});
  await browser.close();
  server.close(); server.closeAllConnections?.();
  await fs.rm(directory, { recursive: true, force: true });
}
