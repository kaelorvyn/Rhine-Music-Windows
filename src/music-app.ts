import { setupTransportTitle } from "./music-transport-title";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./music-overview.css";
import "./music-shell.css";
import './music-song-view.css';
import './online-debug.css';
// 全局滚动条放在最后引入：它的 ::-webkit-scrollbar 规则要压过各组件文件里的零散写法。
import './scrollbar.css';
// 原生 select 展开层的圆角（appearance: base-select），不支持的旧内核自动跳过。
import './ui-select.css';
import { fetchOnline, mountOnlineDebug, onlineErrorReport } from './online-debug';
import { MusicVisualizer, normalizeVisualizer, visualizerMarkup, type VisualizerOptions } from "./music-visualizer";
import { settingsCategories, settingsNavigation, groupSettingsContent, selectSettingsCategory, filterSettings, type SettingsCategory } from './music-settings';
import { buildMusicFeedback, feedbackMarkup } from './music-feedback';
import { clearAudioCache, clearPoolCredential, importPoolCredential, openFeedbackDraft, poolCredentialExportUrl, poolQrImageUrl, pollPoolQrLogin, readAudioCacheUsage, readPoolCredential, startPoolQrLogin as startPoolQrLoginApi, syncCacheSettings, syncTrayPreference } from './desktop';
import { version as appVersion } from "../package.json";
import { MusicOverviewUI } from "./music-overview-ui";
import { MusicSongView } from './music-song-view';
import { loadSavedPlayback, saveSavedPlayback, playModeNames, nextPlayMode, playModes } from './play-queue.ts';
import { findFallbackTrack, findPlayableVariant, resolveLookupOrder } from './source-fallback.ts';
import { loadEffectsConfig, saveEffectsConfig } from './audio-effects.ts';
import { AudioEffectsPanel } from './audio-effects-panel.ts';
import { DownloadPanel, type DownloadOption } from './download-panel.ts';
import { qualityTierWeight, type QualityTier } from './quality-tier.ts';
import { normalizeMusicArrayMode, type MusicArrayMode } from "./music-array-layout";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { automaticQuality, initialQualityMode, type QualityMode } from './automatic-quality';
import { ArchiveScene } from "./scene";
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  setPlaybackAlbums,
  setPlaylistAlbums,
  orderMusicAlbums,
  type MusicSortMode,
} from "./data";
import { fileAtCell, nearestOccurrence, wrap, MUSIC_LOOP_ROWS, type ArchiveNavigation } from "./archive-loop";
import { playbackAlbums } from './playback-albums';
import {
  normalizeQuality,
  initialDesktopQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { MusicPlayer, type MusicPlayerState } from "./music-player";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  MusicTrack,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { setupPlaylistSongBars } from './playlist-song-bars';
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { MusicEntry } from "./music-entry";
import { MusicFrameTiming } from "./music-frame-timing";
import { searchMusicLibrary } from "./music-search";
import { OnlineMusicSearch } from "./online-music-search";
import { lookupVariants, normKey, artistMembers, titleParts } from "./online-search-core";
import { MvPlayer } from "./mv-player";
import { UpdateCenter } from "./update-center";
import { NeteaseLogin, type NeteaseAccount } from "./netease-login";
import { localPlaylistName, musicPlatforms, musicProvider, playlistSourceName, type MusicProvider, type PlaylistSource } from "./music-platform";
import { NeteasePlaylists } from './netease-playlists';
import { LocalPlaylists, trackToLocalSong, localSortKeys, type LocalPlaylistSummary, type LocalSortKey } from './local-playlists';
import { viewportLayout } from "./viewport-layout";
import { setupLightingLab } from "./music-lighting-lab";
import type { LightingLabController, LightingLabSettings } from "./music-lighting-lab";
import { setupMotionLab } from "./music-motion-lab";
import { getMusicMotionSpeed, normalizeMusicMotionSpeed, onMusicMotionSpeedChange, setMusicMotionSpeed } from "./music-motion-settings";
import { mountMusicWheelNavigation } from "./music-wheel-navigation";
import { isDesktop, openExternal } from "./desktop";
import { RenderScheduler } from "./render-scheduler";
import {
  FRAME_RATE_MIN, FRAME_RATE_MAX, FRAME_RATE_UNLIMITED,
  frameRateFromSlider, sliderFromFrameRate, frameRateLabel, normalizeFrameRate,
} from "./frame-rate";

// A repeatable visual study that uses only the three bundled sample covers.
const lightingDemo = new URLSearchParams(location.search).get("demo") === "1";
const lightingLab = new URLSearchParams(location.search).get("lab") !== "0";
let lightingControls: LightingLabController | undefined;
let motionControls: ReturnType<typeof setupMotionLab> | undefined;

type Theme = "day" | "night" | "dusk";
type Panel = "library" | "search" | "settings" | "netease-login" | "playlists" | null;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
 // 设置：齿轮（螺母）形状。原来画的是「两条横线 + 两个滑块」，那是调节/混音器
 // 的图标，用户认为它不像设置。这里换成标准的八齿齿轮 + 中心圆，描边与
 // icons 其余图标同源（svg() 统一 1.5 描边）。
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>',
  ),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
 // 默认头像小人：字形 bbox（含 1.5 描边）精确居中于 24 视区
 // （上移 0.5，修正字形整体偏低、各尺寸可见的不对称留白）。
  account: svg('<circle cx="12" cy="7.5" r="4"/><path d="M4 20.5v-2a8 8 0 0 1 16 0v2"/>'),
};
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    arrayMode: "filled" as MusicArrayMode,
    rememberColumnPosition: true,
    audioBackend: "browser" as "browser" | "coreaudio",
    outputDeviceId: "default",
    quality: (isDesktop() ? "balanced" : "original") as QualityPreset,
    qualityPipelineVersion: 0,
    qualityMode: undefined as QualityMode | undefined,
    reduced: false,
 // 界面帧率上限：默认 60（与既有渲染调度的交互帧率一致，不改变老用户观感）。
 // 用户可在设置里 24~180 任意调，181 = 无限制。
  frameRate: 60,
    volume: 0.65,
 // Leave unset until legacy preferences have been read; a default here
 // would otherwise take precedence over the user's old fade-off choice.
    songTransition: undefined as SongTransitionMode | undefined,
    bgm: true,
    bgmVolume: 0.18,
    sound: true,
    soundVolume: 0.22,
    renderQuality: undefined as RenderQuality | undefined,
    onlineErrorDisplay: false,
    developerMode: false,
    motionDebug: false,
    motionSpeed: 1,
    lighting: undefined as Partial<LightingLabSettings> | undefined,
    avatar: undefined as string | undefined,
 // 歌单内歌曲排序（对照参考行为 playlist.sort.*）：默认 / 添加时间 / 艺术家 /
 // 播放次数 / 名称 / 平台 / 最高音质，配 asc/desc。
    playlistSort: 'default' as LocalSortKey,
    playlistSortDirection: 'ascending' as 'ascending' | 'descending',
 // ── 以下设置面板新增项 的新增项 ──────────────────────────────
    uiScale: 100,
    autoplay: false,
    cacheLimit: 2048,
    cacheLocation: '',
    minimizeToTray: true,
    // 音浪：默认开、进度条上方、细柱频谱（与预览版默认一致）。
    visualizer: normalizeVisualizer(undefined),
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      arrayMode: MusicArrayMode;
      rememberColumnPosition: boolean;
      audioBackend: "browser" | "coreaudio";
      outputDeviceId: string;
      quality: QualityPreset;
      qualityPipelineVersion: number;
      qualityMode: QualityMode;
      reduced: boolean;
      volume: number;
      songTransition: SongTransitionMode;
      songFade: boolean;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      renderQuality: RenderQuality;
      onlineErrorDisplay: boolean;
      developerMode: boolean;
      motionDebug: boolean;
      motionSpeed: number;
 /** 界面帧率上限（fps）；0 = 无限制（跟随显示器刷新率）。 */
      frameRate: number;
      lighting: Partial<LightingLabSettings>;
      avatar: string;
      playlistSort: LocalSortKey;
      playlistSortDirection: 'ascending' | 'descending';
      uiScale: number;
      autoplay: boolean;
      cacheLimit: number;
      cacheLocation: string;
      minimizeToTray: boolean;
      visualizer: VisualizerOptions;
    }>
  >("rhine-music-preferences", {}),
};
preferences.onlineErrorDisplay = preferences.onlineErrorDisplay === true;
preferences.songTransition = normalizeSongTransition(preferences.songTransition, preferences.songFade);
delete preferences.songFade;
const initialQuality = initialDesktopQuality(preferences, isDesktop());
let renderQuality = initialQuality.quality;
preferences.qualityMode = initialQualityMode(preferences.qualityMode, renderQuality, isDesktop());
let automaticProfile: ReturnType<typeof automaticQuality> | undefined;
// Per-session comparison/debug control: resetting a preview starts optimized.
let glassOcclusionMode: "on" | "off" | "debug" = "on";
if (isDesktop() && preferences.qualityPipelineVersion !== 5) {
  if (initialQuality.migrated) preferences.quality = "balanced";
  preferences.renderQuality = renderQuality;
  preferences.qualityPipelineVersion = 5;
  save("rhine-music-preferences", preferences);
}
if (!["day", "night", "dusk"].includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhine-music-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
preferences.developerMode = preferences.developerMode === true;
preferences.motionDebug = preferences.motionDebug === true;
preferences.arrayMode = normalizeMusicArrayMode(preferences.arrayMode);
preferences.rememberColumnPosition = preferences.rememberColumnPosition !== false;
preferences.audioBackend = !isDesktop() && preferences.audioBackend === "coreaudio" ? "coreaudio" : "browser";
if (typeof preferences.outputDeviceId !== "string") preferences.outputDeviceId = "default";
preferences.motionSpeed = normalizeMusicMotionSpeed(preferences.motionSpeed);
// 帧率：清洗存量/脏值（0 或缺失 = 无限制；小于 24 的抬到 24）。
preferences.frameRate = normalizeFrameRate(preferences.frameRate);
setMusicMotionSpeed(preferences.motionSpeed);
const syncMotionScale = () => document.documentElement.style.setProperty("--music-motion-scale", String(1 / getMusicMotionSpeed()));
syncMotionScale();
onMusicMotionSpeedChange(syncMotionScale);
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
const sortLabel = sortLabels[preferences.sortMode];
let libraryReceived = false,
  scanSubmitting = false;

let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: false,
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
let browseLibraryDuringPlayback = false;
let accountActive = false, accountView = false, accountKey = '';
/** 歌单数据是否已引导过一次（本地歌单不依赖登录，启动时也要读）。 */
let bootedPlaylists = false;
let activeProvider = musicProvider(read('rhine-online-provider', 'netease'));
let loginProvider: MusicProvider = activeProvider;
let playlistPlaybackId: string | undefined, followedPlaylistTrack: string | undefined;
let playlistSelectionEpoch = 0, playlistRenderTimer: ReturnType<typeof setTimeout> | undefined;
let playlistNavigationTarget: { row: number; song: number; cell: { lane: number; row: number } } | undefined;
let playbackBrowseTrackId: string | undefined;
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
let scene: ArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";
let creditsStarting = false,
  creditsRequestError = "",
  creditsRequestAlbumId: string | undefined;
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
// 开场动画的看门狗定时器（见 start()）：帧循环停摆时强制收尾，别卡住界面。
let bootDoneWatchdog: number | undefined;
let overview = false;
let overviewRevealPending = false;
let playlistOverviewRequested = false;
const effects = new TerminalAudio();
effects.configure({
  sound: preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let columnMemory = new Map<string, string>();
let playerState: MusicPlayerState;
let outputBusy = false;
let audioOutputsChecked = false;
let outputStatus = "正在检查本机音频输出…";
const player = new MusicPlayer({
  volume: preferences.volume,
  songTransitionMode: preferences.songTransition,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
});
// Restore the temporary queue and its mode across restarts (never auto-plays).
const savedPlayback = loadSavedPlayback();
if (savedPlayback) {
  player.setMode(savedPlayback.mode);
  if (savedPlayback.tracks.length) player.setQueue(savedPlayback.tracks);
}
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  night: "深夜",
  dusk: "蓝灰",
};
const stage = $("#stage");
stage.className = "music-app";
stage.dataset.mode = "archive";
stage.dataset.theme = preferences.theme;
// 界面缩放在 DOM 就绪前就要生效，避免开场闪一下默认比例。
document.documentElement.style.setProperty('--music-ui-scale', String(preferences.uiScale / 100));
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><div class="music-brand" aria-label="Rhine Music 音乐库"><strong>RHINE LAB</strong><span>MUSIC ARCHIVE <i>／</i> 私人音乐终端</span></div></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>
      <button data-action="playlists" id="my-playlists-button" hidden aria-label="歌单">${icons.folder}<span>歌单</span></button>
      <span class="nav-platform-picker" id="playlist-platform-picker" hidden><button type="button" class="nav-platform-trigger" id="playlist-platform" aria-haspopup="listbox" aria-expanded="false" aria-label="歌单来源">全部 <i aria-hidden="true">▾</i></button><div class="nav-platform-menu" id="playlist-platform-menu" role="listbox" aria-label="歌单来源" hidden></div></span>
      <button data-action="settings" class="icon-button" aria-label="设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><button type="button" data-action="locate-playing" id="transport-track" class="transport-track" aria-label="定位当前歌曲" aria-hidden="true" disabled><span id="transport-track-label"></span></button><button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button><div class="mini-playback-below" id="mini-playback-below" data-song="" hidden><span data-mini-lyric></span><input class="playback-seek" type="range" min="0" max="1" value="0" step="0.1" aria-label="歌曲播放进度" disabled></div></div>
      <button data-action="netease-login" id="netease-login-button" data-auth="out" aria-label="账号（未登录），打开登录面板"><span class="account-avatar" id="account-avatar"></span></button>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>正在读取本地音乐索引</span></div>
  <button type="button" class="music-view-toggle" disabled data-action="overview" aria-pressed="false" aria-label="切换我的歌单">${svg('<rect x="3" y="3" width="6" height="7"/><rect x="15" y="3" width="6" height="7"/><rect x="3" y="14" width="6" height="7"/><rect x="15" y="14" width="6" height="7"/>')}<span>我的歌单</span></button>
  <section class="music-overview" id="music-overview" aria-label="音乐库缩略图总览" hidden>
    <div class="overview-heading"><small>COLLECTION / OVERVIEW</small><h2>${sortLabel.name}浏览收藏</h2></div>
    <div class="overview-columns" id="overview-columns"></div>
    <button type="button" class="overview-return" data-action="overview-return" aria-label="返回标准视图">${svg('<path d="M15 5l-7 7 7 7"/>')}<span>返回近景</span></button>
    <nav class="overview-controls" aria-label="总览列导航"><button data-action="genre-prev" aria-label="总览上一列">←</button><button data-action="genre-next" aria-label="总览下一列">→</button></nav>
  </section>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览" tabindex="-1">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code">ALBUM <span id="selection-code-number">001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open">打开专辑 <span>↗</span></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><div id="playlist-song-bars" hidden></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${sortLabel.column}">←</button><div><small id="genre-position">${sortLabel.code} <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${sortLabel.column}">→</button></div>
    </div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架</button>
    <div class="card-caption"><span id="detail-card-id"></span></div>
    <article id="album-detail-content" tabindex="-1"></article>
  </section>
  <div class="music-bottomline"><span>LOCAL COLLECTION <i>·</i> <span id="library-count">0 ALBUMS</span></span><span id="runtime-info">THREE.JS / LOCAL / V${appVersion}</span></div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading" hidden></div>
`;
// 进入应用的整套动画：与预览版同一份实现（开机胶片 / 状态行 / 跳过 / 失败重试）。
// 减少动态效果时整段不创建，加载页退化成一句状态文案。
const entry = preferences.reduced ? undefined : new MusicEntry(stage);
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
const playlistSongBars = setupPlaylistSongBars($('#playlist-song-bars'), {
  enabled: () => ready && accountView && !boot?.active && presentation.phase === 'archive' && !panel,
  select: song => {
    const cell = currentAlbum()?.playlistCell;
    if (cell) void navigatePlaylist(cell.playlistIndex, song);
  },
  step: stepAlbum,
  cachedTitle: (id, song) => {
    if (!accountActive || !accountView) return undefined;
    const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === id);
    return row < 0 ? undefined : playlistLibrary.track(row, song)?.title;
  },
  prefetch: (id, first, last) => {
    if (!accountActive || !accountView) return;
    const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === id);
    if (row >= 0) playlistLibrary.prefetchTitles(row, first, last);
  },
  title: async (id, song) => {
    const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === id);
    if (row < 0 || !accountActive || !accountView) throw new Error('歌单已切换');
    if (!playlistLibrary.track(row, song)) await playlistLibrary.ensure(row, song, true);
    if (!accountActive || !accountView || playlistLibrary.playlists[row]?.id !== id) throw new Error('歌单已切换');
    return playlistLibrary.track(row, song)?.title || `第 ${song + 1} 首 · 歌曲信息不可用`;
  },
});
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
 // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

const onlineDebug = mountOnlineDebug(document.querySelector<HTMLElement>('#stage')!, `${appVersion}-preview`, preferences.onlineErrorDisplay);

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  return albums.find((a) => a.id === records[selected]?.id);
}
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
 // 用户要求：封面一进列表就下，不排「进视口才加载」的队。
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面">`
    : `<span class="cover-placeholder">♪</span>`;
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-overline > span, .detail-artist, .album-facts small, .album-facts span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
 // Keep the existing reveal timing, but fade each overlay in its own layer.
 // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation")],
);
const overviewUI = new MusicOverviewUI($("#music-overview"), $("#overview-columns"), () => {
  const target = overview ? $(".overview-return") : $('[data-action="overview"]');
  target.focus({ preventScroll: true });
}, (lane, first) => void loadOverviewPlaylist(lane, first));
let detailIdentity = "",
  pendingDetailFocus = false;
const trackFocus = new MusicTrackFocus();
let pendingTrackReveal: { albumId: string; trackId: string } | undefined;
function cancelTrackReveal() {
  pendingTrackReveal = undefined;
  trackFocus.cancel();
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingTrackReveal) cancelTrackReveal();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => !!scene?.musicArchiveReady && scene.musicOverviewProgress < .02,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation }) => commitSelection(index, navigation),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    if (next === "detail" && overview) setOverview(false, false);
    mode = next;
    stage.dataset.mode = next;
    updateSongTransport();
    syncSelectionMotion();
  },
  prepareMenu: () => {
    songView.setVisible(false);
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    const detail = $("#music-detail"), content = $("#album-detail-content");
    detailTransition.show(preferences.reduced);
    updateSongTransport();
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    songView.setVisible(false);
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  onStart: () => {
    setOverview(false, false);
    cancelTrackReveal();
    presentation.reset();
    syncAlbumNavigation();
    detailTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
 // 动画正常收尾，撤掉看门狗，避免它在 20 s 后再补一次 skip。
    if (bootDoneWatchdog !== undefined) { clearTimeout(bootDoneWatchdog); bootDoneWatchdog = undefined; }
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
  },
});
function showBrowseSurface() {
  syncAlbumNavigation();
  if (!albums.length || boot?.active) return;
  if (overview) { $("#music-browse").inert = true; return; }
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  // 把焦点停在容器上而不是「打开专辑」按钮上：容器带 tabindex="-1"，
  // 程序化聚焦不会触发 :focus-visible，也就不会每次打开都画一圈橙色描边。
  // Tab 键仍然从容器进入内部第一个可聚焦元素，键盘可达性不变。
  if (!panel) $("#music-browse").focus({ preventScroll: true });
}
function setOverview(active: boolean, reveal = true) {
  if (active && (!ready || (!albums.length && !accountView) || boot?.active || panel || mode !== "archive")) return;
  playlistOverviewRequested = false;
  overview = active;
  paintOverviewHeading();
  overviewRevealPending = !active && reveal;
  scene?.setMusicOverview(active);
  stage.dataset.overview = String(active);
  const toggle = $<HTMLButtonElement>('[data-action="overview"]');
  toggle.setAttribute("aria-pressed", String(active));
  for (const item of stage.querySelectorAll<HTMLElement>(".music-topnav > :not(.minimal-transport)")) item.inert = active;
  toggle.inert = active || !!panel;
  overviewUI.setActive(active, preferences.reduced);
  $("#music-overview").inert = !active || !!panel;
  $("#music-browse").inert = active || !!panel;
  $("#music-browse").setAttribute("aria-hidden", String(active));
  if (active) {
    browseTransition.hide(preferences.reduced);
 // Focus the return control after its visible entrance, never a hidden toggle.
  }
}
function updateOverview() {
  if (!scene || (!overview && $("#music-overview").hidden)) return;
  overviewUI.update(scene.getOverviewColumns(), stage.clientWidth, stage.clientHeight,
    scene.musicOverviewProgress, preferences.reduced, accountView ? '歌单' : sortLabel.column);
}
let overviewListEpoch = 0;
async function loadOverviewPlaylist(lane: number, offset = 0) {
  if (!accountView || !overview || !overviewUI.canEnter(lane)) return;
  const row = wrap(lane - 2, playlistLibrary.playlists.length), playlist = playlistLibrary.playlists[row];
  if (!playlist) return;
  const epoch = ++overviewListEpoch, account = accountKey;
  const paint = (loading: boolean, error?: string) => overviewUI.setPlaylistContent(lane, {
    name: playlist.name, total: playlist.trackCount, offset, loading, error,
    tracks: Array.from({ length: Math.min(32, Math.max(0, playlist.trackCount - offset)) }, (_, index) => playlistLibrary.track(row, offset + index)),
  });
  paint(true);
  try {
    await Promise.all([playlistLibrary.ensure(row, offset, true), playlistLibrary.ensure(row, Math.min(playlist.trackCount - 1, offset + 31), true)]);
    if (epoch === overviewListEpoch && account === accountKey && offset > 0 && offset >= playlist.trackCount) {
      await loadOverviewPlaylist(lane, Math.max(0, playlist.trackCount - 32)); return;
    }
    if (epoch === overviewListEpoch && account === accountKey && overview && accountView && overviewUI.canEnter(lane)) paint(false);
  } catch (error) {
    if (epoch === overviewListEpoch && account === accountKey && overview && overviewUI.canEnter(lane)) paint(false, (error as Error).message);
  }
}
function tryEnterPlaylistOverview() {
  if (!playlistOverviewRequested) return;
  if (!accountActive || !accountView) { playlistOverviewRequested = false; return; }
  if (!libraryRebuilding && stage.classList.contains('playlist-grid') && presentation.phase === 'archive')
    setOverview(true);
}
async function openMyPlaylistsOverview() {
  if (!ready || !accountActive || frameDisposed) return;
  playlistOverviewRequested = true;
  accountView = true;
  cancelTrackReveal();
  if (boot?.active) boot.skip();
  setMode('archive');
  if (!playlistLibrary.playlists.length && !playlistLibrary.loading) await playlistLibrary.load();
  if (!playlistOverviewRequested || !accountActive || !accountView || frameDisposed) return;
  await rebuildPlaylistGrid();
  tryEnterPlaylistOverview();
}
function savePrefs() {
  save("rhine-music-preferences", preferences);
}

/**
 * 把缓存偏好推给后端，并刷新设置面板上的占用显示。
 *
 * 缓存上限与缓存位置过去只是 preferences 里的两个值：滑块能拖、输入框能填、
 * 但后端 `music-audio.mjs` 里上限是硬编码 4GB、目录是硬编码
 * `music-data/audio-cache-v041`，谁都没读过它们。所以 4GB 满了之后用户想调大
 * 或者想清理，界面上做了动作却毫无效果。
 *
 * 现在这里如实下发，并把后端真正生效的值回写到状态行 —— 面板上显示的就是
 * 解码器正在用的，不是前端自己算的。
 */
async function pushCacheSettings(refresh = true) {
  const applied = await syncCacheSettings(preferences.cacheLimit, preferences.cacheLocation);
  // 把后端**真正生效**的缓存目录写回输入框的灰字提示：用户没自定义时也要
  // 看得见缓存落在哪（原来这里只有一句「留空使用默认位置」，等于没说）。
  const location = document.querySelector<HTMLInputElement>('#cache-location');
  if (location && applied?.cacheDir) location.placeholder = applied.cacheDir;
  if (refresh) await refreshCacheStatus();
  return applied;
}

/** 刷新设置面板里的缓存占用 / 上限显示。 */
async function refreshCacheStatus() {
  const status = document.querySelector('#cache-status');
  const usage = await readAudioCacheUsage();
  if (!status) return usage;
  if (!usage) { status.textContent = "无法读取缓存状态"; return null; }
  const used = usage.bytes > 0 ? `${(usage.bytes / 1024 / 1024).toFixed(0)} MB / ${Math.round(usage.limitBytes / 1024 / 1024)} MB` : `0 MB / ${Math.round(usage.limitBytes / 1024 / 1024)} MB`;
  status.textContent = `已用 ${used} · ${usage.files} 个文件`;
  return usage;
}


/** 共享音源密钥：把后端状态画到设置面板上。
 * 只显示账号名与到期时间，不显示凭据本体。 */
async function refreshPoolCredentialStatus() {
  const status = document.querySelector('#pool-credential-status') as HTMLElement | null;
  const state = await readPoolCredential();
  if (!status) return state;
  if (!state) { status.textContent = "无法读取密钥状态"; return null; }
  if (state.configured) {
    // 只给到期时间。账号名不进 UI。
    const until = state.expiresAt ? `${new Date(state.expiresAt).toLocaleDateString("zh-CN")} 到期` : "有效期未知";
    status.textContent = `已启用 · ${until}`;
  } else {
    status.textContent = state.note ?? "未导入密钥，当前只使用备用音源";
  }
  // 【2026-10-26】签名失败单独提示：不然用户只看到「取源失败」，
  // 根本不知道是自己这台电脑缺设备密钥。
  const signBox = document.querySelector('#pool-credential-signnote') as HTMLElement | null;
  if (signBox) {
    if (state.signNote) {
      signBox.textContent = state.signNote;
      signBox.hidden = false;
    } else {
      signBox.textContent = "";
      signBox.hidden = true;
    }
  }
  return state;
}

