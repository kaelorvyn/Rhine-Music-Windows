// Keep the browser's image/canvas export menu out of the application surface.
// This only suppresses UI shortcuts; it cannot prevent system screenshots.
document.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});
document.addEventListener("dragstart", (event) => {
  if (event.target instanceof Element && event.target.closest("img, canvas")) {
    event.preventDefault();
  }
}, { capture: true });

// 启动兜底：模块初始化阶段抛出的异常会变成 unhandledrejection（动态 import），
// 那时 start() 根本没跑起来，加载页会永远转圈。这里把原因写到加载页上并给一个
// 「重新加载」出口 —— 与预览版的启动失败页同一套文案。
const reportStartupError = (detail: string) => {
  const node = document.querySelector<HTMLElement>("#music-loading");
  if (!node) return;
  node.hidden = false;
  node.innerHTML =
    `<strong>启动未能完成</strong><small>${detail}</small>` +
    `<button class="primary-button" data-action="retry-startup">重新加载</button>`;
  node.querySelector("[data-action='retry-startup']")?.addEventListener("click", () => location.reload());
};
window.addEventListener("error", (event) => {
  const reason = (event.error as Error | undefined)?.message ?? event.message;
  if (reason) reportStartupError(reason);
});
window.addEventListener("unhandledrejection", (event) => {
  reportStartupError(String((event.reason as Error | undefined)?.message ?? event.reason));
});

// Preserve the original experience as a visual reference while developing music mode.
if (new URLSearchParams(location.search).get("original") === "1") {
  void import("./archive-main");
} else {
  void import("./music-app").then(() => import("./desktop")).then(({ mountDesktop }) => mountDesktop());
}
