/** 音浪的频谱来源。
 *
 * 这里读的是**服务端 FFmpeg 算好的整轨频谱图**（/api/audio/spectrum*，
 * showspectrumpic 渲染的 256 时间列 × 64 频带灰度 PNG）：像素亮度就是该
 * 时刻该频带的真实能量。按播放位置取列，波形与音乐在数据上是同一份东西。
 *
 * 为什么绕开浏览器取样：本 WebView2 上 captureStream() 拿不到数据
 * （跨源媒体静音轨/空流），createMediaElementSource() 会抢走元素输出
 * （有歌直接放不出声），两条路都踩过。服务端频谱与播放通路完全无关，
 * 任何播放路径（元素/无缝/原生）都能对上同一份数据。
 */

export interface SpectrumTapOptions {
  responsive?: boolean;
}

export const BYTE_TO_AMPLITUDE = Float32Array.from(
  { length: 256 },
  (_, index) => (index === 0 ? 0 : 10 ** ((-90 + (index * 80) / 255) / 20)),
);

export class MusicSpectrum {
  private element?: HTMLAudioElement;
  private frames?: Uint8Array;   // 行=频带(低→高)，列=时间
  private cols = 256;
  private bands = 64;
  private loadKey?: string;
  private responsive = false;

  get attached(): boolean {
    return Boolean(this.element && this.frames);
  }

  get usable(): boolean {
    return true;
  }

  get sampleRate(): number | undefined {
    return undefined;
  }

  attach(element: HTMLAudioElement): boolean {
    this.element = element;
    return true;
  }

  /** 拉一首歌的整轨频谱图（服务端已缓存，通常几十毫秒）。 */
  loadSpectrum(url: string, key: string): void {
    if (this.loadKey === key) return;
    this.loadKey = key;
    this.frames = undefined;
    const token = key;
    fetch(url)
      .then((reply) => { if (!reply.ok) throw new Error(String(reply.status)); return reply.blob(); })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        if (this.loadKey !== token) { bitmap.close?.(); return; }
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const frames = new Uint8Array(bitmap.width * bitmap.height);
        // 灰度 PNG：r=g=b=亮度=能量。图像顶行是高频，波形要的是低频在前。
        for (let band = 0; band < bitmap.height; band += 1) {
          const sourceRow = bitmap.height - 1 - band;
          for (let col = 0; col < bitmap.width; col += 1) {
            frames[band * bitmap.width + col] = data[(sourceRow * bitmap.width + col) * 4];
          }
        }
        this.cols = bitmap.width;
        this.bands = bitmap.height;
        this.frames = frames;
      })
      .catch(() => { if (this.loadKey === token) this.loadKey = undefined; });
  }

  /** 按当前播放位置读一帧：真实频谱该列，插值到目标长度。 */
  read(target: Uint8Array): boolean {
    const element = this.element;
    target.fill(0);
    if (!element || !this.frames) return true;
    const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    if (!duration) return true;
    const progress = Math.min(1, Math.max(0, element.currentTime / duration));
    const col = Math.min(this.cols - 1, Math.floor(progress * this.cols));
    const frames = this.frames;
    const span = target.length / this.bands;
    for (let i = 0; i < target.length; i += 1) {
      const position = i / span;
      const base = Math.min(this.bands - 1, Math.floor(position));
      const next = Math.min(this.bands - 1, base + 1);
      const mix = position - base;
      const a = frames[base * this.cols + col];
      const b = frames[next * this.cols + col];
      target[i] = a + (b - a) * mix;
    }
    return true;
  }

  resume(): void {}

  setResponsive(responsive: boolean): void {
    this.responsive = responsive;
  }

  detach(): void {
    this.element = undefined;
  }

  dispose(): void {
    this.detach();
    this.frames = undefined;
    this.loadKey = undefined;
  }
}