/** 「检测连通性」：线路 + 各平台上游。线路挂了的不会出现在列表里。 */
/**
 * 移除密钥后把「线路 / 平台上游」那一块也清掉。
 *
 * 【2026-10-23】原来只刷新状态文字：探测结果留在页面上，看起来像「移除了还能测」。
 * 后端现在会把线路表与令牌一起作废，这里同步把残留的旧数字擦掉。
 */
function clearPoolConnectivityBox(note = "未导入密钥，没有可检测的线路") {
  const box = document.querySelector<HTMLElement>("#pool-connectivity");
  if (box) box.innerHTML = `<p class="pool-connectivity-note">${esc(note)}</p>`;
}

async function runPoolConnectivity() {
  const box = document.querySelector<HTMLElement>("#pool-connectivity");
  const button = document.querySelector<HTMLButtonElement>('[data-action="pool-connectivity"]');
  if (!box) return;
  if (button) { button.disabled = true; button.textContent = "检测中…"; }
  box.innerHTML = '<p class="pool-connectivity-note">正在探测线路与平台上游…</p>';
  try {
    const response = await fetch("/api/pool/lines/probe?scope=all", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json() as {
      results?: { id?: string; label?: string; host?: string; reachable?: boolean; healthy?: boolean; latency_ms?: number | null; detail?: string }[];
      upstreams?: { platform: string; ok: boolean; latency_ms: number | null; quality?: string; detail?: string }[];
    };
    const lines = value.results ?? [];
    const upstreams = value.upstreams ?? [];
    const lineRows = lines
      .filter(line => line.reachable)
      .map(line => `<li><span class="pool-target">${esc(line.host ?? line.label ?? "")}</span><span class="pool-meter">${line.latency_ms != null ? `${line.latency_ms}ms` : "—"}</span></li>`)
      .join("");
    const upstreamRows = upstreams
      .map(item => {
        const name = (musicPlatforms as Record<string, string>)[item.platform] ?? item.platform;
        const state = item.ok
          ? `${item.latency_ms != null ? `${item.latency_ms}ms` : "—"}${item.quality ? ` · ${esc(item.quality)}` : ""}`
          : esc(item.detail || "失败");
        return `<li class="${item.ok ? "" : "pool-miss"}"><span class="pool-target">${esc(name)}</span><span class="pool-meter">${state}</span></li>`;
      })
      .join("");
    box.innerHTML = [
      lineRows ? `<p class="pool-connectivity-title">线路</p><ul class="pool-connectivity-list">${lineRows}</ul>` : '<p class="pool-connectivity-note">线路都连不上。</p>',
      upstreamRows ? `<p class="pool-connectivity-title">平台上游</p><ul class="pool-connectivity-list">${upstreamRows}</ul>` : "",
    ].join("");
  } catch (error) {
    box.innerHTML = `<p class="pool-connectivity-note">检测失败：${esc(error instanceof Error ? error.message : String(error))}</p>`;
  } finally {
    if (button) { button.disabled = false; button.textContent = "检测连通性 ↗"; }
  }
}

/**
 * 扫码登录。
 *
 * 密钥文件里的私钥只对生成它的那台电脑有效 —— 服务端按设备登记公钥，
 * 换台电脑签名就对不上。这条路让**任何一台电脑**都能自己登记：
 * 本机生成密钥 → 手机扫一下 → 服务端登记 → 这台电脑拿到自己的凭据。
 */
let poolQrTimer: number | null = null;

function stopPoolQrPolling() {
  if (poolQrTimer != null) { window.clearTimeout(poolQrTimer); poolQrTimer = null; }
}

function closePoolQrPanel() {
  stopPoolQrPolling();
  const box = document.querySelector('#pool-qr-login') as HTMLElement | null;
  if (box) box.hidden = true;
}

async function startPoolQrLogin() {
  const box = document.querySelector('#pool-qr-login') as HTMLElement | null;
  const image = document.querySelector('#pool-qr-image') as HTMLImageElement | null;
  const note = document.querySelector('#pool-qr-status') as HTMLElement | null;
  if (!box) return;
  closePoolQrPanel();
  box.hidden = false;
  if (note) note.textContent = "正在生成二维码…";
  const session = await startPoolQrLoginApi();
  if (!session) {
    if (note) note.textContent = "无法连接服务器，请检查网络后重试。";
    return;
  }
  if (image) image.src = poolQrImageUrl(session.qrContent);
  if (note) note.textContent = "请用手机上的客户端扫描二维码。";
  const tick = async () => {
    const state = await pollPoolQrLogin(session.sessionId);
    if (!state) { if (note) note.textContent = "连接中断，请重试。"; return; }
    if (state.status === 'approved') {
      if (note) note.textContent = "授权成功，正在装填…";
      closePoolQrPanel();
      await refreshPoolCredentialStatus();
      return;
    }
    if (state.status === 'error' || state.status === 'expired' || state.status === 'rejected') {
      if (note) note.textContent = state.error ?? "二维码已过期，请重新获取。";
      stopPoolQrPolling();
      return;
    }
    // rate_limited 不是失败，等久一点再问（服务端对轮询有速率限制）
    poolQrTimer = window.setTimeout(() => { void tick(); }, state.status === 'rate_limited' ? 8000 : 5000);
  };
  poolQrTimer = window.setTimeout(() => { void tick(); }, 4000);
}

/** 「导入密钥文件」：打开文件选择器，读文本后交给后端。 */
function pickPoolCredentialFile() {  const input = document.querySelector("#pool-credential-file") as HTMLInputElement | null;
  if (input) input.click();
}

async function handlePoolCredentialFile(input: HTMLInputElement) {
  const status = document.querySelector('#pool-credential-status') as HTMLElement | null;
  const file = input.files?.[0];
  if (!file) return;
  if (status) status.textContent = "正在导入…";
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 密钥文件是二进制信封，按 base64 原样交给后端；前端不解析内容。
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const result = await importPoolCredential(btoa(binary));
  if (!result.ok) {
    if (status) status.textContent = `导入失败：${result.error ?? "未知原因"}`;
    input.value = "";
    return;
  }
  input.value = "";
  await refreshPoolCredentialStatus();
}

/** 「移除」：删掉本地密钥文件，共享池立即停用。 */
async function removePoolCredential() {
  const status = document.querySelector('#pool-credential-status') as HTMLElement | null;
  if (status) status.textContent = "正在移除…";
  await clearPoolCredential();
  const state = await refreshPoolCredentialStatus();
  // 没密钥了：把上一次探测残留的线路/延迟一起擦掉。
  if (!state?.configured) clearPoolConnectivityBox();
}
/** 「清理缓存」按钮的处理器。以前这个 data-action 根本没有监听。 */
async function clearCacheFromSettings() {
  const status = document.querySelector('#cache-status');
  if (status) status.textContent = "正在清理…";
  const result = await clearAudioCache();
  if (!result) { if (status) status.textContent = "清理失败"; return; }
  const { files, bytes } = result.freed;
  const mb = (bytes / 1024 / 1024).toFixed(0);
  if (status) status.textContent = files > 0 ? `已清理 ${files} 个文件，释放 ${mb} MB` : "缓存已经是空的";
  await refreshCacheStatus();
}
/** 设置项变更的统一入口：任何带 data-settings-key 的控件都调这里。
 *
 * 这一张表就是「设置面板与 preferences 的对照」：左边是设置项键名，
 * 右边是 Rhine 里存它的地方。新增项只在这里加一行，不必去翻各处事件监听。 */
function applySetting(key: string, el: HTMLSelectElement | HTMLInputElement) {
 // 勾选框读 checked，其余（下拉、卡片按钮的 value 代理）读 value。
  const value: string | boolean = el instanceof HTMLInputElement && el.type === 'checkbox'
    ? el.checked
    : (el as HTMLSelectElement).value;
  const record = preferences as unknown as Record<string, string | number | boolean>;
 // 布尔类：勾选框。
  if (['autoplay', 'minimizeToTray'].includes(key)) {
    if (typeof value !== 'boolean') return;
    record[key] = value;
    savePrefs();
 // 托盘开关要同步给 Rust：关闭按钮的行为在那里决定。
    if (key === 'minimizeToTray') syncTrayPreference(value);
    return;
  }
 // 枚举类：下拉框，取值必须在白名单里，避免脏值落盘。
  const enums: Record<string, readonly string[]> = {
    playlistSort: Object.keys(localSortKeys),
    playlistSortDirection: ['ascending', 'descending'],
  };
  if (key in enums) {
    if (typeof value !== 'string' || !enums[key].includes(value)) return;
    record[key] = value;
    savePrefs();
 // 排序变了重新加载歌单墙（netease-playlists 会带上 sort/direction）。
    if (key === 'playlistSort' || key === 'playlistSortDirection') {
      playlistLibrary.setLocalSort(preferences.playlistSort, preferences.playlistSortDirection);
      if (accountView) {
        clearTimeout(playlistRenderTimer);
        void playlistLibrary.load().then(() => void playlistLibrary.window(firstPlayablePlaylist(), 0));
      }
    }
    return;
  }
 // 文本 / 数值类：直接存，但要做基本清洗。
  if (key === 'cacheLocation') {
    if (typeof value !== 'string') return;
    record[key] = value.trim();
    savePrefs();
 // 缓存位置以前只存偏好、后端从不读，填了等于没填。现在改完立刻下发。
    if (key === 'cacheLocation') void pushCacheSettings();
    return;
  }
 // 数值区间类：滑杆。只接受范围内的整数。
  const ranges: Record<string, [number, number]> = { uiScale: [80, 140], cacheLimit: [64, 8192] };
  if (key in ranges) {
    const [min, max] = ranges[key];
    const next = Math.round(Number(el.value));
    if (!Number.isFinite(next)) return;
    record[key] = Math.min(max, Math.max(min, next));
    savePrefs();
    if (key === 'uiScale') applyUiScale();
    if (key === 'cacheLimit') {
      const status = document.querySelector('#cache-limit-status');
      if (status) status.textContent = `${record.cacheLimit} MB`;
 // 上限以前是死值 4GB，滑块只改数字。现在真的下发给解码器。
      void pushCacheSettings();
    }
    return;
  }
 // 帧率：滑杆位置 24..180 = 该帧率，181 = 无限制（0）。单独一支是因为
 // 它的"值域 ↔ 语义"不是简单区间（末端溢出为无限制），且改完要立刻
 // 作用到渲染调度器上（用户要求"是真的能调节帧率"）。
  if (key === 'frameRate') {
    const next = frameRateFromSlider(Number(el.value));
    preferences.frameRate = next;
    applyFrameRate();
    savePrefs();
    return;
  }
}
/** 界面缩放：写 CSS 变量，让整套音乐界面按比例缩放。 */
function applyUiScale() {
  document.documentElement.style.setProperty('--music-ui-scale', String(preferences.uiScale / 100));
  const status = document.querySelector('#ui-scale-status');
  if (status) status.textContent = `当前 ${preferences.uiScale}%`;
}
function detectAutomaticQuality() {
  if (!scene) return;
  automaticProfile = automaticQuality({ ...scene.graphicsIdentity,
    cores: navigator.hardwareConcurrency,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    nativePixels: innerWidth * innerHeight * devicePixelRatio ** 2 });
  if (preferences.qualityMode === 'auto') {
    preferences.quality = automaticProfile.preset;
    renderQuality = automaticProfile.quality;
  }
}
/** 预载用的选中格：场景存在时它掌握实时格（歌单/播放队列会把格挪走）；
 * 场景还没建时退回规范位置 —— 与 refreshLibrary() 之后采用的格一致。 */
function coverSelectionCell() {
  if (scene) return scene.musicSelectionCell;
  const location = fileLocation(selected);
  return { lane: location.lane, row: location.row };
}
/** 首屏预热窗口：选中列两侧各一列，纵向覆盖开场镜头能看到的这一段。 */
const FIRST_SCREEN_COVER_LANES = [-1, 0, 1];
const FIRST_SCREEN_COVER_ROWS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
/** 已经建过连的封面：避免重复请求（二次进入本来就走 HTTP 缓存，零等待）。 */
const warmedCoverUrls = new Set<string>();
/** 保住未完成的 Image 引用：否则浏览器可能在响应回来前丢掉请求。 */
const warmingCoverImages = new Set<HTMLImageElement>();
/**
 * 用户要求：封面**启动一开始就下**，不再等加载动画结束后一张张来。
 *
 * 开场动画期间三维专辑架还没进视口，浏览器不会为它建连（这正是原来
 * `loading="lazy"` + 场景就绪后才预载造成的「动画后才一张张下」）。
 * 这里直接用 `new Image()` 提前建连并把响应放进 HTTP 缓存；等场景真正
 * 开始解码时就是缓存命中。
 */
/** 待建连的封面与在飞计数。全库预热有几百张，必须限流：一次 new 几百个
 * Image 会把浏览器连接池占满，最该先到的那几张反而更慢。 */
const warmCoverQueue: string[] = [];
const WARM_COVER_CONCURRENCY = 8;
let warmCoverActive = 0;
/**
 * 用户要求：封面**启动一开始就下**，不再等加载动画结束后一张张来。
 *
 * 开场动画期间三维专辑架还没进视口，浏览器不会为它建连（这正是原来
 * `loading="lazy"` + 场景就绪后才预载造成的「动画后才一张张下」）。
 * 这里直接用 `new Image()` 提前建连并把响应放进 HTTP 缓存；等场景真正
 * 开始解码时就是缓存命中。
 */
function warmCoverUrl(url?: string) {
  if (!url || warmedCoverUrls.has(url)) return;
 // 只当书签用，别让它无限长（全库预热会把整个曲库都过一遍）。
  if (warmedCoverUrls.size > 4096) warmedCoverUrls.clear();
  warmedCoverUrls.add(url);
  warmCoverQueue.push(url);
  pumpWarmCovers();
}
/** 队列泵：始终维持至多 WARM_COVER_CONCURRENCY 个在飞的 Image。 */
function pumpWarmCovers() {
  while (warmCoverActive < WARM_COVER_CONCURRENCY && warmCoverQueue.length) {
    const url = warmCoverQueue.shift()!;
    warmCoverActive++;
    const image = new Image();
  // 与 CoverAtlas 用同一种请求模式（crossOrigin="anonymous"），保证命中同一条
  // HTTP 缓存记录，而不是被浏览器分到另一个缓存分区。
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    const release = () => {
      warmCoverActive--;
      warmingCoverImages.delete(image);
      pumpWarmCovers();
    };
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    warmingCoverImages.add(image);
    image.src = url;
  }
}
function warmFirstScreenCovers() {
  if (!records.length) return;
  const current = coverSelectionCell();
 // 选中的那张排最前：它是最关键路径的那一张，先让它建连。
  warmCoverUrl(records[selected]?.album?.coverUrl);
  for (const lane of FIRST_SCREEN_COVER_LANES)
    for (const row of FIRST_SCREEN_COVER_ROWS)
      if (lane || row)
        warmCoverUrl(records[fileAtCell({ lane: current.lane + lane, row: current.row + row })]?.album?.coverUrl);
}
/** 全库封面预热：启动转圈期间就把**所有**封面建连、压进 HTTP 缓存。
 *
 * 用户反馈在首页快速横向/纵向切换会卡 —— 根因就是新进入视口的封面此刻才
 * 开始下载并解码。原来只预热「选中列 ±1 × 纵向 ±4」这 27 张，其余靠
 * loading=lazy 慢慢来，快速切换必然追赶不上。这里先保关键路径（选中 +
 * 首屏窗口），再把剩余曲库整体排队（并发 8），切到哪张都是缓存命中。 */
function warmAllCovers() {
  if (!records.length) return;
  warmFirstScreenCovers();
  for (const record of records) warmCoverUrl(record?.album?.coverUrl);
  // 关键一步：只建连还不够 —— 用户切过去时仍要现解码。
  // 这里把整库交给 CoverAtlas，让它在后台把每张的 tile 都解码成 canvas 常驻，
  // 之后无论切到哪一张都是「已解码、直接上传纹理」。
  scene?.warmAllCovers(records);
}
function preloadNearbyCovers() {
 // 用户要求：这一趟要能在 boot 之前跑，所以不再拿 `!scene` 当门槛。
  if (!records.length) return;
  const current = coverSelectionCell();
  const ahead = [records[selected]];
  for (const [lane, row] of [[0, -1], [0, 1], [-1, 0], [1, 0], [0, -2], [0, 2]])
    ahead.push(records[fileAtCell({ lane: current.lane + lane, row: current.row + row })]);
 // 场景还没建（启动最初的加载）时也不能白算：先把 HTTP 缓存热上。
  for (const record of ahead) warmCoverUrl(record?.album?.coverUrl);
  scene?.preloadCovers(ahead);
}
async function copyPerformanceReport() {
  const host = $("#three-scene");
  const report = {
    version: `${appVersion}-preview`, browser: navigator.userAgent,
    gpuPreference: (window as unknown as { __RHINE_GPU_REQUEST__?: string }).__RHINE_GPU_REQUEST__ || 'webgl-high-performance',
    automaticQuality: { mode: preferences.qualityMode, profile: automaticProfile },
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    hidden: document.hidden, phase: stage.dataset.musicBoot,
    quality: JSON.parse(host.dataset.renderQuality || "null"),
    preparation: JSON.parse(host.dataset.startupPreparation || "null"),
    frame: frameTiming.snapshot(),
    render: JSON.parse(host.dataset.renderStats || "null"),
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  } catch { notify("浏览器未允许复制，请检查剪贴板权限后重试。"); }
}
function setTheme(theme: Theme) {
  if (theme !== "day" && theme !== "night" && theme !== "dusk") theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#0a1220" : theme === "dusk" ? "#cbd6df" : "#e8e5e1");
  savePrefs();
}
function fit() {
 // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  scene?.resize();
  viewer?.resize();
  if (mode === "detail") {
    syncTabIndicator(false);
    documentDecryption.refresh();
  }
}
window.addEventListener("resize", fit);

async function request<T>(url: string, body?: unknown): Promise<T> {
  const onlineProvider = /^\/api\/online\/(netease|qq|bodian)\//.exec(url)?.[1] as MusicProvider | undefined;
  const response = await (onlineProvider ? (target: string, options: RequestInit) => fetchOnline(onlineProvider, 'request', target, options) : fetch)(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}
async function loadLibrary(force = false) {
 // The forced first snapshot establishes the music model before scene.load().
 // Hold ordinary polling until preparation finishes so data and 3D columns
 // cannot diverge while applyLibrary() intentionally skips an unready scene.
  if (frameDisposed || ((!ready || document.hidden) && !force)) return;
  if (lightingDemo) {
    if (!libraryReceived || force) {
      demo = true;
      apiAvailable = true;
      await receiveLibrary({ version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false }, true);
    }
    return;
  }
 // Keep the selected cards and cover atlas stable for the opening shot.
  if (boot?.active) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(force), 1000);
    return;
  }
  if (refreshing) return;
  refreshing = true;
  const stateVersion = libraryStateVersion;
  try {
    const next = await request<MusicLibrary>("/api/library");
    if (frameDisposed || ((!ready || document.hidden) && !force)) return;
    apiAvailable = true;
    if (stateVersion === libraryStateVersion && !boot?.active) await receiveLibrary(next, force);
  } catch (error) {
    if (frameDisposed || ((!ready || document.hidden) && !force)) return;
    apiAvailable = false;
    updateStatus();
    updateIntroductionStatus();
    updateCreditsStatus();
    if (force)
      notify(
        `${(error as Error).message}。请使用 npm run music 启动本地音乐服务。`,
      );
  } finally {
    refreshing = false;
  }
  clearTimeout(pollTimer);
  if (frameDisposed || !ready || document.hidden) return;
  pollTimer = setTimeout(
    () => void loadLibrary(),
    library.scan.running ||
      library.enrich?.running ||
      library.introductions?.running ||
      library.credits?.running
      ? 1400
      : 12000,
  );
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const previousCreditsRun = library.credits;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
  const creditsOnly = changed && !force && !demo &&
    JSON.stringify(next.genres) === JSON.stringify(library.genres) &&
    JSON.stringify(next.albums.map(albumWithoutCredits)) === JSON.stringify(library.albums.map(albumWithoutCredits));
  const previousCurrentCredits = JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (library.credits?.running) creditsRequestError = "";
  if (creditsOnly) {
 // Updating credits must not reset the selected column, scene, tracks or scroll.
    const byId = new Map(next.albums.map((album) => [album.id, album]));
    albums = albums.map((album) => byId.get(album.id) || album);
    for (const record of records) {
      const album = byId.get(record.id);
      if (album) record.album = album;
    }
    if (mode === "detail" && previousCurrentCredits !== JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]))
      renderCurrentCredits();
  } else if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  updateCreditsStatus();
  if (previousCreditsRun?.running && library.credits && !library.credits.running)
    notify(creditsRunSummary(library.credits));
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
}
function albumWithoutCredits(album: MusicAlbum) {
  const { producers: _producers, creditsLookup: _lookup, ...detail } = album;
  return detail;
}
async function applyLibrary() {
  if (accountActive && accountView) { updateStatus(); return; }
  if (!browseLibraryDuringPlayback && records[0]?.album?.playback && playerState.currentTrack && playerState.transport !== 'idle') { updateStatus(); return; }
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.playback?.albumId || currentAlbum()?.id;
  const previousAlbum = currentAlbum();
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  albums = orderMusicAlbums(demo ? demoAlbums : library.albums, preferences.sortMode);
  if (!albums.length && overview) setOverview(false, false);
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, preferences.sortMode);
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  columnMemory = new Map(
    archiveColumns.map((name, lane) => [
      name,
      records[columnFiles(lane)[0]]?.id,
    ]),
  );
 // 封面 URL 到手的最早时刻（首次启动时还在加载页/开场动画之前）：立刻建连。
 // 这里就全库排队，别等用户切到才下（切换卡顿的根因就是"此刻才开始下"）。
  warmAllCovers();
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    cancelTrackReveal();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    if (intent && "index" in intent)
      select(intent.index, intent.navigation, intent.openAfter, intent.route);
    else if ((intent ? intent.mode === "detail" : reopen) && albums.length)
      presentation.open();
    else showBrowseSurface();
  }
  if (!albums.length) {
    cancelTrackReveal();
    presentation.reset();
  }
  stage.dataset.mode = mode;
 // 「空库」只表示既没有本地专辑、也没有任何歌单（本地歌单不登录也有）。
  stage.classList.toggle('empty-library', !albums.length && !playlistLibrary.playlists.length);
 // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
 // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") detailTransition.hide(true);
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || !!panel;
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail"),
    );
  }
  updateSelection();
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum())) {
    const album = currentAlbum();
    if (previousAlbum && album && previousAlbum.id === album.id &&
        JSON.stringify(albumWithoutCredits(previousAlbum)) === JSON.stringify(albumWithoutCredits(album)))
      renderCurrentCredits();
    else renderDetail();
  }
  updateStatus();
}
function updateStatus() {
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
 // 「我的歌单」入口：有本地专辑，或有任何歌单（本地歌单不登录也有）。
  $<HTMLButtonElement>('[data-action="overview"]').hidden = !albums.length && !playlistLibrary.playlists.length;
  stage.classList.toggle('empty-library', !albums.length && !playlistLibrary.playlists.length);
  const label = lightingDemo ? `V${appVersion}-preview · 内置演示封面` : !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : library.credits?.running
            ? `查询制作信息 ${library.credits.completed}/${library.credits.total}`
            : demo
            ? "演示专辑 · 加入音乐后显示真实封面"
            : "";
  $("#library-status span").textContent = label;
  $("#library-status").hidden = !label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running ||
      !!library.credits?.running,
  );
  $("#library-count").textContent = records[0]?.album?.playback ? `PLAY QUEUE / ${records.filter((record) => !record.album?.searchAnchor).length} TRACKS` : demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
  if (accountActive && accountView) {
    $('#library-count').textContent = `${(playlistPlatformView === 'all' ? 'ALL' : playlistPlatformView).toUpperCase()} / ${playlistLibrary.playlists.length} PLAYLISTS`;
    $('#library-status span').textContent = playlistLibrary.loading
      ? (playlistPlatformView === 'all' ? '正在读取各平台歌单…' : `正在读取${playlistSourceName(playlistPlatformView)}歌单…`)
      : playlistNavigationTarget ? '正在读取歌单歌曲…' : playlistLibrary.error;
    $('#library-status').hidden = !playlistLibrary.loading && !playlistLibrary.error && !playlistNavigationTarget;
  }
}
function updateSelection(navigation?: ArchiveNavigation) {
  syncAlbumNavigation();
  const a = currentAlbum();
  $('#album-ticks').hidden = !!a?.playlistCell;
  playlistSongBars.update(a?.playlistCell?.playlistId || '', a?.playlistCell?.total || 0,
    a?.playlistCell?.songIndex || 0, preferences.reduced);
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = a.playback ? records.flatMap((record, index) => record.album?.searchAnchor ? [] : [index]) : columnFiles(location.lane),
    idx = files.indexOf(selected);
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: a.playlistCell ? a.playlistCell.total ? a.playlistCell.songIndex + 1 : 0 : idx + 1,
      total: a.playlistCell ? a.playlistCell.total : files.length,
      genresTotal: a.playlistCell ? playlistLibrary.playlists.length : archiveColumns.length,
      code: a.playlistCell ? a.playlistCell.songIndex + 1 : selected + 1,
      genreIndex: a.playlistCell ? a.playlistCell.playlistIndex + 1 : location.lane + 1,
      genre: a.playlistCell ? a.playlistCell.playlistName : a.playback ? '播放队列' : archiveColumns[location.lane],
      genreName: a.playlistCell ? a.playlistCell.playlistName : a.playback ? '播放队列' : archiveColumns[location.lane],
      format: demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: [
        a.playlistCell ? a.tracks[0]?.onlineSource?.albumTitle || musicPlatforms[activeProvider] : a.playback ? a.playback.albumTitle || '专辑未提供' : a.year ? String(a.year) : "年份未提供",
        a.playlistCell ? a.playlistCell.total ? `第 ${a.playlistCell.songIndex + 1} / ${a.playlistCell.total} 首` : '空歌单' : demo ? "演示封面" : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  const positionPrefix = $('#genre-position').firstChild;
  if (positionPrefix?.nodeType === Node.TEXT_NODE) positionPrefix.textContent = a.playlistCell ? 'PLAYLIST ' : `${sortLabel.code} `;
  const codePrefix = $('#selection-code').firstChild;
  if (codePrefix?.nodeType === Node.TEXT_NODE) codePrefix.textContent = a.playlistCell ? 'SONG ' : 'ALBUM ';
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
    !a.playback && !a.playlistCell && preferences.arrayMode === "filled",
  );
  $("#detail-card-id").textContent =
    `${a.playlistCell ? 'SONG' : 'ALBUM'} / ${String(a.playlistCell ? a.playlistCell.songIndex + 1 : selected + 1).padStart(3, "0")}`;
 // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  if (preferences.rememberColumnPosition && !records[selected]?.album?.playlistCell) columnMemory.set(
    archiveColumns[fileLocation(selected).lane],
    records[selected].id,
  );
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  preloadNearbyCovers();
  const playlist = records[selected]?.album?.playlistCell;
  if (playlist && scene && !playlistNavigationTarget) void playlistLibrary.window(playlist.playlistIndex, scene.musicSelectionCell.row - 12);
  updateSelection(navigation);
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelTrackReveal();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending && navigation && !("cell" in navigation)) {
 // Coalesced key presses still reach the matching physical loop cell.
    if (previous && "axis" in previous && previous.axis === navigation.axis) {
      navigation = { ...navigation, direction: previous.direction + navigation.direction };
    } else if (navigation.axis === "lane" && navigation.row !== undefined) {
      if (previous && "cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane + navigation.direction, row: navigation.row,
        } };
      } else {
 // A pending search or row change may target a different logical column.
 // Compute its relative occurrence before adding the new arrow direction;
 // this offset is invariant across physical loop periods.
        const committedLane = fileLocation(selected).lane;
        const pendingLane = nearestOccurrence(fileLocation(pending.index).lane,
          committedLane, archiveColumns.length);
        navigation = { ...navigation, direction: pendingLane - committedLane + navigation.direction };
      }
    } else if (!preferences.rememberColumnPosition && navigation.axis === "row" && previous) {
      if ("cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane, row: previous.cell.row + navigation.direction,
        } };
      } else if (previous.axis === "lane" && previous.row !== undefined) {
 // A vertical key inside a queued column change must keep that column's
 // accumulated displacement as well as the requested neighboring album.
        navigation = { ...previous, row: previous.row + navigation.direction };
      } else navigation = undefined;
    } else navigation = undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    syncAlbumNavigation();
    return;
  }
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
  syncAlbumNavigation();
}
/** Playback can reuse its open album; other targets take the archive route. */
function revealAlbum(albumId: string, trackId?: string, options: { reuseOpenAlbum?: boolean } = {}) {
  closePanel(() => {
    cancelTrackReveal();
    if (!ready || boot?.active) return;
    const index = records.findIndex((record) => record.id === albumId);
    const album = albums.find((item) => item.id === albumId);
    if (index < 0 || !album || (trackId && !album.tracks.some((track) => track.id === trackId))) {
      notify("这张专辑或歌曲已不在当前音乐库中，请刷新音乐库后重试。");
      return;
    }
    if (options.reuseOpenAlbum && trackId && !libraryRebuilding &&
      currentAlbum()?.id === albumId && presentation.openingOrDetail &&
      !presentation.pendingSelection &&
      ["detail", "opening", "switching"].includes(presentation.phase)) {
 // Preserve the camera and current scroll position. If the album is still
 // entering, the usual detail gate below will wait before revealing it.
      setTab("tracks");
      pendingTrackReveal = { albumId, trackId };
      return;
    }
    if (trackId) pendingTrackReveal = { albumId, trackId };
    if (overview) setOverview(false, false);
    select(index, undefined, true, "archive");
  });
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
/** Pending detail/return requests already define the next input boundary. */
function syncAlbumNavigation() {
  $('.music-back').textContent = accountView ? '← 返回歌单' : '← 返回专辑架';
  if (records[0]?.album?.playlistCell) { syncPlaylistNavigation(); return; }
  const playback = !!records[0]?.album?.playback;
  $('.music-counter .music-eyebrow').textContent = 'ALBUM / SELECT';
  $('.open-album').innerHTML = '打开专辑 <span>↗</span>';
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="genre-prev"], [data-action="genre-next"]')) {
    button.disabled = false;
    button.setAttribute('aria-label', `${button.dataset.action === 'genre-prev' ? '上一个' : '下一个'}${sortLabel.column}`);
  }
  if (records[0]?.album?.playback) {
    for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
      button.disabled = button.dataset.action === 'prev' ? playerState.currentIndex <= 0 : playerState.currentIndex >= playerState.queue.length - 1;
      button.setAttribute('aria-label', button.dataset.action === 'prev' ? '上一首' : '下一首');
      if (button.closest('.detail-album-navigation')) button.textContent = button.dataset.action === 'prev' ? '↑ 上一首' : '下一首 ↓';
    }
    return;
  }
  const cursor = navigationSelection();
  const files = records.length ? columnFiles(fileLocation(cursor).lane) : [];
  const ordinal = files.indexOf(cursor);
  const bounded = preferences.arrayMode === "realistic";
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
    button.setAttribute('aria-label', button.dataset.action === 'prev' ? '上一个专辑' : '下一个专辑');
    if (button.closest('.detail-album-navigation')) button.textContent = button.dataset.action === 'prev' ? '↑ 上一张' : '下一张 ↓';
    button.disabled = !files.length || (bounded && (button.dataset.action === "prev"
      ? ordinal <= 0 : ordinal >= files.length - 1));
  }
}
function stepAlbum(direction: number) {
  const playlist = records[navigationSelection()]?.album?.playlistCell;
  if (playlist) {
    const row = playlistNavigationTarget?.row ?? playlist.playlistIndex, song = (playlistNavigationTarget?.song ?? playlist.songIndex) + direction;
    if (playlistLibrary.playlists[row].trackCount) void navigatePlaylist(row, song, { axis: 'row', direction }); return;
  }
  if (records[0]?.album?.playback) {
 // 队列首尾相连：最后一首继续往下回到第一首，搜索结果墙可以无限循环。
    const queue = playerState.queue;
    const track = queue.length ? queue[wrap(playerState.currentIndex + direction, queue.length)] : undefined;
    if (track) void player.play(track.id);
    return;
  }
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length < 2) return;
  const ordinal = files.indexOf(cursor);
  const target = preferences.arrayMode === "realistic"
    ? Math.max(0, Math.min(files.length - 1, ordinal + direction))
    : wrap(ordinal + direction, files.length);
  const delta = preferences.arrayMode === "realistic" ? target - ordinal : direction;
 // A boundary input must not restart a detail handoff or cancel track focus.
  if (!delta) return;
  select(files[target], { axis: "row", direction: delta });
}
/** Column arrows and overview entry obey one browsing-position preference. */
function resolveColumnSelection(lane: number): { index: number; row?: number } {
  const files = columnFiles(lane);
  if (!files.length) return { index: -1 };
  if (preferences.rememberColumnPosition) {
    const remembered = columnMemory.get(archiveColumns[lane]);
    const index = files.find((index) => records[index]?.id === remembered);
    return { index: index ?? files[0] };
  }
 // The rendered rail can still be between targets after rapid input. Sample
 // its actual depth, then preserve that physical occurrence in filled arrays.
  const depth = Math.round(scene?.musicBrowseRowForColumn(lane) ??
    scene?.musicBrowseRow ?? fileLocation(navigationSelection()).row);
  const row = preferences.arrayMode === "realistic"
    ? Math.max(12, Math.min(11 + files.length, depth)) : depth;
  return { index: fileAtCell({ lane, row }), row };
}
function stepGenre(direction: number) {
  overviewUI.collapse();
  const playlist = records[navigationSelection()]?.album?.playlistCell;
  if (playlist) {
    void navigatePlaylist((playlistNavigationTarget?.row ?? playlist.playlistIndex) + direction, playlistNavigationTarget?.song ?? playlist.songIndex, { axis: 'lane', direction }); return;
  }
  if (records[0]?.album?.playback) { stepAlbum(direction); return; }
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  const target = resolveColumnSelection(lane);
  select(target.index, {
    axis: "lane",
    direction,
    row: target.row,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") cancelTrackReveal();
  if (libraryRebuilding) { libraryIntent = { mode: next }; syncAlbumNavigation(); return; }
  if (next === "detail") {
    if (overview) setOverview(false, false);
    if (currentAlbum()) presentation.open();
  } else presentation.back();
  syncAlbumNavigation();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelTrackReveal();
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator();
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  const a = currentAlbum();
  if (!a) return;
  const songDetail = Boolean(a.playlistCell || a.tracks.length === 1 && a.tracks[0].onlineSource);
  if (songDetail && detailIdentity === a.id && document.querySelector('#song-view')) {
    syncAlbumNavigation(); updateSongTransport(); return;
  }
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  const albumMarkup = `<div class="detail-overline"><span>ALBUM ${String(selected + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div>
    <h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}</p>
    <div class="album-facts">${fields.map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`).join("")}</div>
    ${a.playlistCell ? "" : `<div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" tabindex="${activeTab === "tracks" ? 0 : -1}" aria-selected="${activeTab === "tracks"}" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" tabindex="${activeTab === "about" ? 0 : -1}" aria-selected="${activeTab === "about"}" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div>
    <div id="album-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}">${activeTab === "tracks" ? trackList(a, discs) : albumAbout(a)}</div>`}`;
  article.innerHTML = songDetail ? `<div class="detail-overline"><span>${esc(musicPlatforms[a.tracks[0]?.onlineSource?.provider || activeProvider])} / ${esc(a.playlistCell?.playlistName || a.tracks[0]?.onlineSource?.albumTitle || '')}</span></div><h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}</p>${a.tracks.length ? songView.markup(a) : trackList(a, 1)}` : albumMarkup;
  article.scrollTop = scroll;
  syncAlbumNavigation();
  syncTabIndicator(false);
  documentDecryption.reset(
    article,
    preferences.reduced,
  );
  updatePlayingRows();
  if (songDetail && a.tracks.length) songView.mount(a, playerState, mode === 'detail');
  updateSongTransport();
}
/** 定位当前歌曲：点顶栏歌名 = 「回到这首歌的详情页」。
 * 旧实现有两条错路：
 * ① 从详情页退回浏览视图后再点歌名，只回到队列墙、不开详情；
 * ② 在线歌曲（搜索来的）一律 openPanel("search") → 跳去搜索界面，而不是详情页。 */
function locatePlaying() {
  if (accountActive && playlistPlaybackId) {
    const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === playlistPlaybackId);
    const album = playlistLibrary.albums().find(album => album.playlistCell?.playlistId === playlistPlaybackId && album.tracks[0]?.id === playerState.currentTrack?.id);
    if (album?.playlistCell) { closePanel(() => void navigatePlaylist(row, album.playlistCell!.songIndex)); return; }
  }
  const track = playerState.currentTrack;
  if (!track) return;
 // 点歌名就是要看这首歌：清掉「正在浏览音乐库」的抑制标志，
 // 并标记队列墙落定后打开详情页（在线歌的详情就在播放队列墙上，它含整条队列）。
  browseLibraryDuringPlayback = false;
  if (records[0]?.album?.playback || track.onlineSource) {
    openDetailAfterQueueSettle = true;
    playbackVisualKey = '';
    closePanel();
    syncPlaybackAlbums(playerState);
    return;
  }
 // 本地曲目：回到它所在专辑并打开详情，保留原有浏览上下文。
  revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true });
}
function updateSongTransport() {
  songView.update(playerState, mode === 'detail');
  visualizer.refresh();
}
/** 详情页音量条按 preferences 初始化（设置面板改这里也跟着变）。 */
function initTransportVolume() {
  const range = document.querySelector<HTMLInputElement>('.volume-range');
  if (!range) return;
  range.value = String(preferences.volume);
  range.disabled = false;
  paintTransportVolume(range);
}
const transportClock = (seconds: number) => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};
document.addEventListener('pointercancel', () => songView.cancelSeek());
document.addEventListener('pointerdown', event => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input.playback-seek');
  if (input) songView.previewSeek(input);
});
document.addEventListener('pointerup', event => {
  if ((event.target as HTMLElement).closest('input.playback-seek')) setTimeout(() => songView.cancelSeek(), 0);
});
function trackList(a: MusicAlbum, discs: number) {
  if (a.playlistCell && !a.tracks.length) return `<div class="empty-tracks"><strong>${a.playlistCell.total ? '这首歌曲暂时没有可用信息' : '这个歌单还没有歌曲'}</strong><button data-action="refresh-playlists" class="text-button">刷新我的歌单 ↻</button></div>`;
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>`;
}
function albumAbout(a: MusicAlbum) {
  if (a.playback && !a.searchAnchor) return `<section class="album-about"><small>${a.tracks[0]?.onlineSource ? musicPlatforms[a.tracks[0].onlineSource.provider] : 'LOCAL MUSIC'}</small><h3>${esc(a.title)}</h3><p>所属专辑：${esc(a.playback.albumTitle || '未提供')}</p>${a.description ? `<p>${esc(a.description)}</p>` : ''}${a.tracks[0]?.onlineSource ? `<a class="text-button" href="${esc(a.tracks[0].onlineSource!.pageUrl)}" target="_blank" rel="noopener noreferrer">在${esc(musicPlatforms[a.tracks[0].onlineSource!.provider])}查看 ↗</a>` : ''}</section>`;
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${!demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>本地目录</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div></section>${producerBlock(a)}`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    const album = albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "暂无本地专辑。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
function producerBlock(a: MusicAlbum) {
  const retry = a.creditsLookup && a.creditsLookup.status !== "unqueried";
  const disabled = creditsStarting || library.credits?.running || !apiAvailable || creditsCoolingDown(a);
  const groups = groupProducers(a);
  const people = new Set(groups.map((group) => group.person.name.normalize("NFKC").toLocaleLowerCase())).size;
  const tracks = new Set(groups.flatMap((group) => [...group.tracks.keys()])).size;
  return `<section class="producer-section" data-credits-album="${esc(a.id)}"><div class="producer-heading"><div><small>ALBUM CREDITS</small><h3>制作人员</h3></div>${!demo ? `<button data-action="${retry ? "credits-retry" : "credits-album"}" ${disabled ? "disabled" : ""}>${retry ? "重新查询 ↻" : "查询制作信息 ↗"}</button>` : ""}</div>${groups.length ? `<p class="producer-overview">${people} 位参与人员${tracks ? ` · 涉及 ${tracks} 首曲目` : ""}<span>职责按下方曲目记录</span></p><ul class="producer-list">${groups.map((group) => {
    const entries = [...group.tracks.values()];
    const urls = [...new Set(group.entries.map((entry) => entry.url).filter(Boolean))];
    const source = producerSource({ ...group.person, url: urls.length === 1 ? urls[0] : undefined }, a);
    const trackMarkup = entries.length > 1
      ? `<details class="producer-tracks" data-credit-group="${esc(group.key)}"><summary>参与 ${entries.length} 首曲目<span aria-hidden="true">＋</span></summary><ul>${entries.map((track) => `<li><strong>${esc(track.title)}</strong><span>${[...track.roles].map(esc).join(" · ")}</span><small class="producer-source">来源：${[...new Map(track.entries.map((entry) => [entry.url || entry.source, entry])).values()].map((entry) => producerSource(entry, a)).join(" · ")}</small></li>`).join("")}</ul></details>`
      : entries.length === 1 ? `<p class="producer-track-note">参与曲目 · ${esc(entries[0].title)}${group.unscoped.size ? `<span>${[...entries[0].roles].map(esc).join(" · ")}</span>` : ""}</p>` : "";
    return `<li class="producer-person"><strong class="producer-name">${esc(group.person.name)}</strong><div class="producer-roles">${[...group.roles].map(esc).join(" · ")}</div><small class="producer-source">来源：${source}</small>${trackMarkup}${group.unscoped.size ? `<p class="producer-track-note">未细分曲目的署名 · ${[...group.unscoped].map(esc).join(" · ")}</p>` : ""}</li>`;
  }).join("")}</ul>` : "<p>暂无制作资料。</p>"}${!demo ? `<p class="credits-feedback" data-credits-feedback="${esc(a.id)}" role="status" aria-live="polite">${esc(creditsAlbumStatus(a))}</p>` : ""}</section>`;
}
function groupProducers(album: MusicAlbum) {
  type Person = MusicAlbum["producers"][number];
  const groups = new Map<string, {
    key: string;
    person: Person;
    entries: Person[];
    roles: Set<string>;
    unscoped: Set<string>;
    tracks: Map<string, { title: string; roles: Set<string>; entries: Person[] }>;
  }>();
  for (const person of album.producers) {
    const key = JSON.stringify([person.name.trim().normalize("NFKC").toLocaleLowerCase(), person.source]);
    let group = groups.get(key);
    if (!group) {
      group = { key, person, entries: [], roles: new Set(), unscoped: new Set(), tracks: new Map() };
      groups.set(key, group);
    }
    group.entries.push(person);
    group.roles.add(person.role);
    const exactTrack = person.trackId ? album.tracks.find((track) => track.id === person.trackId) : undefined;
    const titleMatches = !exactTrack && person.trackTitle ? album.tracks.filter((track) => track.title === person.trackTitle) : [];
    const trackId = exactTrack?.id || (titleMatches.length === 1 ? titleMatches[0].id : undefined);
    const title = exactTrack?.title || person.trackTitle;
    if (title) {
      const trackKey = trackId || `title:${title}`;
      let track = group.tracks.get(trackKey);
      if (!track) {
        track = { title, roles: new Set(), entries: [] };
        group.tracks.set(trackKey, track);
      }
      track.roles.add(person.role);
      track.entries.push(person);
    } else group.unscoped.add(person.role);
  }
  return [...groups.values()];
}
function producerSource(producer: MusicAlbum["producers"][number], album: MusicAlbum) {
  const name = producer.source === "QQ Music" ? "QQ 音乐"
    : producer.source === "local" ? "本地标签"
    : producer.source === "manual" ? "手动补充" : producer.source;
  const candidate = producer.url || (producer.source === "MusicBrainz" ? album.online?.sourceUrl : undefined);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:")
        return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>`;
    } catch { /* A missing or malformed source URL still keeps its source label. */ }
  }
  return esc(name);
}
function creditsCoolingDown(album: MusicAlbum) {
  return !!album.creditsLookup?.retryAt && Date.parse(album.creditsLookup.retryAt) > Date.now();
}
function creditsAlbumStatus(album: MusicAlbum) {
  if (!apiAvailable) return "本地音乐服务尚未连接，已有制作信息仍可阅读。";
  if (creditsRequestError && creditsRequestAlbumId === album.id)
    return `无法开始查询：${creditsRequestError}。已有制作信息仍然保留。`;
  if (creditsStarting || library.credits?.running)
    return "正在查询制作信息，已有资料仍可阅读，完成后自动更新。";
  const lookup = album.creditsLookup;
  const kept = album.producers.length ? " 已有制作信息仍然保留。" : "";
  const cooldown = creditsCoolingDown(album)
    ? ` 可在 ${new Date(lookup!.retryAt!).toLocaleString("zh-CN")} 后重新查询。` : "";
  if (lookup?.status === "partial")
    return `已取得 ${lookup.matchedTracks || 0} / ${lookup.totalTracks || album.tracks.length} 首曲目的参与人员，尚未覆盖整张专辑。${lookup.error ? ` ${lookup.error}` : ""}${cooldown}`;
  if (lookup?.status === "matched")
    return `制作信息已保存在本机，可离线阅读。${lookup.totalTracks ? ` 已核对 ${lookup.matchedTracks || 0} / ${lookup.totalTracks} 首曲目。` : ""}${cooldown}`;
  if (lookup?.status === "uncertain")
    return `尚无法可靠确认对应曲目，未采用存疑的参与人员。${kept}${cooldown}`;
  if (lookup?.status === "not-found")
    return `本次未找到可核实的制作信息。${kept}${cooldown}`;
  if (lookup?.status === "error")
    return `制作信息查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${kept}${cooldown}`;
  return "在线制作信息尚未查询。按曲目核对参与人员，本地标签和已有资料会保留。";
}
function creditsRunSummary(job: NonNullable<MusicLibrary["credits"]>) {
  return job.error ? `制作信息查询未完成：${job.error}`
    : job.total > 0
      ? `制作信息查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张；曲目覆盖情况见各专辑。`
      : "当前没有需要查询的制作信息，已有缓存和查询冷却期会保留。";
}
function renderCurrentCredits() {
  const album = currentAlbum();
  const section = document.querySelector<HTMLElement>("#album-tab-content .producer-section");
  if (!album || !section || section.dataset.creditsAlbum !== album.id) return;
  const article = $("#album-detail-content");
  const scroll = article.scrollTop;
  const hadFocus = section.contains(document.activeElement);
  const openGroups = new Set([...section.querySelectorAll<HTMLDetailsElement>("details[open]")].map((details) => details.dataset.creditGroup));
  const focusedGroup = (document.activeElement as HTMLElement | null)?.closest<HTMLDetailsElement>("details[data-credit-group]")?.dataset.creditGroup;
  section.outerHTML = producerBlock(album);
  for (const details of document.querySelectorAll<HTMLDetailsElement>("#album-tab-content .producer-tracks")) {
    details.open = openGroups.has(details.dataset.creditGroup);
    if (hadFocus && focusedGroup === details.dataset.creditGroup)
      details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  }
  article.scrollTop = scroll;
  if (hadFocus && !focusedGroup)
    document.querySelector<HTMLButtonElement>("#album-tab-content .producer-section button")?.focus({ preventScroll: true });
}
function updateCreditsStatus() {
  const job = library.credits;
  const running = creditsStarting || !!job?.running;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="credits-album"], [data-action="credits-retry"]',
  )) {
    const album = currentAlbum();
    control.disabled = running || !apiAvailable || !album || creditsCoolingDown(album);
  }
  for (const feedback of document.querySelectorAll<HTMLElement>("[data-credits-feedback]")) {
    const album = albums.find((a) => a.id === feedback.dataset.creditsFeedback);
    if (album) feedback.textContent = creditsAlbumStatus(album);
  }
  const button = document.querySelector<HTMLButtonElement>("#credits-refresh");
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length || demo;
    button.textContent = running ? "正在查询制作信息…" : "查询缺失的制作信息 ↗";
  }
  const progress = document.querySelector<HTMLProgressElement>("#credits-progress");
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (creditsStarting && !job?.running) progress.removeAttribute("value");
  }
  const coverage = document.querySelector<HTMLElement>("#credits-coverage");
  if (coverage) {
    const withCredits = library.albums.filter((album) => album.producers.length > 0).length;
    const partial = library.albums.filter((album) => album.creditsLookup?.status === "partial").length;
    coverage.textContent = `已有制作信息 ${withCredits} / ${library.albums.length} 张${partial ? ` · 其中 ${partial} 张在线资料仅覆盖部分曲目` : ""}`;
  }
  const status = document.querySelector<HTMLElement>("#credits-status");
  if (status)
    status.textContent = !apiAvailable ? "本地音乐服务尚未连接。"
      : creditsRequestError ? `无法开始查询：${creditsRequestError}`
      : !library.albums.length ? "暂无本地专辑。"
      : creditsStarting ? "正在提交制作信息查询…"
      : job?.running
        ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}${job.trackTotal ? ` · 曲目 ${job.trackCompleted || 0} / ${job.trackTotal}` : ""}`
        : job ? creditsRunSummary(job)
          : "";
}
function updatePlayingRows() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
}
let lastTransitionWarning = "";
const transportTitleMotion = setupTransportTitle(
  $<HTMLButtonElement>("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
/** 本地歌单读写（对照参考行为的本地歌单：新建/重命名/删除/收藏/加歌）。 */
const localPlaylists = new LocalPlaylists();
// 收藏（本地「莱茵歌单」）：一行 songId 集合驱动全部 ♥ 的按下态。
// 每首歌一个心形收藏、固定心形不提供样式选择 —— 用户 定。
let favoriteIds = new Set<string>();
function refreshFavoriteHearts() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="song-favorite"]').forEach(button => {
    const pressed = favoriteIds.has(button.dataset.favoriteSong ?? '');
    button.setAttribute('aria-pressed', String(pressed));
    button.textContent = pressed ? '♥' : '♡';
  });
}
async function refreshFavoriteState() {
  try { favoriteIds = new Set((await localPlaylists.favorites()).map(song => song.id)); }
  catch { /* 后端未起时保持默认未收藏 */ }
  refreshFavoriteHearts();
}
void refreshFavoriteState();
/** 歌单面板里的本地歌单列表（新建/删除后刷新）。 */
let localPlaylistRows: LocalPlaylistSummary[] = [];
/** 当前正在往哪个本地歌单里加歌（「添加到歌单」对话框选中的目标）。 */
let addToPlaylistTarget = '';
/** 「添加到歌单」对话框的候选曲目。 */
let addToPlaylistTracks: MusicTrack[] = [];
/** 多选模式（对照参考行为 common.selectionMode）：勾选的是临时歌单里的行号。 */
let queueSelectMode = false;
const queueSelection = new Set<number>();
const playlistLibrary = new NeteasePlaylists(() => {
  if (panel === 'playlists') renderPlaylistsPanel();
 // 本地歌单（不登录也有）到达时把「我的歌单」入口放出来。
  if (playlistLibrary.playlists.length) updateStatus();
  clearTimeout(playlistRenderTimer);
  if (accountView) playlistRenderTimer = setTimeout(() => void rebuildPlaylistGrid(), 200);
});
// 启动时把偏好里的歌单排序交给库（对照参考行为 playlist.sort.*）。
playlistLibrary.setLocalSort(preferences.playlistSort, preferences.playlistSortDirection);
/** 收藏集合变了以后，如果歌单墙上正翻的是「莱茵歌单」，立刻重读它的曲目并重画。
 *
 * 用户要求：收藏 → 进莱茵歌单；取消收藏 → 退出莱茵歌单。
 * 后端 `/api/playlists/favorites` 已经做了增删（收藏存在 favorites 歌单里），
 * 但歌单墙拿的是 `playlistLibrary` 里缓存的分页，不会因为一次 POST/DELETE 自己失效。
 * 所以这里显式作废这一页再重建，才能让「取消收藏的那首歌当场从墙上消失」。
 * 只处理 favorites：其他歌单与收藏无关，不做无谓的全量重载。 */
async function syncFavoritesPlaylistWall() {
  if (!accountActive || !accountView || !scene || !ready || frameDisposed) return;
  const favoritesIndex = playlistLibrary.playlists.findIndex(playlist => playlist.favorites);
  if (favoritesIndex < 0) return;
 // 缓存里还是收藏前的分页，不先作废就会读到旧曲目（ensure 命中缓存直接返回）。
  playlistLibrary.invalidatePlaylist(favoritesIndex);
 // 只有用户此刻确实停在莱茵歌单上才重画；否则只更新歌单面板里的曲目数。
  const showingFavorites = albums[selected]?.playlistCell?.playlistId === 'favorites';
  if (!showingFavorites) { void refreshPlaylistTrackCount(favoritesIndex); return; }
  playlistNavigationTarget = undefined;
  void playlistLibrary.ensure(favoritesIndex, 0, true).then(() => rebuildPlaylistGrid());
}
/** 静默刷新单个歌单的曲目数（不重画 3D 墙），让歌单列表里的「N 首」跟上。 */
async function refreshPlaylistTrackCount(index: number) {
  const playlist = playlistLibrary.playlists[index];
  if (!playlist) return;
  try {
    await playlistLibrary.ensure(index, 0, true);
    const total = playlist.trackCount;
    if (typeof total !== 'number') return;
    playlistLibrary.playlists[index] = { ...playlist, trackCount: total };
  } catch { /* 计数刷新失败不影响收藏动作本身 */ }
}
function rebuildPlaylistGrid() {
  if (!accountActive || !accountView || !scene || !ready || frameDisposed) return Promise.resolve();
  clearTimeout(playlistRenderTimer);
  const generation = ++playbackVisualGeneration;
  playbackVisualTask = playbackVisualTask.then(async () => {
    if (generation !== playbackVisualGeneration || !accountActive || !accountView || !scene || frameDisposed) return;
    const previousId = currentAlbum()?.id;
    const next = playlistLibrary.albums();
    if (next === albums && stage.classList.contains('playlist-grid')) { updateStatus(); return; }
    const preserveSurface = stage.classList.contains('playlist-grid') && next.some(album => album.id === previousId);
    if (!preserveSurface) { cancelTrackReveal(); presentation.reset(); detailTransition.hide(true); browseTransition.hide(true); }
    albums = next; genres = []; selected = Math.max(0, next.findIndex(album => album.id === previousId));
 // 落点不能在空歌单上：「莱茵歌单」没收藏前是空的，停在它上面用户看到
 // 的是一片空白。只有当上一张专辑对不上（首次进入歌单墙，或从专辑架切过来）
 // 时才往前找第一个有歌的歌单；正在歌单之间浏览时保持用户的选择。
    const landingOnEmpty = !next[selected] || (next[selected].playlistCell?.total ?? 0) === 0;
    if (landingOnEmpty && !next.some(album => album.id === previousId)) {
      const playable = next.findIndex(album => (album.playlistCell?.total ?? 0) > 0);
      if (playable >= 0) selected = playable;
    }
    setPlaylistAlbums(albums, playlistLibrary.playlists.map(playlist => playlist.name));
    scene.setMusicArrayMode('filled'); libraryRebuilding = true;
    try { await scene.refreshLibrary(selected, true); } finally { libraryRebuilding = false; }
    if (frameDisposed || !accountView || !accountActive) return;
    stage.classList.remove('playback-albums'); stage.classList.add('playlist-grid');
    stage.classList.toggle('empty-library', !albums.length && !playlistLibrary.playlists.length);
    if (!preserveSurface) {
      scene.setMode('archive'); scene.showMusicArchiveImmediately(performance.now() / 1000);
      if (albums.length) showBrowseSurface(); else browseTransition.hide(true);
    } else if (presentation.phase === 'detail') renderDetail();
    updateSelection(); updateStatus();
    preloadNearbyCovers();
  }).catch(error => notify(`歌单视图未能更新：${(error as Error).message}`));
  return playbackVisualTask;
}
async function navigatePlaylist(row: number, song: number, navigation?: ArchiveNavigation) {
  row = wrap(row, playlistLibrary.playlists.length);
  const playlist = playlistLibrary.playlists[row]; if (!playlist || !accountActive) return;
  const generation = ++playlistSelectionEpoch;
  accountView = true;
  const position = wrap(song, Math.max(1, playlist.trackCount));
  const base = playlistNavigationTarget?.cell || scene?.musicSelectionCell || fileLocation(selected);
  const cell = navigation && 'cell' in navigation ? navigation.cell : {
    lane: navigation?.axis === 'lane' ? base.lane + navigation.direction : nearestOccurrence(row + 2, base.lane, playlistLibrary.playlists.length),
    row: navigation?.axis === 'row' ? base.row + navigation.direction : nearestOccurrence(position + 12, base.row, Math.max(1, playlist.trackCount)),
  };
  playlistNavigationTarget = { row, song: position, cell };
  updateStatus();
  const cachedIndex = records.findIndex(record => record.album?.playlistCell?.playlistId === playlist.id && record.album.playlistCell.songIndex === position);
  if (cachedIndex >= 0 && (records[cachedIndex].album?.tracks.length || !playlist.trackCount)) {
 // Start the existing motion immediately; metadata and cover decoding stay asynchronous.
    select(cachedIndex, { cell }, presentation.openingOrDetail);
    playlistNavigationTarget = undefined; updateStatus();
    void playlistLibrary.window(row, cell.row - 12); return;
  }
  try {
    await playlistLibrary.ensure(row, position, true);
    if (generation !== playlistSelectionEpoch || !accountActive || !accountView || frameDisposed) return;
    await rebuildPlaylistGrid();
    if (generation !== playlistSelectionEpoch || !accountActive || !accountView) return;
    const index = records.findIndex(record => record.album?.playlistCell?.playlistId === playlist.id && record.album.playlistCell.songIndex === position);
    if (index >= 0) select(index, { cell }, presentation.openingOrDetail);
    playlistNavigationTarget = undefined;
    updateStatus();
    void playlistLibrary.window(row, cell.row - 12);
  } catch (error) { if (generation === playlistSelectionEpoch && accountActive) { playlistNavigationTarget = undefined; updateStatus(); notify((error as Error).message); } }
}
function syncPlaylistNavigation() {
  const cell = records[navigationSelection()]?.album?.playlistCell; if (!cell) return;
  $('.music-counter .music-eyebrow').textContent = 'SONG / SELECT';
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
    const previous = button.dataset.action === 'prev';
    button.disabled = cell.total < 2;
    button.setAttribute('aria-label', previous ? '上一首歌曲' : '下一首歌曲');
    if (button.closest('.detail-album-navigation')) button.textContent = previous ? '↑ 上一首歌曲' : '下一首歌曲 ↓';
  }
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="genre-prev"], [data-action="genre-next"]')) {
    const previous = button.dataset.action === 'genre-prev';
    button.disabled = playlistLibrary.playlists.length < 2;
    button.setAttribute('aria-label', previous ? '上一个歌单' : '下一个歌单');
  }
  $('.open-album').innerHTML = '歌曲详情 <span>↗</span>';
  $('.music-back').textContent = '← 返回歌单';
}
let playlistPlayEpoch = 0, playlistQueuePending = false, playlistPlaybackSong = 0;
async function playPlaylistAt(row: number, song: number) {
  const playlist = playlistLibrary.playlists[row];
  if (!playlist?.trackCount || !accountActive || playerState.backend !== 'browser') return;
  const generation = ++playlistPlayEpoch, position = wrap(song, playlist.trackCount);
  try {
    // 整张歌单当队列：必须全量，否则播到第 100 首就没下一首了。
    const queue = await playlistLibrary.queue(row, position, { full: true });
    if (generation !== playlistPlayEpoch || !accountActive || frameDisposed) return;
    const track = playlistLibrary.track(row, position);
    if (!track) { notify('这首歌曲暂时不可用。'); return; }
    if (playlistPlaybackId !== playlist.id) followedPlaylistTrack = undefined;
    playlistPlaybackId = playlist.id; playlistPlaybackSong = position;
    await player.play(track.id, queue);
  } catch (error) { if (generation === playlistPlayEpoch && accountActive) notify((error as Error).message); }
}
async function stepPlayingSong(direction: number) {
  const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === playlistPlaybackId);
  const song = row >= 0 && playerState.currentTrack ? playlistLibrary.position(row, playerState.currentTrack.id) ?? playlistPlaybackSong : undefined;
  if (song !== undefined) { await playPlaylistAt(row, song + direction); return; }
  if (direction > 0) await player.next(); else await player.previous();
}
async function playPlaylistSong() {
  const cell = currentAlbum()?.playlistCell; if (!cell || !currentAlbum()?.tracks.length) return;
  if (playerState.backend !== 'browser') { notify('当前音频输出不支持在线歌曲。'); return; }
  if (playlistPlaybackId === cell.playlistId && playerState.currentTrack?.id === currentAlbum()?.tracks[0]?.id && !playerState.error && playerState.transport !== 'idle') {
    if (!playerState.playing) await player.toggle(); return;
  }
  const generation = ++playlistPlayEpoch;
  if (playlistPlaybackId !== cell.playlistId) followedPlaylistTrack = undefined;
  playlistPlaybackId = cell.playlistId; playlistPlaybackSong = cell.songIndex;
  try {
    const queue = await playlistLibrary.queue(cell.playlistIndex, cell.songIndex);
    if (generation !== playlistPlayEpoch || !accountActive || frameDisposed) return;
    const track = playlistLibrary.track(cell.playlistIndex, cell.songIndex); if (track) await player.play(track.id, queue);
  } catch (error) { if (generation === playlistPlayEpoch && accountActive) notify((error as Error).message); }
}
function followPlaylistPlayback(state: MusicPlayerState) {
  if (!playlistPlaybackId || !state.currentTrack || state.transport === 'idle') return;
  const row = playlistLibrary.playlists.findIndex(playlist => playlist.id === playlistPlaybackId);
  const album = albums.find(album => album.playlistCell?.playlistId === playlistPlaybackId && album.tracks[0]?.id === state.currentTrack?.id);
  const cell = album?.playlistCell; if (!cell) return;
  playlistPlaybackSong = cell.songIndex;
  if (followedPlaylistTrack !== state.currentTrack.id) {
    followedPlaylistTrack = state.currentTrack.id;
    const index = records.findIndex(record => record.id === album.id);
    if (index >= 0 && accountView) select(index, undefined, presentation.openingOrDetail);
  }
  if (playlistQueuePending || state.queue.length - state.currentIndex > 25) return;
  playlistQueuePending = true;
  const generation = playlistPlayEpoch, id = state.currentTrack.id;
  void playlistLibrary.queue(row, cell.songIndex).then(queue => {
    if (generation !== playlistPlayEpoch || !accountActive || playerState.currentTrack?.id !== id || playerState.transport === 'idle') return;
    if (queue.map(track => track.id).join(',') !== playerState.queue.map(track => track.id).join(',')) player.setQueue(queue);
  }).catch(error => { if (accountActive && generation === playlistPlayEpoch) notify((error as Error).message); }).finally(() => { playlistQueuePending = false; });
}
/** 本地歌单面板：新建/重命名/删除/收藏，与临时歌单并排（对照参考行为）。
 *
 * 上游把「我的歌单」面板分成两块：上面是本地歌单的增删改，下面是当前的临时
 * 歌单（queue）。这里沿用同一结构，但只做本地歌单这一块 —— 平台歌单的增删
 * 由平台自己管， Rhine 不提供写入口。 */
function renderLocalPlaylistsPanel() {
  const host = document.querySelector<HTMLElement>('#local-playlists'); if (!host) return;
  const rows = localPlaylistRows;
 // 用户要求这一层只留「我的歌单」本身：新建/导入/批量/加入当前歌曲四个按钮、
 // 歌曲排序与升降序、每行的「01」序号和「N 首 · 收藏」全部去掉。
 // 相关 handler 保留 —— 详情页的「加入歌单」仍然走 song-add-to-playlist。
  host.innerHTML = rows.length ? `<div class="playlist-list local-playlist-list">${rows.map((item) => `
      <div class="album-result local-playlist-row${item.favorites ? ' local-playlist-favorites' : ''}" data-local-playlist="${esc(item.id)}">
        <button class="local-playlist-open" data-local-playlist-open="${esc(item.id)}">
          <strong>${esc(item.name)}</strong>
        </button>
        <span class="local-playlist-actions">
          ${item.favorites ? '' : `<button class="text-button" data-action="local-playlist-rename" data-local-playlist-id="${esc(item.id)}" data-local-playlist-name="${esc(item.name)}" aria-label="重命名歌单 ${esc(item.name)}">重命名</button>`}
          ${item.favorites ? '' : `<button class="text-button" data-action="local-playlist-remove" data-local-playlist-id="${esc(item.id)}" data-local-playlist-name="${esc(item.name)}" aria-label="删除歌单 ${esc(item.name)}">删除</button>`}
        </span>
      </div>`).join('')}</div>`
      : '<p class="scan-status">还没有本地歌单。</p>';
}
/** 读一次本地歌单并重画面板。 */
async function refreshLocalPlaylistsPanel() {
  try { localPlaylistRows = await localPlaylists.list(true); }
  catch (error) { localPlaylistRows = []; notify(`本地歌单读取失败：${(error as Error).message}`); }
  renderLocalPlaylistsPanel();
}
/** 「加入歌单」对话框（对照参考行为 playlist.chooseTarget / addedCount）。
 *
 * 上游的流程：选目标歌单 → 加 → 报「已添加 n 首」/「部分歌曲已存在」/
 * 「所选歌曲已在该歌单中」。这里用同一套文案，但只列本地歌单 —— 平台歌单
 * 不接受前端写入。 */
function renderAddToPlaylistDialog() {
  const body = document.querySelector<HTMLElement>('#panel-body'); if (!body || panel !== 'playlists') return;
  const rows = localPlaylistRows;
 // 复用同一个 #queue-panel 容器：对话框只是临时替换它的内容，取消/加完再交回
 // renderPlaylistsPanel，这样本地歌单区（#local-playlists）始终不被重建。
  const host = body.querySelector<HTMLElement>('#queue-panel') ?? body;
  host.innerHTML = `<div class="add-to-playlist" aria-label="添加到歌单">
      <p class="scan-status">将选中歌曲添加到歌单</p>
      <div class="playlist-list">${rows.map(item => `
        <button class="album-result add-to-playlist-target" data-add-to-playlist="${esc(item.id)}" data-add-to-playlist-name="${esc(item.name)}">
          <strong>${esc(item.name)}</strong><small>${item.count} 首</small>
        </button>`).join('') || '<p class="scan-status">还没有歌单，先「新建歌单」创建一个。</p>'}</div>
      <button class="text-button" data-action="add-to-playlist-cancel">取消</button>
    </div>`;
}
/** 打开「加入歌单」对话框，记录待加入的曲目。 */
function openAddToPlaylist(tracks: MusicTrack[]) {
  if (!tracks.length) { notify('没有可加入歌单的歌曲。'); return; }
  addToPlaylistTracks = tracks; addToPlaylistTarget = '';
  if (panel !== 'playlists') openPanel('playlists');
  else renderAddToPlaylistDialog();
}
function renderPlaylistsPanel() {
  const body = document.querySelector<HTMLElement>('#panel-body'); if (!body || panel !== 'playlists') return;
  queuePanelSignature = `${playerState.mode}|${playerState.currentTrack?.id || ''}|${playerState.queue.length}`;
 // 本地歌单区是**常驻**节点：临时歌单每次重画都不该把它连带重建（否则面板
 // 打开时点「新建歌单」会被下一次播放态刷新打断，节点被 detach）。
  let host = body.querySelector<HTMLElement>('#local-playlists');
  if (!host) {
    body.innerHTML = `<section class="local-playlists" id="local-playlists" aria-label="本地歌单"></section><div id="queue-panel"></div>`;
    host = body.querySelector<HTMLElement>('#local-playlists')!;
    void refreshLocalPlaylistsPanel();
  }
  const queueHost = body.querySelector<HTMLElement>('#queue-panel')!;
  const queue = playerState.queue;
 // 多选模式（对照参考行为 common.selectionMode / selected / selectAll / deleteSelected）：
 // 勾选中的行可以一次性移出临时歌单，也可以整批加进本地歌单。
  const picked = queueSelection;
  const toolbar = `<div class="queue-toolbar">
      <button class="text-button" data-action="queue-select-mode">${queueSelectMode ? '退出批量选择' : '批量选择'}</button>
      ${queueSelectMode ? `<button class="text-button" data-action="queue-select-all">全选</button>
      <button class="text-button" data-action="queue-select-clear">清除所选</button>
      <span class="queue-selection-count">已选 ${picked.size} 首</span>
      <button class="text-button" data-action="queue-selection-remove">移出歌单</button>
      <button class="text-button" data-action="queue-selection-add">加入歌单</button>` : ''}
    </div>`;
  const rows = queue.length ? `<div class="playlist-list">${queue.map((track, index) => {
    const selected = picked.has(index);
    return `<div class="album-result queue-row${track.id === playerState.currentTrack?.id ? ' queue-row-active' : ''}${selected ? ' queue-row-selected' : ''}">
      ${queueSelectMode ? `<button class="queue-select" data-queue-select="${index}" aria-pressed="${selected}" aria-label="${selected ? '取消选择' : '选择'} ${esc(track.title)}">${selected ? '✓' : ''}</button>` : ''}
      <button class="queue-play" data-queue-play="${index}"><strong>${esc(track.title)}</strong><small>${esc(track.artist)}</small></button>
      <button class="text-button song-favorite" data-action="song-favorite" data-favorite-song="${esc(track.id)}" aria-pressed="${favoriteIds.has(track.id)}" aria-label="收藏 ${esc(track.title)}">${favoriteIds.has(track.id) ? '♥' : '♡'}</button>
      ${queueSelectMode ? '' : `<button class="text-button queue-remove" data-queue-remove="${index}" aria-label="从歌单移除 ${esc(track.title)}">×</button>`}
    </div>`;
  }).join('')}</div>` : '<p class="scan-status">去“我的歌单”里双击一个歌单，把它替换进临时歌单。</p>';
  queueHost.innerHTML = `<p role="status">${queue.length ? `${queue.length} 首 · 当前模式：${playModeNames[playerState.mode]}` : '临时歌单是空的。'}</p>${toolbar}${rows}`;
}
/** Every provider's login state: the playlist platform selector shows the
 * logged-in platforms and the sorted account set drives account-change resets. */
const accountStates: Partial<Record<MusicProvider, NeteaseAccount>> = {};
let playlistPlatformView: PlaylistSource | 'all' = 'all';
function loggedInProviders(): MusicProvider[] {
  return (Object.keys(musicPlatforms) as MusicProvider[]).filter(provider => accountStates[provider]?.loggedIn);
}
/** 歌单来源选择器的平台显示顺序。用户指定：
 * 网易云 → 酷狗 → QQ → 莱茵（本地，最后）
 * 未在此列出的平台（波点/酷我/JOOX）按原顺序跟在 QQ 之后、莱茵之前，
 * 这样以后新增平台也不会被静默丢掉。 */
const playlistSourceRank: Partial<Record<PlaylistSource, number>> = {
  netease: 0, kugou: 1, qq: 2,
};
function playlistViewProviders(): PlaylistSource[] {
 // 本地歌单永远在列表里（不登录也有），平台歌单按登录态追加。
  const platforms = loggedInProviders()
 // 稳定排序：只比较用户点名的三个平台，其余保持 musicPlatforms 的原始相对顺序。
    .map((provider, index) => ({ provider, index, rank: playlistSourceRank[provider] ?? 3 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.provider);
 // 莱茵（本地）固定最后：它不再是默认落点，也不该排在平台前面。
  if (playlistPlatformView === 'all') return [...platforms, 'local'];
  return playlistPlatformView === 'local' ? ['local'] : [playlistPlatformView];
}
function renderPlaylistPlatformOptions() {
  const picker = document.querySelector<HTMLElement>('#playlist-platform-picker');
  const trigger = document.querySelector<HTMLButtonElement>('#playlist-platform');
  const menu = document.querySelector<HTMLElement>('#playlist-platform-menu');
  if (!picker || !trigger || !menu) return;
  const providers = loggedInProviders();
  if (playlistPlatformView !== 'all' && playlistPlatformView !== 'local' && !providers.includes(playlistPlatformView)) playlistPlatformView = 'all';
 // 选择器始终显示：本地歌单不登录也在，所以不再用登录与否决定显隐。
  picker.hidden = false;
  const options: { value: PlaylistSource | 'all'; label: string }[] = [{ value: 'all', label: '全部' }];
 // 用户要求：网易云 → 酷狗 → QQ → 莱茵（最后）。莱茵音乐固定垫底。
  providers
    .map((provider, index) => ({ provider, index, rank: playlistSourceRank[provider] ?? 3 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .forEach(({ provider }) => options.push({ value: provider, label: musicPlatforms[provider] }));
  options.push({ value: 'local', label: localPlaylistName });
  const current = options.find(item => item.value === playlistPlatformView) ?? options[0];
  trigger.innerHTML = `${esc(current.label)} <i aria-hidden="true">▾</i>`;
  menu.innerHTML = options.map(item =>
    `<button type="button" role="option" class="nav-platform-option" data-platform="${item.value}" aria-selected="${item.value === current.value}">${esc(item.label)}</button>`).join('');
}
/** 自定义下拉的交互：点箭头展开、选一项写回、点别处收起。
 *
 * 为什么不用原生 `<select>`：它的展开列表由系统绘制，圆角/间距一律改不动，
 * 用户反馈那个「抽屉的方框太尖锐」。这里自己画一个 12px 圆角的面板。 */
function mountPlaylistPlatformPicker(): void {
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const menu = document.querySelector<HTMLElement>('#playlist-platform-menu');
    const trigger = document.querySelector<HTMLButtonElement>('#playlist-platform');
    if (!menu || !trigger) return;
    const option = target.closest<HTMLElement>('[data-platform]');
    if (option && menu.contains(option)) {
      playlistPlatformView = option.dataset.platform as PlaylistSource | 'all';
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      renderPlaylistPlatformOptions();
      applyPlaylistPlatformView();
      return;
    }
    if (target.closest('#playlist-platform')) {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }
    if (!menu.hidden && !menu.contains(target)) {
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    }
  });
}
// 启动即建好下拉并填一次选项：默认显示「全部」，不需要先登录。
mountPlaylistPlatformPicker();
renderPlaylistPlatformOptions();
function applyPlaylistPlatformView() {
  paintOverviewHeading();
  playlistLibrary.setProviders(playlistViewProviders());
  if (!accountActive) return;
  accountView = true; playlistSelectionEpoch++;
  const key = accountKey;
  void playlistLibrary.load().then(() => { if (key === accountKey && accountActive && accountView) void playlistLibrary.window(firstPlayablePlaylist(), 0); });
}
function paintOverviewHeading() {
 // 用户要求：这一页就是「我的歌单」，不要再拼来源（原来会变成
 // 「我的歌单 · 网易云音乐」，看起来像只显示了一个平台的歌单）。
  $('.overview-heading h2').textContent = accountView ? '我的歌单' : `${sortLabel.name}浏览收藏`;
}
function onlineAccountChanged(provider: MusicProvider, account: NeteaseAccount) {
  accountStates[provider] = account;
  renderPlaylistPlatformOptions();
  if (account.loggedIn && (provider === activeProvider || provider === loginProvider)) { activeProvider = provider; save("rhine-online-provider", provider); }
  const anyAccount = loggedInProviders().length > 0;
  const button = $<HTMLButtonElement>('#netease-login-button');
 // The header shows one avatar only: no nickname, no platform name.
  button.dataset.auth = anyAccount ? 'in' : 'out';
  button.setAttribute('aria-label', anyAccount ? '账号（已登录），打开账号面板' : '账号（未登录），打开登录面板');
 // 歌单视图不再依赖登录：本地歌单不登录也要能看能建，
 // 这与上游一致 —— 上游的本地歌单在没有账号时照常可用。
  $('#my-playlists-button').hidden = false;
  const nextKey = [...loggedInProviders()].sort().map(p => `${p}:${accountStates[p]?.profile?.userId || accountStates[p]?.profile?.nickname || p}`).join('|');
 // 首次进入（含「没有任何账号」）也要把歌单读进来：本地歌单不依赖登录。
  const firstBoot = !bootedPlaylists;
  bootedPlaylists = true;
  if (nextKey === accountKey && !firstBoot) return;
  accountKey = nextKey; accountActive = true; playlistSelectionEpoch++; playlistPlayEpoch++; playlistNavigationTarget = undefined;
  playlistOverviewRequested = false;
  if (overview) setOverview(false, false);
  songView.invalidate();
  playlistLibrary.setProviders(playlistViewProviders());
 // An account change invalidates its search results as well as private playlist pages.
  onlineSearch.clear();
  followedPlaylistTrack = undefined; playlistPlaybackId = undefined; playbackVisualKey = ''; player.stop();
 // 登录态变化只**刷新歌单数据**，不抢占当前视图 —— 用户还在看专辑架时
 // 不该被切到歌单墙（本地歌单也随时可读，点「我的歌单」按钮才进入）。
 // 例外：真的登录成功时沿用既有行为，直接跟进歌单视图。
  const wasShowing = accountView;
  if (wasShowing) {
    const key = accountKey;
    void playlistLibrary.load().then(() => { if (key === accountKey && accountActive && accountView) void playlistLibrary.window(firstPlayablePlaylist(), 0); });
  } else {
    playlistLibrary.dispose(); clearTimeout(playlistRenderTimer);
    if (anyAccount) {
 // 登录即跟进歌单墙（首次登录或切换账号）：读歌单数据并选中第一个有歌的歌单，
 // 但**不自动打开 3D 总览** —— 是否进入总览由用户点「我的歌单」决定。
      accountView = true; followedPlaylistTrack = undefined;
      const key = accountKey;
      void playlistLibrary.load().then(() => {
        if (key !== accountKey || !accountActive || !accountView) return;
        void playlistLibrary.window(firstPlayablePlaylist(), 0);
      });
    } else {
 // 没有任何账号：只把本地歌单读进来备用，不切换视图。
      const key = accountKey;
      void playlistLibrary.load().then(() => { if (key === accountKey) updateStatus(); });
    }
  }
}
/** 进入歌单墙时的初始落点：第一个有歌的歌单。本地「莱茵歌单」在没收藏
 * 前是空的，落在上面用户看到的是一片空白，所以跳过空歌单（全空则停在 0）。 */
function firstPlayablePlaylist(): number {
  const index = playlistLibrary.playlists.findIndex(playlist => playlist.trackCount > 0);
  return index < 0 ? 0 : index;
}
const platformLogins: Record<MusicProvider, NeteaseLogin> = {
  netease: new NeteaseLogin(account => onlineAccountChanged("netease", account)),
  qq: new NeteaseLogin(account => onlineAccountChanged("qq", account), "qq"),
  bodian: new NeteaseLogin(account => onlineAccountChanged("bodian", account), "bodian"),
  kugou: new NeteaseLogin(account => onlineAccountChanged("kugou", account), "kugou"),
 // 酷我与 JOOX 搜索免账号、播放不要求登录（JOOX 播放本身未接入），登录页签不展示它们；
 // 条目仅为 Record 完整性而存在。
  kuwo: new NeteaseLogin(account => onlineAccountChanged("kuwo", account), "kuwo"),
  joox: new NeteaseLogin(account => onlineAccountChanged("joox", account), "joox"),
};
const loginHiddenProviders = new Set<MusicProvider>(["kuwo", "joox"]);
function disposePlatformLogin() { Object.values(platformLogins).forEach(login => login.dispose()); }
function renderLoginPanel() {
  disposePlatformLogin();
  $("#panel-body").innerHTML = `<div class="search-sources login-platforms" role="group" aria-label="登录平台">${(Object.keys(musicPlatforms) as MusicProvider[]).filter(provider => !loginHiddenProviders.has(provider)).map(provider => `<button data-login-provider="${provider}" aria-pressed="${provider === loginProvider}">${musicPlatforms[provider]}</button>`).join("")}</div><section class="netease-login dedicated-login"></section>`;
  platformLogins[loginProvider].mount($(".dedicated-login"), true);
}
const onlineSearch = new OnlineMusicSearch((track, queue) => {
  browseLibraryDuringPlayback = false; playbackVisualKey = '';
  if (accountActive) accountView = false;
  if (playerState.backend !== "browser") { notify("当前音频输出不支持在线歌曲。"); return; }
  if (playerState.currentTrack?.id === track.id && !playerState.error) void player.toggle();
  else { playlistPlaybackId = undefined; playlistPlayEpoch++; void player.play(track.id, queue); }
}, platformLogins[activeProvider]);
// 搜索行每次重画后回填 ♥ 的收藏态（异步取一次收藏表）。
onlineSearch.onRender = () => refreshFavoriteHearts();
const mvPlayer = new MvPlayer();
/** 版本更新：启动后异步检查 GitHub，之后每小时一次（见 update-center.ts）。 */
const updateCenter = new UpdateCenter();
function detailOnlineTrack(): MusicTrack | undefined {
  return currentAlbum()?.tracks[0]?.onlineSource ? currentAlbum()?.tracks[0] : undefined;
}
async function openSongMv(track: MusicTrack) {
  const mv = track.onlineSource?.mv;
  if (!track.onlineSource || !mv) return;
  try {
    let src = mv.url || '';
    if (!src && mv.id) {
      const provider = track.onlineSource.provider;
      const response = await fetchOnline(provider, 'mv', `/api/online/${provider}/mv/${encodeURIComponent(mv.id)}`);
      const value = await response.json() as { url?: string; error?: string };
      if (!response.ok || !value.url) throw new Error(value.error || '这个 MV 暂时无法在线观看。');
      src = value.url;
    }
    if (!src) throw new Error('这个 MV 暂时无法在线观看。');
 // 下载走与歌曲同一条 /api/downloads 队列：MV 是 ISO-BMFF 视频，format 用
 // mp4（下载器会按 ftyp 魔数校验并保留 .mp4 后缀）。标题加「 MV」，
 // 免得和同名歌曲的文件撞名被覆盖。
    const mvUrl = src;
    mvPlayer.open({
      title: track.title,
      artist: track.artist,
      src: mvUrl,
      download: async () => {
        const reply = await fetch('/api/downloads', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: mvUrl, title: `${track.title} MV`, artist: track.artist, format: 'mp4' }),
        });
        const body = await reply.json().catch(() => ({})) as { error?: string };
        if (!reply.ok) throw new Error(body.error || '无法加入下载队列。');
        return '已加入下载队列，可在下载面板查看进度。';
      },
    });
  } catch (error) {
    notify(error instanceof Error ? error.message : 'MV 加载失败，可能是网络或音源限制。');
  }
}
let playbackVisualKey = '';
let playbackVisualTask = Promise.resolve();
let playbackVisualGeneration = 0;
/** Follow a clicked search row (or a 换源 switch) into the play detail once the
 * playback cards settle; ordinary playback keeps the established behavior. */
let openDetailAfterQueueSettle = false;
function syncPlaybackAlbums(state: MusicPlayerState) {
  if (accountActive && accountView) { followPlaylistPlayback(state); return; }
  if (!ready || !scene || boot?.active) return;
  if (browseLibraryDuringPlayback && playbackBrowseTrackId === state.currentTrack?.id && state.transport !== 'idle') return;
  browseLibraryDuringPlayback = false;
  const active = !!state.currentTrack && state.transport !== 'idle';
  const key = active ? JSON.stringify([state.currentTrack!.id, state.queue.map(track => [track.id, track.albumId, track.onlineSource?.coverUrl])]) : '';
  if (key === playbackVisualKey) return;
  playbackVisualKey = key;
  const generation = ++playbackVisualGeneration;
  playbackVisualTask = playbackVisualTask.then(async () => {
    if (generation !== playbackVisualGeneration || frameDisposed || !scene) return;
    if (!active) { await applyLibrary(); scene.setMusicArrayMode(preferences.arrayMode); return; }
    const nextAlbums = playbackAlbums(state.queue, library.albums);
    const sameQueue = records.length === nextAlbums.length && records.every((record, index) => record.id === nextAlbums[index].id);
    if (sameQueue) {
      select(state.currentIndex, undefined, openDetailAfterQueueSettle || presentation.openingOrDetail);
      openDetailAfterQueueSettle = false; syncAlbumNavigation(); return;
    }
    if (overview) setOverview(false, false);
    cancelTrackReveal(); presentation.reset(); detailTransition.hide(true); browseTransition.hide(true);
    albums = nextAlbums; genres = [{ id: 'playback', name: '播放队列' }]; selected = state.currentIndex;
    setPlaybackAlbums(albums, MUSIC_LOOP_ROWS);
    scene.setMusicArrayMode('filled');
    libraryRebuilding = true;
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    if (frameDisposed) return;
    scene.setMode('archive'); scene.showMusicArchiveImmediately(performance.now() / 1000);
    stage.classList.remove('empty-library'); stage.classList.add('playback-albums');
    showBrowseSurface(); updateSelection(); updateStatus();
    if (openDetailAfterQueueSettle) { openDetailAfterQueueSettle = false; select(state.currentIndex, undefined, true); }
  }).catch(error => { playbackVisualKey = ''; notify(`播放队列封面未能更新：${(error as Error).message}`); });
  stage.classList.toggle('playback-albums', active);
}
applyAvatar();
let queuePanelSignature = '';
let playbackPersistSignature = '';
/** Persist only when the queue or mode changes; timeupdate emits must not
 * starve the save (a debounce would be reset on every progress tick). */
function persistPlaybackIfChanged() {
  const signature = `${playerState.mode}|${playerState.queue.map(track => track.id).join(',')}`;
  if (signature === playbackPersistSignature) return;
  playbackPersistSignature = signature;
  saveSavedPlayback({ mode: playerState.mode, tracks: [...playerState.queue] });
}
const songView = new MusicSongView($('#mini-playback-below'), seconds => player.seek(seconds), () => preferences.reduced);
// 音浪画布：挂在 stage 上，自己按「进度条上方 / 窗口底边」找位置搬过去。
// 注意 playerState 要到启动流程里才有值，这里必须按「可能还没有」写 ——
// configure() 会立刻读一次状态，读崩了会让整个模块初始化中断、开场卡死。
const visualizer = new MusicVisualizer(stage, target => player.readSpectrum(target), () => ({
  playing: playerState?.transport === 'playing',
  detail: mode === 'detail',
  currentTrackId: playerState?.currentTrack?.id,
  reduced: preferences.reduced,
  sampleRate: player.spectrumSampleRate,
}));
// 兜底：音浪初始化出任何问题都只让特效停摆，绝不能拖住开场动画。
try {
  visualizer.configure(normalizeVisualizer(preferences.visualizer));
  player.setSpectrumEnabled(preferences.visualizer.enabled !== false, preferences.reduced);
} catch (error) {
  console.warn('[音浪] 初始化失败，本次不启用：', error);
}
// 详情区（含 ♥ 收藏按钮、音量条）每次重画后回填收藏态与音量。
songView.onPaint = () => { refreshFavoriteHearts(); initTransportVolume(); };
const effectsPanel = new AudioEffectsPanel();
player.setEffects(loadEffectsConfig());
const downloadPanel = new DownloadPanel();
function currentDownloadTarget(): { title: string; artist: string } | null {
  const track = playerState.currentTrack;
  return track ? { title: track.title, artist: track.artist } : null;
}
async function downloadCurrentSong(tier?: QualityTier): Promise<void> {
  const track = playerState.currentTrack;
  if (!track) throw new Error('当前没有可下载的歌曲。');
  //
  // 用户要求：不该用设置里的全局值，应该在点下载时看这首歌有哪些音质，
  // 当场选。这里 tier 由下载面板传进来；没传时按无损兜底。
  //
  // ★ 下载必须**按所选档位重新取址**：track.audioUrl 是播放用的地址（播放链
  // 为了浏览器能放，加密档已降到明文无损），拿它当母带下就是「标母带、得无损」
  // 的根源。这里带着 allowEncrypted 重新取源 —— 服务端可直接返回加密容器
  // + ekey，下载器落盘前解密成真母带（酷我 QMC 链路已通）。
  const wantedQuality = tier ?? 'lossless';
  const source = track.onlineSource;
  let url = track.audioUrl ?? '';
  let format = track.format;
  let ekey = '';
  if (source) {
    try {
      const response = await fetch(`/api/online/${source.provider}/prepare/${encodeURIComponent(source.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality: wantedQuality, allowEncrypted: true }),
      });
      const value = await response.json().catch(() => ({})) as { audioUrl?: string; format?: string; ekey?: string; error?: string };
      if (response.ok && value.audioUrl) {
        url = value.audioUrl;
        if (value.format) format = value.format;
        if (typeof value.ekey === 'string') ekey = value.ekey;
      }
    } catch {
      // 取址失败时回落到播放地址（兜底，不打断下载）。
    }
  }
  if (!url) {
    if (!source) throw new Error('本地歌曲已在磁盘上，无需下载。');
    throw new Error(`${musicPlatforms[source.provider]}没有返回可下载的地址。`);
  }
  const reply = await fetch('/api/downloads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title: track.title, artist: track.artist, quality: wantedQuality, format, ekey,
      provider: source?.provider ?? '' }),
  });
  const value = await reply.json().catch(() => ({})) as { error?: string };
  if (!reply.ok) throw new Error(value.error || '无法加入下载队列。');
}

