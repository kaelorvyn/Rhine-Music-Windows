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

/** 单帧 dt 的上限：超过它才算「停顿」（编译/切后台），否则如实推进。
 * 必须是 0.25s 这种量级 —— 取 0.05s 会把 20fps 以下的所有真实帧都截断，
 * 让动画时钟慢于墙钟、把 5.2 秒的水波拖成几十秒。 */
export const STALL_CLAMP_SECONDS = 0.25;

/** Advance only the portion of a frame the scene can animate. Shader compilation
 * and a suspended tab can take seconds; that wait must not consume the sweep. */
export class MusicBootFrameClock {
  private lastTime = 0;
  private appTime = MUSIC_BOOT_START_TIME;

  reset(nowSeconds: number) {
    this.lastTime = nowSeconds;
    this.appTime = MUSIC_BOOT_START_TIME;
  }

  update(nowSeconds: number) {
    if (!Number.isFinite(nowSeconds) || nowSeconds <= this.lastTime) return this.appTime;
 //
 //
 // 原值 0.05s（=20fps）本意是「别把着色器编译/隐藏标签页的几秒钟算进动画」，
 // 这个意图是对的，但阈值定得太紧：只要实际帧率低于 20fps，**每一帧的真实
 // dt 都会被截到 0.05**，于是动画时钟比墙钟走得慢，动画被拉长。
 // 实测（appTime 是最权威的时钟）：进 array 阶段时墙钟 7.9s、appTime 6.40s；
 // 到墙钟 37.2s 时 appTime 才 6.82s —— **29 秒只推进了 0.42 秒**。
 // 这正是用户说的「像水波一样一帧一帧跳进来」：不是动画本身慢，
 // 是低帧率下时钟被钳住，把 5.2 秒的水波硬拖成了几十秒。
 //
 // 现在改成只过滤**真正的停顿**（编译、切后台、断点）：把「一帧超过 0.25s」
 // 视为停顿并按 0.25s 计；0.25s 以内（即 ≥4fps）如实推进。
 // 于是低帧率时画面是「跳着快进」而不是「慢动作拖长」—— 动画总时长重新与
 // MUSIC_BOOT_END_TIME 对齐，时长可预期。
    const raw = nowSeconds - this.lastTime;
    const dt = Math.min(raw, STALL_CLAMP_SECONDS);
    this.lastTime = nowSeconds;
    this.appTime = Math.min(MUSIC_BOOT_END_TIME, this.appTime + dt);
    if (MUSIC_BOOT_END_TIME - this.appTime < 1e-9) this.appTime = MUSIC_BOOT_END_TIME;
    return this.appTime;
  }
}
