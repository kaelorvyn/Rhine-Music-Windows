import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './update-center.css';
import { escapeHtml as esc } from './html';
import { openExternal } from './desktop';
import { version as APP_VERSION } from '../package.json';

/** 更新来源：本项目的 GitHub 仓库。 */
const REPO = 'kaelorvyn/Rhine-Music-Windows';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** 开着应用时每小时复查一次（用户要求的频率）。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const isDesktop = () => '__TAURI_INTERNALS__' in window;

interface AppInfo {
  version: string;
  directory: string;
  /** 程序目录是否可写：不可写（装在 Program Files）时降级成「打开下载页」。 */
  writable: boolean;
}

/** 主进程推来的更新进度（phase: download / unpack / apply / restart）。 */
interface UpdateProgress {
  phase: 'download' | 'unpack' | 'apply' | 'restart' | 'error';
  downloaded: number;
  total: number;
}

const PHASE_TEXT: Record<UpdateProgress['phase'], string> = {
  download: '正在下载更新包',
  unpack: '正在解压更新包',
  apply: '正在替换程序文件',
  restart: '正在重启应用',
  error: '更新失败',
};

interface ReleaseInfo {
  version: string;
  tag: string;
  notes: string;
  htmlUrl: string;
  /** 便携包地址。没有就只给「打开仓库」。 */
  assetUrl?: string;
  assetSize?: number;
}

/** 版本号比较：`0.1.5` > `0.1.4`；缺位按 0（`1.0` 等于 `1.0.0`）。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) => value.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const a = parse(latest); const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** 本地后端查更新：绕过渲染进程的 CORS 与匿名限流。
 *  浏览器直连 api.github.com 时，一旦撞上「无 CORS 头的 403」，fetch 直接
 *  抛 Failed to fetch —— 旧实现把它 catch 掉当「没更新」，用户就什么都看不到。
 *  后端（node）不受 CORS 限制，还能多走两条无配额通道，所以由它来查。 */
async function fetchLatestFromBackend(): Promise<ReleaseInfo | undefined> {
  try {
    const response = await fetch('/api/update/check', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return undefined;
    const value = await response.json() as {
      version?: string; tag?: string; notes?: string; htmlUrl?: string;
      assetUrl?: string; assetSize?: number; source?: string;
    };
    const version = String(value.version ?? '');
    if (!version) return undefined;
    return {
      version,
      tag: String(value.tag ?? 'v' + version),
      notes: String(value.notes ?? '').slice(0, 400),
      htmlUrl: String(value.htmlUrl ?? RELEASES_URL),
      assetUrl: value.assetUrl,
      assetSize: value.assetSize,
    };
  } catch { return undefined; }
}

/** 直连 GitHub 的兜底（网页版/脱离本地后端时才会用到）。 */
async function fetchLatestDirect(): Promise<ReleaseInfo | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return undefined;
    const value = await response.json() as {
      tag_name?: string; body?: string; html_url?: string;
      assets?: { name: string; browser_download_url: string; size: number }[];
    };
    const tag = String(value.tag_name ?? '');
    const version = tag.replace(/^v/i, '');
    if (!version) return undefined;
    const asset = value.assets?.find(item => /-portable\.zip$/i.test(item.name));
    return {
      version, tag,
      notes: String(value.body ?? '').slice(0, 400),
      htmlUrl: String(value.html_url ?? RELEASES_URL),
      assetUrl: asset?.browser_download_url,
      assetSize: asset?.size,
    };
  } catch { return undefined; }
}

async function fetchLatest(): Promise<ReleaseInfo | undefined> {
  return (await fetchLatestFromBackend()) ?? (await fetchLatestDirect());
}

/** 版本更新的后台检测 + 设置面板分区。
 *
 * 启动时**不阻塞**：先让界面进得去，再异步查 GitHub；之后每小时复查一次。
 * 有新版本时弹「取消 / 下载并更新 / 打开仓库」三选一 —— 下载走主进程的
 * 自更新（解压覆盖后自动重启），失败或目录不可写时退回打开下载页。 */