/** 探测当前曲目**实际具备**的音质档位，供下载面板列出让人选。
 *
 * 数据来源是平台搜索响应里的 capabilities（酷我 MINFO、酷狗 hsash/filesize、
 * 网易云 privilege.maxBrLevel），已经由各平台协议层解析好，这里只做
 * 「按平台叫法归一化到 7 级 + 去重 + 从高到低排序」。
 *
 * 返回空数组表示探测不到（本地歌曲、接口失败、平台没给能力字段）——
 * 此时面板会退回默认档位，不打断下载。
 */
async function listDownloadOptions(): Promise<DownloadOption[]> {
  const track = playerState.currentTrack;
  if (!track) return [];
 // 本地文件已在磁盘上，没有「选音质」这回事。
  if (!track.onlineSource) return [];
  const capability = track.onlineSource.capabilities;
  const rawLevels = capability?.levels ?? [];
  const sizes = capability?.sizes ?? {};
  const seen = new Set<QualityTier>();
  const options: DownloadOption[] = [];
  for (const raw of rawLevels) {
    const tier = normalizeDownloadTier(raw);
    if (!tier || seen.has(tier)) continue;
    seen.add(tier);
 // 大小按平台原生档位名取；取不到就是 0，面板上照常显示（不显示体积）。
    const bytes = Number(sizes[raw]) || Number(sizes[tier]) || 0;
    options.push({ tier, bytes });
  }
 // 从高到低排（母带在前、标准在后），和用户「优先要好音质」的直觉一致。
  options.sort((a, b) => qualityTierWeight[b.tier] - qualityTierWeight[a.tier]);
  return options;
}

