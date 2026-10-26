/** Keep wheel input in the current column and reuse the ordinary album motion. */
export type MusicWheelInput = Pick<
  WheelEvent,
  "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "shiftKey"
>;

/**
 * 一格滚轮对应的像素量。
 *
 * Chromium / Edge / WebView2 在 Windows 上一次滚轮格给的是 **100px**
 * （`deltaMode` 为 0，即像素模式；某些老驱动给 120）。这个值以前是 48，
 * 是按「3 行 × 16px」推出来的 —— 那是行模式（`deltaMode` 1）的量级，
 * 跟真实鼠标滚轮对不上。结果 `trunc(100 / 48) = 2`：用户滚一格，翻两首。
 */
const NOTCH_PIXELS = 100;

/** 触控板累积阈值：细碎增量加到这么多就翻一首，保持原先的手感。 */
const TRACKPAD_PIXELS = 48;

const MAX_ALBUMS_PER_EVENT = 3;
const GESTURE_GAP_MS = 200;

export function musicWheelDelta(event: MusicWheelInput, pageHeight: number) {
 // Read deltaMode before the deltas: some browsers adapt their units when
 // callers inspect it. Pinch-to-zoom and horizontal gestures keep their owner.
  const unit =
    event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? Math.max(1, pageHeight)
        : 1;
  if (
    event.ctrlKey ||
    event.shiftKey ||
    !Number.isFinite(event.deltaY) ||
    !Number.isFinite(event.deltaX) ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  )
    return 0;
  return event.deltaY * unit;
}

export class MusicWheelSteps {
  private remainder = 0;
  private direction = 0;
  private lastTime = -Infinity;

  reset() {
    this.remainder = 0;
    this.direction = 0;
    this.lastTime = -Infinity;
  }

  consume(delta: number, now: number) {
    if (!Number.isFinite(delta) || !delta) return 0;
    const direction = Math.sign(delta);
    if (
      now - this.lastTime > GESTURE_GAP_MS ||
      now < this.lastTime ||
      direction !== this.direction
    ) {
      this.remainder = 0;
    }
    this.lastTime = now;
    this.direction = direction;

    const magnitude = Math.abs(delta);

    // 离散滚轮格（鼠标中键滚轮）：一格 = 一首。
    //
    // 这一档必须先把零头清零再返回，不能走下面的累积 —— 100 的驱动还行，
    // 但 120 的老驱动会攒出 20、40…… 每几格就多翻一首。离散事件没有
    // 「零头」这个概念：一个事件就是一格。快滚时浏览器会把几格合并成
    // 一个更大的 delta，那就按比例翻，上限 MAX_ALBUMS_PER_EVENT 首。
    if (magnitude >= NOTCH_PIXELS) {
      this.remainder = 0;
      const notches = Math.min(
        Math.trunc(magnitude / NOTCH_PIXELS),
        MAX_ALBUMS_PER_EVENT,
      );
      return direction * Math.max(1, notches);
    }

    // 触控板 / 高精度滚轮：细碎增量累积到 TRACKPAD_PIXELS 才翻一首。
    this.remainder += magnitude * direction;
    const steps = Math.trunc(this.remainder / TRACKPAD_PIXELS);
    this.remainder -= steps * TRACKPAD_PIXELS;
    return steps || 0;
  }
}

type MusicWheelOptions = {
  enabled: () => boolean;
  navigate: (direction: number) => void;
 /** A column identity, so a partial gesture cannot leak into another singer. */
  context?: () => string | number;
};

const NATIVE_WHEEL_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "[contenteditable]:not([contenteditable=false])",
  "dialog",
  "[role=dialog]",
  "[role=slider]",
  ".music-panel-scrim",
  "#music-detail",
  ".lighting-lab",
  ".animation-lab",
  "[data-developer-panel]",
].join(",");

function keepsNativeWheel(target: EventTarget | null, stage: HTMLElement) {
  if (!(target instanceof Element)) return true;
  if (target.closest(NATIVE_WHEEL_TARGETS)) return true;
 // Keep native scroll ownership even at a pane's top/bottom boundary. This
 // also protects future scrollable content without a special class name.
  for (
    let element: Element | null = target;
    element && element !== stage;
    element = element.parentElement
  ) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
      return true;
  }
  return false;
}

export function mountMusicWheelNavigation(
  stage: HTMLElement,
  options: MusicWheelOptions,
) {
  const steps = new MusicWheelSteps();
  let context: string | number | undefined;
  const reset = () => steps.reset();
  const onWheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      !options.enabled() ||
      keepsNativeWheel(event.target, stage)
    ) {
      reset();
      return;
    }
    const delta = musicWheelDelta(event, stage.clientHeight);
    if (!delta) {
      reset();
      return;
    }
    const nextContext = options.context?.();
    if (nextContext !== context) reset();
    context = nextContext;
    event.preventDefault();
    const direction = steps.consume(delta, performance.now());
    if (direction) options.navigate(direction);
  };
 // Bubble only: controls can retain wheel ownership with stopPropagation.
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", reset, { passive: true });
  stage.addEventListener("keydown", reset);
  window.addEventListener("blur", reset);
  return {
    reset,
    dispose() {
      reset();
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", reset);
      stage.removeEventListener("keydown", reset);
      window.removeEventListener("blur", reset);
    },
  };
}
