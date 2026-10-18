import type { MusicTrack, OnlineSearchResults } from "./music-types";
import { escapeHtml as esc } from "./html";
import "./online-music-search.css";
import { NeteaseLogin } from './netease-login';
import { musicPlatforms, type MusicProvider } from './music-platform';
import { fetchOnline } from './online-debug';
import { qualityBadges, qualityTierLabels } from './quality-tier.ts';
import { providerOrder, searchSourceNames, SEARCH_PAGE_SIZE, type SearchSource } from './online-search-core.ts';
import { MvPlayer } from './mv-player.ts';

/** 搜索平台页签 = 上游的 4 个搜索平台（网易云/QQ/酷我/酷狗），**没有「全部」**。
 * 顺序与文案全部取自 online-search-core（那边对齐了 exe 的 iC 数组）。 */
type SearchTab = Exclude<MusicProvider, 'bodian' | 'joox'>;
const tabNames: Record<SearchTab, string> = searchSourceNames;

/** 音质徽章的类名（与既有样式表一致）：
 * 容器 .unified-song-quality-badge
 * 单枚 .unified-song-quality-tag.is-quality-standard / .is-quality-hq /
 * .is-quality-sq / .is-quality-hires / .is-hires / .is-dolby / .is-master
 * 上游每次**固定先出一枚基础档位徽章**（标准 / HQ / SQ / Hi-Res），
 * 再按可用档位追加 杜比全景声(is-dolby) / 臻品母带(is-master) / 高阶(is-hires)，
 * 所以一行可以同时出现 2~3 枚。这里把 quality-tier.ts 的 7 级枚举映射到
 * 上面那套真实 kind 上（数据仍只来自 t10 的 qualityBadges()，不另建词表）。 */
const QUALITY_KIND: Record<string, string> = {
  standard: 'is-quality-standard',
  high: 'is-quality-hq',
  lossless: 'is-quality-sq',
  hires: 'is-quality-hires',
  hifi: 'is-hires',
  surround: 'is-dolby',
  master: 'is-master',
};

interface Row {
  key: string;
  track: MusicTrack;
  variants: MusicTrack[];
  variantsLoaded: boolean;
}

