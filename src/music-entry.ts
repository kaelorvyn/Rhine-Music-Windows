import "./music-entry.css";
import { EntryFilm } from "./music-entry-film";
import { ga } from "./music-entry-timeline";

/**
 * 胶片总时长（秒）。压缩版时间轴里 e = t + 5，纸底在 e = 26.92 收掉、白闪在 e = 26.88 打满，
 * 所以基线是 26.92 - 5 = 21.92 秒。
 */
const ENTRY_DURATION = 21.92;

/** 单帧最大步进（秒），避免切回前台后 elapsed 一次跳过整段动画。 */
const MAX_STEP = 0.05;

/**
 * 进入应用动画 · 外层 HUD。
 * 这是从预览版压缩 JS「lc HUD 186860..191500」移植的 class lc：
 * 整页 <section class="rhine-loading"> 的结构、状态行、跳过 / 重试按钮、
 * 帧循环与可见性处理都保持原样；对外 API 是 setStatus / completeLoading / skip / dispose / active。
 */
export class MusicEntry {
  private readonly content: HTMLElement;
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly film: EntryFilm;
  private readonly status: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly observer: ResizeObserver;
  private frame = 0;
  private elapsed = 0;
  private lastTime: number | undefined;
  private ready = false;
  private finished = false;
  private disposed = false;
  private suspended = false;
  private previousInert = false;
  private opener: HTMLElement | null = null;
  private waiters: (() => void)[] = [];

