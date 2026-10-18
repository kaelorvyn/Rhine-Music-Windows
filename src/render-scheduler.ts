/** Bound work on high-refresh screens. Idle retains the authored breathing
 * motion at 30 fps; any input or transition runs at the user's frame-rate cap
 * (default 60). Absolute timestamps are passed through, so animation duration
 * is unchanged. */
export class RenderScheduler {
  private previous: number | undefined;
  private activeUntil = 0;
 /** 交互/过渡时的帧率上限（fps）；0 = 无限制（跟随显示器刷新率）。 */
  private cap = 60;
  wake(now: number) { this.activeUntil = Math.max(this.activeUntil, now + 5000); }
  reset() { this.previous = undefined; }
 /**
 * 用户设定的帧率上限（fps）。0 或非法值 = 无限制。
 *
 * 改值后必须清掉上一帧的时间戳：`shouldRender` 的间隔判定是拿
 * `now - previous` 比的，留着旧时间戳会让「改完帧率后的第一帧」用错误的
 * 基准判断，出现一次不该有的丢帧或多余的等待。
 */
  setFrameRate(fps: number) {
    const next = Number.isFinite(fps) && fps > 0 ? fps : 0;
    if (next === this.cap) return;
    this.cap = next;
    this.previous = undefined;
  }
  shouldRender(now: number, transitioning: boolean, enabled: boolean) {
    if (!enabled) { this.previous = now; return true; }
 // 无限制：不节流，每个 rAF 都画。实际仍受显示器刷新率约束
 // （WebView2 的 rAF 跟合成器走），所以是「不设上限」而非「超过硬件」。
    if (this.cap === 0) { this.previous = now; return true; }
 // 交互/过渡时用用户设定值；空闲时保留作者设定的 30fps 呼吸动效。
 // 空闲值同样不得超过上限 —— 用户把上限设到 24 时，空闲也要一起降到 24。
    const target = transitioning || now < this.activeUntil ? this.cap : Math.min(30, this.cap);
    const interval = 1000 / target;
    if (this.previous !== undefined && now - this.previous < interval - .75) return false;
 // Preserve fractional remainder so a 144 Hz display does not fall to 48 fps.
    const gap = this.previous === undefined ? interval : now - this.previous;
    this.previous = now - Math.min(Math.max(0, gap - interval), interval / 2);
    return true;
  }
}