/** 平台原生档位名 → 我们的 7 级枚举。认不出来就返回 null（不猜）。 */
function normalizeDownloadTier(raw: string): QualityTier | null {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return null;
  const known: Record<string, QualityTier> = {
 // 通用
    standard: 'standard', high: 'high', lossless: 'lossless', hires: 'hires',
    hifi: 'hifi', surround: 'surround', master: 'master',
 // 酷我
    '128k': 'standard', '320k': 'high', flac: 'lossless', dts: 'surround',
 // 网易云
    exhigh: 'high', jymaster: 'master', jyeffect: 'surround', sky: 'surround',
 // 酷狗
    sq: 'lossless', hq: 'high',
  };
  return known[key] ?? null;
}

async function hydrateDownloadSettings(): Promise<void> {
  try {
    const response = await fetch('/api/downloads');
    const value = await response.json() as { settings: { directory?: string; quality?: string; naming?: string; directoryIsDefault?: boolean } };
    const directory = document.querySelector<HTMLInputElement>('#download-directory');
    if (directory) {
      // 用户自己设过的路径填进输入框；走默认目录时输入框留空，只把真正的
      // 落盘位置写进 placeholder（灰字）—— 不填也要看得出文件会存到哪。
      if (value.settings.directoryIsDefault) {
        directory.value = '';
        if (value.settings.directory) directory.placeholder = value.settings.directory;
      } else {
        directory.value = value.settings.directory ?? '';
      }
    }
    const quality = document.querySelector<HTMLSelectElement>('#download-quality');
    if (quality) quality.value = value.settings.quality ?? 'master';
    const naming = document.querySelector<HTMLSelectElement>('#download-naming');
    if (naming) naming.value = value.settings.naming ?? '{artist} - {title}';
  } catch { /* the settings page works without the download service */ }
}
async function configureDownloads(): Promise<void> {
  const status = document.querySelector<HTMLElement>('#download-settings-status');
  const body = {
    directory: (document.querySelector<HTMLInputElement>('#download-directory')?.value ?? '').trim(),
    quality: document.querySelector<HTMLSelectElement>('#download-quality')?.value,
    naming: document.querySelector<HTMLSelectElement>('#download-naming')?.value,
  };
  try {
    const response = await fetch('/api/downloads/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(value.error || '下载设置没有保存成功。');
    if (status) status.textContent = '下载设置已保存。';
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : '下载设置没有保存成功。';
  }
}
interface LxSourceRow {
  id: string;
  name: string;
  version?: string;
  file: string;
  builtin: boolean;
  enabled: boolean;
  /** 本轮正在测试（后端在跑该源的某个平台）。 */
  testing?: boolean;
  /** 本轮自检进行中：还没轮到的源显示「等待中」。 */
  selfCheckRunning?: boolean;
  /** 该插件声明支持的平台键（wy/tx/kg/kw）。 */
  platforms?: string[];
  health: { ok: boolean; ms: number | null; quality: string | null; source?: string | null; error?: string } | null;
}
interface LxSourcesPayload {
  plugins?: LxSourceRow[];
  counts?: { total: number; loaded: number };
  error?: string;
}
/** 音源清单一行：名称 · 延迟 · 停用/启用 · 移除（内置源置灰）。 */
const PLATFORM_LABEL = { wy: '网易', tx: 'QQ', kg: '酷狗', kw: '酷我' } as const;

function renderLxSourcesRows(plugins: LxSourceRow[], counts?: { total: number; loaded: number }) {
  const list = document.querySelector<HTMLElement>('#lx-sources-list');
  const counter = document.querySelector<HTMLElement>('#lx-sources-count');
  if (list) {
    const rowOf = (plugin: LxSourceRow) => {
      // 本轮状态机：正在测 > 已测出结果 > 等待中 > 未测。
      // 失败要显示真正原因（超时/缺ID/资源不存在…），不能一律写成「超时」。
      const health = plugin.health;
      // 一行 = 一个插件。它可能只在某个平台可用（酷我可用、网易超时），
      // 所以既要报「在哪个平台上可用」，也要在失败时说明「几个平台都试过」。
      const platformCount = plugin.platforms?.length ?? 0;
      const platformName = PLATFORM_LABEL[(health?.source ?? '') as keyof typeof PLATFORM_LABEL] ?? '';
      const errorText = (health?.error ?? '').replace(/\s+/g, ' ');
      const meter = !plugin.enabled
        ? '已停用'
        : plugin.testing
          ? '测试中'
          : health
            ? (health.ok
                ? `${health.ms ?? '—'}ms${health.quality ? ` · ${health.quality}` : ''}${platformName ? ` · ${platformName}` : ''}`
                : /需要歌曲ID/.test(errorText)
                  ? '待验证'
                  : /需要配置/.test(errorText)
                    ? '需配置 Key'
                    : `${platformCount || 1} 平台均失败 · ${/超时|timeout/i.test(errorText) ? '超时' : (errorText.slice(0, 14) || '失败')}`)
            : plugin.selfCheckRunning
              ? '等待中'
              : '未测';
      return `<li class="lx-source-row${plugin.enabled ? '' : ' lx-source-off'}" data-id="${esc(plugin.id)}">
        <span class="lx-source-name">${esc(plugin.name)}</span>
        <span class="lx-source-meter">${esc(meter)}</span>
        <button type="button" class="text-button" data-action="lx-source-toggle" data-id="${esc(plugin.id)}" data-enabled="${plugin.enabled}">${plugin.enabled ? '停用' : '启用'}</button>
        <button type="button" class="text-button" data-action="lx-source-remove" data-id="${esc(plugin.id)}" ${plugin.builtin ? 'disabled title="内置音源不能移除，只能停用"' : ''}>移除</button>
      </li>`;
    };
    // 【2026-10-24】列表太长（20 条出厂音源把用户的自加音源淹没了）：
    // 出厂自带的（builtin）收进一行可折叠的「自带音源」，用户自己添加的
    // 平铺在外面一眼可见。展开状态记住，下次打开设置保持原样。
    const builtinRows = plugins.filter(plugin => plugin.builtin);
    const userRows = plugins.filter(plugin => !plugin.builtin);
    const groupOpen = localStorage.getItem("rhine-lx-builtin-open") === "1";
    const enabledCount = builtinRows.filter(plugin => plugin.enabled).length;
    list.innerHTML = [
      ...userRows.map(rowOf),
      `<li class="lx-source-group">
        <button type="button" class="lx-source-group-head" data-action="lx-group-toggle" aria-expanded="${groupOpen}">
          <span class="lx-source-group-chevron" aria-hidden="true">${groupOpen ? "▾" : "▸"}</span>
          <span class="lx-source-group-title">自带音源</span>
          <span class="lx-source-group-meta">${builtinRows.length} 个 · ${enabledCount} 个启用</span>
        </button>
        <ul class="lx-source-group-list"${groupOpen ? "" : " hidden"}>${builtinRows.map(rowOf).join("")}</ul>
      </li>`,
    ].join("");
  }
  if (counter) {
    const total = counts?.total ?? plugins.length;
    const loaded = counts?.loaded ?? plugins.filter(plugin => plugin.enabled).length;
    counter.textContent = `已加载 ${loaded}/${total} 个音源`;
  }
}
async function hydrateLxSources(): Promise<void> {
  try {
    const response = await fetch('/api/lx/status');
    const value = await response.json() as LxSourcesPayload;
    renderLxSourcesRows(value.plugins ?? [], value.counts);
    const status = document.querySelector<HTMLElement>('#lx-sources-status');
    if (status && !(value.plugins ?? []).length) status.textContent = '还没有加载到音源。点「添加音源」选 .js 插件。';
  } catch { /* 设置页不依赖音源服务 */ }
}
async function lxSourcesRequest(path: string, body?: unknown): Promise<LxSourcesPayload> {
  const status = document.querySelector<HTMLElement>('#lx-sources-status');
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({})) as LxSourcesPayload;
  if (!response.ok) {
    const message = value.error || '操作没有成功。';
    if (status) status.textContent = message;
    throw new Error(message);
  }
  if (status) status.textContent = '';
  renderLxSourcesRows(value.plugins ?? [], value.counts);
  return value;
}
/** 「添加音源」：一个原生多选文件框，选完直接写进用户音源目录并加载。 */
async function addLxSources(files: FileList | null): Promise<void> {
  if (!files?.length) return;
  const status = document.querySelector<HTMLElement>('#lx-sources-status');
  if (status) status.textContent = `正在添加 ${files.length} 个音源…`;
  const payload = [];
  for (const file of Array.from(files)) {
    if (!/\.js$/i.test(file.name)) continue;
    payload.push({ name: file.name, text: await file.text() });
  }
  if (!payload.length) { if (status) status.textContent = '请选择 .js 音源插件。'; return; }
  try { await lxSourcesRequest('/api/lx/sources/add', { files: payload }); }
  catch { /* 错误文案已在 lxSourcesRequest 里写过 */ }
}
async function testLxSources(): Promise<void> {
  const status = document.querySelector<HTMLElement>('#lx-sources-status');
  const button = document.querySelector<HTMLButtonElement>('[data-action="lx-sources-test"]');
  if (button) { button.disabled = true; button.textContent = '测试中…'; }
  if (status) status.textContent = '逐个音源试取一首歌，超时的会标超时…';
  // 自检在 worker 里跑，health 是实时更新的：每 700ms 拉一次清单+进度，
  // 测一个就显示一个，不用等整轮跑完。
  let polling = true;
  const tick = async () => {
    try {
      const list = await fetch('/api/lx/status');
      if (list.ok) {
        const value = await list.json() as LxSourcesPayload;
        renderLxSourcesRows(value.plugins ?? [], value.counts);
      }
      const progress = await fetch('/api/lx/progress');
      if (progress.ok && status) {
        const p = await progress.json() as { running?: boolean; done?: number; total?: number; alive?: number };
        if (p.running) status.textContent = `测试中 ${p.done ?? 0}/${p.total ?? 0} · 活 ${p.alive ?? 0}`;
      }
    } catch { /* 轮询失败不影响主流程 */ }
    if (polling) setTimeout(tick, 700);
  };
  void tick();
  try {
    await lxSourcesRequest('/api/lx/selfcheck', {});
    if (status) status.textContent = '测试完成。';
  } catch { /* 错误文案已在 lxSourcesRequest 里写过 */ }
  finally {
    polling = false;
    if (button) { button.disabled = false; button.textContent = '测试连通性 ↗'; }
  }
}
/** 全曲解析（后台静默）: 播放前先问一遍其他音源，能拿到全曲就直接播全曲。
 * 全程**不打扰用户** —— 用户明确要求不标付费、不标来源、不提示换源，
 * 只管把歌放出来。命中就静默切过去，没命中就播手上的（不再提示）。
 *
 * 每首歌只做一次（preparedVariantFor）：换到的变体若仍带付费证据，播放器会
 * 再问一次，而 findPlayableVariant 可能又给出另一个变体 —— 那就成了音源之间
 * 的无限乒乓（用户实测：一直放不出来）。第一次没找到全曲就直接播手上的。 */
