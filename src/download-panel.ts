import './download-panel.css';
import { escapeHtml as esc } from './html';
import { qualityTierLabels, type QualityTier } from './quality-tier.ts';

export type DownloadTaskView = {
  id: string; title: string; artist: string; quality: string;
  status: 'queued' | 'downloading' | 'done' | 'failed'; error: string | null; bytes: number; target: string; createdAt: number;
};

/** 某首歌**实际可选**的音质档位（下载时按歌实时探测，不是全局设置）。
 *
 * 背景：「下载音质不应该从设置里面选，应该在点击
 * 下载的时候，看它有哪些音质，就用哪些音质」。确实如此 —— 一首歌有没有
 * 母带、有没有高清，是**这首歌自己的属性**，写死一个全局档位只会有两种
 * 结果：要么每次都降级（用户选母带，歌没有），要么每次都浪费（用户选标准，
 * 歌明明有无损）。
 */
export type DownloadOption = {
 /** 归一化后的 7 级档位，直接用作 prepare 的 quality 参数。 */
  tier: QualityTier;
 /** 该档位的文件大小（字节），0 表示平台没给。 */
  bytes: number;
};

type Snapshot = { settings: { directory: string; quality: string; naming: string }; tasks: DownloadTaskView[] };
const statusNames: Record<DownloadTaskView['status'], string> = {
  queued: '排队中', downloading: '下载中', done: '已完成', failed: '失败',
};
const qualityNames: Record<string, string> = {
  standard: '标准', high: '高品', lossless: '无损', hires: 'Hi-Res',
  hifi: 'HiFi', surround: '环绕', master: '母带',
 // 平台原生叫法（老数据/后端直传）也认，避免徽章显示成英文
  flac: '无损', '320k': '高品', '128k': '标准', jymaster: '母带',
};
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KiB` : `${bytes} B`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((value as { error?: string }).error || '下载服务暂时不可用。');
  return value as T;
}

/** Task list for 歌曲下载: queue the current song, watch progress, retry or
 * remove entries. 音质**不再由设置里的全局值决定** —— 点「下载当前歌曲」
 * 时现场列出这首歌真正具备的档位，让用户当场挑（见 DownloadOption 注释）。 */
export class DownloadPanel {
  private root?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') this.close(); };
 /**
 * @param current 当前曲目信息（null 表示没有可下载的歌）
 * @param listOptions 探测这首歌实际有哪些音质档位；返回空数组表示探测不到
 * @param onDownloadCurrent 入队回调，参数是用户选中的档位
 */
  open(
    current: { title: string; artist: string } | null,
    listOptions: () => Promise<DownloadOption[]>,
    onDownloadCurrent: (tier: QualityTier) => Promise<void>,
  ): void {
    this.close();
    const root = document.createElement('div');
    root.className = 'dl-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '下载任务');
    root.innerHTML = `<div class="dl-surface">
      <div class="dl-head"><strong>下载任务</strong>
        <button type="button" class="text-button" data-dl-close>关闭</button></div>
      ${current ? `<button type="button" class="primary-button" data-dl-current>下载当前歌曲：${esc(current.artist)} - ${esc(current.title)}</button>`
        : '<p class="dl-status" role="status">当前没有可下载的歌曲。</p>'}
      <div class="dl-quality" data-dl-quality hidden></div>
      <p class="dl-status" role="status" data-dl-message></p>
      <ul class="dl-tasks" data-dl-tasks></ul>
      <p class="dl-hint">下载目录与命名在“设置 → 歌曲下载”里调整；音质按每首歌实际提供的档位在下载时选择。仅下载平台提供给当前账号的音源，请遵守平台协议与版权法。</p>
    </div>`;
    const message = (text: string) => { const node = root.querySelector<HTMLElement>('[data-dl-message]'); if (node) node.textContent = text; };
    const qualityBox = root.querySelector<HTMLElement>('[data-dl-quality]');
    const render = (snapshot: Snapshot) => {
      const list = root.querySelector<HTMLElement>('[data-dl-tasks]');
      if (!list) return;
      list.innerHTML = snapshot.tasks.length ? '' : '<li class="dl-empty">还没有下载任务。</li>';
      for (const task of snapshot.tasks) {
        const item = document.createElement('li');
        item.className = `dl-task is-${task.status}`;
        item.innerHTML = `<div class="dl-task-main"><strong>${esc(task.title)}</strong><small>${esc(task.artist)} · ${qualityNames[task.quality] ?? esc(task.quality)}</small>
          <small class="dl-task-status">${statusNames[task.status]}${task.bytes ? ` · ${formatBytes(task.bytes)}` : ''}${task.status === 'failed' && task.error ? ` · ${esc(task.error)}` : ''}</small></div>
          ${task.status === 'failed' ? `<button type="button" class="text-button" data-dl-retry="${esc(task.id)}">重试</button>` : ''}
          ${task.status !== 'downloading' ? `<button type="button" class="text-button" data-dl-remove="${esc(task.id)}">删除</button>` : ''}`;
        list.appendChild(item);
      }
    };
    const refresh = async () => {
      try { render(await api<Snapshot>('/api/downloads')); }
      catch (error) { message(error instanceof Error ? error.message : '下载服务暂时不可用。'); }
      finally {
        if (this.root === root) this.timer = setTimeout(() => void refresh(), 2500);
      }
    };
 /** 把探测到的档位渲染成一排按钮，点哪个就按哪个档下。 */
    const showOptions = (options: DownloadOption[]) => {
      if (!qualityBox) return;
      if (!options.length) { qualityBox.hidden = true; qualityBox.innerHTML = ''; return; }
      const highest = options[0];
      qualityBox.innerHTML = `<span class="dl-quality-label">选择音质</span><div class="dl-quality-row">${options.map((option, index) => {
        const label = qualityTierLabels[option.tier] ?? option.tier;
        const size = option.bytes ? ` · ${formatBytes(option.bytes)}` : '';
        return `<button type="button" class="dl-quality-option${index === 0 ? ' is-default' : ''}" data-dl-quality-pick="${esc(option.tier)}">${esc(label)}${esc(size)}</button>`;
      }).join('')}</div><p class="dl-quality-hint">这首歌提供以上 ${options.length} 种音质${highest.tier === 'master' ? '，最高为母带' : ''}。</p>`;
      qualityBox.hidden = false;
    };
    root.addEventListener('click', async event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.hasAttribute('data-dl-close')) { this.close(); return; }
      try {
        if (button.hasAttribute('data-dl-current')) {
 // 点「下载当前歌曲」不再直接入队 —— 先问这首歌有什么档位。
          button.disabled = true;
          message('正在查询可用音质…');
          const options = await listOptions().catch(() => [] as DownloadOption[]);
          button.disabled = false;
          if (!options.length) { message('没能获取到这首歌的音质档位，已按默认档位下载。'); }
          else message('');
          options.length ? showOptions(options) : options;
          if (!options.length) {
 // 探测失败也要能下 —— 用最高兜底，总比卡住强。
            await onDownloadCurrent('lossless');
            message('已加入下载队列。');
            render(await api<Snapshot>('/api/downloads'));
            return;
          }
          return;
        }
        if (button.dataset.dlQualityPick) {
          const tier = button.dataset.dlQualityPick as QualityTier;
          button.disabled = true;
          message('正在准备下载…');
          await onDownloadCurrent(tier);
          message(`已加入下载队列（${qualityTierLabels[tier] ?? tier}）。`);
          if (qualityBox) { qualityBox.hidden = true; qualityBox.innerHTML = ''; }
          render(await api<Snapshot>('/api/downloads'));
        } else if (button.dataset.dlRetry) {
          render(await api<Snapshot>(`/api/downloads/${button.dataset.dlRetry}/retry`, {}));
          message('已重新排队。');
        } else if (button.dataset.dlRemove) {
          render(await api<Snapshot>(`/api/downloads/${button.dataset.dlRemove}/remove`, {}));
        }
      } catch (error) {
        message(error instanceof Error ? error.message : '操作失败，请重试。');
        button.disabled = false;
      }
    });
    root.addEventListener('click', event => { if (event.target === root) this.close(); });
    document.addEventListener('keydown', this.keydown);
    document.body.appendChild(root);
    this.root = root;
    void refresh();
  }
  close(): void {
    clearTimeout(this.timer);
    this.root?.remove(); this.root = undefined;
    document.removeEventListener('keydown', this.keydown);
  }
}
