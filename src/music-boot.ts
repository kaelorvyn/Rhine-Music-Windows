import "./music-boot.css";
import { MusicBootFrameClock, MUSIC_BOOT_END_TIME, MUSIC_BOOT_SCENE_REVEAL_TIME, MUSIC_BOOT_SCENE_START, musicBootSceneTime } from "./music-boot-timing.ts";
import { MusicOpening, MUSIC_OPENING_SLOGAN, musicOpeningFrame } from "./music-opening";

const REVEAL_DURATION = 720;
const REVEAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export interface MusicBootFrame {
  cinema: { reveal: number; lift: number; zoom: number; time: number; musicIntro: true };
  renderScene: boolean;
  phase: "logo" | "orbit" | "slogan" | "array" | "select";
  appTime: number;
}
export interface MusicBootOptions {
  onStart?: () => void;
  onComplete?: (reason: "complete" | "skip") => void;
  reduced?: boolean | (() => boolean);
  album?: () => { title: string; artist?: string } | null | undefined;
}
type SavedSibling = {
  node: HTMLElement;
  inert: boolean;
  visibility: string;
  priority: string;
};

/** A frame-driven music prologue followed by the original live scene. */
export class MusicBoot {
  readonly root: HTMLElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly opening: MusicOpening;
  private readonly frameClock = new MusicBootFrameClock();
  private running = false;
  private revealing = false;
  private revealRevision = 0;
  private revealAnimations: Animation[] = [];
  private revealFocus: HTMLElement | null = null;
  private endpointRendered = false;
  private disposed = false;
  private siblings: SavedSibling[] = [];
  private opener: HTMLElement | null = null;
  // 只放专辑阵列波浪、不放口号片：预览版 0.4.x 的进入顺序就是这样
  // （开机胶片放完直接接场景波浪，中间没有第二段 DOM 片）。
  private sceneOnly = false;

