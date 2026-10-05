type PressedKeys = Set<string>;

function currentPad(): Gamepad | undefined {
  const pads = navigator.getGamepads();
  for (const pad of pads) if (pad && pad.connected) return pad;
  return undefined;
}

function keysFor(pad: Gamepad): PressedKeys {
  const keys = new Set<string>();
  const axes = pad.axes;
  const button = (index: number) => pad.buttons[index]?.pressed ?? false;
  const axis = (index: number) => axes[index] ?? 0;

  if (button(0) || button(9)) keys.add("Enter");
  if (button(1) || button(8)) keys.add("Escape");
  if (button(2)) keys.add("/");
  if (button(3)) keys.add("Home");
  if (button(12) || axis(1) < -DEADZONE) keys.add("ArrowUp");
  if (button(13) || axis(1) > DEADZONE) keys.add("ArrowDown");
  if (button(14) || axis(0) < -DEADZONE) keys.add("ArrowLeft");
  if (button(15) || axis(0) > DEADZONE) keys.add("ArrowRight");

  return keys;
}

function dispatch(key: string): void {
  const active = document.activeElement;
  const target =
    active instanceof HTMLElement && active !== document.body
      ? active
      : document;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const DEADZONE = 0.35;
const REPEAT_START = 400;
const REPEAT_RATE = 120;

const held = new Set<string>();
const firstAt = new Map<string, number>();
const lastDispatched = new Map<string, number>();

let frame = 0;
let running = false;
let present = false;

export function gamepadConnected(): boolean {
  return present;
}

export type InputDevice = "keyboard" | "gamepad";

let device: InputDevice = "keyboard";
const deviceListeners = new Set<(device: InputDevice) => void>();

function setDevice(next: InputDevice): void {
  if (device === next) return;
  device = next;
  for (const listener of deviceListeners) listener(next);
}

export function inputDevice(): InputDevice {
  return device;
}

export function onInputDevice(
  listener: (device: InputDevice) => void,
): () => void {
  deviceListeners.add(listener);
  listener(device);
  return () => {
    deviceListeners.delete(listener);
  };
}

function poll(): void {
  frame = requestAnimationFrame(poll);
  const pad = currentPad();
  if (!pad) {
    present = false;
    held.clear();
    firstAt.clear();
    lastDispatched.clear();
    running = false;
    cancelAnimationFrame(frame);
    return;
  }
  present = true;
  const pressed = keysFor(pad);
  const now = performance.now();
  if (pressed.size > 0) setDevice("gamepad");

  for (const key of [...held]) {
    if (!pressed.has(key)) {
      held.delete(key);
      firstAt.delete(key);
      lastDispatched.delete(key);
    }
  }

  for (const key of pressed) {
    if (!held.has(key)) {
      held.add(key);
      firstAt.set(key, now);
      lastDispatched.set(key, now);
      dispatch(key);
    } else if (
      now - firstAt.get(key)! >= REPEAT_START &&
      now - lastDispatched.get(key)! >= REPEAT_RATE
    ) {
      lastDispatched.set(key, now);
      dispatch(key);
    }
  }
}

function start(): void {
  if (running || !currentPad()) return;
  running = true;
  poll();
}

export function enableGamepad(): void {
  if (typeof navigator === "undefined" || !("getGamepads" in navigator)) return;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted) setDevice("keyboard");
    },
    {
      capture: true,
      passive: true,
    },
  );
  start();
  window.addEventListener("gamepadconnected", () => {
    setDevice("gamepad");
    start();
  });
  window.addEventListener("gamepaddisconnected", () => {
    held.clear();
    firstAt.clear();
    lastDispatched.clear();
  });
}
