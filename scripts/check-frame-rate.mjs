/** 界面帧率设置：值域语义 + 渲染调度器真的被限住。
 *
 * 用户要求帧率是"真的能调节"而不是只改个显示，所以这里既测值域换算，
 * 也直接驱动 RenderScheduler 数帧 —— 数出来的帧数不对就是没生效。
 * 不依赖网络、不依赖自检。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderScheduler } from '../src/render-scheduler.ts';
import {
  FRAME_RATE_MIN, FRAME_RATE_MAX, FRAME_RATE_UNLIMITED,
  frameRateFromSlider, sliderFromFrameRate, frameRateLabel, normalizeFrameRate,
} from '../src/frame-rate.ts';

/** 模拟一块显示器：hz 刷新率跑 seconds 秒，返回调度器真正放行的帧数。 */
function countFrames(scheduler, hz, seconds, transitioning = true, wake = true) {
  if (wake) scheduler.wake(0);
  let frames = 0;
  const total = Math.round(hz * seconds);
  for (let i = 0; i < total; i++) {
    const ms = (i * 1000) / hz;
    frames += Number(scheduler.shouldRender(ms, transitioning, true));
  }
  return frames;
}

test('帧率值域：24~180 可任意调，181 = 无限制', () => {
  assert.equal(FRAME_RATE_MIN, 24);
  assert.equal(FRAME_RATE_MAX, 180);
 // 区间内任意值都原样通过（"24到180可以任意调节"）。
  for (const fps of [24, 30, 45, 59, 60, 72, 75, 90, 120, 144, 165, 180])
    assert.equal(frameRateFromSlider(fps), fps, `${fps} 应原样通过`);
 // 末端溢出为无限制（"180之后就是无限制"）。
  assert.equal(frameRateFromSlider(FRAME_RATE_UNLIMITED), 0);
  assert.equal(frameRateFromSlider(FRAME_RATE_UNLIMITED + 50), 0);
 // 越界拖不到，但仍要夹住。
  assert.equal(frameRateFromSlider(1), FRAME_RATE_MIN);
  assert.equal(frameRateFromSlider(9999), 0);
 // 反向换算：无限制落在滑杆最右端。
  assert.equal(sliderFromFrameRate(0), FRAME_RATE_UNLIMITED);
  assert.equal(sliderFromFrameRate(24), 24);
  assert.equal(sliderFromFrameRate(180), 180);
 // 存量脏值清洗。
  assert.equal(normalizeFrameRate(undefined), 0, '缺失 = 无限制（老用户没这项）');
  assert.equal(normalizeFrameRate('abc'), 0);
  assert.equal(normalizeFrameRate(-5), 0);
  assert.equal(normalizeFrameRate(10), 24, '低于下限抬到 24');
  assert.equal(normalizeFrameRate(1e9), 180, '高于上限夹到 180');
 // 文案：无限制要说清是跟随显示器。
  assert.match(frameRateLabel(0), /无限制/);
  assert.match(frameRateLabel(144), /144/);
});

test('帧率设置真的限制渲染帧数（不是只改显示）', () => {
 // 144Hz 显示器上跑 2 秒，交互状态（transitioning=true）时按上限放行。
  for (const fps of [24, 30, 60, 90, 120, 144, 180]) {
    const scheduler = new RenderScheduler();
    scheduler.setFrameRate(fps);
    const got = countFrames(scheduler, 144, 2);
 // 上限低于刷新率时，放行帧数应贴近该上限；
 // 上限高于刷新率时，受刷新率约束，放行帧数贴近刷新率本身。
    const expected = Math.min(fps, 144) * 2;
    assert.ok(
      Math.abs(got - expected) <= Math.max(3, expected * 0.05),
      `上限 ${fps} fps：2 秒放行 ${got} 帧，期望约 ${expected} 帧`,
    );
  }
});

test('无限制 = 每个 rAF 都放行（跟随显示器刷新率）', () => {
  for (const hz of [60, 120, 144]) {
    const scheduler = new RenderScheduler();
    scheduler.setFrameRate(0);
 // 无限制时不该丢任何一帧。
    assert.equal(countFrames(scheduler, hz, 1), hz, `${hz}Hz 无限制应逐帧放行`);
  }
});

test('调低帧率时闲置状态也一起降（不会比上限更快）', () => {
 // 空闲（transitioning=false 且不在 wake 窗口内）默认跑 30fps，
 // 但用户把上限压到 24 时，空闲必须跟着降到 24，不能还跑 30。
  const scheduler = new RenderScheduler();
  scheduler.setFrameRate(24);
  const idle = countFrames(scheduler, 144, 2, false, false);
  assert.ok(idle <= 24 * 2 + 3, `上限 24 时闲置放行 ${idle} 帧，不应超过 24fps`);
 // 上限高于 30 时，闲置仍是作者设定的 30fps 呼吸动效（保住原有观感）。
  const normal = new RenderScheduler();
  normal.setFrameRate(60);
  const idle60 = countFrames(normal, 144, 2, false, false);
  assert.ok(Math.abs(idle60 - 60) <= 3, `默认上限 60 时闲置应仍是 30fps，实得 ${idle60} 帧`);
});

test('改帧率会清掉帧计时基准（避免改完第一帧判断错位）', () => {
  const scheduler = new RenderScheduler();
  assert.equal(scheduler.shouldRender(0, true, true), true);
  assert.equal(scheduler.shouldRender(1, true, true), false, '刚画过一帧应被节流');
 // 改上限后基准被清掉，下一帧必须立刻放行。
  scheduler.setFrameRate(144);
  assert.equal(scheduler.shouldRender(2, true, true), true, '改帧率后首帧应立即生效');
});

test('默认上限 60 不改变既有观感（60 交互 / 30 闲置）', () => {
 // 与 check-windows.mjs 的既有断言同源：老用户没设过这项时行为不变。
  for (const hz of [60, 120, 144]) {
    const idle = new RenderScheduler(), active = new RenderScheduler();
    active.wake(0);
    assert.ok(Math.abs(countFrames(idle, hz, 4, false, false) - 120) <= 2, `${hz}Hz 闲置应仍为 30fps`);
    assert.ok(Math.abs(countFrames(active, hz, 4, true) - 240) <= 2, `${hz}Hz 交互应仍为 60fps`);
  }
});

test('高刷新率下不平滑降级（分数余量保留）', () => {
 // 144Hz 上限设 60：不能让 144/60 的余数累积成 48fps 那种错误值。
  const scheduler = new RenderScheduler();
  scheduler.setFrameRate(60);
  const got = countFrames(scheduler, 144, 4);
  assert.ok(Math.abs(got - 240) <= 4, `144Hz 上 60fps 上限 4 秒应约 240 帧，实得 ${got}`);
});
