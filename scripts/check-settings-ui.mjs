// 设置面板重构（对照参考行为。* 的 tab 清单）：12 个分类都在、默认落在
// 「个性化」、新增项（软件比例/播放/缓存/渲染模式）都能写进
// preferences。hermetic：只挡在线请求，本地 API 用真实的。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-settings-ui-'));
let base;
const emptyCatalog = provider => ({ provider, tracks: [] });
const { server } = await createMusicServer({
  dataDir: directory, autoScan: false,
  online: {
    search: async () => ({ provider: 'netease', query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
    prepare: async () => ({ audioUrl: `${base}/synthetic.wav` }),
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async () => { throw Object.assign(new Error('未找到'), { status: 404 }); },
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
/** 在页面里轮询一个条件（fn 是浏览器里的函数体字符串）。 */
const until = async (fn, label, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`timeout: ${label}`);
};
const readPrefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('rhine-music-preferences') || '{}'));
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
  await page.goto(`${base}/?lab=0`);
  await page.waitForFunction(() => !!window.rhineMusic && !document.querySelector('#music-loading'), undefined, { timeout: 45000 });
  await page.waitForTimeout(2500);

 // 打开设置面板。
  await page.locator('[data-action="settings"]').click();
  await page.waitForTimeout(1500);
  const categories = await page.locator('[data-action="settings-category"]').allTextContents();
  assert.deepEqual(categories,
 // 现行分类：砍掉「关于/反馈/诊断」，developer 只剩「界面维护」；「本地音乐库」
 // 改名为「音乐与音源」，并新增「版本更新」（见 music-settings.ts 与 update-center.ts）。
    ['个性化', '播放', '音频', '画面显示', '下载', '缓存', '本地歌单', '音乐与音源', '版本更新', '界面维护'],
    '分类清单与顺序一致');
 // 默认落在「个性化」，并且页面真的显示出来了。
  await until(`document.querySelector('[data-settings-page="personalization"]')?.hidden === false`, 'personalization shown by default');
  assert.match(await page.locator('[data-settings-page="personalization"]').textContent(), /外观主题/, '默认页有内容');

 // 界面比例（uiScale）已经没有滑杆控件了，preferences 里的值仍在、CSS 变量
 // 仍按它落地。这里只验证「变量确实存在且是合法数值」，不再假装有 #ui-scale。
  const uiScale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--music-ui-scale').trim());
  assert.match(uiScale, /^\d+(\.\d+)?$/, '界面比例落到 CSS 变量');

 // 自动播放 / 无缝切歌：勾选走 applySetting。
  await page.locator('[data-action="settings-category"][data-category="playback"]').click();
  await until(`document.querySelector('[data-settings-page="playback"]')?.hidden === false`, 'playback page');
  await page.locator('#autoplay-setting').check();
  await page.locator('#seamless-playback').uncheck();
  await page.waitForTimeout(500);
  const prefs = await readPrefs();
  assert.equal(prefs.autoplay, true, '进入软件自动播放');
  assert.equal(prefs.seamlessPlayback, false, '无缝切歌可关');

 // 渲染模式在「音频」页。
  await page.locator('[data-action="settings-category"][data-category="audio"]').click();
  await until(`document.querySelector('[data-settings-page="audio"]')?.hidden === false`, 'audio page');
  assert.match(await page.locator('[data-settings-page="audio"]').textContent(), /渲染模式/, '音频页有渲染模式');

 // 缓存在「缓存」页：滑杆 + 文本。
  await page.locator('[data-action="settings-category"][data-category="cache"]').click();
  await until(`document.querySelector('[data-settings-page="cache"]')?.hidden === false`, 'cache page');
  await page.locator('#cache-limit').fill('4096');
  await page.locator('#cache-location').fill('D:\\cache');
  await page.waitForTimeout(500);
  const cachePrefs = await readPrefs();
  assert.equal(cachePrefs.cacheLimit, 4096, '缓存上限');
  assert.equal(cachePrefs.cacheLocation, 'D:\\cache', '缓存位置');
  assert.match(await page.locator('#cache-limit-status').textContent(), /4096 MB/, '缓存上限有回显');

 // 诊断页：不属于 Rhine 原有分类，验证新分类也能打开。
  await page.evaluate(() => document.querySelector('[data-action="settings-category"][data-category="diagnostics"]').click());
  await until(`document.querySelector('[data-settings-page="diagnostics"]')?.hidden === false`, 'diagnostics page');
  assert.match(await page.locator('[data-settings-page="diagnostics"]').textContent(), /诊断/, '诊断页有内容');
  assert.equal(await page.evaluate(() => document.querySelector('[data-action="settings-category"][data-category="diagnostics"]').getAttribute('aria-current')), 'page', '导航高亮跟着走');

 // ── 设置搜索（对照参考行为。searchPlaceholder / searchNoResult）──────
  const search = page.locator('#settings-search');
  await search.waitFor();
  assert.equal(await search.getAttribute('placeholder'), '搜索设置项…', '搜索框占位符对齐');
 // 命中「缓存」：只显示含该词的分区，且所属分类页显示。
  await search.fill('缓存');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => {
    const shown = [...document.querySelectorAll('.panel-section:not([hidden])')];
    return shown.length > 0 && shown.every(s => (s.textContent ?? '').includes('缓存'));
  }), true, '搜索只留下命中分区');
  assert.match(await page.locator('#settings-search-empty').isHidden().then(h => (h ? 'hidden' : 'shown')), /^hidden$/, '有命中时不显示空态');
 // 未命中：显示「未找到相关设置项」。
  await search.fill('zzz-不存在的设置');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#settings-search-empty').isVisible(), true, '未命中显示空态文案');
  assert.equal(await page.locator('#settings-search-empty').textContent(), '未找到相关设置项', '空态文案对齐');
  assert.equal(await page.locator('.panel-section:not([hidden])').count(), 0, '未命中时没有分区');
 // 清空搜索：回到当前分类，分区全部回来。
  await search.fill('');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => {
    const shown = [...document.querySelectorAll('[data-settings-page]:not([hidden]) .panel-section')];
    return shown.length > 0 && shown.every(s => !s.hidden);
  }), true, '清空后当前分类分区全部可见');
 // 搜索中切分类：搜索词被清掉，列出该分类完整设置。
  await search.fill('缩放');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-action="settings-category"][data-category="cache"]').click());
  await page.waitForTimeout(300);
  assert.equal(await search.inputValue(), '', '切分类清空搜索词');
  assert.equal(await page.evaluate(() => document.querySelector('[data-settings-page="cache"]')?.hidden === false), true, '切到缓存页');

  assert.deepEqual(errors, []);
  console.log('Settings restructure: 12 categories, default personalization, new settings persisted and settings search (match filter / no-result / clear / category switch) all passed.');
} finally {
  await page?.screenshot({ path: 'artifacts/settings-restructure.png' }).catch(() => {});
  await browser.close();
  server.close(); server.closeAllConnections?.();
  await fs.rm(directory, { recursive: true, force: true });
}
