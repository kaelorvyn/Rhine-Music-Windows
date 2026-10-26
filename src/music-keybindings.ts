/**
 * 键盘操作绑定：同一枚键按「单击 / 双击 / 长按」三种方式，各管一件事。
 *
 * 为什么要分组：`←` 一个键既要「上一首」（单击）、又要「回退 15 秒」（双击）、
 * 还要「2 倍速」（长按）—— 三者可以共用，因为它们的触发方式不同。但
 * 「上一个歌单」和「下一个歌单」都是单击，它们撞键就分不清了。所以只在
 * 「同一种操作方式」内部查重，跨组共用一律允许。
 */

export type KeyAction =
  | "playlistPrevious"
  | "playlistNext"
  | "songPrevious"
  | "songNext"
  | "seekBackward"
  | "seekForward"
  | "boostPrimary"
  | "boostSecondary";

export type KeyBindings = Record<KeyAction, string>;

/** 行的顺序就是页面顺序。 */
export const KEY_ACTION_LABELS: Record<KeyAction, string> = {
  playlistPrevious: "上一个歌单",
  playlistNext: "下一个歌单",
  songPrevious: "上一首 / 模型",
  songNext: "下一首 / 模型",
  seekBackward: "双击 · 回退 15 秒",
  seekForward: "双击 · 快进 15 秒",
  boostPrimary: "长按 · 2 倍速（键一）",
  boostSecondary: "长按 · 2 倍速（键二）",
};

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  playlistPrevious: "ArrowUp",
  playlistNext: "ArrowDown",
  songPrevious: "ArrowLeft",
  songNext: "ArrowRight",
  seekBackward: "ArrowLeft",
  seekForward: "ArrowRight",
  boostPrimary: "ArrowLeft",
  boostSecondary: "ArrowRight",
};

/** 同一「操作方式」内的动作，同组不许撞键。 */
const GESTURE_GROUPS: readonly (readonly KeyAction[])[] = [
  ["playlistPrevious", "playlistNext", "songPrevious", "songNext"],
  ["seekBackward", "seekForward"],
  ["boostPrimary", "boostSecondary"],
];

const CONFLICT_MESSAGE =
  "同一种操作方式不能重复使用同一个键。单击、双击、长按可以共用一个键。";

/**
 * 合法键白名单。
 *
 * `v` 排除：它是界面快捷键（切换总览）。`F11` 排除：全屏。
 * 其余字母、数字、方向键、Home/End、Page Up/Down、F1~F10 都放行。
 */
export function normalizeKeyBinding(key: string): string | undefined {
  if (/^[a-z0-9]$/i.test(key) && key.toLowerCase() !== "v") {
    return key.toLowerCase();
  }
  if (
    /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|F([1-9]|10|12))$/.test(
      key,
    )
  ) {
    return key;
  }
  return undefined;
}

/** 返回撞键提示，没有冲突返回 undefined。 */
export function bindingConflict(bindings: KeyBindings): string | undefined {
  for (const group of GESTURE_GROUPS) {
    if (new Set(group.map((action) => bindings[action])).size !== group.length) {
      return CONFLICT_MESSAGE;
    }
  }
  return undefined;
}

/**
 * 读存档。任何一格非法、或整体撞键，一律回退默认 ——
 * 宁可回到出厂键位，也不要让用户拿着一个「按了没反应」的键位表。
 */
export function sanitizeKeyBindings(saved: unknown): KeyBindings {
  if (!saved || typeof saved !== "object") return { ...DEFAULT_KEY_BINDINGS };
  const source = saved as Record<string, unknown>;
  const next = { ...DEFAULT_KEY_BINDINGS };
  for (const action of Object.keys(DEFAULT_KEY_BINDINGS) as KeyAction[]) {
    const value = source[action];
    if (typeof value === "string") {
      next[action] = normalizeKeyBinding(value) ?? DEFAULT_KEY_BINDINGS[action];
    }
  }
  return bindingConflict(next) ? { ...DEFAULT_KEY_BINDINGS } : next;
}

/** 键位显示名：方向键用箭头，翻页键用原名，其余大写。 */
export function keyBindingLabel(key: string): string {
  const glyphs: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    PageUp: "Page Up",
    PageDown: "Page Down",
  };
  return glyphs[key] ?? key.toUpperCase();
}

/** 双击窗口 300ms、长按阈值 450ms：手感取自参考实现，别随手改。 */
const DOUBLE_TAP_MS = 300;
const HOLD_MS = 450;

