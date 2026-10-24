// The music prologue owns its own edit; the measured live-scene clock stays
// unchanged. Keeping these separate prevents replay from changing camera cues.
export const MUSIC_BOOT_START_TIME = 0;
// The 2D paper starts dissolving 80 ms before the live shelf starts moving.
// Prepare the renderer before boot.start(); it need not render behind opaque art.
export const MUSIC_BOOT_SCENE_REVEAL_TIME = 6.32;
export const MUSIC_BOOT_SCENE_START = 6.4;
export const MUSIC_BOOT_SCENE_TIME = 21.92;
export const MUSIC_BOOT_END_TIME = MUSIC_BOOT_SCENE_START + 5.2;

export const musicBootSceneTime = (time: number) =>
  MUSIC_BOOT_SCENE_TIME + Math.max(0, time - MUSIC_BOOT_SCENE_START);

/** 单帧 dt 的上限：超过它才算「停顿」（着色器编译/切后台），否则如实推进。
 * 0.055s = 用户定稿的进场节奏：还原原来的慢速水波，只加快一点点。
 * 帧率正常时永远不触发；只在低帧率下把进场波浪放慢成电影感。 */
export const STALL_CLAMP_SECONDS = 0.055;

/** Advance only the portion of a frame the scene can animate. Shader compilation
 * and a suspended tab can take seconds; that wait must not consume the sweep. */
export class MusicBootFrameClock {
  private lastTime = 0;
  private appTime = MUSIC_BOOT_START_TIME;

  reset(nowSeconds: number, startTime = MUSIC_BOOT_START_TIME) {
    this.lastTime = nowSeconds;
    this.appTime = startTime;
  }

  update(nowSeconds: number) {
    if (!Number.isFinite(nowSeconds) || nowSeconds <= this.lastTime) return this.appTime;
 // 0.055s 用户定稿值：还原 0.05 的慢速水波，只加一点点。
 // （曾试过 0.25 —— 低帧率下把进场波浪推快约 5 倍，用户判定「加得太快」而回退。）
    const raw = nowSeconds - this.lastTime;
    const dt = Math.min(raw, STALL_CLAMP_SECONDS);
    this.lastTime = nowSeconds;
    this.appTime = Math.min(MUSIC_BOOT_END_TIME, this.appTime + dt);
    if (MUSIC_BOOT_END_TIME - this.appTime < 1e-9) this.appTime = MUSIC_BOOT_END_TIME;
    return this.appTime;
  }
}