export class UpdateCenter {
  private info?: AppInfo;
  private release?: ReleaseInfo;
  private timer?: number;
  private overlay?: HTMLElement;
  private busy = false;
  private progress?: UpdateProgress;
  constructor() {
    // 主进程一边下载一边推进度：百分比、阶段都在这里落地。
    if (isDesktop()) {
      void listen<UpdateProgress>('rhine-update-progress', event => {
        this.progress = event.payload;
        this.paintProgress();
      });
    }
    // 不等 check()：设置面板可能在检测完成前就渲染，先把这个值拿到。
    void this.appInfo().then(() => this.paintStatus());
  }
  /** invoke 失败时的原文：静默吞掉只会让「版本读不出来」变成玄学。 */
  private lastError = '';

  /** 启动后台检测。web 预览里什么都不做。 */
  start(): void {
    if (!isDesktop() || this.timer) return;
    void this.check(false);
    this.timer = window.setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
    this.closeDialog();
  }

  /** @param manual 用户主动点的：无论结果如何都要有回音。 */
  async check(manual: boolean): Promise<void> {
    const app = await this.appInfo();
    if (!app) {
      // 这里有两种完全不同的失败，别再共用一个提示：
      //   · 浏览器预览 —— 确实没有主进程，只能在桌面版里用；
      //   · 桌面版但 invoke 失败（早期就是 ACL 没授权）—— 那是 bug，
      //     把它说成「只在桌面版里可用」会让人以为便携版不支持更新。
      if (manual) {
        this.toast(isDesktop()
          ? `读不到程序信息（${this.lastError || '未知原因'}），暂时无法检查更新。`
          : '版本更新只在桌面版里可用。');
      }
      return;
    }
    const release = await fetchLatest();
    this.release = release;
    this.paintStatus();
    if (!release) { if (manual) this.toast('暂时查不到更新，稍后再试。'); return; }
    if (!isNewerVersion(release.version, app.version)) {
      if (manual) this.toast(`已是最新版本 ${app.version}。`);
      return;
    }
    this.openDialog();
  }

  /** 设置面板里的「版本更新」分区。 */
  settingsMarkup(): string {
    return `<section class="panel-section" id="update-settings" data-settings-group="update">
      <h3>版本更新</h3>
      <p class="scan-status" id="update-status" role="status" aria-live="polite">${esc(this.statusText())}</p>
      <div class="update-actions"><button class="primary-button" data-action="update-check">检查更新</button>
        <button class="text-button" data-action="update-repo">打开仓库 ↗</button></div></section>`;
  }

  private statusText(): string {
    const version = this.info?.version;
    // 非桌面（浏览器预览 / 未打包）用构建时的版本号，别停在「读取中」。
    if (!version) {
      if (!isDesktop()) return `当前版本 ${APP_VERSION} · 预览环境`;
      if (this.lastError) return `版本信息读取失败：${this.lastError}`;
      return `当前版本 ${APP_VERSION}（正在确认程序信息…）`;
    }
    if (!this.release) return `当前版本 ${version}`;
    if (!isNewerVersion(this.release.version, version)) return `当前版本 ${version} · 已是最新`;
    return `当前版本 ${version} · 发现新版本 ${this.release.version}`;
  }

  private paintStatus(): void {
    const status = document.querySelector<HTMLElement>('#update-status');
    if (status) status.textContent = this.statusText();
  }

  private async appInfo(): Promise<AppInfo | undefined> {
    if (this.info) return this.info;
    if (!isDesktop()) return undefined;
    try {
      this.info = await invoke<AppInfo>('desktop_app_info');
      this.lastError = '';
    } catch (error) {
      this.lastError = String(error);
      return undefined;
    }
    return this.info;
  }