  constructor(content: HTMLElement) {
    this.content = content;
    this.root = document.createElement("section");
    this.root.className = "rhine-loading";
    this.root.dataset.state = "playing";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Rhine Music 正在载入音乐库");
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <div class="opening-stage" data-mode="boot" aria-hidden="true">
        <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" style="stroke:var(--boot-texture)" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
        <header class="brand"><h1>RHINE MUSIC</h1><div>PERSONAL MUSIC ARCHIVE</div><p>MUSIC <b>OS</b></p></header>
        <div class="powered">RHINE MUSIC <b>WINDOWS</b><i></i></div>
        <section class="boot">
          <div class="access-text"></div>
          <div class="boot-logo">${ga}</div>
          <div class="auth-status"><span>▪</span><span id="auth-message"></span><i></i></div>
          <div class="scan"><svg viewBox="0 0 1920 1080"><g fill="none" style="stroke:var(--boot-scan-ink)" stroke-width="2" stroke-linecap="round"><path/><path style="stroke:var(--boot-scan-line)"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PREPARING YOUR MUSIC</span></div>
          <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE MUSIC</strong><strong class="welcome-highlight">RHINE MUSIC</strong></div><div class="welcome-database">MUSIC ARCHIVE</div><div class="welcome-logo">${ga}</div></div>
          <div class="boot-white"></div>
        </section>
      </div>
      <div class="opening-hold"><strong>RHINE MUSIC</strong><span>MUSIC ARCHIVE</span></div>
      <p class="opening-status" role="status">正在准备音乐库…</p>
      <button type="button" class="opening-skip" aria-label="跳过开场"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M13 6l6 6-6 6"/></svg></button>
      <button type="button" class="opening-retry" hidden>重新加载</button>`;
    this.content.parentElement!.append(this.root);
    this.stage = this.root.querySelector<HTMLElement>(".opening-stage")!;
    this.status = this.root.querySelector<HTMLElement>(".opening-status")!;
    this.retryButton = this.root.querySelector<HTMLButtonElement>(".opening-retry")!;
    this.film = new EntryFilm(this.stage);
    this.retryButton.addEventListener("click", () => location.reload());
    this.root.querySelector(".opening-skip")!.addEventListener("click", () => this.skip());
    this.root.addEventListener("click", (event) => event.stopPropagation());
    this.root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if ((event.key === "Enter" || event.key === "Escape") && this.root.dataset.state !== "error") {
        event.preventDefault();
        this.skip();
      } else if (event.key === "Tab") {
        event.preventDefault();
        (this.retryButton.hidden ? this.root : this.retryButton).focus({ preventScroll: true });
      }
    });
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.root);
    document.addEventListener("visibilitychange", this.resetClock);
    this.begin();
    if (new URLSearchParams(location.search).get("scene") === "archive") this.skip();
  }

  get active(): boolean {
    return !this.root.hidden && !this.disposed;
  }

  /** 底部状态行文案（"正在准备音乐库…" 之类）。 */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /**
   * 内容已就绪：动画自然播完就收场；已经播完（停在 holding 态）就立刻收场。
   * 返回的 Promise 在 HUD 真正退场时兑现。
   */
  completeLoading(): Promise<void> {
    if (this.disposed || this.finished) return Promise.resolve();
    const settled = new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.ready = true;
    if (this.elapsed >= ENTRY_DURATION) this.finish();
    return settled;
  }

  /** 跳过开场（按钮 / Enter / Esc / ?scene=archive 都走这里）。 */
  skip(): void {
    this.finish();
  }

  /** 载入失败：切到 error 态，露出「重新加载」按钮。 */
  fail(message: string): void {
    if (this.disposed || this.finished) return;
    this.root.dataset.state = "error";
    this.status.textContent = message;
    this.retryButton.hidden = false;
    this.retryButton.focus({ preventScroll: true });
  }

  /** 暂停帧循环（压缩版 tick 里的 suspended 分支；导出片段在 tick 中截断，这里补上开关）。 */
  suspend(): void {
    if (this.disposed || this.finished) return;
    this.suspended = true;
  }

  /** 恢复帧循环。 */
  resume(): void {
    if (!this.suspended || this.disposed || this.finished) return;
    this.suspended = false;
    this.lastTime = undefined;
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.resetClock);
    this.film.reset();
    this.content.inert = this.previousInert;
    this.root.remove();
    this.drain();
  }

  private begin(): void {
    if (this.disposed) return;
    this.previousInert = this.content.inert;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.content.inert = true;
    this.root.hidden = false;
    this.root.dataset.state = "playing";
    this.retryButton.hidden = true;
    this.elapsed = 0;
    this.lastTime = undefined;
    this.finished = false;
    this.ready = false;
    this.fit();
    this.film.update(0);
    this.root.focus({ preventScroll: true });
    this.frame = requestAnimationFrame(this.tick);
  }

  /** 按 1920×1080 的舞台等比缩放，并给 CSS 传 --opening-width 之类的变量。 */
  private fit(): void {
    const { width, height } = this.root.getBoundingClientRect();
    const scale = Math.min(height / 1080, width / 1280) || 1;
    this.stage.style.width = `${width / scale}px`;
    this.stage.style.height = `${height / scale}px`;
    this.stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    this.stage.style.setProperty("--opening-width", `${width / scale}px`);
    this.stage.style.setProperty("--opening-height", `${height / scale}px`);
    this.stage.style.setProperty("--scan-scale", String(Math.min(1, width / scale / 1920)));
    this.stage.dataset.portrait = String(width < height);
  }

  private readonly resetClock = (): void => {
    this.lastTime = undefined;
  };

  private readonly tick = (time: number): void => {
    this.frame = 0;
    if (this.disposed || this.finished || this.suspended || this.root.dataset.state === "error") {
      return;
    }
    if (!document.hidden && this.lastTime !== undefined) {
      this.elapsed += Math.min((time - this.lastTime) / 1000, MAX_STEP);
    }
    this.lastTime = time;
    this.film.update(this.elapsed);
    if (this.elapsed >= ENTRY_DURATION) {
      this.reachEnd();
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  /** 胶片播完：内容要是还没就绪，就停在 holding 态等 completeLoading。 */
  private reachEnd(): void {
    this.elapsed = ENTRY_DURATION;
    this.film.update(this.elapsed);
    if (this.ready) {
      this.finish();
      return;
    }
    this.root.dataset.state = "waiting";
  }

  private finish(): void {
    if (this.finished || this.disposed) return;
    this.finished = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.dataset.state = "done";
    this.root.hidden = true;
    this.content.inert = this.previousInert;
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    this.drain();
  }

  private drain(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