const preparedVariantFor = new Set<string>();
player.resolveFullVariant = async (track) => {
  const source = track.onlineSource;
  if (!source) return null;
  const key = fallbackSongKey(track);
  if (preparedVariantFor.has(key)) return null;
  preparedVariantFor.add(key);
  const providers = (Object.keys(musicPlatforms) as MusicProvider[]).filter(provider => provider !== source.provider);
  const variant = await findPlayableVariant(track, resolveLookupOrder(undefined, providers));
 // 静默切换：不 notify，界面上也不显示来源/付费。
  if (variant?.onlineSource) openDetailAfterQueueSettle = true;
  return variant;
};
/** 播放被拒兜底: one automatic cross-source attempt per song (keyed by
 * the song itself, not one source's variant id, so switches cannot loop). */
const fallbackTried = new Set<string>();
let lastTrialKey = '';
/** 变体标题可能与原曲不同（版本词匹配会挑「降调版」这类同曲异名），
 * 所以「是否已为这首歌换过源」不能只看 title|artist —— 那样每换到一
 * 个新标题的变体守卫就失效，会在音源之间无限乒乓。这里按平台无关的
 * 歌名主干（去掉版本词/符号）记键，一首歌无论换到哪个变体都只换一次。 */
function fallbackSongKey(track: MusicTrack): string {
 // 传 artist：酷狗的标题带「歌手 - 」前缀，不剥掉的话同一首歌在不同源
 // 会算出不同的键，切换守卫就失效了（详见 online-search-core 的 titleParts）。
  const base = titleParts(track.title, track.artist).base || normKey(track);
  return `${base}|${artistMembers(track.artist).sort().join(',')}`;
}
/** 静默换源时的「视觉身份保持」：把换来的变体的播放身份装进原曲的外壳。
 *
 * 为什么要这样（用户实测：换源那一刻画面会闪一下、翻到另一张封面）：
 * 换源会把 queue 里的这一条整个换成另一平台返回的 variant，而 variant 有它
 * 自己的 id / albumId / coverUrl / 标题（常还带「(DJ版)」这类后缀）。3D 阵列的
 * 视觉 key 是 `[track.id, albumId, coverUrl]`，所以一换就重建并翻到新封面。
 *
 * 用户的要求是「只在背后换源，画面不许动」。因此这里：
 * · **保留**原 track 的展示字段（id/title/artist/albumId/duration/序号/封面
 * 相关的一切）—— 视觉 key 因此完全不变；
 * · **只替换**真正决定"从哪儿取音频"的字段：onlineSource（provider/id/fee
 * /rescuedUrl 等）、audioUrl、format/codec 等技术字段。
 *
 * 这样播放器拿 variant 的地址播，界面上还是原来那一张卡片、同一个标题。
 * 注意 id 保持原值：`player.play(id, queue)` 靠它在 queue 里定位，而 queue
 * 里存的也是这份外壳，所以两边一致。
 */
