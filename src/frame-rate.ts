/**
 * 界面帧率设置的值域与换算。
 *
 * 用户要求：「最低24帧，最高无限制，也就是24帧到180帧，然后无限制。
 * 24到180可以任意调节，180之后就是无限制」。
 *
 * 所以滑杆是 24..181 的整数：
 * 24..180 → 该值就是帧率上限
 * 181 → 无限制（哨兵值）
 * 之所以用「181」而不是「0」当无限制的哨兵：滑杆是从小到大的连续区间，
 * 无限制必须排在 180 **之后**（用户明确「180之后就是无限制」），
 * 用 181 能让滑杆天然表达这个次序，拖动时一到头就进入无限制。
 */
export const FRAME_RATE_MIN = 24;
export const FRAME_RATE_MAX = 180;
/** 滑杆上代表「无限制」的位置（排在 180 之后）。 */
export const FRAME_RATE_UNLIMITED = 181;

/** 滑杆位置 → 实际帧率（0 表示无限制）。 */
export function frameRateFromSlider(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded >= FRAME_RATE_UNLIMITED) return 0;
  return Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, rounded));
}

/** 实际帧率 → 滑杆位置。 */
export function sliderFromFrameRate(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return FRAME_RATE_UNLIMITED;
  return Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, Math.round(fps)));
}

/** 给界面显示的文案。 */
export function frameRateLabel(fps: number): string {
  return Number.isFinite(fps) && fps > 0
    ? `${Math.round(fps)} 帧 / 秒`
    : `无限制（跟随显示器）`;
}

/** 把任意存量值清洗成合法的帧率（0 = 无限制）。 */
export function normalizeFrameRate(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
 // 小于下限的存量值（例如旧默认 30 被手工写成 10）抬到下限，
 // 避免出现用户无法通过界面复现的极低帧率。
  return Math.min(FRAME_RATE_MAX, Math.max(FRAME_RATE_MIN, Math.round(n)));
}
