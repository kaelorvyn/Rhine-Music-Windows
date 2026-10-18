import './mv-player.css';
import { escapeHtml as esc } from './html';

export interface MvEntry { title: string; artist: string; src: string }

/** Watch-only MV overlay (只看不下载). The provider stream plays in place; the
 * product decision is deliberate: no download, save, or export affordance. */
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
        <button type="button" class="text-button" data-mv-close>关闭</button></div>
      <video class="mv-video" controls autoplay playsinline src="${esc(entry.src)}"></video>
      <p class="mv-status" role="status"></p></div>`;
    const video = root.querySelector('video')!;
    video.addEventListener('error', () => {
      const status = root.querySelector<HTMLElement>('.mv-status');
      if (status) status.textContent = 'MV 加载失败，可能是网络或音源限制。';
    });
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