function keepVisualIdentity(variant: MusicTrack, original: MusicTrack): MusicTrack {
  const nextSource = variant.onlineSource;
 // coverUrl 必须钉回原值：3D 阵列的视觉 key 里就包含 `onlineSource.coverUrl`
 // （见 syncPlaybackAlbums 的 `[id, albumId, coverUrl]`），只要它变了照样重建、
 // 照样翻封面 —— 只保住 track.id/albumId 是不够的（实测踩过这一点）。
  const visualSource = nextSource && original.onlineSource
    ? { ...nextSource, coverUrl: original.onlineSource.coverUrl ?? nextSource.coverUrl,
        albumTitle: original.onlineSource.albumTitle ?? nextSource.albumTitle,
        pageUrl: original.onlineSource.pageUrl ?? nextSource.pageUrl }
    : nextSource;
  return {
    ...original, // 视觉外壳：id/title/artist/albumId/duration/cover 等一律不动
 // ── 以下是"从哪儿取音频"，必须跟随变体 ──
    audioUrl: variant.audioUrl,
    format: variant.format,
    codec: variant.codec,
    bitsPerSample: variant.bitsPerSample,
    sampleRate: variant.sampleRate,
    bitrate: variant.bitrate,
    numberOfChannels: variant.numberOfChannels,
    lossless: variant.lossless,
    browserPlayable: variant.browserPlayable,
    decodedAudioUrl: variant.decodedAudioUrl,
    localDecodable: variant.localDecodable,
    relativePath: variant.relativePath,
    onlineSource: visualSource,
  };
}
/** 详情页当前是否正停在这首歌上（决定换源后还要不要"打开详情"）。 */
function openedDetailForTrack(track: MusicTrack): boolean {
  return presentation.phase === 'detail' && playerState.currentTrack?.id === track.id;
}
/** 静默换源（播放器会在重试预算用尽时同步回调这里）。返回 true = 已接手：
 * 播放器就此收场，不写 state.error、不提示。返回 false = 确实没别的源了，
 * 才由播放器落最终文案、上层提示**一次**。全程静默，界面只看到 loading。 */
async function fallbackToOtherSource(failed: MusicTrack): Promise<boolean> {
  const source = failed.onlineSource;
  const key = fallbackSongKey(failed);
  if (!source || fallbackTried.has(key)) return false;
  fallbackTried.add(key);
  const providers = (Object.keys(musicPlatforms) as MusicProvider[]).filter(provider => provider !== source.provider);
 // 先按优先级跨源找同曲（findFallbackTrack），拿不到再用 findPlayableVariant
 // 做「prepare 级 + 备用音源（/api/backup/resolve，备用音源模块那层）」
 // 的深层兜底。少了第二步，平台全部拒绝/只给试听的歌就彻底放不出来。
  const variant = await findFallbackTrack(failed, providers)
    ?? await findPlayableVariant(failed, resolveLookupOrder(undefined, providers));
  if (!variant) return false;
 //
 //
 // 快闪的真实成因（用户描述：换源那一刻画面闪一下，跳到另一张封面）：
 // · 下面把 queue 里的这一条**整个换成 variant**，而 variant 来自另一个
 // 平台，自带它的 albumId / coverUrl / 标题（有时还带版本后缀）
 // —— 于是它有**另一张封面**；
 // · `syncPlaybackAlbums` 的视觉 key 是
 // `[track.id, albumId, onlineSource.coverUrl]`（见那里），queue 一变
 // 整个 3D 阵列就按新身份重建，于是画面切到那张新封面上；
 // · 再叠加 `openDetailAfterQueueSettle = true`，详情页也被强制打开到
 // 新变体上 —— 两件事一起发生，观感就是"闪一下"。
 //
 // 用户的诉求很明确：**换源是后台的事，画面不许动。**
 // 「我在这个播放器放这首歌的时候，不管后台切到哪一个源，即使播放器里
 // 有另外对应的封面，也不要切过去，只是在背后换源。」
 //
 // 所以这里把 variant 的**播放身份**（provider/id/音源细节）换上，但把
 // **视觉身份**（id/title/artist/albumId/coverUrl/时长等展示字段）全部
 // 保留原来的 track —— queue 的这一项因此长得和原来一模一样，3D 阵列的
 // 视觉 key 不变，不会重建、不会换封面。
  const keepVisual = keepVisualIdentity(variant, failed);
  const queue = playerState.queue.map(track => track.id === failed.id ? keepVisual : track);
 // 不再强制打开详情页：详情页跟着"这首歌"走，而不是跟着后台音源走。
 // （点击搜索结果行仍会进详情 —— 那条路径由别处设置这个标志，不受影响。）
  if (openedDetailForTrack(failed)) openDetailAfterQueueSettle = false;
 // 同步发出新播放意图：player.play 立刻推进 operation，正在等兜底结果的那次
 // 失败重试就此静默收场（不再走 fail）。新意图自带新的重试预算，互不牵连。
  void player.play(keepVisual.id, queue).catch(() => undefined);
  return true;
}
// 接线：播放器在自己的重试预算用尽（或平台直接拒绝重取）时，把这次失败交回
// 上面这条路做静默换源。它返回 true → 播放器静默收场，**一个字节的 error 都
// 不写**，界面只剩 loading（用户只看到「还在加载」，看不到中间换过源）；返回
// false → 播放器才落那唯一一条最终失败文案，由订阅者提示一次。
player.rescueFailedSource = failed => fallbackToOtherSource(failed);
let lastFailureNotified = '';
player.subscribe((state) => {
  playerState = state;
  persistPlaybackIfChanged();
 // Trial fragments get no reactive switching any more (proactive resolution
 // runs before playback). The「全网仅试听」badge carries the evidence; repaint
 // the detail when it appears or clears.
  const trialKey = state.trial ? JSON.stringify(state.trial) : '';
  if (trialKey !== lastTrialKey) {
    lastTrialKey = trialKey;
    if (presentation.phase === 'detail') renderDetail();
  }
  const queueSignature = `${state.mode}|${state.currentTrack?.id || ''}|${state.queue.length}`;
  if (panel === 'playlists' && queueSignature !== queuePanelSignature) renderPlaylistsPanel();
 // The search list marks the row that is playing (the panel's own play button
 // toggles between ▷ / Ⅱ / …). reference's list behaves the same way.
  onlineSearch.setPlayback(
    state.currentTrack?.onlineSource ? state.currentTrack.id : undefined,
    state.playing,
    state.transport === 'loading',
  );
  const transport = $(".minimal-transport");
  transport.dataset.backend = state.backend;
  transport.dataset.transport = state.transport;
  transport.dataset.position = String(state.currentTime);
  transport.dataset.duration = String(state.duration);
  const titleVisible = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
 // 播放失败的用户可见提示：**只提示一次**。换源/重试全程静默（播放器不再写
 // state.error），能走到这里的只剩「兜底也无解」的最终失败；同一句文案重复
 // 出现（例如用户又点一次同一首）也不再重复弹，免得黑框连着闪。
  if (state.error) {
    if (state.error !== lastFailureNotified) {
      lastFailureNotified = state.error;
      notify(state.error);
    }
  } else lastFailureNotified = '';
  if (state.transitionWarning && state.transitionWarning !== lastTransitionWarning && !state.error)
    notify(state.transitionWarning);
  lastTransitionWarning = state.transitionWarning || "";
  updatePlayingRows();
  updateSongTransport();
  syncPlaybackAlbums(state);  syncAudioOutputUI();
});

function audioOutputMarkup() {
  return `<section class="panel-section"><h3>音频输出</h3><label class="settings-row"><span>输出方式</span><select id="audio-backend" aria-label="音频输出方式">${isDesktop() ? '<option value="browser">Windows 系统输出</option>' : '<option value="browser">浏览器输出</option><option value="coreaudio">Mac 原生 CoreAudio</option>'}</select></label><label class="settings-row" id="audio-device-row"><span>输出设备</span><select id="audio-device" aria-label="音频输出设备"></select></label><p id="audio-output-status" role="status"></p><button class="text-button" data-action="refresh-output">刷新输出设备 ↻</button></section>`;
}
function syncAudioOutputUI() {
  const backend = document.querySelector<HTMLSelectElement>("#audio-backend");
  if (!backend || !playerState) return;
  backend.value = playerState.backend;
  backend.disabled = outputBusy || !apiAvailable || lightingDemo;
  if (backend.options[1]) backend.options[1].disabled = !playerState.nativeAvailable;
  const device = $<HTMLSelectElement>("#audio-device");
  const items = playerState.outputDevices;
  const key = JSON.stringify(items);
  if (device.dataset.devices !== key) {
    device.innerHTML = items.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    device.dataset.devices = key;
  }
  device.value = playerState.outputDeviceId;
  device.disabled = outputBusy || playerState.backend !== "coreaudio";
  $("#audio-device-row").hidden = playerState.backend !== "coreaudio";
  $("#audio-output-status").textContent = lightingDemo ? "演示模式无音频输出。" :
    !apiAvailable ? "本机音频服务未连接。" : outputBusy ? "正在连接音频输出…" :
    playerState.outputError || playerState.transitionWarning || outputStatus;
  $<HTMLButtonElement>('[data-action="refresh-output"]').disabled = outputBusy || !apiAvailable || lightingDemo;
}
async function refreshAudioOutputs(restore = false) {
  if (lightingDemo || !apiAvailable) { syncAudioOutputUI(); return; }
  outputBusy = true; syncAudioOutputUI();
  try {
    const capabilities = await player.refreshOutputs();
    audioOutputsChecked = true;
    outputStatus = isDesktop() ? capabilities.decoderAvailable ? "本机解码已就绪，歌曲通过 Windows 系统默认设备输出。" : "未检测到 FFmpeg，当前仅可播放系统支持的格式。" : capabilities.decoderAvailable ? capabilities.nativeAvailable ?
      "本机解码与 CoreAudio 已就绪。" : "本机解码已就绪；原生输出暂不可用。" :
      "未检测到 FFmpeg，当前仅可播放浏览器支持的格式。";
    if (restore && preferences.audioBackend === "coreaudio")
      await player.setBackend("coreaudio", preferences.outputDeviceId);
  } catch (error) { outputStatus = (error as Error).message; }
  finally { outputBusy = false; syncAudioOutputUI(); }
}
async function changeAudioOutput(backend: "browser" | "coreaudio", deviceId: string) {
  if (outputBusy) return;
  outputBusy = true; syncAudioOutputUI();
  try {
    if (backend !== playerState.backend) await player.setBackend(backend, deviceId);
    else await player.setOutputDevice(deviceId);
    preferences.audioBackend = player.state.backend;
    preferences.outputDeviceId = player.state.outputDeviceId;
    savePrefs();
    outputStatus = isDesktop() ? "歌曲通过 Windows 系统默认设备输出。" : backend === "coreaudio" ? "歌曲通过 Mac 原生设备输出。" : "歌曲通过浏览器输出。";
  } catch (error) { outputStatus = (error as Error).message; notify(outputStatus); }
  finally { outputBusy = false; syncAudioOutputUI(); }
}

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  onlineSearch.dispose(); disposePlatformLogin();
  if (!panel) {
    after?.();
    return;
  }
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  panelTransition?.hide(preferences.reduced, () => {
    panel = null;
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    if (overview) $("#music-browse").inert = true;
    $("#music-overview").inert = !overview;
    $<HTMLButtonElement>('[data-action="overview"]').inert = overview;
    $("#music-detail").inert = presentation.phase !== "detail";
    stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = false; });
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
let settingsCategory: SettingsCategory = "personalization";
let feedbackDescription = "";
function openPanel(next: Panel) {
  if (!next) return closePanel();
  playlistOverviewRequested = false;
  onlineSearch.dispose(); disposePlatformLogin();
  cancelTrackReveal();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  $("#music-overview").inert = true;
  $<HTMLButtonElement>('[data-action="overview"]').inert = true;
  stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = true; });
  const titles = {
    library: ["MUSIC LIBRARY", "音乐与音源"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
    settings: ["SYSTEM SETTINGS", "设置"],
    'netease-login': ["MUSIC ACCOUNT", "音乐账号"],
 // 用户要求：这里就是「我的歌单」，不要带上平台名（原来会拼成
 // 「我的网易云音乐歌单」，看着像只显示那一个平台的歌单）。
    playlists: ['MY PLAYLISTS', '我的歌单'],
  };
  const settingsWindow = next === "settings" || next === "library";
 // 「本地音乐库」这个入口落在本地歌单/音乐库这一组上。
  if (next === 'library') settingsCategory = 'local';
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim ${settingsWindow ? 'settings-scrim' : ''}" data-action="dismiss-panel"><section class="music-panel ${settingsWindow ? 'settings-window' : ''}" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${settingsWindow ? '设置' : titles[next][1]}</h2></div><button data-action="close-panel" aria-label="${settingsWindow ? '关闭设置' : '关闭'}">×</button></div>${settingsWindow ? settingsNavigation() : ''}<div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, settingsWindow ? undefined : $(".music-panel"));
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") { renderLibraryPanel(); selectSettingsCategory($("#music-panel-root"), "local"); }
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  if (next === 'playlists') renderPlaylistsPanel();
  if (next === 'netease-login') renderLoginPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
function renderLibraryPanel() {
  $("#panel-body").innerHTML =
    `<label class="field-label" for="music-roots">音乐文件夹</label><textarea id="music-roots" rows="3" placeholder="/Users/你的用户名/Music">${esc(library.roots.map((r) => r.path).join("\n"))}</textarea><div class="panel-actions"><button class="primary-button" data-action="scan">保存目录并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n, a) => n + a.tracks.length, 0)}</b><span>曲目</span></div><div><b>${library.genres.filter((g) => library.albums.some((a) => a.genreId === g.id)).length}</b><span>流派</span></div></div><section class="panel-section"><h3>本地分类</h3><button data-action="edit-genres" class="text-button">编辑流派归并规则 ↗</button></section><section class="panel-section"><h3>封面显示</h3>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示封面 ↗</button>' : ""}</section>`;
  $('#panel-body').insertAdjacentHTML('afterbegin', '<h2 class="settings-library-heading">本地音乐库</h2><button data-action="settings" class="text-button">← 返回本地歌单设置</button>');
  if (isDesktop()) {
    const roots = document.querySelector<HTMLTextAreaElement>("#music-roots");
    if (roots) {
      roots.placeholder = "音乐文件夹";
      roots.insertAdjacentHTML("afterend", '<button data-action="choose-music-folder" class="text-button desktop-folder-button">选择音乐文件夹 ↗</button>');
    }
  }
  updateScanStatus();
}
function renderMusicBrainzSettings() {
  const configSection = document.querySelector<HTMLElement>("#online-config");
  if (!configSection) return;
  void (async () => {
    try {
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
      }>("/api/config");
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">MusicBrainz 联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><label class="settings-row"><span>扫描后自动补充新专辑资料</span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置。" : "尚未配置；本地曲库和播放已可使用。"}</p>`;
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  onlineSearch.dispose(); disposePlatformLogin();
  const searchGenres = demo ? demoGenres : library.genres;
  $("#panel-body").innerHTML =
    `<div class="search-sources" role="group" aria-label="搜索来源"><button data-search-source="network" aria-pressed="${searchSource === "network"}">网络搜索</button><button data-search-source="local" aria-pressed="${searchSource === "local"}">本地音乐</button></div>${searchSource === "network" ? '<div id="online-results"></div>' : `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${searchGenres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`}`;
  if (searchSource === "network") onlineSearch.mount($("#online-results"));
  else renderSearchResults();
}
let searchSource: "local" | "network" = "network";
let searchGenre = "";
function renderSearchResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const result of searchMusicLibrary(demo ? demoAlbums : library.albums, demo ? demoGenres : library.genres, query, searchGenre)) {
    const a = result.album;
    if (result.kind === 'album') {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    } else {
      const track = result.track!;
 // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
function refreshFeedbackReport() {
  const field = document.querySelector<HTMLTextAreaElement>('#feedback-report');
  if (!field) return undefined;
  const feedback = buildMusicFeedback(onlineErrorReport(`${appVersion}-preview`),
    document.querySelector<HTMLTextAreaElement>('#feedback-description')?.value ?? feedbackDescription,
    { version: `${appVersion}-preview`, quality: preferences.quality, width: innerWidth, height: innerHeight });
  field.value = feedback.report;
  return feedback;
}
async function copyFeedback() {
  const feedback = refreshFeedbackReport();
  if (!feedback) return;
  const status = document.querySelector<HTMLElement>('#feedback-status');
  try { await navigator.clipboard.writeText(feedback.report); if (status?.isConnected) status.textContent = '完整诊断已复制'; }
  catch {
    const field = document.querySelector<HTMLTextAreaElement>('#feedback-report');
    if (field) { field.closest('details')!.open = true; field.focus(); field.select(); }
    if (status?.isConnected) status.textContent = '请按 Ctrl+C 复制';
  }
}
async function composeFeedback() {
  const feedback = refreshFeedbackReport();
  if (!feedback) return;
  const status = document.querySelector<HTMLElement>('#feedback-status');
  try {
    await openFeedbackDraft(feedback.url);
    if (status?.isConnected) status.textContent = '已请求打开邮件草稿，请在邮件客户端确认发送。若未打开，可复制诊断并发送至上方邮箱。';
  } catch {
    if (status?.isConnected) status.textContent = '无法打开邮件客户端，可复制诊断并发送至上方邮箱。';
  }
}
/** One avatar in the header: the uploaded image, or the default account glyph. */
function applyAvatar() {
  const content = preferences.avatar ? `<img src="${preferences.avatar}" alt="">` : icons.account;
  for (const node of document.querySelectorAll<HTMLElement>('#account-avatar, #avatar-preview')) node.innerHTML = content;
}
async function setAvatarFromFile(file?: File) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { notify('请选择图片文件作为头像。'); return; }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const scale = Math.max(128 / bitmap.width, 128 / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    context.drawImage(bitmap, (128 - width) / 2, (128 - height) / 2, width, height);
    bitmap.close();
    preferences.avatar = canvas.toDataURL('image/png');
    save("rhine-music-preferences", preferences);
    applyAvatar();
  } catch { notify('头像图片读取失败，请换一张图片。'); }
}
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section" data-settings-group="personalization"><h3>外观主题</h3><div class="theme-cards">${(["day", "night", "dusk"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : t === "dusk" ? "冷调薄雾与雾蓝玻璃" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>

    <section class="panel-section" data-settings-group="playback"><h3>播放</h3><label class="settings-row"><span>进入软件自动播放</span><input type="checkbox" id="autoplay-setting" data-settings-key="autoplay" ${preferences.autoplay ? "checked" : ""}></label></section>
    <section class="panel-section" data-settings-group="cache"><h3>缓存</h3><label class="settings-row"><span>缓存上限</span><input type="range" id="cache-limit" data-settings-key="cacheLimit" min="64" max="8192" step="64" value="${preferences.cacheLimit}" aria-label="缓存上限"></label><p class="scan-status" id="cache-limit-status" role="status">${preferences.cacheLimit} MB</p><label class="settings-row"><span>缓存位置</span><input type="text" id="cache-location" data-settings-key="cacheLocation" placeholder="读取中…" aria-label="缓存位置" value="${esc(preferences.cacheLocation)}"></label><button class="text-button" data-action="cache-clear">清理缓存 ↗</button><p class="scan-status" id="cache-status" role="status" aria-live="polite"></p></section>
    <section class="panel-section" data-settings-group="library"><h3>共享音源</h3><p class="scan-status" id="pool-credential-status" role="status" aria-live="polite">检查中…</p><p class="scan-status pool-sign-note" id="pool-credential-signnote" role="alert" hidden></p><div class="pool-credential-actions"><button class="text-button" data-action="pool-connectivity">检测连通性 ↗</button><button class="text-button" data-action="pool-qr-login">扫码登录 ↗</button><button class="text-button" data-action="pool-credential-import">导入密钥文件 ↗</button><button class="text-button" data-action="pool-credential-export">导出密钥 ↗</button><button class="text-button" data-action="pool-credential-clear">移除 ↗</button></div><div class="pool-qr-login" id="pool-qr-login" hidden><img id="pool-qr-image" alt="扫码登录二维码" width="220" height="220"><p class="scan-status" id="pool-qr-status" role="status" aria-live="polite">请用手机上的客户端扫描二维码。</p><button class="text-button" data-action="pool-qr-cancel">取消</button></div><div class="pool-connectivity" id="pool-connectivity" role="status" aria-live="polite"></div><input type="file" id="pool-credential-file" accept=".rhinekey,.json" hidden><p class="scan-status">密钥由你自己提供，程序不内置任何凭据。没导入时只使用备用音源。<br>换一台电脑用？点「扫码登录 ↗」用手机授权一次即可。</p></section>
    <section class="panel-section" data-settings-group="display"><h3>窗口</h3><label class="settings-row"><span>关闭窗口时最小化到托盘</span><input type="checkbox" id="minimize-to-tray" data-settings-key="minimizeToTray" ${preferences.minimizeToTray ? "checked" : ""}></label></section>
    ${visualizerMarkup(normalizeVisualizer(preferences.visualizer))}
    <section class="panel-section" data-settings-group="personalization"><h3>账号头像</h3><div class="avatar-settings"><span class="account-avatar avatar-large" id="avatar-preview"></span><label class="text-button" for="avatar-upload">上传头像 ↗</label><input type="file" id="avatar-upload" accept="image/png,image/jpeg,image/webp" hidden><button class="text-button" data-action="avatar-reset">恢复默认头像</button></div><p class="scan-status">未上传时使用默认头像。</p></section>
    <section class="panel-section" data-settings-group="local"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式</span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label></section>
    <section class="panel-section" data-settings-group="download"><h3>歌曲下载</h3><label class="settings-row"><span>下载目录</span><input type="text" id="download-directory" placeholder="读取中…" aria-label="下载目录"></label><label class="settings-row"><span>下载音质</span><select id="download-quality" aria-label="下载音质"><option value="lossless">无损</option><option value="master">母带</option><option value="surround">环绕</option><option value="hifi">HiFi</option><option value="hires">Hi-Res</option><option value="high">高品</option><option value="standard">标准</option></select></label><label class="settings-row"><span>文件命名</span><select id="download-naming" aria-label="文件命名"><option value="{artist} - {title}">歌手 - 歌名</option><option value="{title} - {artist}">歌名 - 歌手</option><option value="{title}">仅歌名</option></select></label><p class="scan-status" id="download-settings-status" role="status">下载仅保存平台提供给当前账号的音源，请遵守平台协议与版权法。</p></section>
    <section class="panel-section" id="lx-sources-settings" data-settings-group="library"><h3>备用音源</h3>
      <div class="lx-sources-actions"><button class="text-button" data-action="lx-sources-add">添加音源 ↗</button><button class="text-button" data-action="lx-sources-test">测试连通性 ↗</button><input type="file" id="lx-sources-files" accept=".js" multiple hidden></div>
      <ul class="lx-sources-list" id="lx-sources-list"></ul>
      <p class="lx-sources-count" id="lx-sources-count" role="status" aria-live="polite">读取中…</p>
      <p class="scan-status" id="lx-sources-status" role="status" aria-live="polite"></p></section>
    <section class="panel-section" data-settings-group="local"><h3>高级设置 · 专辑阵列</h3><label class="settings-row"><span>专辑列显示</span><select id="music-array-mode" aria-label="专辑列显示方式"><option value="filled" ${preferences.arrayMode === "filled" ? "selected" : ""}>填充画面</option><option value="realistic" ${preferences.arrayMode === "realistic" ? "selected" : ""}>真实专辑列</option></select></label><label class="settings-row"><span>保留每列浏览位置</span><input type="checkbox" id="remember-column-position" ${preferences.rememberColumnPosition ? "checked" : ""}></label></section>
    <section class="settings-audio" data-settings-group="audio">${audioOutputMarkup()}</section>
    <section class="panel-section" data-settings-group="display"><h3>渲染画质</h3><label class="quality-control"><span>画质选择</span><select id="quality-mode"><option value="auto" ${preferences.qualityMode === 'auto' ? 'selected' : ''}>自动适配</option><option value="manual" ${preferences.qualityMode === 'manual' ? 'selected' : ''}>手动设置</option></select></label>
    <p class="quality-note">当前渲染显卡：${esc(scene?.graphicsIdentity.renderer || '尚未初始化')}</p>
    ${qualityMarkup(renderQuality)}</section>
    <section class="panel-section" data-settings-group="display"><h3>界面帧率</h3><label class="settings-row"><span>帧率上限</span><input type="range" id="frame-rate" data-settings-key="frameRate" min="${FRAME_RATE_MIN}" max="${FRAME_RATE_UNLIMITED}" step="1" value="${sliderFromFrameRate(preferences.frameRate)}" aria-label="界面帧率上限" aria-describedby="frame-rate-status"></label><p class="quality-note" id="frame-rate-status" role="status">${frameRateLabel(preferences.frameRate)}</p><p class="quality-note">拖动到最右为「无限制」（跟随显示器刷新率）。降低帧率可减少发热与耗电。</p></section>
    <section class="panel-section" data-settings-group="display"><h3>玻璃遮挡优化</h3><label class="settings-row"><span>可见区域绘制</span><select id="glass-occlusion" aria-label="玻璃遮挡优化"><option value="on" ${glassOcclusionMode === "on" ? "selected" : ""}>开启遮挡优化</option><option value="off" ${glassOcclusionMode === "off" ? "selected" : ""}>关闭 · Perf6 对照</option><option value="debug" ${glassOcclusionMode === "debug" ? "selected" : ""}>三类区域调试</option></select></label><button class="text-button" data-action="copy-performance">复制性能诊断 ↗</button></section>
    <section class="panel-section" data-settings-group="display"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果</span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label></section><section class="panel-section" data-settings-group="display"><h3>窗口</h3><button class="text-button" data-action="fullscreen">最大化 / 还原 ↗</button></section><section class="panel-section" data-settings-group="developer"><h3>界面维护</h3><button class="text-button" data-action="replay-boot">重播开场 ↗</button><button class="text-button" data-action="reload-interface">重新载入界面 ↻</button></section>
    <section class="panel-section" data-settings-group="audio"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>歌曲衔接</span><select id="song-fade-setting" aria-label="歌曲衔接方式"><option value="fade-out" ${preferences.songTransition === "fade-out" ? "selected" : ""}>淡出但不淡入</option><option value="fade-in-out" ${preferences.songTransition === "fade-in-out" ? "selected" : ""}>淡出淡入</option><option value="gapless" ${preferences.songTransition === "gapless" ? "selected" : ""}>无缝播放</option></select></label><label class="settings-row"><span>界面音效</span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM</span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button></section>${updateCenter.settingsMarkup()}`;
  $('#panel-body').insertAdjacentHTML('afterbegin', '<section class="panel-section" data-settings-group="local"><h3>音乐库</h3><button data-action="library" class="primary-button">管理音乐库 ↗</button></section>');
 // 用户要求删掉「关于 / 反馈 / 开发者 / 诊断」四类，只保留界面维护里的
 // 「重播开场 / 重新载入界面」（它们不是诊断入口）。
  groupSettingsContent($("#panel-body"));
  selectSettingsCategory($("#music-panel-root"), settingsCategory);
  void hydrateDownloadSettings();
 // 缓存偏好在启动与每次打开设置面板时都要同步一次：面板上要显示后端真正
 // 在用的目录与占用，而不是前端自己记的数字。
  void pushCacheSettings();
 // 共享音源密钥状态：面板上直接显示有没有导入，而不是等用户点开才发现。
  void refreshPoolCredentialStatus();
  void hydrateLxSources();
  renderMusicBrainzSettings();
  updateQuality();
  updateIntroductionStatus();
  updateCreditsStatus();
  applyAvatar();
  syncAudioOutputUI();
  if (!audioOutputsChecked && !outputBusy) void refreshAudioOutputs(true);
}
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  scene?.setGlassOcclusion(glassOcclusionMode);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `${preferences.qualityMode === 'auto' ? '自动适配' : '手动设置'} · 渲染 ${renderQuality.scale}% · 上限 ${Math.round(renderQuality.pixelBudget / 10000)} 万像素 · 透射 ${renderQuality.transmission * 100}% · 遮蔽 ${renderQuality.aoResolution * 100}% · 景深 ${renderQuality.depthOfFieldResolution * 100}%`;
  const qualityMode = document.querySelector<HTMLSelectElement>('#quality-mode');
  if (qualityMode) qualityMode.value = preferences.qualityMode!;
  savePrefs();
}
async function editGenres() {
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(saveRoots = false) {
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  ++libraryStateVersion;
  try {
    const roots = saveRoots
      ? $<HTMLTextAreaElement>("#music-roots")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const next = await request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
    ++libraryStateVersion; // Discard polls started before this accepted scan.

    await receiveLibrary(next);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 600);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich(one = false) {
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );

    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: true,
    });
 // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}
async function queryCredits(one = false, force = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (creditsStarting || library.credits?.running) return;
  if (one && creditsCoolingDown(album!)) {
    notify(creditsAlbumStatus(album!));
    return;
  }
  creditsStarting = true;
  creditsRequestError = "";
  creditsRequestAlbumId = one ? album!.id : undefined;
  updateCreditsStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/credits", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force,
    });
    ++libraryStateVersion;
    apiAvailable = true;
    const previousRunning = library.credits?.running;
    await receiveLibrary(next);
    if (next.credits?.running)
      notify(`${one ? "这张专辑" : "音乐库"}的制作信息查询已开始。`);
    else if (!previousRunning && next.credits)
      notify(creditsRunSummary(next.credits));
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    creditsRequestError = (error as Error).message;
    notify(`无法开始制作信息查询：${creditsRequestError}`);
  } finally {
    creditsStarting = false;
    updateCreditsStatus();
  }
}
function playAlbum(id?: string) {
  if (currentAlbum()?.playlistCell) { void playPlaylistSong(); return; }
  browseLibraryDuringPlayback = false;
  const a = currentAlbum();
  if (!a?.tracks.length || a.offline) return;
  void player.play(id || a.tracks[0].id, a.playback && !a.searchAnchor ? playerState.queue : a.tracks);
}
/** Double-clicking a playlist replaces the temporary queue and plays its first song. */
async function replaceQueueWithPlaylist(row: number) {
  const playlist = playlistLibrary.playlists[row]; if (!playlist) return;
  try {
    // 点开歌单＝要听整张，全量取下来（原来只取 100 首）。
    const queue = await playlistLibrary.queue(row, 0, { full: true });
    if (!queue.length) { notify('这个歌单还没有歌曲。'); return; }
    playlistPlayEpoch++; playlistQueuePending = false;
    playlistPlaybackId = playlist.id; playlistPlaybackSong = 0; followedPlaylistTrack = undefined;
    await player.play(queue[0].id, queue);
  } catch (error) { notify((error as Error).message); }
}
async function startSelectedSong() {
  if (currentAlbum()?.playlistCell) { await playPlaylistSong(); return; }
  const track = currentAlbum()?.tracks[0]; if (!track) return;
  if (playerState.currentTrack?.id === track.id && !['idle', 'error'].includes(playerState.transport)) {
    if (!playerState.playing && !playerState.loading) await player.toggle();
  } else playAlbum();
}

