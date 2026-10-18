import { invoke } from "@tauri-apps/api/core";
import "./desktop.css";

export const isDesktop = () => "__TAURI_INTERNALS__" in window;
function showError(error: unknown) {
  const toast = document.querySelector<HTMLElement>("#music-toast");
  if (!toast) return;
  toast.textContent = `桌面操作失败：${String(error)}`;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 5500);
}
export function mountDesktop() {
  if (!isDesktop()) return;
  document.documentElement.classList.add("rhine-desktop");
  const bar = document.createElement("header");
  bar.className = "desktop-chrome";
  const icon = (paths: string) => `<svg viewBox="0 0 12 12" aria-hidden="true">${paths}</svg>`;
  const maximizeIcon = icon('<rect x="1.5" y="1.5" width="9" height="9"/>');
  const restoreIcon = icon('<path d="M3.5 3.5V1.5H10.5V8.5H8.5"/><rect x="1.5" y="3.5" width="7" height="7"/>');
  bar.innerHTML = `<div class="desktop-drag" data-tauri-drag-region aria-hidden="true"></div>
    <nav aria-label="窗口控制"><button data-window="minimize" aria-label="最小化">${icon('<path d="M1 6.5H11"/>')}</button><button data-window="maximize" aria-label="最大化">${maximizeIcon}</button><button data-window="close" aria-label="关闭">${icon('<path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"/>')}</button></nav>`;
  document.body.prepend(bar);
  const syncWindowState = (state: { fullscreen: boolean; maximized: boolean }) => {
    document.documentElement.classList.toggle("desktop-maximized", state.maximized);
    const maximize = bar.querySelector<HTMLButtonElement>('[data-window="maximize"]')!;
    const restore = state.maximized;
    maximize.innerHTML = restore ? restoreIcon : maximizeIcon;
    maximize.setAttribute("aria-label", restore ? "还原" : "最大化");
    window.dispatchEvent(new Event("resize"));
  };
  const act = (action: string) => invoke("desktop_window_action", { action }).catch(showError);
  bar.addEventListener("click", event => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-window]")?.dataset.window;
    if (action) void act(action);
  });
  window.addEventListener("rhine-desktop-window-state", event => {
    syncWindowState((event as CustomEvent<{ fullscreen: boolean; maximized: boolean }>).detail);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "F11") { event.preventDefault(); event.stopImmediatePropagation(); void act("maximize"); }
    else if (event.key === "Escape" && document.documentElement.classList.contains("desktop-maximized") &&
      !document.querySelector(".music-panel") && document.querySelector<HTMLElement>("#stage")?.dataset.presentation === "archive" &&
      document.querySelector<HTMLElement>("#stage")?.dataset.overview !== "true") {
      event.preventDefault(); event.stopImmediatePropagation(); void act("restore");
    }
  }, true);
 // Route the existing settings control through the same work-area behavior.
  document.addEventListener("click", event => {
    if (!(event.target as HTMLElement).closest('[data-action="fullscreen"]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); void act("maximize");
  }, true);
  document.addEventListener("click", event => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (anchor && anchor.origin !== location.origin && /^https?:$/.test(anchor.protocol)) {
      event.preventDefault(); void invoke("desktop_open_link", { url: anchor.href }).catch(showError);
    }
    const choose = (event.target as HTMLElement).closest('[data-action="choose-music-folder"]');
    if (choose) void (async () => {
      const folder = await invoke<string | null>("desktop_pick_folder");
      const field = document.querySelector<HTMLTextAreaElement>("#music-roots");
      if (!folder || !field) return;
      const roots = field.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!roots.includes(folder)) roots.push(folder);
      field.value = roots.join("\n"); field.dispatchEvent(new Event("input", { bubbles: true }));
    })().catch(showError);
  });
 // Restored window state can predate the frontend listeners.
  void invoke<{ fullscreen: boolean; maximized: boolean }>("desktop_window_state").then(syncWindowState).catch(showError);
}

