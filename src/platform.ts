export const isTauriApp = () => "__TAURI_INTERNALS__" in window;

export const isAndroidApp = () =>
  isTauriApp() && /Android/i.test(navigator.userAgent);

export const isDesktopApp = () => isTauriApp() && !isAndroidApp();