const normKey = (track: MusicTrack) =>
  `${track.title}|${track.artist}`.toLowerCase().replace(/[\s\u3000·・\-,.'"“”‘’()（）[\]]/g, '');

interface FetchResult { rows: Row[]; total: number; hasMore: boolean; sources: number; failure: string }

/** 上游式单平台搜索列表：平台页签、多枚音质徽章、原唱标签、只看 MV，
 * 以及每行的「序号 / 封面 / 标题+徽章 / 歌手 / 专辑 / 时长 / 下载」结构。 */
export class OnlineMusicSearch {
  private controller?: AbortController;
  private generation = 0;
  private rows: Row[] = [];
  private overrides = new Map<string, MusicTrack>();
  private query = "";
  private offset = 0;
 /** 默认平台 = 酷我。上游的 searchSource 初值就是 `useState("Kuwo")`
 * （`[gn,as]=m.useState("Kuwo")`），页签顺序才是 网易云/QQ/酷我/酷狗。 */
  private tab: SearchTab = 'kuwo';
  private sort: 'hot' | 'time' = 'hot';
  private container?: HTMLElement;
  private mv = new MvPlayer();
  private resultsHasMore = false;
  private total = 0;
  private statusMessage = '';
 /** 每次行重画后的通知（music-app 用来回填 ♥ 的收藏态）。 */
  onRender?: () => void;
  private playback: { id?: string; playing: boolean; loading: boolean } = { playing: false, loading: false };
  constructor(private play: (track: MusicTrack, queue: MusicTrack[]) => void, private login = new NeteaseLogin()) {}
  setLogin(login: NeteaseLogin) {
    if (this.login === login) return;
    this.dispose(); this.login = login; this.reset();
  }
  private reset() {
    this.rows = []; this.overrides.clear(); this.query = ''; this.offset = 0;
    this.statusMessage = ''; this.total = 0;
  }
  clear() {
    this.controller?.abort(); this.generation++; this.reset();
    if (this.container?.isConnected) {
      this.container.removeAttribute('aria-busy');
      this.container.querySelector<HTMLElement>('.online-search-status')!.textContent = '';
      this.container.querySelector<HTMLInputElement>('#online-search')!.value = '';
      this.render();
    }
  }
  setPlayback(id: string | undefined, playing: boolean, loading: boolean, force = false) {
    if (!force && this.playback.id === id && this.playback.playing === playing && this.playback.loading === loading) return;
    this.playback = { id, playing, loading };
    this.container?.querySelectorAll<HTMLButtonElement>('[data-online-track]').forEach(button => {
      const active = button.dataset.onlineTrack === id;
      button.setAttribute('aria-pressed', String(active && playing));
      button.querySelector('i')!.textContent = active && loading ? '…' : active && playing ? 'Ⅱ' : '▷';
      const track = this.effectiveTracks().find(track => track.id === button.dataset.onlineTrack);
      if (track) button.setAttribute('aria-label', `${active && playing ? '暂停' : '播放'} ${track.title}，${track.artist}`);
    });
  }
  dispose() {
    this.controller?.abort(); this.login.dispose(); this.generation++;
    this.container = undefined; this.mv.close();
  }
  mount(container: HTMLElement) {
    this.dispose(); this.container = container;
 // 平台页签 = 上游的 4 个搜索平台，**没有「全部」**。。
    const tabs = providerOrder.map(tab =>
      `<button type="button" role="tab" data-source-tab="${tab}" aria-selected="${this.tab === tab}">${tabNames[tab as SearchTab]}</button>`).join('');
 // 对齐上游 search-platform-row：平台切换行 + 人气/最新 排序切换只在搜出结果后出现。
    const order = `<div class="online-song-order" role="tablist" aria-label="歌曲排序"${this.query ? '' : ' hidden'}>
        <button type="button" role="tab" data-song-order="hot" aria-selected="${this.sort === 'hot'}">人气</button>
        <button type="button" role="tab" data-song-order="time" aria-selected="${this.sort === 'time'}">最新</button>
      </div>`;
    container.innerHTML = `<form class="online-search-form"><input id="online-search" class="album-search" type="search" maxlength="100" value="${esc(this.query)}" placeholder="搜索歌曲、歌手或专辑…" aria-label="搜索歌曲" required><button class="primary-button" type="submit">搜索 ↗</button></form><div class="online-platform-row"><div class="online-source-tabs" role="tablist" aria-label="音乐平台"${this.query ? '' : ' hidden'}>${tabs}</div>${order}</div><p class="online-search-status" role="status" aria-live="polite"></p><div class="online-search-results"></div><div class="online-search-pages"></div>`;
 // 搜索页不再放网易云扫码登录块（用户要求移除）：登录走设置页的平台登录，
 // 搜索框上方保持干净，和上游的搜索页一致。
    container.querySelector("form")!.addEventListener("submit", event => {
      event.preventDefault(); const keyword = container.querySelector<HTMLInputElement>("input")!.value.trim();
      if (keyword) void this.search(keyword, 0);
    });
    container.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!button) return;
      if (button.dataset.sourceTab) {
        this.tab = button.dataset.sourceTab as SearchTab;
        if (this.query) void this.search(this.query, 0); else this.render();
        return;
      }
      if (button.dataset.songOrder) {
 // 排序：只换排序重画当前这批结果，不重新请求。
        this.sort = button.dataset.songOrder === 'time' ? 'time' : 'hot';
        this.render();
        return;
      }
      if (button.dataset.onlinePage !== undefined) void this.search(this.query, Number(button.dataset.onlinePage));
      if (button.dataset.onlineRetry !== undefined) void this.search(this.query, this.offset);
      if (button.dataset.mv !== undefined) void this.openMv(button.dataset.mv);
      if (button.dataset.onlineTrack) {
        const track = this.effectiveTracks().find(track => track.id === button.dataset.onlineTrack);
        if (track) this.play(track, this.effectiveTracks());
      }
    });
    this.render();
  }
 /** 当前这批结果、按**显示顺序**（人气/最新）展开成曲目 —— 播放队列和
 * 「下一首」必须跟着用户看到的顺序走，和上游一致。 */
  private effectiveTracks(): MusicTrack[] {
    return this.ordered().map(row => this.overrides.get(row.key) ?? row.track);
  }
  private rowOf(key: string | undefined): Row | undefined {
    return this.rows.find(row => row.key === key);
  }
  trackOf(key: string | undefined): MusicTrack | undefined {
    const row = this.rowOf(key); if (!row) return undefined;
    return this.overrides.get(row.key) ?? row.track;
  }
  private statusText(): string {
    if (!this.rows.length) return this.statusMessage || '没有找到歌曲。';
    const page = this.offset / SEARCH_PAGE_SIZE + 1;
    const base = `找到 ${this.total} 首歌曲 · 第 ${page} 页`;
    return this.statusMessage ? `${base} · ${this.statusMessage}` : base;
  }
 /** 显示顺序 —— 对齐上游 Ot 的比较器：
 * hot → 按 popularity 降序（平台不给 popularity 时全部为 0，退化成原序）
 * time → 按 publishedAt 降序
 * 两者都以**原始下标**为最后一级 tie-break ⇒ 同分时就是**平台原序**。
 * 既有实现：sort((a,b)=>{ if(gt==="time"){…} else {…} return a.index-b.index })
 *
 * popularity 目前不在 MusicTrack.onlineSource 的类型声明里（各平台是否上报由
 * 后端的数据解析负责），所以这里**防御式读取**：字段缺失就按 0 处理，
 * 排序自然退化成上游式的「平台原序」。 */
  private ordered(): Row[] {
    const value = (track: MusicTrack) =>
      this.sort === 'time'
        ? (track.onlineSource?.publishTime ?? 0)
        : (Number((track.onlineSource as { popularity?: unknown } | undefined)?.popularity) || 0);
    return this.rows
      .map((row, index) => ({ row, index, score: value(row.track) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.row);
  }
  private render() {
    const container = this.container;
    if (!container?.isConnected) return;
    const results = container.querySelector<HTMLElement>(".online-search-results")!;
    const pages = container.querySelector<HTMLElement>(".online-search-pages")!;
    const status = container.querySelector<HTMLElement>(".online-search-status")!;
    container.querySelectorAll<HTMLButtonElement>('[data-source-tab]').forEach(button =>
      button.setAttribute('aria-selected', String(button.dataset.sourceTab === this.tab)));
    container.querySelectorAll<HTMLButtonElement>('[data-song-order]').forEach(button =>
      button.setAttribute('aria-selected', String(button.dataset.songOrder === this.sort)));
    container.querySelector<HTMLElement>('.online-song-order')?.classList.toggle('is-time-active', this.sort === 'time');
 // 对齐上游 search-platform-row：只有搜索过、有查询词时才显示平台切换行。
    const tabs = container.querySelector<HTMLElement>('.online-source-tabs');
    if (tabs) tabs.hidden = !this.query;
    const order = container.querySelector<HTMLElement>('.online-song-order');
    if (order) order.hidden = !this.query;
    if (!this.rows.length && !this.query) { results.innerHTML = '<div class="no-results"></div>'; pages.innerHTML = ""; return; }
    status.textContent = this.statusText();
    const shown = this.ordered();
 // 序号 = 列表里的显示位置（序号两位补零）。
    results.innerHTML = shown.length
      ? shown.map((row, index) => this.renderRow(row, index)).join("")
      : '<div class="no-results">没有找到歌曲。</div>';
    const more = this.resultsHasMore;
    pages.innerHTML = `${this.offset ? `<button data-online-page="${Math.max(0, this.offset - SEARCH_PAGE_SIZE)}">← 上一页</button>` : ""}${more && this.offset < 1000 ? `<button data-online-page="${this.offset + SEARCH_PAGE_SIZE}">下一页 →</button>` : ""}`;
    this.setPlayback(this.playback.id, this.playback.playing, this.playback.loading, true);
    this.onRender?.();
  }
 /** 行结构对齐上游 unified-song-row：
 * [序号] [封面] [标题 + 原唱/MV/多枚音质徽章 · 歌手] [专辑名] [时长] [下载]
 * 上游的 grid 是 38px 28px 42px minmax(180px,1.5fr) minmax(130px,1fr) 64px 68px，
 * 我们少一列（收藏心形并进标题行），所以列数按实际 DOM 定。
 * 音质徽章用 quality-tier.ts 的 qualityBadges()：上游一行可同时出现多枚
 * （例：母带 + HiFi + 5.1），class 用真实类名 is-quality-* / is-master /
 * is-dolby / is-hires。 */
  private renderRow(row: Row, index: number): string {
    const track = this.overrides.get(row.key) ?? row.track;
    const source = track.onlineSource!;
    const cover = source.coverUrl ? `<img class="unified-song-cover" src="${esc(source.coverUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="unified-song-cover unified-song-cover-empty" aria-hidden="true">♪</span>';
    const original = source.original ? '<span class="unified-song-original-tag">原唱</span>' : '';
    const alias = source.aliases?.length ? `<small class="unified-song-alias">${esc(source.aliases[0])}</small>` : '';
    const mv = source.mv ? `<button type="button" class="text-button unified-song-mv" data-mv="${esc(row.key)}" aria-label="观看 ${esc(track.title)} 的 MV">MV</button>` : '';
    const badges = qualityBadges(track)
      .map(tier => `<span class="unified-song-quality-tag ${QUALITY_KIND[tier] ?? 'is-quality-standard'}">${qualityTierLabels[tier]}</span>`)
      .join('');
    const album = source.albumTitle || '未知专辑';
 // 用户明确要求：不标付费、不标来源 ——「它付不付费我都需要听，你都要给我放出来」。
 // 所以行内只留音质徽章与 MV（音质是用户点名要的），去掉 source-badge 与 fee-tag。
    return `<div class="unified-song" data-row="${esc(row.key)}">
      <span class="unified-song-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      ${cover}
      <div class="unified-song-copy">
        <div class="unified-song-title-line"><strong title="${esc(track.title)}">${esc(track.title)}</strong>${original}${mv}<span class="unified-song-quality-badge">${badges}</span></div>
        <div class="unified-song-artist-line"><span class="unified-song-artist" title="${esc(track.artist)}">${esc(track.artist)}</span>${alias}<button type="button" class="text-button song-favorite" data-action="song-favorite" data-favorite-song="${esc(track.id)}" data-favorite-row="${esc(row.key)}" aria-pressed="false" aria-label="收藏 ${esc(track.title)}">♥</button></div>
      </div>
      <div class="unified-song-album" title="${esc(album)}">${esc(album)}</div>
      <div class="unified-song-duration">${durationText(track.duration)}</div>
      <div class="unified-song-actions"><button type="button" class="unified-song-play" data-online-track="${esc(track.id)}" aria-pressed="false" aria-label="播放 ${esc(track.title)}，${esc(track.artist)}"><i>▷</i></button><a class="unified-song-view" href="${esc(source.pageUrl)}" target="_blank" rel="noopener noreferrer" aria-label="查看 ${esc(track.title)} 来源页">查看</a></div>
    </div>`;
  }
  private async openMv(key: string) {
    const container = this.container;
    const track = this.trackOf(key);
    const mv = track?.onlineSource?.mv;
    if (!container?.isConnected || !track || !mv) return;
    const status = container.querySelector<HTMLElement>(".online-search-status")!;
    try {
      let src = mv.url || '';
      if (!src && mv.id) {
        status.textContent = '正在获取 MV 地址…';
        const provider = track.onlineSource!.provider;
        const response = await fetchOnline(provider, 'mv', `/api/online/${provider}/mv/${encodeURIComponent(mv.id)}`);
        const value = await response.json() as { url?: string; error?: string };
        if (!response.ok || !value.url) throw new Error(value.error || '这个 MV 暂时无法在线观看。');
        src = value.url;
      }
      if (!src) throw new Error('这个 MV 暂时无法在线观看。');
      this.mv.open({ title: track.title, artist: track.artist, src });
      status.textContent = '';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'MV 加载失败，可能是网络或音源限制。';
    }
  }
  private async search(query: string, offset: number) {
    this.controller?.abort(); const controller = this.controller = new AbortController();
    const generation = ++this.generation; this.query = query; this.offset = offset;
    const container = this.container; if (!container) return;
    const status = container.querySelector<HTMLElement>(".online-search-status")!;
 // 上游一次只搜一个平台，没有「全部」聚合。
    status.textContent = `正在搜索${musicPlatforms[this.tab]}…`; container.setAttribute("aria-busy", "true");
    container.querySelectorAll<HTMLButtonElement>("[data-online-page], [data-online-track], [data-mv]").forEach(button => button.disabled = true);
    try {
      const fetched = await this.fetchSingle(this.tab, query, offset, controller.signal);
      if (controller.signal.aborted || generation !== this.generation || !container.isConnected) return;
      this.rows = fetched.rows; this.overrides.clear();
      this.total = fetched.total; this.resultsHasMore = fetched.hasMore;
      this.statusMessage = fetched.failure;
      this.render();
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || !container.isConnected) return;
      this.rows = []; this.overrides.clear();
      status.textContent = error instanceof Error ? error.message : "搜索失败，请检查网络后重试。";
      container.querySelector(".online-search-results")!.innerHTML = '<div class="no-results"><button class="text-button" data-online-retry>重新搜索 ↻</button></div>';
      container.querySelector(".online-search-pages")!.innerHTML = "";
    } finally {
      if (generation === this.generation && container.isConnected) container.removeAttribute("aria-busy");
    }
  }
 /** 把平台返回的原始数组折成一行一首。
 * **不做自定义排序** —— 上游显示的就是平台原序（顺序只在 ordered() 里按
 * 人气/最新 重排，同分回落原始下标）。原来的 rank()（相关度→去翻唱→音质
 * 降序）连同 coverPattern 词表一起删掉了：上游没有这套词表，实测也没有
 * 任何「伴奏/翻唱/remix」过滤。去重只用于折叠「同一首歌的多个版本」，
 * 让单曲换源时有变体可切，不改变行的先后。 */
  private merge(tracks: MusicTrack[]): Row[] {
 // 单平台页签同样需要变体（换源用），所以 variantsLoaded 恒为 true。
    const variantsLoaded = true;
    const rows: Row[] = [], byKey = new Map<string, Row>();
    for (const track of tracks) {
      const key = normKey(track);
      const existing = byKey.get(key);
      if (existing) existing.variants.push(track);
      else {
        const row: Row = { key: `${track.onlineSource!.provider}_${track.onlineSource!.id}`, track, variants: [], variantsLoaded };
        byKey.set(key, row); rows.push(row);
      }
    }
    return rows;
  }

  private async fetchSingle(provider: MusicProvider, query: string, offset: number, signal: AbortSignal): Promise<FetchResult> {
    const response = await fetchOnline(provider, 'search', `/api/online/${provider}/search?q=${encodeURIComponent(query)}&offset=${offset}`, { signal });
    const value = await response.json() as OnlineSearchResults & { error?: string };
    if (!response.ok) throw new Error(value.error || `${musicPlatforms[provider]}搜索暂时不可用。`);
    if (value.provider !== provider) throw new Error('搜索平台已变化，请重新搜索。');
    return { rows: this.merge(value.tracks), total: value.total, hasMore: value.hasMore, sources: 1, failure: '' };
  }
}

/** 时长列：时长格式化 = `${floor(s/60)}:${s%60}` 两位补零（`mm:ss`）。 */
function durationText(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function cssEscape(value: string): string {
  return (window as unknown as { CSS?: { escape(value: string): string } }).CSS?.escape?.(value) ?? value.replace(/["\\]/g, '\\$&');
}
