// 帧率设置的真机验证：驱动真实设置面板里的 #frame-rate 滑杆，
// 读真实的 #runtime-info FPS 读数，证明帧率真的被改变了（不是只改显示），
// 并验证重载后仍按该帧率运行（"下次启动时界面动画以这个帧率运行"）。
// hermetic：page.route 挡掉在线请求，用真实 createMusicServer。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMusicServer } from './music-server.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-frame-rate-'));
const emptyCatalog = provider => ({ provider, tracks: [] });
const { server } = await createMusicServer({
  dataDir: directory, autoScan: false,
  online: {
    search: async () => ({ provider: 'netease', query: '', tracks: [], offset: 0, limit: 20, total: 0, hasMore: false }),
    prepare: async () => ({ audioUrl: '' }),
    auth: { status: async () => ({ loggedIn: false }), start: async () => ({}), poll: async () => ({ state: 'waiting' }), cancel: async () => ({ state: 'cancelled' }), logout: async () => ({ loggedIn: false }) },
    songInfo: async () => null,
    playlists: async () => ({ playlists: [], hasMore: false }),
    playlistTracks: async () => ({ playlistId: '0', offset: 0, total: 0, tracks: [], hasMore: false }),
  },
  catalogs: { qq: emptyCatalog('qq'), bodian: emptyCatalog('bodian'), kugou: emptyCatalog('kugou'), kuwo: emptyCatalog('kuwo'), joox: emptyCatalog('joox') },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'], timeout: 15000 });
const errors = [];
let page;
/** 等应用真正进入可渲染状态（加载层消失）。 */
const waitReady = async (target) => {
  await target.waitForFunction(
    () => !!window.rhineMusic && !document.querySelector('#music-loading'),
    undefined, { timeout: 180000 },
  );
};
/** 打开设置面板并切到「画面显示」分类，确保帧率滑杆真的可见。
 * 设置面板是按分类分页的，不切页时 section 存在但 hidden。 */
const openSettings = async (target) => {
  await target.locator('[data-action="settings"]').first().click();
  await target.waitForSelector('[data-action="settings-category"][data-category="display"]', { timeout: 30000 });
  await target.locator('[data-action="settings-category"][data-category="display"]').click();
  await target.waitForSelector('#frame-rate', { state: 'visible', timeout: 30000 });
};
/** 把滑杆设成给定位置（真实事件，走生产 applySetting 路径）。 */
const setSlider = async (target, value) => {
  await target.$eval('#frame-rate', (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await target.waitForTimeout(250);
};
const statusText = (target) => target.$eval('#frame-rate-status', el => el.textContent.trim());
const storedPrefs = (target) => target.evaluate(() =>
  JSON.parse(localStorage.getItem('rhine-music-preferences') || '{}'));
/** 读生产 FPS 读数（#runtime-info 形如 "58 FPS / 日间 / V0.4.1"）。
 *
 * 采样前先持续制造交互（指针移动 + 滚轮），把调度器保持在 wake 窗口内，
 * 这样读到的是**帧率上限**而不是空闲的 30fps 基线 —— 否则 24 和 30 无法区分，
 * 无限制也会被空闲基线掩盖。 */
const sampleFps = async (target, { interactive = true } = {}) => {
  if (interactive) {
    for (let i = 0; i < 8; i++) {
      await target.mouse.move(300 + i * 20, 300 + (i % 3) * 10);
      await target.mouse.wheel(0, i % 2 ? 1 : -1);
      await target.waitForTimeout(180);
    }
  }
 // 读数每 1500ms 刷一次；等两轮再取，避免拿到上一档的残留值。
  await target.waitForTimeout(3400);
  const text = await target.$eval('#runtime-info', el => el.textContent);
  const match = /(\d+)\s*FPS/.exec(text);
  assert.ok(match, `未能从 #runtime-info 解析 FPS：${text}`);
  return Number(match[1]);
};

try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => { errors.push(error.message); console.error('UI error:', error.message); });
 // ?scheduler=1 打开渲染调度器的节流（桌面版由 isDesktop() 自动开启；
 // 浏览器探针必须显式带上，否则 shouldRender 恒为 true，测不出帧率上限）。
  await page.goto(`${base}/?lab=0&scheduler=1`);
  await waitReady(page);
  console.log('  应用已就绪');

  await openSettings(page);

 // ① 默认值：老用户不设这项时是 60，且滑杆位置与文案一致。
  const initial = await page.$eval('#frame-rate', el => Number(el.value));
  console.log(`  ① 默认滑杆位置 = ${initial}`);
  assert.equal(initial, 60, '默认应为 60 帧');

 // ② 拖到最低 24：文案与落盘都要跟着变。
  await setSlider(page, 24);
  const lowStatus = await statusText(page);
  console.log(`  ② 设为 24 → 文案 "${lowStatus}"`);
  assert.match(lowStatus, /24/, '状态文案应显示 24');
  assert.equal((await storedPrefs(page)).frameRate, 24, '24 必须落盘');

 // ③ 读真实 FPS：限制到 24 后，生产读数应明显低于无限制。
  const fpsLow = await sampleFps(page);
  console.log(`  ③ 上限 24 时实测 ${fpsLow} FPS`);

 // ④ 拖到最右 = 无限制：文案要说清是跟随显示器。
  await setSlider(page, 181);
  const unlimitedStatus = await statusText(page);
  console.log(`  ④ 拖到最右 → 文案 "${unlimitedStatus}"`);
  assert.match(unlimitedStatus, /无限制/, '最右端应是「无限制」');
  const storedUnlimited = await storedPrefs(page);
  assert.equal(storedUnlimited.frameRate, 0, '无限制应落盘为 0');
  const fpsUnlimited = await sampleFps(page);
  console.log(`  ④ 无限制实测 ${fpsUnlimited} FPS`);

 // ⑤ 核心断言：帧率真的被限制了。
  assert.ok(fpsLow <= 30, `上限 24 时实测 ${fpsLow} FPS，应贴近 24`);
  assert.ok(fpsUnlimited >= fpsLow + 8, `无限制(${fpsUnlimited}) 应明显高于受限(${fpsLow})`);
  console.log(`  ✅ 帧率确实可调：24 上限 = ${fpsLow} FPS，无限制 = ${fpsUnlimited} FPS`);
 // ⑥ 持久化 + 启动即生效：用户要求"下次启动时界面动画以这个帧率运行"。
 //
 // 这里故意设 24（低于空闲基线 30），且重载后**完全不碰页面**再采样：
 // cap 生效 → 空闲被压到 24
 // cap 没生效（启动忘了应用）→ 空闲是默认 30
 // 只有这两个数不一样，才能真正区分"启动时应用了"和"只是存下来了"。
  await setSlider(page, 24);
  assert.equal((await storedPrefs(page)).frameRate, 24);
 // 重载时保留 ?scheduler=1，否则调度器被旁路、启动帧率就无从验证。
  await page.goto(`${base}/?lab=0&scheduler=1`);
  await waitReady(page);
 // 重载后不点任何东西，先直接读 localStorage 确认值还在。
  assert.equal((await storedPrefs(page)).frameRate, 24, '重载后 localStorage 应仍是 24');
 // 等过交互唤醒窗口（wake 会给 5s 的满帧窗口），否则采到的是 cap 而非启动默认。
  await page.waitForTimeout(6200);
  const fpsBoot = await sampleFps(page, { interactive: false });
  console.log(`  ⑥ 重载后完全静止实测 ${fpsBoot} FPS（cap=24 应为 24，未生效会是 30）`);
  assert.ok(
    fpsBoot <= 27,
    `重载后静止应以 24 帧运行（若为 30 说明启动没应用该设置），实得 ${fpsBoot}`,
  );
 // 再打开设置确认界面也回显到位（这一步会触发交互，所以放在采样之后）。
  await openSettings(page);
  const afterReload = await page.$eval('#frame-rate', el => Number(el.value));
  const reloadStatus = await statusText(page);
  console.log(`  ⑥ 重载后滑杆回显 = ${afterReload}，文案 "${reloadStatus}"`);
  assert.equal(afterReload, 24, '重载后滑杆应停在上次的值');
  assert.match(reloadStatus, /24/, '重载后文案应显示 24');

 // ⑦ 边界：区间内任意值都接受，且非法值被夹住。
  for (const [value, expected] of [[24, 24], [45, 45], [180, 180], [181, 0]]) {
    await setSlider(page, value);
    const got = (await storedPrefs(page)).frameRate;
    assert.equal(got, expected, `滑杆 ${value} 应存为 ${expected}`);
  }
  console.log('  ⑦ 边界值 24/45/180/无限制 全部正确落盘');

  assert.deepEqual(errors, [], `页面无 JS 错误，实得：${errors.join(' | ')}`);
  console.log('  ✅ 帧率设置端到端通过');
} finally {
  await browser.close();
  server.close();
}
