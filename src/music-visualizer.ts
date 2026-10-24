/** 音浪：把频谱画成顶部/底部的动态条（对齐预览版 visualizer）。
 *
 * 三种职责在一个文件里，因为它们共享同一份选项语义：
 *   1. normalizeVisualizer —— 读盘时归一化，脏数据不会传到画布；
 *   2. visualizerMarkup   —— 设置面板那一段 HTML；
 *   3. MusicVisualizer    —— 画布控制器（挂载点、尺寸、绘制、帧调度）。
 */

import { FlowingWave, flowingLevelAt } from "./music-flowing-wave";

export type VisualizerPosition = "progress" | "bottom";
export type VisualizerStyle = "bars" | "dots" | "mini" | "outline";

export interface VisualizerOptions {
  enabled: boolean;
  position: VisualizerPosition;
  style: VisualizerStyle;
  /** 自定义颜色：#rrggbb；不填跟随主题。 */
  color?: string;
}

export const VISUALIZER_STYLE_LABELS: Record<VisualizerStyle, string> = {
  bars: "细柱频谱",
  dots: "点阵频谱",
  mini: "极简五柱",
  outline: "流动波形",
};

export const VISUALIZER_POSITION_LABELS: Record<VisualizerPosition, string> = {
  progress: "进度条上方",
  bottom: "窗口底边",
};

export function normalizeVisualizer(input: Partial<VisualizerOptions> | undefined): VisualizerOptions {
  const source = input ?? {};
  const style: VisualizerStyle =
    source.style === "dots" || source.style === "mini" || source.style === "outline" ? source.style : "bars";
  const position: VisualizerPosition = source.position === "bottom" ? "bottom" : "progress";
  const color = typeof source.color === "string" && /^#[\da-f]{6}$/i.test(source.color) ? source.color.toLowerCase() : undefined;
  return { enabled: source.enabled !== false, position, style, ...(color ? { color } : {}) };
}

export function visualizerMarkup(options: VisualizerOptions): string {
  const styleOptions = (Object.keys(VISUALIZER_STYLE_LABELS) as VisualizerStyle[])
    .map(value => `<option value="${value}" ${options.style === value ? "selected" : ""}>${VISUALIZER_STYLE_LABELS[value]}</option>`)
    .join("");
  const positionOptions = (Object.keys(VISUALIZER_POSITION_LABELS) as VisualizerPosition[])
    .map(value => `<option value="${value}" ${options.position === value ? "selected" : ""}>${VISUALIZER_POSITION_LABELS[value]}</option>`)
    .join("");
  return `<section class="panel-section" data-settings-group="personalization"><h3>音浪</h3>
    <label class="settings-row"><span>启用音浪</span><input id="visualizer-enabled" type="checkbox" ${options.enabled ? "checked" : ""}></label>
    <label class="settings-row"><span>位置</span><select id="visualizer-position" aria-label="音浪位置">${positionOptions}</select></label>
    <label class="settings-row"><span>样式</span><select id="visualizer-style" aria-label="音浪样式">${styleOptions}</select></label>
    <div class="settings-row"><span>音浪颜色</span><span class="visualizer-color">
      <input id="visualizer-color" type="color" aria-label="音浪颜色" value="${options.color ?? "#d9ad7d"}">
      <button type="button" class="text-button" data-action="visualizer-color-reset">跟随主题</button>
    </span></div>
  </section>`;
}

/** 播放器与视图之间那一份状态：绘制需要的东西全在这里，别去读全局。 */
export interface VisualizerView {
  playing: boolean;
  detail: boolean;
  currentTrackId?: string;
  blocked?: boolean;
  reduced: boolean;
  sampleRate?: number;
}

const MIN_FRAME_MS = 1000 / 60;
const REDUCED_FRAME_MS = 125;
const THEME_DEFAULT = {
  crest: "rgba(175, 112, 36, .9)",
  top: "rgba(230, 181, 100, .58)",
  middle: "rgba(204, 154, 92, .28)",
  base: "rgba(193, 151, 105, .06)",
};

export class MusicVisualizer {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d", { alpha: true });
  private samples: Uint8Array;
  private wave = new FlowingWave();
  private levels = new Float32Array(128);
  private idle = new Float32Array(0);
  private options = normalizeVisualizer(undefined);
  private frame = 0;
  private last = 0;
  private width = 0;
  private height = 0;
  private hiddenFlag = false;
  private disposed = false;
  private crest = THEME_DEFAULT.crest;
  private top = THEME_DEFAULT.top;
  private middle = THEME_DEFAULT.middle;
  private base = THEME_DEFAULT.base;
  private fill?: CanvasGradient;
  private themeKey = "";
  private trackId?: string;
  private observer?: ResizeObserver;
  private mutations?: MutationObserver;