  private toast(message: string): void {
    const toast = document.querySelector<HTMLElement>('#music-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    window.setTimeout(() => toast.classList.remove('visible'), 5500);
  }

  private openDialog(): void {
    if (this.overlay || !this.release) return;
    const release = this.release;
    const version = this.info?.version ?? '';
    const root = document.createElement('div');
    root.className = 'update-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `发现新版本 ${release.version}`);
    const size = formatSize(release.assetSize);
    root.innerHTML = `<div class="update-surface">
      <h2>发现新版本 ${esc(release.version)}</h2>
      <p class="update-sub">当前 ${esc(version)}${size ? ` · 更新包 ${esc(size)}` : ''}${release.assetSize && !this.info?.writable ? '' : ''}</p>
      ${release.notes ? `<pre class="update-notes">${esc(release.notes)}</pre>` : ''}
      <div class="update-progress" hidden>
        <div class="update-progress-track"><i class="update-progress-fill"></i></div>
        <div class="update-progress-line"><span class="update-progress-phase"></span><span class="update-progress-number"></span></div>
      </div>
      <p class="update-hint"></p>
      <div class="update-buttons">
        <button type="button" class="update-button" data-update="later">取消</button>
        <button type="button" class="update-button update-button-primary" data-update="install">${this.info?.writable ? '下载并更新' : '打开下载页'}</button>
        <button type="button" class="update-button" data-update="repo">打开仓库</button>
      </div></div>`;
    const hint = root.querySelector<HTMLElement>('.update-hint')!;
    root.querySelector('[data-update="later"]')!.addEventListener('click', () => this.closeDialog());
    root.querySelector('[data-update="repo"]')!.addEventListener('click', () => this.openLink(release.htmlUrl));
    root.querySelector('[data-update="install"]')!.addEventListener('click', () => {
      if (!this.info?.writable || !release.assetUrl) { this.openLink(release.htmlUrl); return; }
      void this.install(release, hint, root.querySelector<HTMLButtonElement>('[data-update="install"]')!);
    });
    root.addEventListener('click', event => { if (event.target === root) this.closeDialog(); });
    document.body.appendChild(root);
    this.overlay = root;
  }

  private async install(release: ReleaseInfo, hint: HTMLElement, button: HTMLButtonElement): Promise<void> {
    if (this.busy || !release.assetUrl) return;
    this.busy = true;
    button.disabled = true;
    // 先摆出「开始下载」的状态，别让用户对着静止的按钮猜。
    this.progress = { phase: 'download', downloaded: 0, total: release.assetSize ?? 0 };
    hint.textContent = '下载完成后会自动替换并重启，中途不用管它。';
    this.paintProgress();
    try {
// 主进程下载、解压、写替换脚本，然后自己退出；重启后就是新版本。
// 这里不要等它"完成"——进程会先退出，等不到返回值是正常的。
      await invoke('desktop_update_install', { url: release.assetUrl, size: release.assetSize ?? 0 });
    } catch (error) {
      this.busy = false;
      button.disabled = false;
      const message = String(error).replace(/^Error:\s*/, '');
      hint.textContent = `${message} 可以改用「打开仓库」手动下载。`;
      this.progress = { phase: 'error', downloaded: 0, total: 0 };
      this.paintProgress();
    }
  }

  /** 把主进程推来的阶段与字节数画成进度条。 */
  private paintProgress(): void {
    const box = this.overlay?.querySelector<HTMLElement>('.update-progress');
    if (!box) return;
    const state = this.progress;
    const fill = box.querySelector<HTMLElement>('.update-progress-fill');
    const phase = box.querySelector<HTMLElement>('.update-progress-phase');
    const number = box.querySelector<HTMLElement>('.update-progress-number');
    if (!state) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.phase = state.phase;
    if (phase) phase.textContent = PHASE_TEXT[state.phase];
    if (state.phase === 'download') {
      const total = state.total || 0;
      const percent = total > 0 ? Math.min(100, Math.round((state.downloaded / total) * 100)) : 0;
      box.dataset.indeterminate = String(total <= 0);
      if (fill) fill.style.width = total > 0 ? `${percent}%` : '';
      if (number) {
        number.textContent = total > 0
          ? `${percent}% · ${formatSize(state.downloaded)} / ${formatSize(total)}`
          : formatSize(state.downloaded);
      }
    } else {
      box.dataset.indeterminate = 'false';
      if (fill) fill.style.width = '100%';
      if (number) number.textContent = '';
    }
  }

  private openLink(url: string): void {
    openExternal(url);
  }

  private closeDialog(): void {
    this.overlay?.remove();
    this.overlay = undefined;
  }
}
