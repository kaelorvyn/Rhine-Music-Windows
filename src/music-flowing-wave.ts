/** 流动波形的物理模型（对齐预览版 FlowingWave）。
 *
 * 输入是一帧字节频谱 + 采样率 + 帧间隔；输出 32 段归一化电平。
 * 三段结构：
 *   energy  —— 本帧各频段的 RMS 能量；
 *   reference —— 缓慢衰减的参考峰值，用来把能量归一成 0..1；
 *   levels/velocity —— 弹簧模型，让柱子冲上去、再慢慢回弹，而不是死跟音量跳。
 *
 * 为什么不是直接画 FFT：直接画会随音量整体涨落，看着"一片一起抖"。
 * 归一化到 reference 之后，安静段落里人声依然能把对应频段顶起来。
 */

import { BYTE_TO_AMPLITUDE } from "./music-spectrum-tap";

export const WAVE_BANDS = 32;
const MIN_REFERENCE = 0.035;
const BAND_LOW_HZ = 60;
const BAND_HIGH_HZ = 12000;
const SPRING = 300;
const DAMPING = 22;
const DECAY_SECONDS = 1.5;

export class FlowingWave {
  readonly levels = new Float32Array(WAVE_BANDS);
  readonly energy = new Float32Array(WAVE_BANDS);
  readonly velocity = new Float32Array(WAVE_BANDS);
  reference = MIN_REFERENCE;

  reset(): void {
    this.levels.fill(0);
    this.energy.fill(0);
    this.velocity.fill(0);
    this.reference = MIN_REFERENCE;
  }

  /** @param samples 字节频谱（0..255）；@param sampleRate 采样率；@param dt 帧间隔秒。 */
  update(samples: Uint8Array | undefined, sampleRate: number | undefined, dt: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.15, dt)) : 0;
    this.energy.fill(0);

    if (samples && samples.length > 1 && Number.isFinite(sampleRate) && (sampleRate as number) > 0) {
      const hzPerBin = (sampleRate as number) / (samples.length * 2);
      const lowBin = Math.min(samples.length - 1, Math.max(1, BAND_LOW_HZ / hzPerBin));
      const highBin = Math.min(samples.length, Math.max(lowBin + 1, BAND_HIGH_HZ / hzPerBin));
      const ratio = highBin / lowBin;
      for (let band = 0; band < this.energy.length; band += 1) {
        const from = lowBin * ratio ** (band / this.energy.length);
        const to = lowBin * ratio ** ((band + 1) / this.energy.length);
        let sum = 0;
        for (let bin = Math.floor(from); bin < Math.ceil(to); bin += 1) {
          const weight = Math.max(0, Math.min(to, bin + 1) - Math.max(from, bin));
          const amplitude = BYTE_TO_AMPLITUDE[samples[Math.min(samples.length - 1, bin)]];
          sum += amplitude ** 2 * weight;
        }
        this.energy[band] = Math.sqrt(sum / (to - from));
      }
    }

    // 参考峰值：只跟涨、慢慢落。落得慢，安静段里的细节才不会被压平。
    const peak = Math.max(MIN_REFERENCE, ...this.energy);
    this.reference = peak > this.reference ? peak : Math.max(peak, this.reference * Math.exp(-step / DECAY_SECONDS));

    const substeps = Math.max(1, Math.ceil(step * 120));
    const slice = step / substeps;
    for (let band = 0; band < this.levels.length; band += 1) {
      const ratio = this.energy[band] / this.reference;
      const target = 0.84 * Math.min(1, ratio) ** 0.7;
      let level = this.levels[band];
      let velocity = this.velocity[band];
      for (let i = 0; i < substeps; i += 1) {
        velocity += ((target - level) * SPRING - velocity * DAMPING) * slice;
        level += velocity * slice;
        if (level < 0) { level = 0; velocity = Math.max(0, velocity); }
        if (level > 0.995) { level = 0.995; velocity = Math.min(0, velocity); }
        if (target === 0 && level < 0.001 && Math.abs(velocity) < 0.01) { level = 0; velocity = 0; }
      }
      this.levels[band] = level;
      this.velocity[band] = velocity;
    }
  }
}

/** 平滑采样：把一段电平按小数位置插值，避免柱子数量与频段数量不整除时跳动。 */
export function flowingLevelAt(values: Float32Array, position: number): number {
  if (!values.length || !Number.isFinite(position)) return 0;
  const scaled = Math.max(0, Math.min(1, position)) * (values.length + 1) - 1;
  const base = Math.floor(scaled);
  const fraction = scaled - base;
  const left = base < 0 || base >= values.length ? 0 : values[base];
  const right = base + 1 < 0 || base + 1 >= values.length ? 0 : values[base + 1];
  return left + (right - left) * fraction * fraction * (3 - 2 * fraction);
}