  constructor(private parent: HTMLElement, private options: MusicBootOptions = {}) {
    this.root = document.createElement("section");
    this.root.className = "music-boot-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", `音乐开场：${MUSIC_OPENING_SLOGAN}`);
    this.root.tabIndex = -1;
    this.opening = new MusicOpening(this.root);
    this.skipButton = document.createElement("button");
    this.skipButton.type = "button";
    this.skipButton.className = "music-boot-skip";
 // 无文字、只有一个圆圈加箭头（用户要求「做成一个圆圈带一个箭头就行，
 // 不要有文字，放到比较隐蔽的地方」）。可访问名靠 aria-label 提供 ——
 // 视觉上隐形，读屏器仍能念出「跳过开场」。
    this.skipButton.setAttribute("aria-label", "跳过开场");
    this.skipButton.title = "跳过开场";
    this.skipButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="9"/>'
      + '<path d="m10 8 5 4-5 4"/></svg>';
    this.root.appendChild(this.skipButton);
    this.parent.appendChild(this.root);
    this.skipButton.addEventListener("click", () => this.skip());
    this.root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (this.revealing) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        this.skip();
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.skipButton.focus({ preventScroll: true });
      }
    });
  }
  get active() { return this.running || this.revealing; }

  startScene(nowSeconds = performance.now() / 1000) { this.sceneOnly = true; this.start(nowSeconds); }

  start(nowSeconds = performance.now() / 1000, _forceMotion = false) {
    if (this.disposed) return;
    if (!Number.isFinite(nowSeconds)) nowSeconds = performance.now() / 1000;
    if (this.revealing) this.completeReveal(false);
    if (!this.running) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.siblings = [...this.parent.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.root)
 // Keep the real brand in its existing layout throughout the film. The
 // header stays inert; only its controls receive a visibility override.
 // Snapshot those nested controls too, preserving any prior inline state.
        .flatMap((node) => node.classList.contains("music-header")
          ? [node, ...[...node.children].filter((child): child is HTMLElement =>
            child instanceof HTMLElement && !child.classList.contains("music-identity"))]
          : [node])
        .map((node) => ({ node, inert: node.inert,
          visibility: node.style.getPropertyValue("visibility"),
          priority: node.style.getPropertyPriority("visibility") }));
      for (const { node } of this.siblings) {
        node.inert = true;
        if (!node.classList.contains("three-scene") && !node.classList.contains("music-header"))
          node.style.setProperty("visibility", "hidden");
      }
    }
    this.running = true;
    this.endpointRendered = false;
    this.parent.dataset.musicBoot = "running";
    this.frameClock.reset(nowSeconds, this.sceneOnly ? MUSIC_BOOT_SCENE_START : 0);
    this.opening.update(0);
    // 场景模式没有口号片：DOM 片层直接藏起来，由 3D 阵列自己演。
    this.opening.root.hidden = this.sceneOnly;
    this.root.hidden = false;
    this.root.setAttribute("aria-label", `音乐开场：${MUSIC_OPENING_SLOGAN}`);
    this.skipButton.hidden = false;
    this.options.onStart?.();
    const reduced = typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
    if (reduced) { this.skip(); return; }
 // 聚焦 **root** 而不是跳过按钮。
 //
 // 原来聚焦按钮，而 `:focus-visible` 会让按钮 opacity 变 1 ——
 // 于是开场一开始按钮就亮着，与「要隐蔽」的要求相冲（实测量到 opacity=1）。
 // 键盘能力不受影响：keydown 监听挂在 root 上，root 有 tabIndex=-1
 // （负值可编程聚焦、不进 Tab 序列），Esc/Enter 跳过照样能用。
 // 用户主动按 Tab 时仍会把焦点移到按钮上（见下方 keydown），那时才亮 ——
 // 这才是 `:focus-visible` 该有的语义：**用户显式操作**才显示焦点样式。
    this.root.focus({ preventScroll: true });
  }
  replay(nowSeconds = performance.now() / 1000) { this.start(nowSeconds); }
  skip() { if (this.running && !this.disposed) this.finish("skip"); }

  update(nowSeconds: number): MusicBootFrame | undefined {
    if (this.revealing && this.isReduced()) this.completeReveal();
    if (!this.running || this.disposed || !Number.isFinite(nowSeconds)) return;
    if (this.isReduced()) { this.skip(); return; }
    if (this.endpointRendered) { this.finish("complete"); return; }
    const appTime = this.frameClock.update(nowSeconds);
    this.endpointRendered = appTime === MUSIC_BOOT_END_TIME;
    if (!this.sceneOnly) this.opening.update(appTime);
    const sceneTime = musicBootSceneTime(appTime);
    const phase = sceneTime >= 25.68 ? "select" : musicOpeningFrame(appTime).phase;
    this.root.dataset.phase = phase;
    this.root.dataset.appTime = String(appTime);
    return {
      appTime, phase, renderScene: appTime >= MUSIC_BOOT_SCENE_REVEAL_TIME,
      cinema: {
        reveal: ease((sceneTime - 21.9) / 0.13),
        lift: 0,
        zoom: 0,
        time: sceneTime,
        musicIntro: true,
      },
    };
  }
  private finish(reason: "complete" | "skip", notify = true) {
    this.running = false;
    this.opening.root.hidden = true;
    this.root.hidden = true;
    for (const { node, inert, visibility, priority } of this.siblings) {
      node.inert = inert;
      if (visibility) node.style.setProperty("visibility", visibility, priority);
      else node.style.removeProperty("visibility");
    }
 // The completion hook owns the camera endpoint and browse surface fade. It
 // must run while active is false so showBrowseSurface can start normally.
    if (notify) this.options.onComplete?.(reason);
    this.revealFocus = document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body && !this.root.contains(document.activeElement)
      ? document.activeElement : this.opener;
    if (!notify || this.isReduced()) {
      this.siblings = [];
      this.parent.dataset.musicBoot = "done";
      if (notify) this.restoreFocus();
      return;
    }

 // Snapshot the hook's final interaction state, then keep the whole stage
 // locked until the controls are visible. All of this happens before paint.
    for (const sibling of this.siblings) {
      sibling.inert = sibling.node.inert;
      sibling.node.inert = true;
    }
    this.revealing = true;
    this.parent.dataset.musicBoot = "revealing";
    this.root.hidden = false;
    this.skipButton.hidden = true;
    this.root.setAttribute("aria-label", "正在显示音乐库");
    this.root.focus({ preventScroll: true });
    const revision = ++this.revealRevision;
    const fade = (selector: string, delay = 0) => {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node || node.hidden) return;
      this.revealAnimations.push(node.animate(
        [{ opacity: 0 }, { opacity: getComputedStyle(node).opacity }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    };
    fade(".music-vignette");
 // The shared brand never fades out or re-enters at the film handoff.
    fade(".music-topnav");
    fade(".library-status", 45);
    fade(".music-bottomline", 90);
    fade(".music-empty", 60);
 // SurfaceTransition owns the navigation container's opacity. Stagger its
 // inner groups so the intro never reads/overrides that in-flight fade.
    for (const selector of [".music-counter", ".album-stepper", ".genre-stepper"])
      fade(selector, 110);
 // Keep navigation geometry stable for the title's bottom clearance. Move
 // Callout uses independent translate, preserving existing transforms.
    for (const [selector, delay] of [
      [".album-callout", 60],
    ] as const) {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node) continue;
      this.revealAnimations.push(node.animate(
        [{ translate: "0 8px" }, { translate: getComputedStyle(node).translate }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    }
    void Promise.all(this.revealAnimations.map((animation) => animation.finished))
      .then(() => {
        if (revision === this.revealRevision && !this.disposed) this.completeReveal();
      }).catch(() => {});
  }
  private isReduced() {
    return typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
  }
  private restoreFocus() {
    if (this.revealFocus?.isConnected && !this.revealFocus.closest("[inert], [hidden]"))
      this.revealFocus.focus({ preventScroll: true });
    this.revealFocus = null;
  }
  private completeReveal(restoreFocus = true) {
    this.revealRevision++;
    this.revealAnimations.forEach((animation) => animation.cancel());
    this.revealAnimations = [];
    this.revealing = false;
    this.root.hidden = true;
    this.parent.dataset.musicBoot = "done";
    for (const { node, inert } of this.siblings) node.inert = inert;
    this.siblings = [];
    if (restoreFocus) this.restoreFocus();
    else this.revealFocus = null;
  }
  dispose() {
    if (this.disposed) return;
    if (this.running) this.finish("skip", false);
    if (this.revealing) this.completeReveal(false);
    this.disposed = true;
    this.root.remove();
  }
}
