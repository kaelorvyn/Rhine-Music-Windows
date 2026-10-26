import assert from "node:assert/strict";

// 手势机用 window.setTimeout；Node 里把 window 指向自己就够了。
globalThis.window = globalThis;

const {
  DEFAULT_KEY_BINDINGS,
  KEY_ACTION_LABELS,
  MusicKeyGestures,
  bindingConflict,
  keyBindingLabel,
  keybindingsSectionMarkup,
  normalizeKeyBinding,
  sanitizeKeyBindings,
} = await import("../src/music-keybindings.ts");

// ── 合法键白名单 ───────────────────────────────────────────────
assert.equal(normalizeKeyBinding("v"), undefined, "V 是界面快捷键，不能绑");
assert.equal(normalizeKeyBinding("V"), undefined);
assert.equal(normalizeKeyBinding("F11"), undefined, "F11 是全屏，不能绑");
assert.equal(normalizeKeyBinding("F12"), "F12");
assert.equal(normalizeKeyBinding("F1"), "F1");
assert.equal(normalizeKeyBinding("F10"), "F10");
assert.equal(normalizeKeyBinding("A"), "a", "字母统一存小写");
assert.equal(normalizeKeyBinding("7"), "7");
assert.equal(normalizeKeyBinding("ArrowUp"), "ArrowUp");
assert.equal(normalizeKeyBinding("PageDown"), "PageDown");
assert.equal(normalizeKeyBinding(" "), undefined, "空格固定暂停，不参与绑定");
assert.equal(normalizeKeyBinding("Escape"), undefined);
assert.equal(normalizeKeyBinding("Shift"), undefined);

// ── 撞键规则：同组不许重复，跨组可以共用 ────────────────────────
assert.equal(bindingConflict({ ...DEFAULT_KEY_BINDINGS }), undefined, "默认键位本身合法");

// ← 同时管单击（上一首）、双击（回退）、长按（变速）—— 这是设计，不是冲突。
assert.equal(
  bindingConflict({
    ...DEFAULT_KEY_BINDINGS,
    songPrevious: "ArrowLeft",
    seekBackward: "ArrowLeft",
    boostPrimary: "ArrowLeft",
  }),
  undefined,
  "跨组共用一键合法",
);

assert.match(
  bindingConflict({ ...DEFAULT_KEY_BINDINGS, playlistPrevious: "ArrowDown" }),
  /同一种操作方式不能重复使用同一个键/,
  "单击组内撞键要拦住",
);
assert.match(
  bindingConflict({ ...DEFAULT_KEY_BINDINGS, seekForward: "ArrowLeft" }),
  /同一种操作方式/,
  "双击组内撞键要拦住",
);
assert.match(
  bindingConflict({ ...DEFAULT_KEY_BINDINGS, boostSecondary: "ArrowLeft" }),
  /同一种操作方式/,
  "长按组内撞键要拦住",
);

// ── 存档清洗 ───────────────────────────────────────────────────
assert.deepEqual(sanitizeKeyBindings(undefined), DEFAULT_KEY_BINDINGS);
assert.deepEqual(sanitizeKeyBindings("垃圾"), DEFAULT_KEY_BINDINGS);
assert.deepEqual(
  sanitizeKeyBindings({ songPrevious: "v", songNext: "ArrowRight" }),
  DEFAULT_KEY_BINDINGS,
  "存档里有非法键 → 整份回默认",
);
assert.deepEqual(
  sanitizeKeyBindings({ songPrevious: "ArrowUp" }),
  DEFAULT_KEY_BINDINGS,
  "存档撞键 → 整份回默认",
);
const custom = { ...DEFAULT_KEY_BINDINGS, playlistPrevious: "PageUp", playlistNext: "PageDown" };
assert.deepEqual(sanitizeKeyBindings(custom), custom, "合法存档原样保留");

