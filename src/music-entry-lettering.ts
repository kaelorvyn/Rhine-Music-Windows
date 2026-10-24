/**
 * 进入应用动画 · 逐字定位器。
 * 这是从预览版压缩 JS 基元区尾部移植的 class Oi（紧邻 rc / Di 声明）：
 * 它只做一件事——把一段文字写进宿主元素，内容没变就不碰 DOM，避免逐帧触发重排。
 */

export class Oi {
  private readonly host: HTMLElement;
  private value = "";

  /**
   * 压缩版的第二个参数是分组标签（"brand" / "access" / "identity" …）。
   * 它在压缩版里没有参与任何行为，这里保留形参以便调用点一一对应。
   */
  constructor(host: HTMLElement, _tags: readonly string[]) {
    this.host = host;
    host.textContent = "";
  }

  setText(text: string): this {
    if (text !== this.value) {
      this.value = text;
      this.host.textContent = text;
    }
    return this;
  }
}