document.addEventListener("dblclick", (e) => {
  if (boot?.active || !overview || !accountView) return;
  const label = (e.target as HTMLElement).closest<HTMLElement>('.overview-anchor[data-playlist="true"] .overview-column-label');
  if (!label) return;
  const lane = Number((label.getAttribute('aria-controls') || '').replace('overview-playlist-', ''));
  if (!Number.isInteger(lane)) return;
  void replaceQueueWithPlaylist(wrap(lane - 2, playlistLibrary.playlists.length));
});
document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  if (target.dataset.queuePlay !== undefined) {
    const track = playerState.queue[Number(target.dataset.queuePlay)];
    if (track) void player.play(track.id);
    return;
  }
  if (target.dataset.queueRemove !== undefined) {
    const index = Number(target.dataset.queueRemove);
    player.setQueue([...playerState.queue.filter((_, i) => i !== index)]);
    return;
  }
 // ── 多选模式（对照参考行为 common.selectionMode）──────────────────────────
  if (target.dataset.queueSelect !== undefined) {
    const index = Number(target.dataset.queueSelect);
    if (queueSelection.has(index)) queueSelection.delete(index); else queueSelection.add(index);
    renderPlaylistsPanel();
    return;
  }
  if (target.dataset.action === 'queue-select-mode') {
    queueSelectMode = !queueSelectMode;
    if (!queueSelectMode) queueSelection.clear();
    renderPlaylistsPanel();
    return;
  }
  if (target.dataset.action === 'queue-select-all') {
    playerState.queue.forEach((_, index) => queueSelection.add(index));
    renderPlaylistsPanel();
    return;
  }
  if (target.dataset.action === 'queue-select-clear') {
    queueSelection.clear();
    renderPlaylistsPanel();
    return;
  }
  if (target.dataset.action === 'queue-selection-remove') {
    if (!queueSelection.size) { notify('还没有选择歌曲。'); return; }
    player.setQueue([...playerState.queue.filter((_, index) => !queueSelection.has(index))]);
    queueSelection.clear();
    notify('已移出所选歌曲');
    return;
  }
  if (target.dataset.action === 'queue-selection-add') {
    const tracks = [...queueSelection].sort((a, b) => a - b).map(index => playerState.queue[index]).filter(Boolean);
    if (!tracks.length) { notify('还没有选择歌曲。'); return; }
    openAddToPlaylist(tracks);
    return;
  }
 // ── 本地歌单（对照参考行为 playlist.*）────────────────────────────────────
  if (target.dataset.localPlaylistOpen !== undefined) {
 // 打开一个本地歌单：进入歌单墙并选中它。
    const index = Number(target.dataset.localPlaylistIndex);
    const playlist = localPlaylistRows[index];
    if (playlist) { closePanel(() => void navigatePlaylist(playlistLibrary.playlists.findIndex(p => p.id === playlist.id && p.provider === 'local'), 0)); }
    return;
  }
  if (target.dataset.action === 'local-playlist-create') {
    const name = window.prompt('新建歌单（留空使用默认名称）：', '');
 // 取消返回 null；空串是用户明确要默认名。
    if (name === null) return;
    void localPlaylists.create(name.trim()).then(async () => {
      await refreshLocalPlaylistsPanel();
      playlistLibrary.dispose(); clearTimeout(playlistRenderTimer);
      void playlistLibrary.load();
      notify('已创建本地歌单');
    }).catch(error => notify(`新建歌单失败：${(error as Error).message}`));
    return;
  }
  if (target.dataset.action === 'local-playlist-rename') {
    const id = target.dataset.localPlaylistId, name = target.dataset.localPlaylistName ?? '';
    if (!id) return;
    const next = window.prompt('重命名歌单：', name);
    if (next === null || !next.trim() || next.trim() === name) return;
    void localPlaylists.rename(id, next.trim()).then(async () => {
      await refreshLocalPlaylistsPanel();
      playlistLibrary.dispose(); clearTimeout(playlistRenderTimer);
      void playlistLibrary.load();
    }).catch(error => notify(`重命名失败：${(error as Error).message}`));
    return;
  }
  if (target.dataset.action === 'local-playlist-remove') {
    const id = target.dataset.localPlaylistId, name = target.dataset.localPlaylistName ?? '';
    if (!id) return;
    if (!window.confirm(`确定删除歌单「${name}」及其中歌曲吗？`)) return;
    void localPlaylists.remove(id).then(async () => {
      await refreshLocalPlaylistsPanel();
      playlistLibrary.dispose(); clearTimeout(playlistRenderTimer);
      void playlistLibrary.load();
      notify('已删除');
    }).catch(error => notify(`删除失败：${(error as Error).message}`));
    return;
  }
  if (target.dataset.action === 'local-playlist-import') {
    notify('导入网络歌单：在「我的歌单」里打开一个平台歌单，再用「添加到歌单」存到本机。');
    return;
  }
  if (target.dataset.action === 'local-playlist-batch') {
    notify('批量管理：多选模式下可批量移除歌曲。');
    return;
  }
 // 「加入歌单」对话框：选一个本地歌单把当前曲目存进去。
  if (target.dataset.addToPlaylist !== undefined) {
    const id = target.dataset.addToPlaylist;
    if (!id || !addToPlaylistTracks.length) return;
    void localPlaylists.addSongs(id, addToPlaylistTracks).then(async result => {
      await refreshLocalPlaylistsPanel();
      playlistLibrary.dispose(); clearTimeout(playlistRenderTimer);
      void playlistLibrary.load();
 // 文案对齐上游：allExist / skipped>0 / 全部新增。
      if (result.allExist) notify('所选歌曲已在该歌单中');
      else if (result.skipped > 0) notify(`部分歌曲已存在，已添加 ${result.added} 首`);
      else notify(`已添加 ${result.added} 首`);
      addToPlaylistTracks = [];
 // 加完把面板交回临时歌单视图（对话框只替换了 #queue-panel 的内容）。
      if (panel === 'playlists') renderPlaylistsPanel(); else closePanel();
    }).catch(error => notify(`加入失败：${(error as Error).message}`));
    return;
  }
  if (target.dataset.action === 'add-to-playlist-cancel') {
    addToPlaylistTracks = [];
    if (panel === 'playlists') renderPlaylistsPanel(); else closePanel();
    return;
  }
 // ♥ 收藏：一键收进本地「莱茵歌单」（对照参考行为的本地收藏，固定心形不给样式）。
 // 取曲按 id 对齐：搜索行 → 详情页曲目 → 临时歌单 → 当前播放，谁的 id 匹配用谁，
 // 避免详情页看着 A 首却把 B 首收进去。
  if (target.dataset.action === 'song-favorite') {
    const songId = target.dataset.favoriteSong ?? '';
    const candidates = [
      ...(target.dataset.favoriteRow ? [onlineSearch.trackOf(target.dataset.favoriteRow)] : []),
      ...(currentAlbum()?.tracks ?? []),
      ...playerState.queue,
      ...(playerState.currentTrack ? [playerState.currentTrack] : []),
    ];
    const track = candidates.find(item => item && item.id === songId);
    if (!track) { notify('没有可收藏的歌曲。'); return; }
    void (async () => {
      try {
        if (favoriteIds.has(track.id)) {
          await localPlaylists.unfavorite(track.id);
          favoriteIds.delete(track.id);
          notify('已取消收藏');
        } else {
          await localPlaylists.favorite(track);
          favoriteIds.add(track.id);
          notify('已收藏到「莱茵歌单」');
        }
        refreshFavoriteHearts();
        void refreshLocalPlaylistsPanel();
        renderPlaylistsPanel();
 // 收藏/取消收藏会改变「莱茵歌单」的曲目集合，正在歌单墙上翻它的时候
 // 必须立刻重读并重画，否则取消收藏后这首歌还留在墙上（用户看到的就是
 // 「取消了但没退出莱茵歌单」）。其他歌单不受影响，不必重载。
        void syncFavoritesPlaylistWall();
      } catch (error) {
        notify(error instanceof Error ? error.message : '收藏失败，请检查本地服务。');
      }
    })();
    return;
  }
  if (target.dataset.action === 'song-add-to-playlist') {
 // 详情页正在看的这首歌：#song-view 的 data-song 就是它的 id（可能是当前
 // 播放的，也可能是用户切到的另一首）。取不到就退回当前播放的曲目。
    const songId = document.querySelector<HTMLElement>('#song-view')?.dataset.song;
    const album = currentAlbum();
    const track = (songId ? album?.tracks.find(item => item.id === songId) : undefined)
      ?? playerState.currentTrack ?? album?.tracks[0];
    if (!track) { notify('没有可加入歌单的歌曲。'); return; }
    openAddToPlaylist([track]);
    return;
  }
  if (target.dataset.loginProvider && panel === "netease-login") {
    loginProvider = musicProvider(target.dataset.loginProvider); renderLoginPanel(); return;
  }
  if (target.dataset.searchSource) {
    searchSource = target.dataset.searchSource === "network" ? "network" : "local";
    renderSearchPanel();
    document.querySelector<HTMLInputElement>("#online-search, #album-search")?.focus();
    return;
  }
  if (target.dataset.overviewPlaylistToggle !== undefined) {
    const lane = Number(target.dataset.overviewPlaylistToggle);
    if (overviewUI.togglePlaylist(lane) && accountView) void loadOverviewPlaylist(lane);
    else overviewListEpoch++;
    return;
  }
  if (target.dataset.overviewLane !== undefined) {
    const lane = Number(target.dataset.overviewLane);
    overviewUI.expand(lane);
    return;
  }
  if (target.dataset.overviewEnterLane !== undefined) {
    const lane = Number(target.dataset.overviewEnterLane);
    if (!overviewUI.canEnter(lane)) return;
    if (accountView) {
      const row = wrap(lane - 2, playlistLibrary.playlists.length);
      const song = Math.round(scene?.musicBrowseRow ?? 12) - 12;
      setOverview(false);
      void navigatePlaylist(row, song);
      return;
    }
    const targetColumn = resolveColumnSelection(lane);
    const navigation = targetColumn.row === undefined ? undefined : {
      cell: scene?.musicColumnCell(lane, targetColumn.row) ?? { lane, row: targetColumn.row },
      guided: true,
    };
 // The shared preference chooses an album; reveal browse text only after the
 // rail and near camera settle. Entry never opens album details.
    select(targetColumn.index, navigation, false);
    setOverview(false);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (target.dataset.track) {
 // 搜索结果行：play the song and follow it into the play detail.
    if (currentAlbum()?.id === 'search-results') openDetailAfterQueueSettle = true;
    playAlbum(target.dataset.track);
    return;
  }
  if (target.dataset.select) {
    const playlist = records[Number(target.dataset.select)]?.album?.playlistCell;
    if (playlist) { void navigatePlaylist(playlist.playlistIndex, playlist.songIndex); return; }
    if (records[0]?.album?.playback) {
      const card = records[Number(target.dataset.select)]?.album;
      const anchor = records.find(record => record.album?.searchAnchor)?.album;
      if (card?.tracks[0]) {
 // The search wall's cards play inside the results queue; the plain
 // playback wall keeps its established queue lookup semantics.
        if (anchor) void player.play(card.tracks[0].id, anchor.tracks);
        else void player.play(card.tracks[0].id);
      }
      return;
    }
    const rulerStep = Number(target.dataset.rulerStep);
    select(Number(target.dataset.select),
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (target.dataset.album) {
    if (accountView) {
      accountView = false; playlistSelectionEpoch++; stage.classList.remove('playlist-grid');
      browseLibraryDuringPlayback = true; playbackBrowseTrackId = playerState.currentTrack?.id; playbackVisualKey = '';
      void playbackVisualTask.then(async () => { await applyLibrary(); scene?.setMusicArrayMode(preferences.arrayMode); revealAlbum(target.dataset.album!, target.dataset.searchTrack); });
      return;
    }
    if (records[0]?.album?.playback) {
      browseLibraryDuringPlayback = true; playbackBrowseTrackId = playerState.currentTrack?.id; playbackVisualKey = '';
      stage.classList.remove('playback-albums');
      void playbackVisualTask.then(async () => { await applyLibrary(); scene?.setMusicArrayMode(preferences.arrayMode); revealAlbum(target.dataset.album!, target.dataset.searchTrack); });
      return;
    }
    revealAlbum(target.dataset.album, target.dataset.searchTrack);
    return;
  }
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  const action = target.dataset.action;
  if (action === 'settings-category') {
    const category = target.dataset.category as SettingsCategory;
    if (Object.hasOwn(settingsCategories, category)) {
      settingsCategory = category;
      if (panel === 'library') openPanel('settings');
      else selectSettingsCategory($("#music-panel-root"), category);
 // 切分类后清掉搜索词：留在页里的是完整列表，别让人以为只剩一条。
      const search = document.querySelector<HTMLInputElement>('#settings-search');
      if (search && search.value) {
        search.value = '';
        filterSettings($('#music-panel-root'), '');
      }
    }
    return;
  }
  if (action === 'playlists') {
    openPanel('playlists');
    return;
  }
  if (["library", "search", "settings", "netease-login"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  switch (action) {
    case 'overview-play-song': {
      const lane = Number(target.dataset.listLane);
      if (overview && accountView && overviewUI.canEnter(lane)) {
        overviewListEpoch++;
        setOverview(false); setMode('archive');
        void navigatePlaylist(wrap(lane - 2, playlistLibrary.playlists.length), Number(target.dataset.songIndex));
      }
      break;
    }
    case 'song-toggle-play':
 // One control: pause and resume only ever mute the audio; playback state
 // and the now-playing display survive every press (no stop semantics).
      if (playerState.currentTrack?.id === currentAlbum()?.tracks[0]?.id && !['idle', 'error'].includes(playerState.transport)) void player.toggle();
      else void startSelectedSong();
      break;
    case 'playing-prev':
      void stepPlayingSong(-1);
      break;
    case 'playing-next':
      void stepPlayingSong(1);
      break;
    case 'song-mv': {
      const track = detailOnlineTrack();
      if (track) void openSongMv(track);
      break;
    }
    case "copy-performance":
      void copyPerformanceReport();
      break;
    case 'compose-feedback':
      void composeFeedback();
      break;
    case 'copy-feedback':
      void copyFeedback();
      break;
    case 'save-feedback': {
      const feedback = refreshFeedbackReport();
      if (feedback) {
        const url = URL.createObjectURL(new Blob([feedback.report], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'Rhine-Music-feedback.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      break;
    }
    case "show-online-errors":
      onlineDebug.show();
      break;
    case "reload-interface":
      disposePage();
      location.reload();
      break;
    case "refresh-output":
      void refreshAudioOutputs();
      break;
    case "overview-return":
      setOverview(false);
      break;
    case "overview":
      if (overview) setOverview(false);
      else if (accountActive) void openMyPlaylistsOverview();
      else setOverview(true);
      break;
    case "replay-boot":
      closePanel(() => { setOverview(false, false); boot?.replay(); });
      break;
    case "lighting-debug":
      closePanel(() => {
        setMode("archive");
        lightingControls?.focus();
      });
      break;
    case "motion-debug":
      closePanel(() => {
        setMode("archive");
        motionControls?.focus();
      });
      break;
    case "locate-playing":
      locatePlaying();
      break;
    case "cache-clear":
 // 这个按钮以前完全没有处理器：HTML 里声明了 data-action="cache-clear"，
 // 但事件委托的 switch 里没有对应分支，点了什么都不会发生。
      void clearCacheFromSettings();
      break;
    case "visualizer-color-reset":
      preferences.visualizer = normalizeVisualizer({ ...preferences.visualizer, color: undefined });
      savePrefs();
      visualizer.configure(preferences.visualizer);
      {
        const input = document.querySelector<HTMLInputElement>("#visualizer-color");
        if (input) input.value = "#d9ad7d";
      }
      break;
    case "pool-connectivity":
      void runPoolConnectivity();
      break;
    case "pool-credential-import":
      pickPoolCredentialFile();
      break;
    case "pool-qr-login":
      void startPoolQrLogin();
      break;
    case "pool-qr-cancel":
      closePoolQrPanel();
      break;
    case "pool-credential-export":
      openExternal(poolCredentialExportUrl());
      break;
    case "pool-credential-clear":
      void removePoolCredential();
      break;
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    case "open":
      setMode("detail");
      if (currentAlbum()?.playlistCell || currentAlbum()?.tracks[0]?.onlineSource) void startSelectedSong();
      break;
    case "back":
      setMode("archive");
      break;
    case "model-viewer":
 // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "retry-startup":
      location.reload();
      break;
    case "lx-sources-add":
      document.querySelector<HTMLInputElement>("#lx-sources-files")?.click();
      break;
    case "lx-sources-test":
      void testLxSources();
      break;
    case "lx-group-toggle": {
      // 折叠/展开「自带音源」。状态存本地，重渲染后保持原样。
      const open = localStorage.getItem("rhine-lx-builtin-open") !== "1";
      localStorage.setItem("rhine-lx-builtin-open", open ? "1" : "0");
      const group = target.closest(".lx-source-group");
      const body = group?.querySelector<HTMLElement>(".lx-source-group-list");
      const chevron = group?.querySelector<HTMLElement>(".lx-source-group-chevron");
      if (body) body.hidden = !open;
      if (chevron) chevron.textContent = open ? "▾" : "▸";
      target.setAttribute("aria-expanded", String(open));
      break;
    }
    case "lx-source-toggle": {
      // 【2026-10-24】乐观启停：点下的瞬间按钮和行就切过去，后端随后跟上。
      // 以前点完要干等 1–2 秒才有反应，像是指令没执行。失败才回滚并提示。
      const row = target.closest(".lx-source-row");
      const id = target.dataset.id ?? "";
      const next = target.dataset.enabled !== "true";
      const paint = (enabled: boolean) => {
        row?.classList.toggle("lx-source-off", !enabled);
        target.dataset.enabled = String(enabled);
        target.textContent = enabled ? "停用" : "启用";
      };
      paint(next);
      void lxSourcesRequest("/api/lx/sources/toggle", { id, enabled: next })
        .catch(() => {
          paint(!next);
          const status = document.querySelector<HTMLElement>("#lx-sources-status");
          if (status) status.textContent = "启停没有成功，已恢复原状态。";
        });
      break;
    }
    case "lx-source-remove":
      void lxSourcesRequest("/api/lx/sources/remove", { id: target.dataset.id });
      break;
    case "avatar-reset":
      preferences.avatar = undefined;
      save("rhine-music-preferences", preferences);
      applyAvatar();
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "fullscreen":
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    case "genres":
      if (accountView) closePanel(() => void openMyPlaylistsOverview());
      else openPanel('search');
      break;
    case 'play-mode':
      player.setMode(nextPlayMode(playerState.mode));
      break;
    case 'audio-effects':
      effectsPanel.open(loadEffectsConfig(), config => { saveEffectsConfig(config); player.setEffects(config); });
      break;
    case 'download-song':
      downloadPanel.open(currentDownloadTarget(), listDownloadOptions, downloadCurrentSong);
      break;
   // 版本更新：主动检查一定给回音（已是最新 / 查不到 / 有新版本都提示）。
    case 'update-check':
      void updateCenter.check(true);
      break;
    case 'update-repo':
      openExternal('https://github.com/kaelorvyn/Rhine-Music-Windows/releases');
      break;
    case "play-pause":
      playerState.currentTrack ? void player.toggle() : playAlbum();
      break;
    case 'refresh-playlists':
      if (accountActive) { accountView = true; playlistSelectionEpoch++; void playlistLibrary.load().then(() => playlistLibrary.window(firstPlayablePlaylist(), 0)); }
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "credits-album":
      void queryCredits(true);
      break;
    case "credits-retry":
      void queryCredits(true, true);
      break;
    case "credits-library":
      void queryCredits();
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "edit-genres":
      void editGenres();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });

        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);

          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
 // 设置搜索（对照参考行为 settings.searchPlaceholder / searchNoResult）：跨分类实时筛。
  if (el.id === 'settings-search') {
    filterSettings($('#music-panel-root'), el.value);
    return;
  }
 // 文本类设置（缓存位置 / MV 下载目录）边打边存，不必等失焦。
  if (el.type === 'text' && el.dataset.settingsKey) applySetting(el.dataset.settingsKey, el);
 // 帧率滑杆：拖动过程中就生效，松手前就能从状态栏 FPS 看到变化，
 // 不必等 change（否则用户会以为"只是个样子"）。
  if (el.dataset.settingsKey === 'frameRate') applySetting('frameRate', el);
  if (el.id === 'feedback-description') { feedbackDescription = el.value; refreshFeedbackReport(); }
  if (el.classList.contains('playback-seek')) {
    songView.previewSeek(el); return;
  }
  if (el.dataset.quality && el.type === "range") {
    preferences.qualityMode = 'manual';
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "bgm-volume") {
    preferences.bgmVolume = Number(el.value) / 100;
    player.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "album-search") renderSearchResults();
 // 详情页音量条（和音效器一组），与设置面板共用同一份 preferences。
  if (el.classList.contains("volume-range")) {
    preferences.volume = Number(el.value);
    player.setVolume(preferences.volume);
    paintTransportVolume(el);
    savePrefs();
  }
  if (el.id === "volume") {
    preferences.volume = Number(el.value) / 100;
    player.setVolume(preferences.volume);
    savePrefs();
  }
});
/** 音量条的填充比例（0..1 → CSS 变量）。 */
function paintTransportVolume(input?: HTMLInputElement) {
  const range = input ?? document.querySelector<HTMLInputElement>('.volume-range');
  if (!range) return;
  range.style.setProperty('--volume', `${Number(range.value) * 100}%`);
}
document.addEventListener("change", (e) => {  const el = e.target as HTMLInputElement;
 // 共享音源密钥文件：选中后读文本交给后端。
  if (el.id === "pool-credential-file") {
    void handlePoolCredentialFile(el);
    return;
  }
  // 自定义音源：支持一次选多个 .js，选完直接写入并加载。
  if (el.id === "lx-sources-files") {
    void addLxSources(el.files);
    el.value = "";
    return;
  }
  if (el.id === "glass-occlusion") {
    if (el.value === "on" || el.value === "off" || el.value === "debug") {
      glassOcclusionMode = el.value;
      scene?.setGlassOcclusion(glassOcclusionMode);
    }
    return;
  }
  if (el.classList.contains('playback-seek')) {
    songView.commitSeek(el); updateSongTransport(); return;
  }
  // 歌单来源选择器已换成自定义下拉（见 mountPlaylistPlatformPicker），
  // 不再走 select 的 change 事件。
 // 通用设置项：任何带 data-settings-key 的控件都走这里（第五步设置面板会大量复用）。
  const settingsKey = el.dataset.settingsKey;
  if (settingsKey) { applySetting(settingsKey, el); return; }
  if (el.id === "audio-backend") {
    void changeAudioOutput(el.value === "coreaudio" ? "coreaudio" : "browser", playerState.outputDeviceId);
  }
  if (el.id === "audio-device") void changeAudioOutput(playerState.backend, el.value);
  if (el.id === "developer-mode") {
    preferences.developerMode = el.checked;
    lightingControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="lighting-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "developer-motion") {
    preferences.motionDebug = el.checked;
    motionControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="motion-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "avatar-upload") {
    void setAvatarFromFile(el.files?.[0]);
    el.value = '';
    return;
  }
  if (el.id === "download-directory" || el.id === "download-quality" || el.id === "download-naming") {
    void configureDownloads(); return;
  }
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    location.reload();
    return;
  }
  if (el.id === 'online-error-display') {
    preferences.onlineErrorDisplay = el.checked;
    onlineDebug.setEnabled(el.checked);
    const view = document.querySelector<HTMLButtonElement>('[data-action="show-online-errors"]');
    if (view) view.disabled = !el.checked;
    savePrefs();
  }
  if (el.id === "music-array-mode") {
    preferences.arrayMode = normalizeMusicArrayMode(el.value);
    scene?.setMusicArrayMode(records[0]?.album?.playback || accountView ? 'filled' : preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    updateSelection();
    savePrefs();
  }
  if (el.id === "remember-column-position") {
    preferences.rememberColumnPosition = el.checked;
 // Changing this preference never navigates or changes playback. Re-enabling
 // starts with the current album while other columns retain their session memory.
    if (el.checked && records[selected]) columnMemory.set(
      archiveColumns[fileLocation(selected).lane], records[selected].id,
    );
    savePrefs();
  }
  if (el.id === 'quality-mode') {
    preferences.qualityMode = el.value === 'auto' ? 'auto' : 'manual';
    if (preferences.qualityMode === 'auto') detectAutomaticQuality();
    updateQuality();
  }
  if (el.id === "quality-preset") {
    preferences.qualityMode = 'manual';
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    preferences.qualityMode = 'manual';
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    const mode = normalizeSongTransition(el.value);
    preferences.songTransition = mode;
    el.value = mode;
    player.setSongTransitionMode(mode);
    savePrefs();
  }
  if (el.id === "visualizer-enabled") {
    preferences.visualizer = normalizeVisualizer({ ...preferences.visualizer, enabled: el.checked });
    savePrefs();
    player.setSpectrumEnabled(preferences.visualizer.enabled, preferences.reduced);
    visualizer.configure(preferences.visualizer);
    return;
  }
  if (el.id === "visualizer-position") {
    preferences.visualizer = normalizeVisualizer({ ...preferences.visualizer, position: el.value as "progress" | "bottom" });
    savePrefs();
    visualizer.configure(preferences.visualizer);
    return;
  }
  if (el.id === "visualizer-style") {
    preferences.visualizer = normalizeVisualizer({ ...preferences.visualizer, style: el.value as "bars" | "dots" | "mini" | "outline" });
    savePrefs();
    visualizer.configure(preferences.visualizer);
    return;
  }
  if (el.id === "visualizer-color") {
    preferences.visualizer = normalizeVisualizer({ ...preferences.visualizer, color: el.value });
    savePrefs();
    visualizer.configure(preferences.visualizer);
    return;
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
      overviewUI.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
  }
  if (el.id === "bgm-setting") {
    preferences.bgm = el.checked;
    player.setBgmEnabled(el.checked);
    savePrefs();
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen || mvPlayer.isOpen) return;
  if (e.key === "Escape") {
    playlistOverviewRequested = false;
    panel ? closePanel() : overview ? setOverview(false) : setMode("archive");
    return;
  }
  if (panel) {
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ].filter((node) => !node.matches(":disabled") && node.tabIndex >= 0 &&
        !node.closest("[hidden], [inert]") && node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== "hidden");
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
    return;
  }
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setOverview(!overview);
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    setMode("detail");
  }
  if (e.code === "Space" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    playerState.currentTrack ? void player.toggle() : playAlbum();
  }
});

let lastFrame: number | undefined;
let frameCount = 0, frameHandle = 0;
let frameDisposed = false, frameSuspended = false;
let nativeHidden = false;
const renderScheduler = new RenderScheduler();
/**
 * 把用户的帧率偏好作用到渲染调度器，并刷新设置页的状态文案。
 *
 * 这是"真的能调节帧率"的落点：`RenderScheduler.shouldRender` 是整条
 * rAF 渲染循环的唯一闸门（见下方 frame()），改它的上限就真的改了
 * 每秒钟画多少帧，而不是只改个显示。
 *
 * 启动时也要调一次 —— 用户要求"下次启动时，界面动画以这个帧率运行"，
 * 所以这个函数在初始化路径上被调用（见 initFrameRate 的调用点）。
 */
function applyFrameRate() {
  renderScheduler.setFrameRate(preferences.frameRate);
 // 改上限后清掉帧计时基准，避免用旧基准算出的第一帧间隔异常，
 // 让 FPS 读数也立刻反映新值。
  resetFrameTiming();
  const status = document.querySelector('#frame-rate-status');
  if (status) status.textContent = frameRateLabel(preferences.frameRate);
}
for (const event of ["pointerdown", "wheel", "keydown"] as const)
  document.addEventListener(event, () => renderScheduler.wake(performance.now()), { passive: true });
document.addEventListener("pointermove", event => { if (event.buttons) renderScheduler.wake(performance.now()); }, { passive: true });
const frameTiming = new MusicFrameTiming();
let textMotionTime = 0, textMotionLastFrame: number | undefined;
function frame(ms: number) {
  frameHandle = 0;
  if (frameDisposed || frameSuspended) return;
  if (!renderScheduler.shouldRender(ms, Boolean(boot?.active || viewer?.isOpen || scene?.musicRenderTransitioning),
    (isDesktop() || new URLSearchParams(location.search).get("scheduler") === "1") &&
      new URLSearchParams(location.search).get("render") !== "reference")) {
    frameHandle = requestAnimationFrame(frame); return;
  }
  const workStart = performance.now();
  const textDt = textMotionLastFrame === undefined ? 0 : Math.min(.05, Math.max(0, ms - textMotionLastFrame) / 1000);
  textMotionLastFrame = ms;
  if (!document.hidden && scene) {
    frameTiming.begin(ms);
    if (lastFrame === undefined) lastFrame = ms;
    textMotionTime += textDt * (preferences.reduced ? 1 : getMusicMotionSpeed());
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen && opening?.renderScene !== false) scene.update(ms / 1000, opening?.cinema);
    updateOverview();
    if (overviewRevealPending && !overview && !boot?.active &&
      scene.musicOverviewProgress < .02 && scene.musicArchiveReady) {
      overviewRevealPending = false;
      showBrowseSurface();
    }
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    tryEnterPlaylistOverview();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    const detailTextVisible = phase === 'detail' &&
      $("#music-detail").dataset.transition === 'open' && !viewer?.isOpen && !panel;
    songView.setVisible(detailTextVisible);
    if (presentation.phase === "detail") {
      documentDecryption.update(
        textMotionTime,
        scene.decryptionFrame,
        preferences.reduced,
        detailTextVisible,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      if (pendingTrackReveal && !panel && !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingTrackReveal.albumId) {
        const content = $("#album-detail-content");
        const trackId = pendingTrackReveal.trackId;
        pendingTrackReveal = undefined;
        const row = Array.from(content.querySelectorAll<HTMLButtonElement>(".track-row"))
          .find((item) => item.dataset.track === trackId);
        if (row) trackFocus.reveal(content, row, preferences.reduced);
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      $("#runtime-info").textContent =
        `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS / ${themeNames[preferences.theme]} / V${appVersion}`;
 // Keep read-only render diagnostics alongside the existing resolution
 // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight, arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics, gpuTiming, optimization } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
          arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics, gpuTiming, optimization,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      $("#three-scene").dataset.frameTiming = JSON.stringify(frameTiming.snapshot());
      frameCount = 0;
      lastFrame = ms;
    }
    frameTiming.end(performance.now() - workStart);
  } else {
    resetFrameTiming();
  }
  frameHandle = requestAnimationFrame(frame);
}
function resetFrameTiming() {
  renderScheduler.reset();
  frameCount = 0;
  lastFrame = undefined;
  textMotionLastFrame = undefined;
  frameTiming.reset();
}
function suspendPage() {
  songView.setVisible(false);
  frameSuspended = true;
  cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  clearTimeout(pollTimer);
  resetFrameTiming();
}
function resumePage() {
  if (frameDisposed || document.hidden || nativeHidden) return;
  frameSuspended = false;
  resetFrameTiming();
  if (ready && !frameHandle) frameHandle = requestAnimationFrame(frame);
  if (ready) void loadLibrary();
}
function disposePage() {
  playlistLibrary.dispose(); clearTimeout(playlistRenderTimer); playlistPlayEpoch++; playlistSelectionEpoch++;
  if (frameDisposed) return;
  frameDisposed = true;
  onlineDebug.dispose();
  songView.dispose(); disposePlatformLogin();
  playlistSongBars.destroy();
  onlineSearch.dispose(); playbackVisualGeneration++;
  suspendPage();
  clearTimeout(toastTimer);
  boot?.dispose();
  overviewUI.dispose();
  player.dispose();
  effects.dispose();
  trackFocus.cancel();
  scene?.dispose();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) suspendPage(); else resumePage();
});
window.addEventListener("rhine-desktop-visibility", event => {
  nativeHidden = (event as CustomEvent<{ hidden: boolean }>).detail.hidden;
  if (nativeHidden) suspendPage(); else resumePage();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) suspendPage(); else disposePage();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) resumePage(); });

