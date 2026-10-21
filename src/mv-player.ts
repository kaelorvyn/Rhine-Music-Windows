import './mv-player.css';
import { escapeHtml as esc } from './html';

export interface MvEntry {
  title: string;
  artist: string;
  src: string;
  /** 保存到本地。不传就只显示播放器（没有可下载的地址时）。 */
  download?: () => Promise<string>;
}

/** MV 浮层：播放 + 保存到本地。
 *
 * 早先这里的注释写着“只看不下载，刻意不给导出入口”。用户现在要求能下载，
 * 所以加了「下载 MV」按钮 —— 实际下载走主进程的下载队列（/api/downloads），
 * 和歌曲下载共用同一份目录设置与任务列表。 */
export class MvPlayer {
  private root?: HTMLElement;
  private keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') this.close(); };
 /** While open, Escape belongs to the overlay — never to page navigation. */
  get isOpen(): boolean { return !!this.root; }
  open(entry: MvEntry): void {
    this.close();
    const root = document.createElement('div');
    root.className = 'mv-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `MV：${entry.title}`);
    root.innerHTML = `<div class="mv-surface">
      <div class="mv-head"><strong>${esc(entry.title)}</strong><small>${esc(entry.artist)}</small>
        <span class="mv-head-actions"><button type="button" class="text-button" data-mv-download>下载 MV</button><button type="button" class="text-button" data-mv-close>关闭</button></span></div>
      <video class="mv-video" controls autoplay playsinline src="${esc(entry.src)}"></video>
      <p class="mv-status" role="status"></p></div>`;
    const video = root.querySelector('video')!;
    const status = root.querySelector<HTMLElement>('.mv-status')!;
    video.addEventListener('error', () => {
      status.textContent = 'MV 加载失败，可能是网络或音源限制。';
    });
    const downloadButton = root.querySelector<HTMLButtonElement>('[data-mv-download]');
    if (downloadButton && entry.download) {
      downloadButton.addEventListener('click', async () => {
        downloadButton.disabled = true;
        status.textContent = '正在加入下载队列…';
        try {
          status.textContent = await entry.download!();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'MV 下载没有开始。';
        } finally {
          downloadButton.disabled = false;
        }
      });
    } else {
      downloadButton?.remove();
    }
    root.querySelector('[data-mv-close]')!.addEventListener('click', () => this.close());
    root.addEventListener('click', event => { if (event.target === root) this.close(); });
    document.addEventListener('keydown', this.keydown);
    document.body.appendChild(root);
    this.root = root;
  }
  close(): void {
    const video = this.root?.querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    this.root?.remove(); this.root = undefined;
    document.removeEventListener('keydown', this.keydown);
  }
}