  constructor(
    private stage: HTMLElement,
    private read: (target: Uint8Array) => boolean,
    private view: () => VisualizerView,
  ) {
    this.samples = new Uint8Array(1024);
    this.canvas.className = "music-visualizer";
    this.canvas.setAttribute("aria-hidden", "true");
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(entries => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        this.width = rect.width;
        this.height = rect.height;
        this.resize();
      });
      this.observer.observe(this.canvas);
    }
    if (typeof MutationObserver !== "undefined") {
      // 视图切换 / 换歌 / 详情页重建都会把画布从 DOM 里踢掉，这里跟着搬回去。
      this.mutations = new MutationObserver(records => {
        const relevant = records.some(record => {
          if (record.target === this.canvas) return false;
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          return target === this.stage || Boolean(target?.closest("#song-view,#mini-playback-below,#album-detail-content,#music-detail,#music-panel-root"));
        });
        if (relevant) this.refresh();
      });
      this.mutations.observe(this.stage, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "data-song", "data-lyrics-active", "data-theme"],
      });
    }
  }

  configure(options: VisualizerOptions): void {
    this.options = options;
    this.stage.classList.toggle("has-bottom-visualizer", options.enabled && options.position === "bottom");
    this.fitBands();
    this.refresh();
  }

  setHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
    this.refresh();
  }

  private fitBands(): void {
    if (this.options.style === "outline") {
      this.levels = this.wave.levels;
      return;
    }
    const count = this.options.style === "mini"
      ? 5
      : this.options.position === "bottom"
        ? Math.max(128, Math.min(this.options.style === "dots" ? 768 : 512, Math.round(this.width / (this.options.style === "dots" ? 3 : 5))))
        : 128;
    if (this.levels.length !== count || this.levels === this.wave.levels) this.levels = new Float32Array(count);
  }

  refresh(): void {
    if (this.disposed) return;
    const state = this.view();
    const active = Boolean(state.currentTrackId);
    let host: Element | null = null;
    let anchor: Element | null = null;

    if (this.options.position === "bottom") {
      host = this.stage;
    } else if (state.detail) {
      // 停在进度条上方：画布是**绝对定位浮层**（见 music.css），插进这一行也不占位。
      // 之前它是普通流元素 + 168px 高 + flex-shrink:0，把进度条压扁、
      // 把播放模式/音效/下载/音量四个按钮挤出了可视区 —— 就是这个把详情页搞坏的。
      const row = this.stage.querySelector<HTMLElement>("#song-view .lyric-transport");
      if (row && !row.closest("[hidden]")) {
        host = row;
        anchor = null;
      }
    } else {
      // 顶栏迷你条：同样只做浮层，不动 .minimal-transport 的布局。
      const mini = this.stage.querySelector<HTMLElement>("#mini-playback-below");
      if (mini && !mini.closest("[hidden]")) {
        host = mini;
        anchor = null;
      }
    }

    const visible = this.options.enabled && active && state.playing && Boolean(host) && !this.hiddenFlag
      && !document.hidden && !state.blocked;
    if (this.canvas.hidden === visible) this.canvas.hidden = !visible;
    this.canvas.classList.toggle("music-visualizer-bottom", this.options.position === "bottom");
    this.canvas.classList.toggle("music-visualizer-mini", this.options.position === "progress" && !state.detail);
    this.canvas.classList.toggle("music-visualizer-wave", this.options.style === "outline");
    if (host && (this.canvas.parentElement !== host || (anchor && this.canvas.nextElementSibling !== anchor))) {
      host.insertBefore(this.canvas, anchor ?? null);
    }

    const themeKey = `${this.stage.dataset.theme ?? ""}:${this.options.color ?? "theme"}:${state.detail ? "d" : "m"}`;
    if (this.themeKey !== themeKey) {
      this.themeKey = themeKey;
      const computed = getComputedStyle(this.stage);
      this.crest = computed.getPropertyValue("--wave-crest").trim() || THEME_DEFAULT.crest;
      this.top = computed.getPropertyValue("--wave-top").trim() || THEME_DEFAULT.top;
      this.middle = computed.getPropertyValue("--wave-middle").trim() || THEME_DEFAULT.middle;
      this.base = computed.getPropertyValue("--wave-base").trim() || THEME_DEFAULT.base;
      if (this.options.color) {
        const rgb = [1, 3, 5].map(index => parseInt(this.options.color!.slice(index, index + 2), 16)).join(",");
        this.crest = `rgba(${rgb},.95)`;
        this.top = `rgba(${rgb},.56)`;
        this.middle = `rgba(${rgb},.28)`;
        this.base = `rgba(${rgb},.06)`;
      }
      this.fill = undefined;
    }

    if (this.trackId !== state.currentTrackId) {
      this.trackId = state.currentTrackId;
      this.wave.reset();
      this.levels.fill(0);
      this.samples.fill(0);
    }

    if (!visible) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.last = 0;
      return;
    }
    if (!this.frame && (state.playing || this.wave.levels.some(level => level > 0.001))) {
      this.last = 0;
      this.frame = requestAnimationFrame(this.draw);
    } else if (!state.playing && !this.frame) {
      this.paint();
    }
  }

  private resize(): void {
    this.fitBands();
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * dpr));
    this.fill = undefined;
    this.context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  private draw = (now: number): void => {
    this.frame = 0;
    if (this.disposed || this.canvas.hidden) return;
    const state = this.view();
    if (document.hidden || this.hiddenFlag) {
      this.refresh();
      return;
    }
    const interval = state.reduced ? REDUCED_FRAME_MS : MIN_FRAME_MS;
    if (this.last && now - this.last < interval - 0.5) {
      this.frame = requestAnimationFrame(this.draw);
      return;
    }
    const dt = this.last ? Math.min(0.15, (now - this.last) / 1000) : 1 / 30;
    this.last = now;
    const freshness = this.read(this.samples);
    this.wave.update(freshness ? this.samples : undefined, state.sampleRate ?? 48000, dt);
    this.paint();
    if (state.playing || this.wave.levels.some(level => level > 0.001)) {
      this.frame = requestAnimationFrame(this.draw);
    }
  };

  private paint(): void {
    const context = this.context;
    if (!context) return;
    context.clearRect(0, 0, this.width, this.height);

    if (this.levels !== this.wave.levels) {
      for (let index = 0; index < this.levels.length; index += 1) {
        if (this.options.style === "mini") {
          let peak = 0;
          for (let band = Math.floor((index * 32) / 5); band < Math.ceil(((index + 1) * 32) / 5); band += 1) {
            peak = Math.max(peak, this.wave.levels[band]);
          }
          this.levels[index] = peak;
        } else {
          this.levels[index] = flowingLevelAt(this.wave.levels, (index + 0.5) / this.levels.length);
        }
      }
    }

    // 静止基准线：真数据没到时只画一条静止的低基准 —— 音浪条"看得见"，
    // 但绝不随时间起伏（那正是被点名的"有规律起伏、跟音乐没关系"）。
    // 真频谱一来，弹簧电平立刻接管；没声音就是没声音，不伪造节奏。
    let restore: Float32Array<ArrayBuffer> | null = null;
    if (!this.wave.levels.some(level => level > 0)) {
      if (this.idle.length !== this.levels.length) this.idle = new Float32Array(this.levels.length);
      this.idle.fill(0.055);
      restore = this.levels;
      this.levels = this.idle;
    }

    if (!this.fill) {
      this.fill = context.createLinearGradient(0, 0, 0, this.height);
      this.fill.addColorStop(0, this.top);
      this.fill.addColorStop(0.55, this.middle);
      this.fill.addColorStop(1, this.base);
    }
    context.fillStyle = this.fill;
    context.strokeStyle = this.crest;
    context.lineWidth = 1.35;
    context.lineJoin = "round";
    context.lineCap = "round";

    if (this.options.style === "outline") {
      const count = this.levels.length;
      const step = this.width / (count + 1);
      const height = this.height;
      const valueAt = (index: number) => height - Math.max(1.5, (index < 0 || index >= count ? 0 : this.levels[index]) * Math.max(0, height - 6));
      const body = new Path2D();
      const line = new Path2D();
      body.moveTo(0, height);
      body.lineTo(0, valueAt(-1));
      line.moveTo(0, valueAt(-1));
      for (let index = -1; index < count; index += 1) {
        const segments = Math.max(2, Math.ceil(step / 4));
        const from = valueAt(index);
        const delta = valueAt(index + 1) - from;
        for (let segment = 1; segment <= segments; segment += 1) {
          const progress = segment / segments;
          const x = (index + 1 + progress) * step;
          const y = from + delta * progress * progress * (3 - 2 * progress);
          body.lineTo(x, y);
          line.lineTo(x, y);
        }
      }
      body.lineTo(this.width, height);
      body.closePath();
      context.fill(body);
      context.stroke(line);
      if (restore) this.levels = restore;
      return;
    }

    const mini = this.options.style === "mini";
    const count = this.levels.length;
    const span = mini ? Math.min(80, this.width) : this.width;
    const offset = (this.width - span) / 2;
    const pitch = span / count;
    const barWidth = Math.max(1, Math.min(mini ? 5 : 6, pitch * 0.72));
    const dots = this.options.style === "dots";
    const bottom = this.options.position === "bottom";
    const dotWidth = Math.min(bottom ? 2 : 4, barWidth);
    const dotStep = bottom ? 3 : 5;

    const bars = new Path2D();
    const crest = new Path2D();
    for (let index = 0; index < count; index += 1) {
      const height = Math.max(2, this.levels[index] * (this.height - 6));
      const x = offset + index * pitch + (pitch - barWidth) / 2;
      if (dots) {
        let y = this.height - 2;
        for (let row = this.height - 2; row >= this.height - height; row -= dotStep) {
          bars.rect(x, row, dotWidth, 2);
          y = row;
        }
        crest.rect(x, y, dotWidth, 2);
      } else {
        bars.rect(x, this.height - height, barWidth, height);
        crest.moveTo(x, this.height - height);
        crest.lineTo(x + barWidth, this.height - height);
      }
    }
    context.fill(bars);
    if (dots) {
      context.fillStyle = this.crest;
      context.fill(crest);
    } else {
      context.stroke(crest);
    }
    if (restore) this.levels = restore;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.mutations?.disconnect();
    this.canvas.remove();
    this.stage.classList.remove("has-bottom-visualizer");
  }
}