/**
 * 把「关闭窗口时最小化到托盘」偏好同步给 Rust 侧。
 *
 * 关闭按钮的最终行为在 Rust 里决定（`desktop_window_action("close")`）：开了就
 * `hide()`（歌继续放、任务栏图标消失），关了才真退出。前端只负责传值，并且
 * 必须在**挂载后立刻同步一次** —— 否则用户上次关掉了这个开关，本次启动点关闭
 * 仍会被拦回托盘，找不到退出入口。
 */
export function syncTrayPreference(enabled: boolean) {
  if (!isDesktop()) return;
  void invoke("desktop_tray_preference", { enabled }).catch(showError);
}

/**
 * 把「缓存上限 / 缓存位置」下发给后端解码器。
 *
 * 这两项在设置面板里存在很久了，但后端从来没读过 —— 上限写死 4GB、目录写死
 * `music-data/audio-cache-v041`，滑块和输入框只是改了个没人看的数字。
 * 现在统一走 `POST /api/audio/cache/configure`：前端一改就下发，
 * 后端 prune 按新上限淘汰、按新位置落盘。
 */
export async function syncCacheSettings(limitMb: number, location: string): Promise<{ limitBytes: number; cacheDir: string } | null> {
  try {
    const response = await fetch('/api/audio/cache/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limitMb, location }),
    });
    if (!response.ok) return null;
    return await response.json() as { limitBytes: number; cacheDir: string };
  } catch { return null; }
}

/** 真正清空音频缓存。以前那个「清理缓存」按钮没有任何处理器。
 *
 * 返回里 `freed` 是**释放量**，`files`/`bytes` 是**清理后剩余量**。两者必须分开：
 * 早先后端把两个对象直接合并，`usage()` 的 0 覆盖了 `freed` 的统计，
 * 界面上就永远显示「删除 0 个文件」。 */
export async function clearAudioCache(): Promise<{ freed: { files: number; bytes: number } } | null> {
  try {
    const response = await fetch('/api/audio/cache/clear', { method: 'POST' });
    if (!response.ok) return null;
    return await response.json() as { freed: { files: number; bytes: number } };
  } catch { return null; }
}

/** 读取当前音频缓存占用，用于设置面板展示。 */
export async function readAudioCacheUsage(): Promise<{ files: number; bytes: number; limitBytes: number; cacheDir: string } | null> {
  try {
    const response = await fetch('/api/audio/cache');
    if (!response.ok) return null;
    return await response.json() as { files: number; bytes: number; limitBytes: number; cacheDir: string };
  } catch { return null; }
}

/** 共享音源密钥的状态。**返回值里没有 token** —— 后端只回账号名与到期时间。 */
export interface PoolCredentialStatus {
  configured: boolean;
  poolEnabled: boolean;
  account: string | null;
  expiresAt: string | null;
  importedAt: string | null;
  note: string | null;
}

export async function readPoolCredential(): Promise<PoolCredentialStatus | null> {
  try {
    const response = await fetch('/api/pool/credential');
    if (!response.ok) return null;
    return await response.json() as PoolCredentialStatus;
  } catch { return null; }
}

/** 导入密钥文件内容（.rhinekey 的原文）。返回 null 表示请求失败。 */
export async function importPoolCredential(payload: string): Promise<{ ok: boolean; status?: PoolCredentialStatus; error?: string }> {
  try {
    const response = await fetch('/api/pool/credential/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    const data = await response.json() as PoolCredentialStatus & { error?: string };
    if (!response.ok) return { ok: false, error: data.error ?? "导入失败" };
    return { ok: true, status: data };
  } catch { return { ok: false, error: "无法连接本地服务" }; }
}

/** 移除已导入的密钥。 */
export async function clearPoolCredential(): Promise<PoolCredentialStatus | null> {
  try {
    const response = await fetch('/api/pool/credential', { method: 'DELETE' });
    if (!response.ok) return null;
    return await response.json() as PoolCredentialStatus;
  } catch { return null; }
}

/** 导出当前密钥文件的下载地址（浏览器直接下载）。 */
export function poolCredentialExportUrl() {
  return '/api/pool/credential/export';
}

export async function openFeedbackDraft(url: string) {
  if (isDesktop()) await invoke('desktop_open_feedback', { url });
  else window.location.assign(url);
}