export type KeyBindingActions = {
  /** 界面是否接受按键（弹窗、开场等场合要停）。 */
  enabled: () => boolean;
  /** 是否已有当前曲目：没有歌时双击跳转和长按变速无意义。 */
  active: () => boolean;
  /** 是否正在出声：静音/暂停时长按不该变速。 */
  playing: () => boolean;
  bindings: () => KeyBindings;
  navigateSong: (direction: number) => void;
  navigatePlaylist: (direction: number) => void;
  seekBy: (seconds: number) => void;
  boost: (active: boolean) => void;
};

/**
 * 按键手势状态机。
 *
 * ```
 * keydown
 *   ├ 只有单击动作 → 立即执行
 *   └ 还兼着双击/长按 → 进入等待
 *       ├ 按住 450ms 且正在播放 → 变速，松开恢复
 *       ├ 300ms 内按下第二下   → seek ±15 秒
 *       └ 300ms 内没有第二下   → 执行单击动作
 * ```
 */
type Press = {
  key: string;
  /** 这一下是某次双击的第二下。 */
  double: boolean;
  long: boolean;
  boosted: boolean;
  /** 双击动作的跳转秒数；未定义表示这个键不参与双击。 */
  seek?: number;
  /** 单击动作。 */
  navigate?: () => void;
  /** 这个键参与长按变速。 */
  hold: boolean;
};

export class MusicKeyGestures {
  private press?: Press;
  private tap?: { key: string; at: number; navigate?: () => void };
  private holdTimer = 0;
  private tapTimer = 0;
  private disposed = false;

  private readonly actions: KeyBindingActions;

  // 不写成构造参数属性：Node 的 type-stripping 跑测试时不支持那种语法。
  constructor(actions: KeyBindingActions) {
    this.actions = actions;
  }

  /** 返回 true 表示这次按键被消费掉了，调用方别再处理。 */
  keydown(event: KeyboardEvent): boolean {
    if (this.disposed) return false;
    if (
      event.isComposing ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return false;
    }
    const key = normalizeKeyBinding(event.key);
    if (!key) return false;
    if (!this.actions.enabled()) return false;

    const bindings = this.actions.bindings();
    const navigate =
      key === bindings.songPrevious
        ? () => this.actions.navigateSong(-1)
        : key === bindings.songNext
          ? () => this.actions.navigateSong(1)
          : key === bindings.playlistPrevious
            ? () => this.actions.navigatePlaylist(-1)
            : key === bindings.playlistNext
              ? () => this.actions.navigatePlaylist(1)
              : undefined;
    const active = this.actions.active();
    const seek = !active
      ? undefined
      : key === bindings.seekBackward
        ? -15
        : key === bindings.seekForward
          ? 15
          : undefined;
    const hold =
      active && (key === bindings.boostPrimary || key === bindings.boostSecondary);

    if (!navigate && seek === undefined && !hold) return false;

    event.preventDefault();
    event.stopImmediatePropagation?.();
    // 系统自动重复不算新手势，否则按住会连翻十几首。
    if (event.repeat || this.press?.key === key) return true;

    // 纯单击动作没有任何等待歧义，直接执行。
    if (seek === undefined && !hold) {
      this.flushTap();
      navigate?.();
      return true;
    }

    const double =
      seek !== undefined &&
      this.tap?.key === key &&
      performance.now() - this.tap.at <= DOUBLE_TAP_MS;
    if (this.tap && !double) this.flushTap();
    this.clearTapTimer();
    this.tap = undefined;

    this.press = { key, double, long: false, boosted: false, seek, navigate, hold };
    if (hold) {
      this.holdTimer = window.setTimeout(() => {
        const press = this.press;
        if (!press || press.key !== key) return;
        press.long = true;
        if (!this.actions.enabled() || !this.actions.playing()) return;
        press.boosted = true;
        this.actions.boost(true);
      }, HOLD_MS);
    }
    return true;
  }

  keyup(event: KeyboardEvent): void {
    if (this.disposed) return;
    const press = this.press;
    if (!press || normalizeKeyBinding(event.key) !== press.key) return;
    event.preventDefault();
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.press = undefined;

    // 已经进入长按：松开只是收掉变速，不再当成单击。
    if (press.long) {
      if (press.boosted) this.actions.boost(false);
      return;
    }
    if (!this.actions.enabled()) return;
    if (press.double && press.seek !== undefined) {
      this.actions.seekBy(press.seek);
      return;
    }
    if (press.seek !== undefined) {
      // 先按住不判：300ms 内可能还有第二下。
      this.tap = { key: press.key, at: performance.now(), navigate: press.navigate };
      this.tapTimer = window.setTimeout(() => this.flushTap(), DOUBLE_TAP_MS);
      return;
    }
    press.navigate?.();
  }

