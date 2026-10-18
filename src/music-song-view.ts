import { musicPlatforms } from './music-platform';
import { fetchOnline } from './online-debug';
import type { MusicAlbum, MusicTrack, OnlineSongInfo, PlayMode } from './music-types';
import type { MusicPlayerState } from './music-player';
import { playModeNames } from './play-queue.ts';
import { escapeHtml as esc } from './html';
import { parseLyrics, lyricIndex, untimedLyrics, backfillLyrics, type LyricLine } from './music-lyrics';
import { SongTextReveal } from './song-text-reveal';
import { qualityTierOf, qualityTierLabels } from './quality-tier.ts';

const clock = (value: number) => {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const play = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
const pause = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
const previousArrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6"/></svg>';
const nextArrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const modeIcons: Record<PlayMode, string> = {
  order: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 12h12M4 18h8"/><path d="m17 15 3 3-3 3"/><path d="M20 18h-6"/></svg>',
  loop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  "repeat-one": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" text-anchor="middle" font-size="8">1</text></svg>',
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/></svg>',
 // 真随机：在洗牌图标上加一个 ∞ 表示可重复。
  "shuffle-all": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/><path d="M9 14c1.5 0 2-1 2-2s-.5-2-2-2"/><path d="M9 18c1.5 0 2-1 2-2s-.5-2-2-2"/></svg>',
};

type CachedSong = { info?: OnlineSongInfo; error?: string; at: number; lyricAt: number; lines: LyricLine[] };

/** DOM and lyric timing only. Audio, queue ownership and seeking stay with MusicPlayer. */
export class MusicSongView {
  private cache = new Map<string, CachedSong>();
  private pending = new Map<string, AbortController>();
  private epoch = 0;
  private disposed = false;
  private detailTrack?: MusicTrack;
  private state?: MusicPlayerState;
  private detailActive = false;
 /** Manual lyrics/details choice; blank-area clicks flip it. Undefined keeps the default. */
  private manualView?: 'lyrics' | 'details';
  private currentView: 'lyrics' | 'details' = 'details';
  private wasSelected = false;
  private paintedInfo?: CachedSong;
  private paintedRoot?: HTMLElement;
  private lyricKey = '';
  private lyricNode?: HTMLElement;
  private lyricEvents?: AbortController;
  private manualLyricsUntil = 0;
  private drag?: { input: HTMLInputElement; trackId: string };
  private reveal = new SongTextReveal();
  private lastReduced = false;

  constructor(private mini: HTMLElement, private seek: (seconds: number) => void, private reduced: () => boolean = () => false) {}

  markup(album: MusicAlbum) {
    const track = album.tracks[0];
    if (!track) return '';
    return `<section id="song-view" data-song="${esc(track.id)}">
      <div class="song-view-heading"><button type="button" data-action="song-toggle-play" id="song-toggle-play">${play}<span data-song-reveal>开始播放</span></button><div class="song-step-buttons"><button type="button" data-action="playing-prev" aria-label="上一首（详情）">${previousArrow}<span data-song-reveal>上一首</span></button><button type="button" data-action="playing-next" aria-label="下一首（详情）"><span data-song-reveal>下一首</span>${nextArrow}</button></div></div>
      <section id="song-info" aria-label="歌曲资料"><div id="song-online"></div><dl id="song-facts"></dl><p id="song-description" data-song-reveal></p><p id="song-metadata-error" data-song-reveal role="status"></p></section>
      <section id="song-lyric-view" aria-label="歌词" hidden><div id="song-lyrics" role="region" aria-label="同步歌词"></div>
        <div class="lyric-transport">
          <input class="playback-seek" type="range" min="0" max="1" value="0" step="0.1" aria-label="歌曲播放进度" disabled><div class="song-time"><span data-elapsed data-song-reveal>0:00</span><span data-duration data-song-reveal>${clock(track.duration)}</span></div>
          <div class="song-action-cluster"><button type="button" data-action="play-mode" id="play-mode-button" class="song-mode-button" title="播放模式"></button><button type="button" data-action="audio-effects" id="audio-effects-button" class="song-mode-button" title="音效"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="8" cy="17" r="1.8"/></svg></button><button type="button" data-action="download-song" id="download-button" class="song-mode-button" title="下载"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg></button><label class="song-volume" title="音量"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg><input class="volume-range" type="range" min="0" max="1" step="0.01" value="0.7" aria-label="音量大小"></label></div>
        </div></section><p id="song-view-error" data-song-reveal role="status"></p></section>`;
  }

  mount(album: MusicAlbum, state: MusicPlayerState, detailActive: boolean) {
    this.reveal.reset();
    this.detailTrack = album.tracks[0]; this.paintedInfo = undefined; this.lyricKey = '';
    this.manualView = undefined; this.currentView = 'details'; this.wasSelected = false;
    this.update(state, detailActive);
  }

  setVisible(visible: boolean) { this.reveal.setVisible(visible); }

  update(state: MusicPlayerState, detailActive: boolean) {
    if (this.disposed) return;
    const enteringDetail = detailActive && !this.detailActive;
    if (this.detailActive !== detailActive) this.lyricKey = '';
    if (this.drag && this.drag.trackId !== state.currentTrack?.id) this.drag = undefined;
    this.state = state; this.detailActive = detailActive;
    const active = !!state.currentTrack && !['idle', 'error'].includes(state.transport);
    const root = document.querySelector<HTMLElement>('#song-view');
    const detailTrack = this.detailTrack;
    if (root && detailTrack && detailTrack.id === root.dataset.song) {
      const selectedActive = active && state.currentTrack?.id === detailTrack.id;
      const info = detailTrack.onlineSource ? this.cache.get(`${detailTrack.onlineSource.provider}:${detailTrack.onlineSource.id}`) : undefined;
      let revealChanged = root !== this.paintedRoot || info !== this.paintedInfo;
      if (revealChanged) { this.paintInfo(root, detailTrack, info); this.paintedInfo = info; this.paintedRoot = root; }
      const button = root.querySelector<HTMLButtonElement>('#song-toggle-play')!;
 // One play/pause control: it only mutes and resumes audio. Playback state
 // and the now-playing display survive every press (no stop semantics).
      const playingThis = selectedActive && state.transport === 'playing';
      const label = playingThis ? '暂停播放' : selectedActive ? '继续播放' : '开始播放';
      if (button.dataset.label !== label) { button.innerHTML = `${playingThis ? pause : play}<span data-song-reveal>${label}</span>`; button.dataset.label = label; revealChanged = true; }
      button.setAttribute('aria-label', label);
      const modeButton = root.querySelector<HTMLButtonElement>('#play-mode-button');
      if (modeButton && modeButton.dataset.mode !== state.mode) {
        const modeName = playModeNames[state.mode];
        modeButton.dataset.mode = state.mode;
        modeButton.innerHTML = modeIcons[state.mode];
        modeButton.title = `播放模式：${modeName}（点击切换）`;
        modeButton.setAttribute('aria-label', `播放模式：${modeName}，点击切换`);
      }
      if (!root.dataset.viewToggle) {
        root.dataset.viewToggle = '1';
 // Blank-area clicks flip lyrics ⇄ song details; interactive children
 // (lyric lines, sliders, buttons) keep their own behavior.
        root.addEventListener('click', event => {
          if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [data-lyric-time]')) return;
          this.manualView = this.currentView === 'lyrics' ? 'details' : 'lyrics';
          if (this.state) this.update(this.state, this.detailActive);
        });
      }
      if (selectedActive && !this.wasSelected) this.manualView = undefined;
      this.wasSelected = selectedActive;
 // Lyrics vs. details is a manual choice; playback only supplies the
 // initial default (playing this song shows lyrics).
      const showLyrics = this.manualView ? this.manualView === 'lyrics' : selectedActive;
      this.currentView = showLyrics ? 'lyrics' : 'details';
      const viewChanged = root.querySelector<HTMLElement>('#song-info')!.hidden !== showLyrics;
      if (viewChanged) revealChanged = true;
      root.querySelector<HTMLElement>('#song-info')!.hidden = showLyrics;
      root.querySelector<HTMLElement>('#song-lyric-view')!.hidden = !showLyrics;
      const error = root.querySelector<HTMLElement>('#song-view-error')!, errorText = state.currentTrack?.id === detailTrack.id ? state.error || state.transitionWarning || '' : '';
      if (error.textContent !== errorText) { error.textContent = errorText; revealChanged = true; }
      const lyricContent = root.querySelector<HTMLElement>('#song-lyrics')!.dataset.content;
      if (showLyrics && detailActive && !root.closest('[hidden]')) this.paintLyrics(root.querySelector('#song-lyrics')!, info, state.currentTime, detailTrack);
      if (revealChanged || enteringDetail || lyricContent !== root.querySelector<HTMLElement>('#song-lyrics')!.dataset.content || this.lastReduced !== this.reduced()) {
        this.lastReduced = this.reduced(); this.reveal.refresh(root, this.lastReduced, enteringDetail || viewChanged);
      }
      if (detailTrack.onlineSource) this.ensure(detailTrack);
    }
    this.mini.hidden = !active || detailActive;
    this.mini.dataset.song = state.currentTrack?.id || '';
    if (active && state.currentTrack) {
      const track = state.currentTrack, cached = track.onlineSource ? this.cache.get(`${track.onlineSource.provider}:${track.onlineSource.id}`) : undefined;
      const index = cached ? lyricIndex(cached.lines, state.currentTime) : -1;
      const line = index >= 0 ? cached!.lines[index].text : cached?.info?.lyrics.instrumental ? '纯音乐' : '';
      const node = this.mini.querySelector<HTMLElement>('[data-mini-lyric]')!;
      if (node.textContent !== line) node.textContent = line;
      if (track.onlineSource) this.ensure(track);
    }
    for (const input of document.querySelectorAll<HTMLInputElement>('.playback-seek')) {
      const owner = input.closest<HTMLElement>('[data-song]');
      const matching = active && owner?.dataset.song === state.currentTrack?.id;
      input.disabled = !matching || state.loading || !Number.isFinite(state.duration) || state.duration <= 0;
      input.max = String(matching ? Math.max(1, state.duration || state.currentTrack?.duration || 1) : 1);
      if (!this.drag || this.drag.input !== input || this.drag.trackId !== state.currentTrack?.id) input.value = String(matching ? state.currentTime : 0);
      this.paintSeek(input);
      const group = input.parentElement!;
      const elapsed = group.querySelector<HTMLElement>('[data-elapsed]'), duration = group.querySelector<HTMLElement>('[data-duration]');
      if (elapsed) elapsed.textContent = clock(Number(input.value));
      if (duration) duration.textContent = clock(matching ? state.duration || state.currentTrack!.duration : 0);
    }
  }

  private paintSeek(input: HTMLInputElement) {
    const position = Math.max(0, Math.min(Number(input.max), Number(input.value)));
    input.style.setProperty('--progress', `${100 * position / Number(input.max)}%`);
    input.setAttribute('aria-valuetext', `${clock(position)} / ${clock(Number(input.max))}`);
  }
  previewSeek(input: HTMLInputElement) {
    const id = input.closest<HTMLElement>('[data-song]')?.dataset.song;
    if (!input.disabled && id && id === this.state?.currentTrack?.id) { this.drag = { input, trackId: id }; this.paintSeek(input); }
  }
  commitSeek(input: HTMLInputElement) {
    const id = input.closest<HTMLElement>('[data-song]')?.dataset.song;
    if (!input.disabled && id === this.state?.currentTrack?.id && (!this.drag || this.drag.trackId === id)) {
      const position = Math.min(this.state!.duration, Math.max(0, Number(input.value)));
      this.drag = undefined;
      if (Number.isFinite(position)) this.seek(position);
    } else this.drag = undefined;
  }
  cancelSeek() { this.drag = undefined; if (this.state) this.update(this.state, this.detailActive); }
 /** 详情区重画后的通知（music-app 用来回填 ♥ 的收藏态）。 */
  onPaint?: () => void;

  private paintInfo(root: HTMLElement, track: MusicTrack, cached?: CachedSong) {
    const info = cached?.info, source = track.onlineSource;
    this.paintOnline(root, track);
    const fields = [
      ['歌曲', info?.track.title || track.title], ['歌手', info?.track.artist || track.artist],
      ['专辑', info?.album.title || source?.albumTitle || '未提供'],
      ['发行日期', info?.album.published || (source?.publishTime ? new Date(source.publishTime).toISOString().slice(0, 10) : '未提供')],
      ['唱片公司', info?.album.company || '未提供'], ['时长', clock(info?.track.duration || track.duration)],
      ['来源', source ? musicPlatforms[source.provider] : "本地音乐"],
    ];
    root.querySelector('#song-facts')!.innerHTML = fields.map(([label, value]) => `<div><dt><span data-song-reveal>${esc(label)}</span></dt><dd><span data-song-reveal>${esc(value)}</span></dd></div>`).join('');
    root.querySelector('#song-description')!.textContent = info?.album.description || '';
    const error = root.querySelector<HTMLElement>('#song-metadata-error')!;
    error.textContent = cached?.error || info?.metadataError || '';
    this.onPaint?.();
  }
 /** 在线歌曲信息区：音质档位、原唱标识、别名小字、MV 按钮（只看不下载）。
 * 不显示来源徽标、不显示付费/试听标签、没有换源入口 —— 用户明确要求：
 * 「不需要标明付费歌曲，也不需要标明它的来源是什么」+「用户是不能自己换源的」。 */
  private paintOnline(root: HTMLElement, track: MusicTrack) {
    const online = root.querySelector<HTMLElement>('#song-online');
    if (!online) return;
    const source = track.onlineSource;
    if (!source) { online.innerHTML = ''; return; }
    const tier = qualityTierOf(track);
 // 不标注付费/试听，也不标注这首歌是从哪个源拿到的 —— 用户明确要求：
 // 「不需要标明付费歌曲，也不需要标明它的来源是什么，反正都是我自己听，
 // 它付不付费我都需要听，你都要给我放出来」。
 // 试听判定仍然保留（music-player 用它触发「去找全曲」），只是不再显示。
    const original = source.original ? '<span class="unified-song-original-tag">原唱</span>' : '';
    const alias = source.aliases?.length ? `<small class="unified-song-alias">${esc(source.aliases[0])}</small>` : '';
    const mv = source.mv ? `<button type="button" class="text-button" data-action="song-mv" aria-label="观看 ${esc(track.title)} 的 MV">MV</button>` : '';
 // 「加入歌单」：把这首歌存进本地歌单（对照参考行为 playlist.addSong）。
 // 付费/试听/来源一律不标注，但收藏动作照常可用 —— 用户要求「它付不付费我
 // 都需要听」，加歌单只是把自己要听的歌收起来，与付费状态无关。
    const add = `<button type="button" class="text-button" data-action="song-add-to-playlist" aria-label="把 ${esc(track.title)} 加入歌单">加入歌单</button>`;
 // 收藏（心形，固定样式）：一键收进本地「莱茵歌单」（对照参考行为的本地收藏）。
    const fav = `<button type="button" class="text-button song-favorite" data-action="song-favorite" data-favorite-song="${esc(track.id)}" aria-pressed="false" aria-label="收藏 ${esc(track.title)}">♥</button>`;
    online.innerHTML = `<div class="unified-song-badges"><span class="quality-tag quality-${tier}">${qualityTierLabels[tier]}</span>${original}</div>${alias}
      <div class="song-online-actions">${fav}${mv}${add}<a class="online-source-link" href="${esc(source.pageUrl)}" target="_blank" rel="noopener noreferrer">查看 ↗</a></div>`;
  }

  private paintLyrics(node: HTMLElement, cached: CachedSong | undefined, time: number, track: MusicTrack) {
    if (this.lyricNode !== node) {
      this.lyricEvents?.abort(); this.lyricEvents = new AbortController(); this.lyricNode = node;
      this.manualLyricsUntil = 0; this.lyricKey = '';
      const options = { signal: this.lyricEvents.signal, passive: true };
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) node.addEventListener(event, () => { this.manualLyricsUntil = Date.now() + 8000; }, options);
      node.addEventListener('click', event => {
        const line = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-lyric-time]');
        const state = this.state;
        if (!line || !node.contains(line) || state?.currentTrack?.id !== track.id || state.loading || ['idle', 'error'].includes(state.transport) || !(state.duration > 0)) return;
        const seconds = Number(line.dataset.lyricTime);
        if (!Number.isFinite(seconds)) return;
        this.manualLyricsUntil = 0; this.lyricKey = ''; this.seek(Math.min(state.duration, Math.max(0, seconds)));
      }, { signal: this.lyricEvents.signal });
    }
    const index = cached ? lyricIndex(cached.lines, time) : -1;
    const content = `${track.id}:${cached?.lyricAt || 0}`, key = `${content}:${index}`;
    const resume = this.manualLyricsUntil > 0 && Date.now() >= this.manualLyricsUntil;
    if (resume) this.manualLyricsUntil = 0;
    if (key === this.lyricKey && !resume && node.dataset.content === content) return;
    this.lyricKey = key;
    if (cached?.lines.length) {
      node.classList.remove('lyrics-untimed');
 // A bounded (parser limit: 4,000 lines) lyric document is built once per song.
 // Playback changes two classes; it never replaces the scrolling document.
      const rebuilt = node.dataset.content !== content;
      if (rebuilt) {
        node.innerHTML = cached.lines.map((line, position) => `<button type="button" class="lyric-line" data-lyric-index="${position}" data-lyric-time="${line.time}"><span data-song-reveal="entry">${esc(line.text)}</span>${line.translation ? `<small data-song-reveal="entry">${esc(line.translation)}</small>` : ''}</button>`).join('');
        node.dataset.content = content; this.manualLyricsUntil = 0;
      }
      const previous = node.querySelector<HTMLElement>('.current');
      const current = index < 0 ? null : node.children[index] as HTMLElement;
      if (previous !== current) {
        previous?.classList.remove('current'); previous?.removeAttribute('aria-current');
        current?.classList.add('current'); current?.setAttribute('aria-current', 'true');
      }
      if (current && !this.manualLyricsUntil) {
 // 丝滑跟随（用户要求）：行切换平滑滚动过渡；换歌重建文档的首定位仍瞬时，
 // 否则会从文档头一路扫到当前行。手动滚动（manualLyricsUntil）期间不干预。
        const top = current.offsetTop - node.clientHeight / 2 + current.offsetHeight / 2;
        const reduced = node.closest('.music-app')?.classList.contains('reduce-motion');
        if (rebuilt || reduced) node.scrollTop = top;
        else node.scrollTo({ top, behavior: 'smooth' });
      }
      return;
    }
    const lyric = cached?.info?.lyrics;
    const text = lyric?.instrumental ? '纯音乐' : lyric?.error || cached?.error ||
      (lyric?.original ? untimedLyrics(lyric.original) || '暂无歌词' : cached ? '暂无歌词' : track.onlineSource ? '正在读取歌词…' : '暂无歌词');
    if (node.dataset.content !== content) {
      node.innerHTML = text.split(/\r?\n/).slice(0, 4000).map(line => `<p data-song-reveal="entry">${esc(line) || ' '}</p>`).join('');
      node.dataset.content = content;
    }
    node.classList.toggle('lyrics-untimed', true);
  }
  private ensure(track: MusicTrack) {
    const source = track.onlineSource; if (!source || this.disposed) return;
    const id = `${source.provider}:${source.id}`;
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < (cached.error || cached.info?.lyrics.error || cached.info?.metadataError ? 30000 : 300000)) return;
    if (this.pending.has(id)) return;
    const wanted = new Set([this.detailTrack, this.state?.currentTrack].filter(item => item?.onlineSource).map(item => `${item!.onlineSource!.provider}:${item!.onlineSource!.id}`));
    for (const [other, controller] of this.pending) if (!wanted.has(other)) { controller.abort(); this.pending.delete(other); }
    if (this.pending.size >= 2) return;
    const epoch = this.epoch, controller = new AbortController(); this.pending.set(id, controller);
    void (async () => {
      try {
        const response = await fetchOnline(source.provider, 'songInfo', `/api/online/${source.provider}/songs/${encodeURIComponent(source.id)}/info`, { signal: controller.signal });
        let info = await response.json();
        if (!response.ok) throw new Error(info.error || '歌曲资料暂时不可用。');
        if (epoch !== this.epoch || controller.signal.aborted || this.disposed) return;
 // 歌词回填：本源无可用歌词（缺失/不可用/出错）时按 歌名+歌手+时长 跨源匹配。
        const own = info.lyrics;
        if (own && !own.instrumental && (!own.original || own.unavailable || own.error)) {
          const filled = await backfillLyrics(track, (url) => fetchOnline(source.provider, 'lyric', url, { signal: controller.signal })).catch(() => null);
          if (epoch !== this.epoch || controller.signal.aborted || this.disposed) return;
          if (filled) info = { ...info, lyrics: filled };
        }
        const previous = this.cache.get(id), lyrics = info.lyrics, prior = previous?.info?.lyrics;
        const sameLyrics = prior && prior.original === lyrics.original && prior.translated === lyrics.translated && prior.instrumental === lyrics.instrumental && prior.error === lyrics.error;
        const now = Date.now();
 // A metadata TTL refresh must not rebuild the same lyric document or
 // replay its entry masks while the user is listening / scrolling.
        this.cache.delete(id); this.cache.set(id, { info, at: now, lyricAt: sameLyrics ? previous!.lyricAt : now,
          lines: sameLyrics ? previous!.lines : lyrics.instrumental ? [] : parseLyrics(lyrics.original, lyrics.translated) });
      } catch (error) {
        if (epoch !== this.epoch || controller.signal.aborted || this.disposed) return;
        const message = (error as Error).message, previous = this.cache.get(id), now = Date.now();
        this.cache.set(id, { error: message, at: now, lyricAt: previous?.error === message ? previous.lyricAt : now, lines: [] });
      } finally {
        if (this.pending.get(id) === controller) this.pending.delete(id);
        while (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
        if (epoch === this.epoch && !this.disposed && this.state) this.update(this.state, this.detailActive);
      }
    })();
  }
  invalidate() {
    this.reveal.reset();
    this.epoch++; for (const controller of this.pending.values()) controller.abort();
    this.pending.clear(); this.cache.clear(); this.lyricKey = ''; this.paintedInfo = undefined; this.detailTrack = undefined;
    this.manualView = undefined; this.currentView = 'details'; this.wasSelected = false;
    this.lyricEvents?.abort(); this.lyricEvents = undefined; this.lyricNode = undefined; this.manualLyricsUntil = 0;
  }
  dispose() { this.disposed = true; this.invalidate(); }
}