// ── 显示名 ─────────────────────────────────────────────────────
assert.equal(keyBindingLabel("ArrowLeft"), "←");
assert.equal(keyBindingLabel("ArrowUp"), "↑");
assert.equal(keyBindingLabel("PageUp"), "Page Up");
assert.equal(keyBindingLabel("k"), "K");

// ── 页面标记 ───────────────────────────────────────────────────
const markup = keybindingsSectionMarkup(DEFAULT_KEY_BINDINGS);
for (const label of Object.values(KEY_ACTION_LABELS)) {
  assert.ok(markup.includes(label), `页面里应该有「${label}」`);
}
assert.ok(markup.includes("恢复默认 ↗"), "恢复默认按钮带 ↗");
assert.ok(markup.includes('class="text-button" data-key-preset="default"'), "恢复默认用 text-button");
assert.equal(
  (markup.match(/data-key-binding="/g) || []).length,
  8,
  "正好 8 行键位",
);
assert.ok(markup.includes('data-settings-group="playback"'), "挂在播放分区下");
assert.ok(!markup.includes("交换上下"), "不要「交换上下／左右」");
assert.ok(!markup.includes("导航按键切换时同步播放"), "不要同步播放开关");
assert.ok(
  markup.includes("空格固定为暂停／继续") && markup.includes("F11"),
  "说明文字原样保留",
);

// ── 手势机 ─────────────────────────────────────────────────────
const event = (key, overrides = {}) => ({
  key,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  prevented: 0,
  preventDefault() {
    this.prevented += 1;
  },
  stopImmediatePropagation() {},
  ...overrides,
});

function harness(overrides = {}) {
  const calls = [];
  const gestures = new MusicKeyGestures({
    enabled: () => true,
    active: () => true,
    playing: () => true,
    bindings: () => DEFAULT_KEY_BINDINGS,
    navigateSong: (d) => calls.push(["song", d]),
    navigatePlaylist: (d) => calls.push(["playlist", d]),
    seekBy: (s) => calls.push(["seek", s]),
    boost: (on) => calls.push(["boost", on]),
    ...overrides,
  });
  return { gestures, calls };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 单击（←）→ 上一首。要等过双击窗口才落地。
{
  const { gestures, calls } = harness();
  const down = event("ArrowLeft");
  assert.equal(gestures.keydown(down), true, "被消费");
  assert.equal(down.prevented, 1, "阻止默认滚动");
  gestures.keyup(event("ArrowLeft"));
  assert.deepEqual(calls, [], "300ms 内还不执行，先等第二下");
  await wait(360);
  assert.deepEqual(calls, [["song", -1]], "单击 = 上一首");
  gestures.dispose();
}

// 双击（←←）→ 回退 15 秒，且不触发单击。
{
  const { gestures, calls } = harness();
  gestures.keydown(event("ArrowLeft"));
  gestures.keyup(event("ArrowLeft"));
  gestures.keydown(event("ArrowLeft"));
  gestures.keyup(event("ArrowLeft"));
  assert.deepEqual(calls, [["seek", -15]], "双击 = 回退 15 秒");
  await wait(360);
  assert.deepEqual(calls, [["seek", -15]], "第二下吃掉单击，不会又切一首");
  gestures.dispose();
}

// 双击（→→）→ 快进 15 秒。
{
  const { gestures, calls } = harness();
  gestures.keydown(event("ArrowRight"));
  gestures.keyup(event("ArrowRight"));
  gestures.keydown(event("ArrowRight"));
  gestures.keyup(event("ArrowRight"));
  assert.deepEqual(calls, [["seek", 15]]);
  gestures.dispose();
}

// 长按（← 按住 450ms）→ 2 倍速；松开恢复，且不当成单击。
{
  const { gestures, calls } = harness();
  gestures.keydown(event("ArrowLeft"));
  await wait(520);
  assert.deepEqual(calls, [["boost", true]], "按住 450ms 进入变速");
  gestures.keyup(event("ArrowLeft"));
  assert.deepEqual(calls, [["boost", true], ["boost", false]], "松开回到原速");
  await wait(360);
  assert.deepEqual(calls, [["boost", true], ["boost", false]], "长按之后不再当单击切歌");
  gestures.dispose();
}

// 自动重复不算新手势。
{
  const { gestures, calls } = harness();
  assert.equal(gestures.keydown(event("ArrowLeft", { repeat: true })), true);
  await wait(30);
  gestures.keyup(event("ArrowLeft"));
  await wait(360);
  assert.deepEqual(calls, [], "系统自动重复被忽略");
  gestures.dispose();
}

// 没有当前曲目时：双击/长按不生效，键退化成纯单击 —— 立即执行，不用等双击窗口。
{
  const { gestures, calls } = harness({ active: () => false });
  gestures.keydown(event("ArrowLeft"));
  gestures.keyup(event("ArrowLeft"));
  assert.deepEqual(calls, [["song", -1]], "无歌时单击不用等 300ms，立刻切");
  gestures.keydown(event("ArrowLeft"));
  gestures.keyup(event("ArrowLeft"));
  await wait(360);
  assert.deepEqual(
    calls,
    [["song", -1], ["song", -1]],
    "无歌时连按两下就是切两次，不跳转、不延迟",
  );
  gestures.dispose();
}

// 弹窗打开（enabled=false）时不响应。
{
  const { gestures, calls } = harness({ enabled: () => false });
  assert.equal(gestures.keydown(event("ArrowLeft")), false, "不该消费");
  gestures.dispose();
}

// 未绑定的键不拦截。
{
  const { gestures } = harness();
  assert.equal(gestures.keydown(event("q")), false, "q 没绑，放行");
  gestures.dispose();
}

// 带修饰键的组合留给系统和界面快捷键。
{
  const { gestures } = harness();
  assert.equal(gestures.keydown(event("ArrowLeft", { shiftKey: true })), false);
  assert.equal(gestures.keydown(event("ArrowLeft", { ctrlKey: true })), false);
  gestures.dispose();
}

// cancel() 要收掉正在生效的变速。
{
  const { gestures, calls } = harness();
  gestures.keydown(event("ArrowLeft"));
  await wait(520);
  gestures.cancel();
  assert.deepEqual(calls, [["boost", true], ["boost", false]], "cancel 收掉变速");
  gestures.keyup(event("ArrowLeft"));
  assert.deepEqual(calls, [["boost", true], ["boost", false]], "cancel 后 keyup 不再动作");
  gestures.dispose();
}

// 换成自定义键位后，旧键失效、新键生效。
{
  const bindings = { ...DEFAULT_KEY_BINDINGS, songPrevious: "PageUp", songNext: "PageDown" };
  const calls = [];
  const gestures = new MusicKeyGestures({
    enabled: () => true,
    active: () => true,
    playing: () => true,
    bindings: () => bindings,
    navigateSong: (d) => calls.push(["song", d]),
    navigatePlaylist: (d) => calls.push(["playlist", d]),
    seekBy: (s) => calls.push(["seek", s]),
    boost: (on) => calls.push(["boost", on]),
  });
  // ← 已经不再管切歌；它还兼着双击/长按，所以仍会被消费，但不该产生切歌动作。
  gestures.keydown(event("ArrowLeft"));
  gestures.keyup(event("ArrowLeft"));
  await wait(360);
  assert.ok(
    !calls.some(([kind]) => kind === "song"),
    "改键后 ← 不再切歌",
  );
  gestures.keydown(event("PageUp"));
  gestures.keyup(event("PageUp"));
  await wait(360);
  assert.deepEqual(calls, [["song", -1]], "PageUp 变成上一首");
  gestures.dispose();
}

console.log(
  "Keyboard bindings passed: key whitelist, group conflict rules, saved-state sanitising, labels, settings markup (8 rows + 恢复默认 ↗ + hint), single/double/hold gestures, repeat suppression, inactive guard, modifier pass-through, cancel, custom bindings.",
);