  /** 窗口失焦、切换面板时调用：把半截手势和变速一起收掉。 */
  cancel(): void {
    this.clearTapTimer();
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.tap = undefined;
    if (this.press?.boosted) this.actions.boost(false);
    this.press = undefined;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private flushTap() {
    this.clearTapTimer();
    const tap = this.tap;
    this.tap = undefined;
    if (!tap) return;
    if (!this.actions.enabled()) return;
    tap.navigate?.();
  }

  private clearTapTimer() {
    window.clearTimeout(this.tapTimer);
    this.tapTimer = 0;
  }
}

/** 设置页里这一段的行标记：`.settings-row` + `.text-button`，与其它按钮同款。 */
export function keybindingsSectionMarkup(bindings: KeyBindings): string {
  const rows = (Object.keys(KEY_ACTION_LABELS) as KeyAction[])
    .map(
      (action) =>
        `<div class="settings-row shortcut-row"><span>${KEY_ACTION_LABELS[action]}</span><button type="button" class="text-button shortcut-binding" data-key-binding="${action}" aria-label="设置${KEY_ACTION_LABELS[action]}快捷键">${keyBindingLabel(bindings[action])}</button></div>`,
    )
    .join("");
  return `<section class="panel-section" data-settings-group="playback"><h3>键盘操作</h3>${rows}<button type="button" class="text-button" data-key-preset="default">恢复默认 ↗</button><p class="quality-note">空格固定为暂停／继续。点击右侧按键即可重新设置；Esc 取消。可使用方向键、字母、数字、Home／End、Page Up／Down 或功能键（V、F11 等界面快捷键保留）。</p><p id="shortcut-status" class="quality-note" role="status" aria-live="polite"></p></section>`;
}

/**
 * 录制式改键。点右侧按钮 → 按钮变「请按键…」→ 按下合法键即保存。
 *
 * 用捕获阶段监听，并且 `stopImmediatePropagation`：录制期间这一下按键
 * 只能用来改键，不能顺带把歌切了。
 */
export function mountKeybindingEditor(
  root: HTMLElement,
  read: () => KeyBindings,
  write: (next: KeyBindings) => void,
) {
  const controller = new AbortController();
  let recording: HTMLButtonElement | undefined;

  const status = (text: string) => {
    const node = root.querySelector<HTMLElement>("#shortcut-status");
    if (node) node.textContent = text;
  };

  const paint = () => {
    const bindings = read();
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-key-binding]")) {
      const action = button.dataset.keyBinding as KeyAction | undefined;
      if (!action) continue;
      button.textContent = keyBindingLabel(bindings[action]);
      button.removeAttribute("data-recording");
    }
    recording = undefined;
  };

  const stopRecording = (message: string) => {
    paint();
    status(message);
  };

  root.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-key-binding], [data-key-preset]",
      );
      if (!target) return;
      if (target.dataset.keyPreset === "default") {
        write({ ...DEFAULT_KEY_BINDINGS });
        stopRecording("快捷键已恢复默认。");
        return;
      }
      if (!(target instanceof HTMLButtonElement)) return;
      paint();
      recording = target;
      target.dataset.recording = "true";
      target.textContent = "请按键…";
      status("等待按键，Esc 取消。");
    },
    { signal: controller.signal },
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!recording) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === "Escape") {
        stopRecording("已取消。");
        return;
      }
      const key =
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
          ? undefined
          : normalizeKeyBinding(event.key);
      if (!key) {
        status("此按键为系统／界面保留键，请选择其他按键。");
        return;
      }
      const action = recording.dataset.keyBinding as KeyAction;
      const next = { ...read(), [action]: key };
      const conflict = bindingConflict(next);
      if (conflict) {
        status(conflict);
        return;
      }
      write(next);
      stopRecording("快捷键已保存。");
    },
    { capture: true, signal: controller.signal },
  );

  // 点了别处就放弃这次改键，避免「请按键…」一直亮着。
  root.addEventListener(
    "focusout",
    (event) => {
      if (recording && event.target === recording) stopRecording("已取消。");
    },
    { signal: controller.signal },
  );

  return () => {
    paint();
    controller.abort();
  };
}