/** 启动阶段超时器：对齐预览版的 xt.run。
 *  每个阶段都有自己的上限 —— 任何一步卡住都不该让加载页无限转圈，
 *  超时/抛错时打日志并交给上层决定降级还是进失败页。 */
async function runStartupStage<T>(label: string, run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 启动失败页：说明原因，并给「重新加载」与「打开设置」两个出口。 */
function showStartupFailure(message: string) {
  // 胶片还在跑的时候，失败信息交给它自己那一套（预览版同一套文案与重试按钮）。
  if (entry?.active) { entry.fail(message); return; }
  const node = document.querySelector<HTMLElement>("#music-loading");
  if (!node) return;
  node.hidden = false;
  node.innerHTML = `<strong>启动未能完成</strong><small>${esc(message)}</small>` +
    `<button class="primary-button" data-action="retry-startup">重新加载</button>` +
    `<button data-action="settings">打开设置</button>`;
}

async function start() {
 // This local application owns its live index. An old archive PWA must not serve stale UI.
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  initTransportVolume();
 // 先把托盘偏好同步给 Rust，再干别的：用户上次若关掉了「最小化到托盘」，
 // 本次启动点关闭就该真退出，不能还拦回托盘（那样找不到退出入口）。
  syncTrayPreference(preferences.minimizeToTray);
 // 版本更新：这里只发起一次后台 fetch，**不 await** —— 检测慢或失败都不该
 // 拖住进入应用的路径；之后每小时复查一次由 UpdateCenter 自己排。
  updateCenter.start();
 // 用户要求：封面不要等开场动画跑完才一张张下。先把首屏那几张的请求发出去
 // （此刻 records 还是内置档案，通常没封面，纯属不放过任何一次提前建连的机会）。
  warmFirstScreenCovers();
  // 曲库读不到就带着内置档案继续 —— 这一跳不值得挡住整个应用。
  await runStartupStage("读取曲库", () => loadLibrary(true), 20000).catch((error) => {
    console.warn("[启动] 曲库读取失败，先用内置档案继续：", error);
  });
  if (frameDisposed) return;
 // 真正的第一枪：曲库到手、封面 URL 已知，立刻在加载页/动画期间建连 + 进 HTTP 缓存，
 // 不等 boot.start()，更不等动画结束。这里直接预热**全库**（前台优先 + 并发 8），
 // 否则快速切换时新进视口的封面才开始下载，必然卡。
  warmAllCovers();
  preloadNearbyCovers();
  if (frameDisposed) return;
  try {
    fit();
    scene = new ArchiveScene($("#three-scene"));
    detectAutomaticQuality();
    scene.setQuality(renderQuality);
    scene.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
 // Keep a direct visual comparison URL without adding another user setting.
    if (lightingLab || new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    if (lightingLab) {
      const devPanels = document.createElement("div");
      devPanels.className = "music-dev-panels";
      stage.append(devPanels);
      const closeDebugPanel = (key: "developerMode" | "motionDebug") => {
        preferences[key] = false;
        savePrefs();
        if (panel === "settings") renderSettingsPanel();
        else document.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus({ preventScroll: true });
      };
      motionControls = setupMotionLab(devPanels, {
        enabled: preferences.motionDebug,
        onChange: (speed) => { preferences.motionSpeed = speed; savePrefs(); },
        onClose: () => closeDebugPanel("motionDebug"),
      });
      lightingControls = setupLightingLab(devPanels, {
        setExperiment: (settings) => scene?.setLightingExperiment(settings),
        enabled: preferences.developerMode,
        initial: preferences.lighting,
        onChange: (settings) => {
          preferences.lighting = settings;
          savePrefs();
        },
        onClose: () => closeDebugPanel("developerMode"),
      });
    }
    await runStartupStage("载入三维场景", () => Promise.all([
      scene!.load(undefined, selected),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("600 20px MiSans"),
    ]), 45000);
    if (frameDisposed) return;
 // 场景已建、格已定：此刻就把选中格周围的封面压进解码队列，比 boot.start()
 // 早一整段（开场动画期间/之前），动画结束时这些封面已经在解或在缓存里。
    preloadNearbyCovers();
    entry?.setStatus("正在准备玻璃材质与专辑封面…");
    $("#three-scene canvas").setAttribute(
      "aria-label",
      `三维专辑阵列，左右切${sortLabel.column}，上下切专辑`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    scene.setTheme(preferences.theme);
    preferences.renderQuality = renderQuality; savePrefs();
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    await runStartupStage("准备渲染器", () => scene!.prepareMusicRenderer(), 60000);
    if (frameDisposed) return;
 // Browser playback does not need a Swift compiler at startup. A saved
 // native output is restored after graphics preparation; otherwise discover
 // native devices only when the user opens the output settings.
    if (preferences.audioBackend === "coreaudio") {
      entry?.setStatus("正在连接已选择的音频设备…");
      await runStartupStage("连接音频设备", () => refreshAudioOutputs(true), 15000).catch((error) => {
        console.warn("[启动] 音频设备连接失败，稍后可在设置里重试：", error);
      });
    }
    if (frameDisposed) return;
    ready = true;
 // 本地歌单不依赖登录：先把歌单视图带起来，平台登录态稍后合并。
    onlineAccountChanged('netease', accountStates.netease ?? { loggedIn: false } as NeteaseAccount);
 // Every login-eligible platform reports its session at boot so the playlist
 // platform selector can show the logged-in platforms from the start.
    for (const provider of (Object.keys(platformLogins) as MusicProvider[]).filter(p => !loginHiddenProviders.has(p))) void platformLogins[provider].status();
    $<HTMLButtonElement>('[data-action="overview"]').disabled = false;
    scene.onSelect = (index, cell, selectedModel) => {
      if (!boot?.active && presentation.phase === "archive" && !panel) {
        const playlist = records[index]?.album?.playlistCell;
        if (playlist) {
          const fromOverview = overview;
          if (fromOverview) setOverview(false);
          if (!fromOverview && selectedModel && index === selected && currentAlbum()?.tracks.length) { setMode('detail'); void playPlaylistSong(); }
          else void navigatePlaylist(playlist.playlistIndex, playlist.songIndex, cell ? { cell } : undefined);
          return;
        }
        if (!overview && selectedModel && index === selected && records[index]?.album?.tracks[0]?.onlineSource) { setMode('detail'); void startSelectedSong(); return; }
        if (records[0]?.album?.playback && index !== playerState.currentIndex) { const track = playerState.queue[index]; if (track) void player.play(track.id); return; }
        select(index, cell ? { cell } : undefined);
        if (overview) setOverview(false);
      }
    };
    scene.onNavigate = (axis, direction) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    mountMusicWheelNavigation(stage, {
      enabled: () => ready && !boot?.active && presentation.phase === "archive" && !panel &&
        (accountView ? (currentAlbum()?.playlistCell?.total || 0) > 1 : columnFiles(fileLocation(navigationSelection()).lane).length > 1),
      navigate: stepAlbum,
      context: () => fileLocation(navigationSelection()).lane,
    });
    $("#music-loading").remove();
    // 胶片放完（或被跳过）才继续 —— 与预览版一致；跳过键随时可以提前结束。
    if (entry) {
      // 胶片靠 requestAnimationFrame 推进：窗口在后台时 rAF 会停，胶片就永远
      // 放不完。这里给一个硬上限 —— 到点直接收摊，绝不把进入应用卡死。
      await Promise.race([
        entry.completeLoading(),
        new Promise<void>((resolve) => { window.setTimeout(resolve, 30000); }),
      ]);
      entry.dispose();
    }
    updateSelection();
 // 加载页撤掉之后播开场动画（用户要求：等加载完毕之后再放开场动画）。
 //
 // 原来这里是 showMusicArchiveImmediately()，直接把专辑架静态摆出来，
 // MusicBoot 只是被 new 出来、start() 从没调用过 —— 所以开场动画永远看不到
 // （只有设置里手动「重播开场」才跑一次）。
 //
 // 现在交给 boot.start()：它会先藏起其它层，由帧循环里的 boot.update()
 // 推进整段动画，结束后走 onComplete → showMusicArchiveImmediately()
 // （skip 分支）或 finishMusicIntro()（完整播完）。两条路径都会回到档案架。
 // reduced（减少动态效果）时 start() 内部会立刻 skip()，等价于原来的直接显示。
    // 与预览版一致：开机胶片之后直接是专辑阵列波浪（约 5.2 秒），
    // 不再插一段口号片；口号片仍保留给设置里的「重播开场」。
    boot?.startScene(performance.now() / 1000);
    if (boot?.active === true) {
 // 开场动画进行中：可见性/inert 由 MusicBoot 自己管（它在 start() 里把
 // 兄弟层设为 inert 并隐藏），这里**不能**再去改 #music-browse 的 inert，
 // 否则会把动画的交互锁覆盖掉，动画期间还能点到后面的专辑架。
 // 收尾由 onComplete → showBrowseSurface() 负责。
 //
 // 看门狗：开场动画靠帧循环推进，窗口若在动画期间被最小化/隐藏，
 // requestAnimationFrame 会停，动画卡住、档案架永远出不来。
 // 给一个远大于正常时长（约 11.6 s）的上限，到点强制收尾。
      bootDoneWatchdog = window.setTimeout(() => { if (boot?.active) boot.skip(); }, 20000);
    } else {
 // 兜底：boot 不存在、或已自行结束（reduced 会立刻 skip），
 // 仍要保证档案架可见、可交互。
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
    }
    syncSelectionMotion();
    stage.classList.add("theme-motion-ready");
    if (!document.hidden && !frameDisposed) {
      frameSuspended = false;
 // 启动即按用户上次保存的帧率上限运行（用户要求"下次启动时界面动画
 // 以这个帧率运行"）。必须在首帧 requestAnimationFrame 之前生效，
 // 否则开场动画会先用默认 60 跑一小段。applyFrameRate 内部已重置帧计时。
      applyFrameRate();
      frameHandle = requestAnimationFrame(frame);
 // Poll only after data, geometry and renderer preparation agree. During
 // the opening loadLibrary() defers updates until its handoff completes.
      void loadLibrary();
    }
  } catch (error) {
    console.error(error);
    if (frameDisposed) return;
    showStartupFailure((error as Error).message || "三维资源未能加载。");
  }
}
// 加载页看门狗：正常情况下 start() 会在十几秒内把它撤掉。
// 万一某个阶段静默卡死，这里兜底亮出「启动未能完成 + 重新加载」，
// 而不是让用户对着一个转圈的圈发呆。
window.setTimeout(() => {
  if (!entry?.active && !document.querySelector("#music-loading")) return;
  console.warn("[启动] 加载页超时未撤下，转入失败页");
  showStartupFailure("启动时间过长，某个环节没有完成。");
}, 90000);

void start();
Object.assign(window, {
  rhineMusic: {
    get library() {
      return library;
    },
 /** Read-only account playlist view (the platform selector's filter result). */
    get accountPlaylists() {
      return playlistLibrary.playlists.map(({ id, name, provider, trackCount, favorites }) => ({ id, name, provider, trackCount, favorites: !!favorites }));
    },
    get selectedAlbum() {
      return currentAlbum();
    },
 /** Read-only wall rows: the per-song cards (each with its own cover) and
 * the hidden search anchor, for display-shape assertions. */
    get wallCards() {
      return records.map((record) => ({ id: record.album?.id, coverUrl: record.album?.coverUrl,
        trackId: record.album?.playback?.trackId, anchor: !!record.album?.searchAnchor }));
    },
    get player() {
      return player.state;
    },
 /** 对齐上游的 5 种播放模式（顺序/列表循环/单曲循环/随机/真随机）。 */
    playModes,
 /** Audio-path diagnostics for support dumps (see MusicPlayer.audioDiagnostics). */
    get audioDiagnostics() {
      return {
        ...player.audioDiagnostics,
        volume: player.state.volume,
        transition: player.state.songTransitionMode,
        backend: player.state.backend,
        outputDeviceId: player.state.outputDeviceId,
      };
    },
    stats: () => scene?.getStats(),
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});
