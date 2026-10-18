import { musicPlatforms } from './music-platform.ts';
import { fetchOnline, reportOnlineFailure } from './online-debug.ts';
import type { MusicTrack, PlayMode } from "./music-types";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition.ts";
import { AudioClockSuspended, BrowserGaplessPlayer } from "./music-browser-gapless.ts";
import { AudioEffectsChain, defaultEffectsConfig, normalizeEffectsConfig, type EffectsConfig } from "./audio-effects.ts";

export interface AudioOutputDevice { id: string; name: string }
export interface AudioCapabilities {
  decoderAvailable: boolean;
  nativeAvailable: boolean;
  devices: AudioOutputDevice[];
  decoder?: string | null;
  decoderError?: string | null;
  nativeError?: string | null;
}
interface NativeState {
  trackId: string; playing: boolean; currentTime: number; duration: number;
  deviceId: string; endedSerial: number; error?: string;
  nextTrackId?: string; boundarySerial?: number;
}

/**
 * 把音效配置归一成服务端查询串（中性/关闭时返回 null = 走原始直连地址）。
 *
 * 抽成纯函数是为了能对「改动前的配置」和「改动后的配置」各算一次并比较 ——
 * setEffects() 靠这个判断参数是否真的变了，避免滑块高频触发时每次都重取音频流。
 * 与 scripts/pcm-effects.mjs 的 parseEffectsQuery 一一对应。
 */
export function effectsQueryFor(c: EffectsConfig): string | null {
  if (!c.enabled) return null;
  const active = c.preampDb !== 0 || (c.eqEnabled && c.eqBands.some(band => Number(band)))
    || (c.bassEnabled && c.bassGain > 0) || c.trebleGain !== 0 || c.clarityGain !== 0
    || c.compressor > 0 || c.balance !== 0 || (c.widenEnabled && c.widenWidth !== 100)
    || c.reverbEnabled || c.surroundEnabled || c.limiterEnabled === true;
  if (!active) return null;
  const params = new URLSearchParams();
  const put = (key: string, value: number) => params.set(key, String(value));
  if (c.preampDb) put('preamp', c.preampDb);
  if (c.eqEnabled) params.set('eq', c.eqBands.join(','));
  if (c.bassEnabled && c.bassGain > 0) { put('bass', c.bassGain); put('bassFreq', c.bassFreq); }
  if (c.trebleGain) put('treble', c.trebleGain);
  if (c.clarityGain) put('clarity', c.clarityGain);
  if (c.compressor > 0) put('comp', c.compressor);
  if (c.balance) put('bal', c.balance);
  if (c.widenEnabled && c.widenWidth !== 100) put('widen', c.widenWidth);
  if (c.reverbEnabled) put('rev', c.reverbMix);
  if (c.surroundEnabled) put('sur', c.surroundSpeed);
  if (c.limiterEnabled === true) params.set('lim', '1');
  return params.toString();
}

export interface MusicPlayerState {
  transport: "idle" | "loading" | "playing" | "paused" | "error";
  currentTrack: MusicTrack | null;
  queue: readonly MusicTrack[];
  currentIndex: number;
  mode: PlayMode;
  playing: boolean;
  loading: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  songTransitionMode: SongTransitionMode;
 /** Legacy read-only projection; new settings use songTransitionMode. */
  songFadeEnabled: boolean;
  bgmVolume: number;
  bgmEnabled: boolean;
  bgmPlaying: boolean;
  error: string | null;
  bgmError: string | null;
  backend: "browser" | "coreaudio";
  outputDeviceId: string;
  outputDevices: AudioOutputDevice[];
  decoderAvailable: boolean;
  nativeAvailable: boolean;
  outputError: string | null;
  transitionWarning: string | null;
 /** 在线试听片段（平台 freeTrialInfo/is_free_part 实证返回时非空）。 */
  trial: { start: number; end: number } | null;
}

type Listener = (state: MusicPlayerState) => void;
type Transport = MusicPlayerState["transport"];
type Fade = { timer: ReturnType<typeof setTimeout>; finish: () => void };
type OnlineRecovery = { retries: number };

const ONLINE_RETRY_DELAYS = [600, 1400, 2800] as const;
const retryableOnlineStatus = (status: number) => [408, 425, 429].includes(status) || status >= 500 && status <= 599;
class OnlineSourceError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}
const retryDelay = (milliseconds: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) { resolve(false); return; }
  const finish = (ready: boolean) => {
    clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(ready);
  };
  const abort = () => finish(false);
  const timer = setTimeout(() => finish(true), milliseconds);
  signal.addEventListener('abort', abort, { once: true });
});

const SONG_FADE_MS = 450;
const unit = (value: number) => Math.max(0, Math.min(1, value));
const seconds = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;
const isDsdTrack = (track: MusicTrack) =>
  /^(DSD|DSF|DFF)$/i.test(track.format) || /\.(dsf|dff)$/i.test(track.relativePath);
const uniqueTracks = (tracks: readonly MusicTrack[]): MusicTrack[] => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
};

/** Music transport is independent from TerminalAudio and the Three.js scene lifecycle. */
export class MusicPlayer {
  private value: Omit<MusicPlayerState, "transport">;
  private listeners = new Set<Listener>();
  private song?: HTMLAudioElement;
  private songTrackId?: string;
  private songGain = 1;
  private songFade?: Fade & { target: number };
  private readonly bgm: HTMLAudioElement;
  private transport: Transport = "idle";
  private operation = 0;
  private bgmOperation = 0;
  private bgmTarget = 0;
  private bgmTask: Promise<void> = Promise.resolve();
  private fade?: Fade;
  private gestureReceived = false;
  private disposed = false;
  private pendingSeek: number | null = null;
  private preparation?: AbortController;
  private onlineRecovery?: OnlineRecovery;
  private nativePoll?: ReturnType<typeof setTimeout>;
  private nativeEndedSerial = 0;
  private outputOperation = 0;
  private nativePollEpoch = 0;
  private gapless?: BrowserGaplessPlayer;
  private gaplessFallback = false;
  private effects?: AudioEffectsChain;
  private effectsContext?: AudioContext;
 /**
 * 已经接过音效链的音频元素。createMediaElementSource 对同一元素只能调一次
 * （重复调用抛 InvalidStateError，会让这一路播放失效），所以记下来防重复。
 */
  private routedSongs = new WeakSet<HTMLAudioElement>();
  private effectsConfig: EffectsConfig = defaultEffectsConfig;
 /** 音效改动的防抖定时器（见 setEffects）：拖滑块时合并成最后一次再换流。 */
  private effectsReloadTimer?: number;
  private nativePreparedId?: string;
  private nativeHandoffId?: string;
  private nativePrepareGeneration = 0;
 /** Track ids in playback order for shuffle-mode previous(); last item is the latest. */
  private playHistory: string[] = [];
 /** Upcoming queue indexes for shuffle; refilled as a shuffled bag, never the current index. */
  private shuffleBag: number[] = [];

  setMode(mode: PlayMode): void {
    if (this.disposed || this.value.mode === mode) return;
    this.value.mode = mode;
    if (mode === "shuffle") this.shuffleBag = [];
    this.emit();
  }

  private refillShuffleBag(current: number): void {
    const bag = this.value.queue.map((_, index) => index).filter(index => index !== current);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.shuffleBag = bag;
  }

  private remember(track?: MusicTrack): void {
    if (track) this.playHistory = [...this.playHistory.slice(-99), track.id];
  }

 /** Next track for a manual skip or a natural end, honoring the play mode. */
  private advance(auto: boolean): MusicTrack | null {
    const queue = this.value.queue;
    if (!queue.length) return null;
    const current = this.value.currentIndex;
    const track = current >= 0 ? queue[current] : undefined;
    if (auto && this.value.mode === "repeat-one" && track) return track;
    if (this.value.mode === "shuffle" || this.value.mode === "shuffle-all") {
 // 上游区分两种随机：
 // shuffleQueue（bag 洗牌）—— 一轮内不重复，播完才补袋
 // shuffle（真随机）——— 每次纯随机，可能连续中同一首
      if (this.value.mode === "shuffle") {
        if (!this.shuffleBag.length) this.refillShuffleBag(current);
        const index = this.shuffleBag.pop();
        if (index === undefined) return track ?? null;
        this.remember(track);
        return queue[index] ?? null;
      }
      if (queue.length === 1) return track ?? null;
      let index = current;
      while (index === current && queue.length > 1) index = Math.floor(Math.random() * queue.length);
      this.remember(track);
      return queue[index] ?? null;
    }
    const next = current + 1;
    if (next < queue.length) { this.remember(track); return queue[next]; }
    if (this.value.mode === "loop" || this.value.mode === "repeat-one") {
      if (track) { this.remember(track); return queue[0]; }
    }
    return null;
  }

 /** Non-mutating successor for gapless preparation; matches what advance() will pick. */
  private peekSuccessor(): MusicTrack | undefined {
    const queue = this.value.queue;
    if (!queue.length) return undefined;
    const current = this.value.currentIndex;
    if (this.value.mode === "repeat-one") return queue[current];
    if (this.value.mode === "shuffle") {
      const index = this.shuffleBag[this.shuffleBag.length - 1];
      return index === undefined ? undefined : queue[index];
    }
 // 真随机的下一首无法预知，无缝衔接只能放弃（回落到普通衔接）。
    if (this.value.mode === "shuffle-all") return undefined;
    const next = current + 1;
    if (next < queue.length) return queue[next];
    return this.value.mode === "loop" ? queue[0] : undefined;
  }

  constructor(
    options: {
      volume?: number;
      songTransitionMode?: SongTransitionMode;
      songFadeEnabled?: boolean;
      bgmVolume?: number;
      bgmEnabled?: boolean;
    } = {},
  ) {
    const transitionMode = normalizeSongTransition(options.songTransitionMode, options.songFadeEnabled);
    this.value = {
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      mode: "order",
      playing: false,
      loading: false,
      duration: 0,
      currentTime: 0,
      volume: Number.isFinite(options.volume) ? unit(options.volume!) : 0.7,
      songTransitionMode: transitionMode,
      songFadeEnabled: transitionMode !== "gapless",
      bgmVolume: Number.isFinite(options.bgmVolume)
        ? unit(options.bgmVolume!)
        : 0.18,
      bgmEnabled: options.bgmEnabled ?? true,
      bgmPlaying: false,
      error: null,
      bgmError: null,
      backend: "browser",
      outputDeviceId: "default",
      outputDevices: [{ id: "default", name: "系统默认输出" }],
      decoderAvailable: false,
      nativeAvailable: false,
      outputError: null,
      transitionWarning: null,
      trial: null,
    };
    this.bgm = new Audio("/audio/atmosphere.ogg");
    this.bgm.loop = true;
    this.bgm.preload = "none";
    this.bgm.volume = 0;
    this.bgm.addEventListener("error", this.onBgmError);
    document.addEventListener("pointerdown", this.onGesture, { capture: true });
    document.addEventListener("keydown", this.onGesture, { capture: true });
 // Intentionally no visibilitychange handler: music must continue in the background.
  }

  get state(): MusicPlayerState {
    return { ...this.value, transport: this.transport, queue: [...this.value.queue] };
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async refreshOutputs(): Promise<AudioCapabilities> {
    const response = await fetch("/api/audio/capabilities");
    const capabilities = await response.json() as AudioCapabilities & { error?: string };
    if (!response.ok) throw new Error(capabilities.error || "无法读取音频输出");
    if (!this.disposed) {
      this.value.decoderAvailable = capabilities.decoderAvailable;
      this.value.nativeAvailable = capabilities.nativeAvailable;
      this.value.outputDevices = capabilities.devices;
      this.value.outputError = capabilities.nativeError ?? capabilities.decoderError ?? null;
      this.emit();
    }
    return capabilities;
  }

  async setBackend(backend: "browser" | "coreaudio", deviceId = "default"): Promise<void> {
    if (this.disposed) return;
    const outputRequest = ++this.outputOperation;
    if (backend === "coreaudio") {
      const capabilities = await this.refreshOutputs();
      if (outputRequest !== this.outputOperation || this.disposed) return;
      if (!capabilities.nativeAvailable) throw new Error(capabilities.nativeError || "CoreAudio 输出不可用，请检查 FFmpeg 和 Apple Command Line Tools");
    }
    if (this.value.backend === "coreaudio") await this.cancelNativeNext();
    if (outputRequest !== this.outputOperation || this.disposed) return;
    void this.gapless?.trackId;
    const current = this.value.currentTrack;
    const position = this.gapless?.trackId ? this.gapless.position : this.value.currentTime;
    const resume = this.expectsSong();
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); this.cancelNativeNext();
    this.gaplessFallback = false; this.value.transitionWarning = null; this.value.trial = null;
    this.releaseSong();
    this.value.playing = false; this.value.loading = false; this.value.error = null;
    this.transport = resume ? "loading" : current ? "paused" : "idle";
    if (this.value.backend === "coreaudio") await this.nativeCommand({ action: "stop" });
    if (outputRequest !== this.outputOperation || this.disposed) return;
    this.value.backend = backend;
    this.value.outputDeviceId = deviceId;
    this.value.outputError = null;
    if (backend === "coreaudio") {
      try { await this.nativeCommand({ action: "device", deviceId }); }
      catch (error) {
        if (outputRequest !== this.outputOperation || this.disposed) return;
        this.value.backend = "browser";
        this.transport = current ? "paused" : "idle";
        this.value.outputError = error instanceof Error ? error.message : "输出设备不可用";
        this.emit(); throw error;
      }
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.startNativePoll();
    } else this.stopNativePoll();
    this.value.currentTime = position;
    this.pendingSeek = current ? position : null;
    this.emit();
    if (resume && current) {
      await this.play(current.id);
      if (outputRequest === this.outputOperation) this.seek(position);
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.disposed) return;
    const outputRequest = ++this.outputOperation;
    if (this.value.backend !== "coreaudio") { this.value.outputDeviceId = deviceId; this.emit(); return; }
    try {
      await this.cancelNativeNext();
      if (outputRequest !== this.outputOperation || this.disposed) return;
      const state = await this.nativeCommand({ action: "device", deviceId });
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.adoptNativePosition(state);
      this.value.outputDeviceId = state.deviceId;
      this.value.outputError = null;
      this.emit();
      this.prepareSuccessor();
    } catch (error) {
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.value.outputError = error instanceof Error ? error.message : "输出设备不可用";
      this.fail(this.value.outputError);
      throw error;
    }
  }

  setQueue(tracks: readonly MusicTrack[]): void {
    if (this.disposed) return;
    void this.gapless?.trackId;
    const queue = uniqueTracks(tracks);
    this.shuffleBag = [];
    this.value.queue = queue;
    const apply = () => {
      const id = this.value.currentTrack?.id;
      const index = queue.findIndex((track) => track.id === id);
      if (id && index === -1) {
        this.stop(); this.value.currentTrack = null; this.value.duration = 0;
      } else if (index !== -1) this.value.currentTrack = queue[index];
      this.value.currentIndex = index; this.prepareSuccessor(); this.emit();
    };
    if (this.value.backend === "coreaudio" && this.nativePreparedId) {
      const operation = this.operation;
      void this.cancelNativeNext().then(() => {
        if (!this.disposed && operation === this.operation && this.value.queue === queue) apply();
      });
    } else apply();
  }

 /** 试听根治：预备式全曲解析钩子（music-app 注入）。prepare 返回试听/付费
 * 证据时先走它查免费全曲变体，命中即直接播全曲；全网仅试听才播片段。 */
  resolveFullVariant: ((track: MusicTrack) => Promise<MusicTrack | null>) | null = null;

 /** 静默换源钩子（music-app 注入）：重试预算用尽后，先把失败交给上层做
 * 跨源同曲 / 备用音源 / 池子回落兜底。返回 true = 已接手（新的播放由上层
 * 发起），播放器就此静默收场：**不写 state.error、不提示**，transport 保持
 * loading；只有返回 false 才落下面那句最终失败文案，由上层提示一次。 */
  rescueFailedSource: ((track: MusicTrack) => Promise<boolean>) | null = null;

  async play(id: string, tracks?: readonly MusicTrack[]): Promise<void> {
    return this.playAttempt(id, tracks, { retries: 0 });
  }

  private async playAttempt(id: string, tracks: readonly MusicTrack[] | undefined, recovery: OnlineRecovery): Promise<void> {
    if (this.disposed) return;
    const queue = tracks ? uniqueTracks(tracks) : this.value.queue;
    if (tracks && (queue.length !== this.value.queue.length || queue.some((track, i) => track.id !== this.value.queue[i]?.id))) {
      this.gaplessFallback = false; this.value.transitionWarning = null; this.value.trial = null;
      this.shuffleBag = [];
    }
    const index = queue.findIndex((track) => track.id === id);
    if (index === -1) {
      this.value.error = "这首歌曲已不在播放队列中，请重新选择。";
      this.emit();
      return;
    }
    const track = queue[index];
    if (this.value.backend === "coreaudio") return this.playNative(track, queue, index);
    if (this.value.songTransitionMode === "gapless" && queue.some(item => item.onlineSource)) this.gaplessWarning();
    if (this.value.songTransitionMode === "gapless" && !this.gaplessFallback)
      return this.playGapless(track, queue, index);
    this.gapless?.stop();
    this.preparation?.abort();
 // Updating the queue in a play request keeps cross-album switches in the same fade.
    this.value.queue = queue;
    const request = ++this.operation;
    const retainedSeek = this.value.currentTrack?.id === id ? this.pendingSeek : null;
    this.cancelSongFade();
    const resume =
      this.songTrackId === id && this.song && !this.song.ended
        ? this.song
        : undefined;
    this.value.currentTrack = track;
    this.onlineRecovery = track.onlineSource ? recovery : undefined;
    this.value.currentIndex = index;
    this.value.error = null;
    this.value.loading = true;
    this.transport = "loading";
    this.value.playing = !!resume && !resume.paused;
    this.value.currentTime = resume
      ? this.pendingSeek ?? seconds(resume.currentTime)
      : retainedSeek ?? 0;
    this.value.duration =
      (resume ? seconds(resume.duration) : 0) || seconds(track.duration);
    if (!resume) this.pendingSeek = retainedSeek;
    const unsupported = this.unsupported(track);
    if (unsupported) {
      this.fail(unsupported);
      return;
    }
    this.emit();
    if (request !== this.operation || this.disposed) return;

    if (!resume) {
      const outgoing = this.song;
      if (
        outgoing &&
        !outgoing.paused &&
        !outgoing.ended &&
        this.value.songTransitionMode !== "gapless"
      ) {
        await this.fadeSong(outgoing, 0);
        if (request !== this.operation || this.disposed) return;
      }
 // Release the outgoing source before the next one can start: songs never overlap.
      this.releaseSong();
      this.pendingSeek = retainedSeek;
    }
    let audioUrl = track.audioUrl;
    if (!resume && track.onlineSource) {
      const rescuedUrl = track.onlineSource.rescuedUrl;
      if (rescuedUrl) {
        this.value.trial = null;
        audioUrl = rescuedUrl;
      } else {
      const controller = new AbortController(); this.preparation = controller;
      try {
        const response = await fetchOnline(track.onlineSource.provider, 'playback', `/api/online/${track.onlineSource.provider}/prepare/${encodeURIComponent(track.onlineSource.id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal,
        }, recovery.retries + 1);
        const result = await response.json().catch(() => {
          reportOnlineFailure(track.onlineSource!.provider, 'playback', { stage: 'response', code: `${track.onlineSource!.provider.toUpperCase()}_FRONTEND_INVALID_JSON` }, response.status, recovery.retries + 1);
          throw new OnlineSourceError(`${musicPlatforms[track.onlineSource!.provider]}返回了无法读取的音源响应。`, !response.ok && retryableOnlineStatus(response.status));
        }) as { audioUrl?: string; error?: string; trial?: { start: number; end: number }; fee?: number; format?: string; ekey?: string | null; actualQuality?: string };
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        if (response.ok && (!result || typeof result.audioUrl !== 'string' || !result.audioUrl)) reportOnlineFailure(track.onlineSource.provider, 'playback', { stage: 'response', code: `${track.onlineSource.provider.toUpperCase()}_FRONTEND_EMPTY_SOURCE` }, response.status, recovery.retries + 1);
        if (!response.ok || !result || typeof result.audioUrl !== 'string' || !result.audioUrl) throw new OnlineSourceError(
          result?.error || `${musicPlatforms[track.onlineSource.provider]}没有返回可播放的音源。`,
          !response.ok && retryableOnlineStatus(response.status),
        );
 // 共享池回的实际档位（actualQuality）与解密密钥（ekey）回填到曲目上：
 // 音质徽章用它显示真实档位，加密格式（mflac/mgg）靠 ekey 还原。
        if ((result.actualQuality || result.ekey || result.format) && this.value.currentTrack?.id === track.id) {
          const current = this.value.currentTrack;
          this.value.currentTrack = {
            ...current,
            format: result.format ?? current.format,
            onlineSource: current.onlineSource ? {
              ...current.onlineSource,
              qualityLabel: result.actualQuality ?? current.onlineSource.qualityLabel,
              ekey: result.ekey ?? current.onlineSource.ekey,
            } : current.onlineSource,
          };
        }
 // 试听根治（预备式）: paid/trial evidence triggers a full-song lookup
 // BEFORE any audio starts — the trial fragment never enters playback.
 // The variant plays as a normal full song: no trial state, no residue.
        const paidEvidence = !!result.trial || (result.fee ?? track.onlineSource.fee ?? 0) !== 0;
        if (paidEvidence && this.resolveFullVariant) {
          const full = await this.resolveFullVariant(track).catch(() => null);
          if (request !== this.operation || this.disposed || controller.signal.aborted) return;
          if (full) {
            this.value.trial = null;
            return this.play(full.id, queue.map(item => (item.id === track.id ? full : item)));
          }
        }
        audioUrl = result.audioUrl;
        this.value.trial = result.trial ?? null;
        this.emit();
      } catch (error) {
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        await this.recoverOnline(track, request, recovery,
          error instanceof OnlineSourceError ? error.message : `${musicPlatforms[track.onlineSource.provider]}音源请求失败或超时，请检查网络后重试。`,
          !(error instanceof OnlineSourceError) || error.retryable);
        return;
      } finally { if (this.preparation === controller) this.preparation = undefined; }
      }
    }
 // Older indexes marked DSD undecodable. Always prepare a PCM source for it,
 // including when that cached entry predates decodedAudioUrl.
    const dsd = isDsdTrack(track);
    const decodedAudioUrl = track.decodedAudioUrl || (dsd ? `/api/decoded-audio/${encodeURIComponent(track.id)}` : undefined);
    if (!resume && decodedAudioUrl && (dsd || track.localDecodable !== false)) {
      const controller = new AbortController();
      this.preparation = controller;
      try {
        const response = await fetch(`/api/audio/prepare/${encodeURIComponent(track.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
        const result = await response.json() as { audioUrl?: string; duration?: number; error?: string };
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        if (!response.ok) {
          if (response.status !== 503 || dsd || !track.browserPlayable) throw new Error(result.error || "音频解码失败");
        } else {
          audioUrl = result.audioUrl || decodedAudioUrl;
          this.value.duration = seconds(result.duration || 0) || this.value.duration;
        }
      } catch (error) {
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        this.fail(error instanceof Error ? error.message : "本地解码失败"); return;
      } finally { if (this.preparation === controller) this.preparation = undefined; }
      if (request !== this.operation || this.disposed) return;
    }
    const audio = this.song ?? this.createSong(track, audioUrl);

 // A shared transition promise keeps rapid BGM toggles from bypassing this silence gate.
    await this.reconcileBgm();
    if (request !== this.operation || this.disposed || this.song !== audio)
      return;
    try {
      await audio.play();
      if (request !== this.operation || this.disposed || this.song !== audio) {
        if (this.song !== audio || !this.expectsSong()) audio.pause();
        return;
      }
      if (!audio.paused) {
        this.transport = "playing";
        this.value.playing = true;
        this.value.loading = false;
        this.emit();
        if (request !== this.operation || this.disposed || this.song !== audio)
          return;
        if (this.value.songTransitionMode === "fade-in-out") await this.fadeSong(audio, 1);
        else this.setSongGain(1);
      }
    } catch (error) {
      if (request !== this.operation || this.disposed || this.song !== audio)
        return;
      await this.handleSongFailure(track, error, request, recovery);
    }
  }

  private async handleSongFailure(track: MusicTrack, error: unknown, request: number, recovery = this.onlineRecovery): Promise<void> {
    if (request !== this.operation || this.disposed) return;
    const message = this.playbackError(track, error);
    if (!track.onlineSource || !recovery || !this.expectsSong()) { this.fail(message); return; }
    const name = error instanceof DOMException ? error.name : '';
    const code = this.song?.error?.code;
    const diagnosticCode = code && code >= 1 && code <= 4 ? `MEDIA_${code}` : name === 'NotAllowedError' ? 'PLAY_NOT_ALLOWED' : name === 'AbortError' ? 'PLAY_ABORTED' : 'PLAY_FAILED';
    reportOnlineFailure(track.onlineSource.provider, 'playback', { stage: 'media', code: `${track.onlineSource.provider.toUpperCase()}_${diagnosticCode}` }, undefined, recovery.retries + 1);
 // A stale/failed media URL can surface as MEDIA_ERR_SRC_NOT_SUPPORTED.
 // Decoder failures and gesture rejection cannot be repaired by refreshing it.
    const retryable = !['NotAllowedError', 'AbortError'].includes(name) && code !== 1 && code !== 3;
    await this.recoverOnline(track, request, recovery, message, retryable);
  }

  private async recoverOnline(track: MusicTrack, request: number, recovery: OnlineRecovery, message: string, retryable: boolean): Promise<void> {
    if (request !== this.operation || this.disposed || this.value.currentTrack?.id !== track.id) return;
 // 手势拒绝（NotAllowedError）/ 解码失败不能靠重取地址修，重试也是白搭；
 // 但那不代表这首歌没救 —— 换个音源往往还能放，所以照样先走静默换源。
    if (retryable && recovery.retries < ONLINE_RETRY_DELAYS.length) {
      const delay = ONLINE_RETRY_DELAYS[recovery.retries++];
 // Claim the failure before releasing the element: its error event and
 // rejected play() promise must share one attempt, never schedule two retries.
      const waiting = ++this.operation;
      this.preparation?.abort();
      const position = this.pendingSeek ?? seconds(this.song?.currentTime ?? this.value.currentTime);
      this.releaseSong();
      this.pendingSeek = position;
      const controller = new AbortController(); this.preparation = controller;
 // 重试是**静默**的：transport 留在 loading、error 保持空，界面看到的只是
 // 「还在加载」。旧行为在这里写 error → 上层订阅者弹框，于是黑框闪现。
      this.transport = 'loading'; this.value.loading = true; this.value.playing = false;
      this.value.currentTime = position; this.value.error = null;
      this.emit();
      try {
        if (waiting !== this.operation || this.disposed || controller.signal.aborted) return;
        void this.reconcileBgm();
        if (!await retryDelay(delay, controller.signal) || waiting !== this.operation || this.disposed) return;
      } finally { if (this.preparation === controller) this.preparation = undefined; }
 // Fresh source and element each time; the budget survives successful loads
 // within this play intent. Stop/pause/selection abort both wait and request.
      await this.playAttempt(track.id, undefined, recovery);
      return;
    }
 // 重试预算用尽（或平台直接拒绝，重取没意义）：先把这次失败交给上层的静默
 // 换源兜底（跨源同曲 → 备用音源 → 池子回落）。它接手就静默收场 —— 不写
 // state.error、不 notify、transport 留在 loading，用户只看到还在加载，根本
 // 不知道中间换过源；只有兜底也无解，才落下面这句**唯一**的最终失败文案，
 // 由上层提示一次。失败文案也不再带「已自动重试 N 次」。
    const waiting = ++this.operation;
    this.preparation?.abort();
    const position = this.pendingSeek ?? seconds(this.song?.currentTime ?? this.value.currentTime);
    this.releaseSong();
    this.pendingSeek = position;
    this.transport = 'loading'; this.value.loading = true; this.value.playing = false;
    this.value.currentTime = position; this.value.error = null;
    this.emit();
    const rescued = this.rescueFailedSource
      ? await this.rescueFailedSource(track).then(Boolean, () => false)
      : false;
    if (this.disposed) return;
 // 兜底接手时播放器已被新的播放意图接管（operation 前进），就此静默收场。
    if (rescued || waiting !== this.operation) return;
    this.fail(message);
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    void this.gapless?.trackId;
    if (this.value.backend === "coreaudio") {
      if (this.expectsSong()) {
        const request = ++this.operation;
        const cancelled = this.cancelNativeNext();
        this.transport = "paused"; this.value.playing = false; this.value.loading = false;
        this.emit();
        try {
          await cancelled;
          if (request !== this.operation || this.disposed) return;
          const state = await this.nativeCommand({ action: "pause" });
          if (request !== this.operation || this.disposed) return;
          this.adoptNativePosition(state); this.emit();
        } catch (error) { if (request === this.operation && !this.disposed) this.fail(error instanceof Error ? error.message : "原生输出暂停失败"); }
      } else { const track = this.value.currentTrack ?? this.value.queue[0]; if (track) await this.play(track.id); }
      return;
    }
    if (this.transport === "loading" || this.transport === "playing") {
      ++this.operation;
      this.preparation?.abort();
      if (this.gapless?.trackId) this.value.currentTime = this.gapless.pause();
      this.cancelSongFade();
      this.transport = "paused";
      this.song?.pause();
      if (this.songTrackId !== this.value.currentTrack?.id) {
        const position = this.pendingSeek ?? this.value.currentTime;
        this.releaseSong(); this.pendingSeek = position;
      }
      else this.setSongGain(1);
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
      await this.reconcileBgm();
      return;
    }
    const track = this.value.currentTrack ?? this.value.queue[0];
    if (track) await this.play(track.id);
  }

  async next(): Promise<void> {
    if (this.disposed) return;
    if (this.value.backend === "coreaudio") {
      const operation = this.operation; await this.cancelNativeNext();
      if (operation !== this.operation || this.disposed) return;
    }
    void this.gapless?.trackId;
    const track = this.advance(false);
    if (track) await this.play(track.id);
    else this.stop();
  }

  async previous(): Promise<void> {
    if (this.disposed) return;
    if (this.value.backend === "coreaudio") {
      const operation = this.operation; await this.cancelNativeNext();
      if (operation !== this.operation || this.disposed) return;
    }
    void this.gapless?.trackId;
    if (this.value.currentTime > 3 && (this.song || this.gapless?.trackId || this.value.backend === "coreaudio")) {
      this.seek(0);
      return;
    }
    if (this.value.mode === "shuffle" && this.playHistory.length) {
      const id = this.playHistory.pop()!;
      if (this.value.queue.some(track => track.id === id)) { await this.play(id); return; }
    }
    const track = this.value.queue[Math.max(0, this.value.currentIndex - 1)];
    if (track) {
      if (track.id === this.value.currentTrack?.id) this.seek(0);
      await this.play(track.id);
    }
  }

  seek(position: number): void {
    if (this.disposed || !Number.isFinite(position)) return;
    if (this.value.backend === "coreaudio") {
      if (this.transport === "loading") { this.pendingSeek = Math.max(0, position); this.value.currentTime = this.pendingSeek; this.emit(); return; }
      const target = Math.max(0, this.value.duration > 0 ? Math.min(this.value.duration, position) : position);
      this.value.currentTime = target; this.emit();
      const operation = ++this.operation;
      const cancelled = this.cancelNativeNext();
      void cancelled.then(() => {
        if (operation !== this.operation || this.disposed) return;
        return this.nativeCommand({ action: "seek", position: target });
      }).then(state => {
        if (state && operation === this.operation) { this.adoptNativePosition(state); this.emit(); this.prepareSuccessor(); }
      }).catch((error) => { if (operation === this.operation && !this.disposed) this.fail(error.message); });
      return;
    }
    if (this.gapless?.trackId) {
      this.gapless.seek(position); this.prepareSuccessor(); return;
    }
    if (!this.song && this.transport === "loading") { this.pendingSeek = Math.max(0, position); this.value.currentTime = this.pendingSeek; this.emit(); return; }
    if (
      this.disposed ||
      !this.song ||
      this.songTrackId !== this.value.currentTrack?.id ||
      !Number.isFinite(position)
    )
      return;
    const duration = seconds(this.song.duration) || this.value.duration;
    const target = Math.max(
      0,
      duration > 0 ? Math.min(duration, position) : position,
    );
    this.pendingSeek = target;
    if (this.song.readyState >= 1) this.applySeek(this.song);
    this.value.currentTime = target;
    this.emit();
  }

  stop(): void {
    if (this.disposed) return;
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); void this.cancelNativeNext(false);
    this.gaplessFallback = false; this.value.transitionWarning = null; this.value.trial = null;
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }).catch(() => {});
    this.transport = "idle";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.currentTime = 0;
    this.value.error = null;
    this.emit();
    void this.reconcileBgm();
  }

  setVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.volume = unit(volume);
    this.gapless?.volume(this.value.volume);
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "volume", volume: this.value.volume }).catch((error) => { this.value.outputError = error.message; this.emit(); });
    this.setSongGain(this.songGain);
    this.emit();
  }

  setSongTransitionMode(mode: SongTransitionMode): void {
    if (this.disposed) return;
    const transitionMode = normalizeSongTransition(mode);
    const previous = this.value.songTransitionMode;
    const position = this.gapless?.trackId ? this.gapless.position : this.value.currentTime;
    const resume = this.expectsSong();
    this.value.songTransitionMode = transitionMode;
    this.value.songFadeEnabled = transitionMode !== "gapless";
    this.gaplessFallback = false; this.value.transitionWarning = null; this.value.trial = null;
    if (this.value.backend === "coreaudio") {
      const output = this.outputOperation;
      const operation = this.operation;
      void this.cancelNativeNext().then(() => {
        if (this.disposed || this.value.backend !== "coreaudio" || output !== this.outputOperation || operation !== this.operation || this.value.songTransitionMode !== transitionMode) return;
        return this.nativeCommand({ action: "transition", transitionMode });
      }).then(state => {
        if (state && operation === this.operation) { this.adoptNativePosition(state); this.emit(); this.prepareSuccessor(); }
      }).catch((error) => {
        if (this.disposed || this.value.backend !== "coreaudio" || output !== this.outputOperation) return;
        this.value.outputError = error instanceof Error ? error.message : "无法更新歌曲衔接方式";
        this.emit();
      });
    } else if (previous !== transitionMode && (previous === "gapless" || transitionMode === "gapless")) {
 // A transport change retains the actual position and paused state. It
 // cannot leave a previously scheduled next source alive in the old engine.
      ++this.operation; this.preparation?.abort();
      this.gapless?.stop(); this.releaseSong();
      this.value.currentTime = position; this.pendingSeek = position;
      this.value.playing = false; this.value.loading = false;
      this.transport = this.value.currentTrack ? "paused" : "idle";
      if (resume && this.value.currentTrack) void this.play(this.value.currentTrack.id);
    }
    if ((this.songFade?.target === 0 && transitionMode === "gapless") ||
      (this.songFade?.target === 1 && transitionMode !== "fade-in-out")) {
      this.cancelSongFade();
 // Finishing an incoming fade must restore full user volume. An outgoing
 // switch retains source ownership until its awaiting operation resumes.
      if (this.songTrackId === this.value.currentTrack?.id) this.setSongGain(1);
    }
    this.emit();
  }

 /** Compatibility for callers with an older saved boolean. */
  setSongFadeEnabled(enabled: boolean): void {
    this.setSongTransitionMode(enabled ? "fade-in-out" : "gapless");
  }

  setBgmVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.bgmVolume = unit(volume);
    this.emit();
    void this.reconcileBgm();
  }

  setBgmEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.value.bgmEnabled = enabled;
    this.value.bgmError = null;
    this.emit();
    void this.reconcileBgm();
  }

  dispose(): void {
    if (this.disposed) return;
 // pagehide may unload this document before a normal fetch reaches the local
 // service. This tiny request must survive unload; hidden tabs still keep
 // playing because visibilitychange never calls dispose().
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }, true).catch(() => {});
    this.preparation?.abort();
 // 防抖中的音效重载要取消：dispose 之后再去换流会操作已释放的元素。
    if (this.effectsReloadTimer) { clearTimeout(this.effectsReloadTimer); this.effectsReloadTimer = undefined; }
    this.gapless?.dispose(); this.gapless = undefined;
    ++this.nativePrepareGeneration;
    this.stopNativePoll();
    this.disposed = true;
    ++this.operation;
    ++this.bgmOperation;
    this.cancelFade();
    this.releaseSong();
    this.bgm.pause();
    this.bgm.removeEventListener("error", this.onBgmError);
    this.bgm.removeAttribute("src");
    this.bgm.load();
    document.removeEventListener("pointerdown", this.onGesture, {
      capture: true,
    });
    document.removeEventListener("keydown", this.onGesture, { capture: true });
    this.listeners.clear();
  }

 /** Shared Web Audio effects chain: HTMLAudio songs and the gapless engine
 * both route through it; the native backend gets its own PCM stage. A missing
 * or hostile Web Audio environment degrades to plain playback. */
  private effectsNodes(): AudioEffectsChain | undefined {
    try {
      const AudioContextCtor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!AudioContextCtor) return undefined;
      if (!this.effects) {
        const context = this.effectsContext = new AudioContextCtor();
        const chain = new AudioEffectsChain(context);
        chain.output.connect(context.destination);
        chain.apply(this.effectsConfig);
        this.effects = chain;
      }
      return this.effects;
    } catch { return undefined; }
  }
  setEffects(config: EffectsConfig): void {
    const before = this.effectsConfig;
    this.effectsConfig = normalizeEffectsConfig(config);
    this.effects?.apply(this.effectsConfig);
    if (this.value.backend === "coreaudio") {
      void this.nativeCommand({ action: "effects", config: this.effectsConfig }).catch(() => {});
    }
 // 服务端烘焙方案下，音效参数写在播放 URL 里，所以「马上听到
 // 变化」需要换一次音频流。这里**原地重载**：把当前播放位置带过去，用户
 // 听到的是「当场变化、接着放」，而不是「下一首才生效」或「从头重播」。
 //
 // 必须防抖：拖滑块会连续触发（每动一格一次），而每次换 URL 都意味着服务端
 // 用 FFmpeg 重新解码一遍整首歌（缓存键含效果指纹）。不防抖会把 CPU 和网络
 // 打满，听起来反而断续、卡顿。所以合并成「停下来 ~220ms 后处理最后一次」，
 // 拖动的中间态不重载 —— 用户松手听到最终效果，交互是跟手的。
 //
 // 只有参数真的变了才重载：effectsQueryFor() 已把有效参数归一成查询串
 // （中性/关闭时返回 null），比较它即可。
    if (this.value.backend !== "coreaudio" && this.value.currentTrack) {
      const beforeQuery = effectsQueryFor(before);
      const afterQuery = this.effectsQueryString();
      if (beforeQuery === afterQuery) return;
      if (this.effectsReloadTimer) clearTimeout(this.effectsReloadTimer);
      this.effectsReloadTimer = window.setTimeout(() => {
        this.effectsReloadTimer = undefined;
        void this.reloadForEffects();
      }, 220);
    }
  }

 /**
 * 音效变化后原地重载当前歌曲：保留播放位置与播放/暂停状态。
 *
 * 为什么不 seek 到旧位置就算完：换了 URL 就是换了一条流，必须等新流能
 * seek 之后再跳，否则 seek 会被丢弃、从头开始播。
 */
  private async reloadForEffects(): Promise<void> {
    const track = this.value.currentTrack;
    if (!track) return;
    const position = this.value.currentTime;
    const wasPlaying = this.value.playing;
    const song = this.song;
    if (!song) return;
    const source = this.processedSource(track) ?? (track.audioUrl || `/api/audio/${encodeURIComponent(track.id)}`);
 // 同一个 operation 代次内完成，避免与正在进行的加载/切歌互相打断。
    const operation = ++this.operation;
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error("音效切换时音频未能就绪")); };
        const cleanup = () => {
          song.removeEventListener("loadedmetadata", done);
          song.removeEventListener("error", fail);
        };
        song.addEventListener("loadedmetadata", done, { once: true });
        song.addEventListener("error", fail, { once: true });
        song.src = source;
        song.load();
      });
      if (this.disposed || operation !== this.operation || this.value.currentTrack?.id !== track.id) return;
 // 新流就绪后再跳回原位置；超出新时长（理论上不该发生）则从头。
      const target = Math.min(position, Math.max(0, (song.duration || 0) - 0.25));
      if (Number.isFinite(target) && target > 0) song.currentTime = target;
      if (wasPlaying) await song.play().catch(() => {});
      this.value.currentTime = Number.isFinite(song.currentTime) ? song.currentTime : position;
      this.value.duration = Number.isFinite(song.duration) && song.duration > 0 ? song.duration : this.value.duration;
      this.emit();
    } catch {
 // 重载失败：保留原流继续播（音效没切换成功，但绝不把歌弄停/弄哑）。
    }
  }
  get effectsValue(): EffectsConfig { return this.effectsConfig; }

 /** Read-only audio-path diagnostics (test hook / support dumps): every value
 * that can silently mute the song path while the progress bar keeps moving. */
  get audioDiagnostics() {
    return {
      songGain: this.songGain,
      songVolume: this.song ? this.song.volume : null,
      songMuted: this.song ? this.song.muted : null,
      songPaused: this.song ? this.song.paused : null,
      contextState: this.effectsContext ? this.effectsContext.state : 'none',
      effectsEnabled: this.effectsConfig.enabled,
      chain: this.effects ? this.effects.diagnosticGains : null,
      chainRms: this.effects ? this.effects.outputRms : null,
      songSrc: this.song ? String(this.song.src) : null,
    };
  }

 /**
 * 服务端烘焙音效的播放地址（上游语义：效果处理在原生侧，不走 Web Audio）。
 *
 * 音效启用且非中性时返回 /api/audio/processed* 地址，服务端用 FFmpeg 把
 * 效果烘焙进音频再给浏览器直放；关闭或中性时返回 null，走原始直连地址
 * ——「默认关 = 原版直放路径」，任何环境都必有声。
 *
 * 烘焙方案改设置需要重新取一次音频流，所以 setEffects() 会
 * 把当前播放位置接回去（见那里的实现），听感上是「当场变化」而不是
 * 「下一首才生效」，也不会从头重播。
 */
  private processedSource(track: MusicTrack): string | null {
    const query = this.effectsQueryString();
    return query === null ? null : track.onlineSource
      ? `/api/audio/processed-online/${track.onlineSource.provider}/${encodeURIComponent(track.onlineSource.id)}?${query}`
      : `/api/audio/processed/${encodeURIComponent(track.id)}?${query}`;
  }
  private effectsQueryString(): string | null {
    return effectsQueryFor(this.effectsConfig);
  }

 /**
 * 把音频元素接入 Web Audio 音效链（实时生效）。
 *
 * createMediaElementSource 对**同一个元素只能调用一次**，重复调用会抛
 * InvalidStateError；所以每个新建的 audio 元素单独接一次，并记录已接过的
 * 元素，避免重复接线导致播放中断。
 *
 * 这是本项目踩过两次的坑（见
 * ）：
 * `createMediaElementSource()` 一旦调用，该元素的输出就**只**流向 Web Audio
 * 图，不再直连扬声器。若此刻 AudioContext 处于 suspended（浏览器自动播放
 * 策略下首次播放几乎必然如此），整条图不发声 —— 现象就是**进度条在走、
 * 完全没有声音**。所以：
 * · context 未 running → 先 resume()，本次仍**不接线**（元素直连出声，
 * 降级但绝不静音），下一首歌会重新尝试接线，效果器自动恢复；
 * · 只有确认 running 才接线。
 * 用户手势（onGesture）里也会补 resume()，让后续歌曲拿回实时音效。
 */
  private routeThroughEffects(audio: HTMLAudioElement): void {
 // Web Audio 效果链在部分 WebView2 环境下输出通道不出声：
 // 图内 AnalyserNode 显示信号在正常流动，但扬声器听不到任何声音；
 // 同一元素改走 HTMLAudio 直连则一切正常。
 //
 // 这类问题无法靠自检发现 ——「信号健康」不能证明「用户能听到」，
 // 只能靠行为兜底。因此音效处理完全绕开 Web Audio，改为在服务端用
 // FFmpeg 把效果烘焙进音频（/api/audio/processed*，见 scripts/pcm-effects.mjs）。
 //
 // 保留这个空方法是为了标记「这里曾经接过链」，防止后续改动把效果
 // 处理重新接回 Web Audio。
    void audio;
  }

  private createSong(track: MusicTrack, source = track.audioUrl): HTMLAudioElement {
    const audio = new Audio();
    this.song = audio;
    this.songTrackId = track.id;
    this.songGain = this.value.songTransitionMode === "fade-in-out" ? 0 : 1;
    audio.preload = "metadata";
    this.setSongGain(this.songGain);
 // 音效实时化（用户要求：「音效器要能实时切换、实时变化」）：
 // 把音频元素接进 Web Audio 音效链，改设置时只改 AudioParam，**不重新加载
 // 音频**，所以拖动滑块/换预设是即时听到的，播放位置也不会丢。
 //
 // 原来只走「服务端把音效烘焙进音频流」那条路（/api/audio/processed*），
 // 改一次配置就要重新请求整首歌 —— 既不是实时，还会从头播，用户自然
 // 「听不出区别」。这里改为浏览器路径实时生效；服务端烘焙只保留给原生
 // 后端（coreaudio），那里没法插 Web Audio 节点。
 //
 // 稳妥起见：接链失败（宿主 Web Audio 输出不可用）就退回直连播放，
 // 绝不因为音效把歌弄哑。
    this.routeThroughEffects(audio);
    const active = () =>
      !this.disposed &&
      this.song === audio &&
      this.value.currentTrack?.id === track.id;
    audio.addEventListener("loadedmetadata", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.applySeek(audio);
      this.emit();
    });
    audio.addEventListener("durationchange", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.emit();
    });
    audio.addEventListener("timeupdate", () => {
      if (!active() || this.pendingSeek !== null) return;
      this.value.currentTime = seconds(audio.currentTime);
      this.emit();
    });
    audio.addEventListener("playing", () => {
      if (!active() || audio.paused) return;
      if (this.transport !== "loading" && this.transport !== "playing") {
        audio.pause();
        return;
      }
      this.transport = "playing";
      this.value.playing = true;
      this.value.loading = false;
 // Audibility safety net: a fade cancelled mid-flight (rapid switches,
 // trial fallback) must never leave the active song at zero gain — the
 // progress bar would advance in silence.
      if (!this.songFade && this.songGain < 0.001 && this.value.songTransitionMode === "fade-in-out") {
        void this.fadeSong(audio, 1);
      }
      this.emit();
    });
    audio.addEventListener("waiting", () => {
      if (!active() || this.transport !== "playing") return;
      this.value.loading = true;
      this.emit();
    });
    audio.addEventListener("pause", () => {
      if (!active() && this.song === audio && audio.paused) {
        this.cancelSongFade();
        return;
      }
      if (
        !active() ||
        this.transport !== "playing" ||
        audio.ended ||
        !audio.paused
      )
        return;
      ++this.operation;
      this.cancelSongFade();
      this.setSongGain(1);
      this.transport = "paused";
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("ended", () => {
      if (!active() && this.song === audio && audio.ended) {
 // The outgoing song can finish naturally during its fade-out.
        this.cancelSongFade();
        return;
      }
      if (!active() || this.transport !== "playing") return;
      this.cancelSongFade();
      this.value.playing = false;
      this.value.loading = false;
      this.value.currentTime = this.value.duration;
      const next = this.advance(true);
      if (next) {
 // No idle intermediate state, so BGM never appears between songs.
        void this.play(next.id);
      } else {
        ++this.operation;
        this.transport = "idle";
        this.emit();
        void this.reconcileBgm();
      }
    });
    audio.addEventListener("error", () => {
      if (active()) void this.handleSongFailure(track, audio.error, this.operation);
      else if (this.song === audio) this.cancelSongFade();
    });
    audio.src = this.processedSource(track) ?? (source || `/api/audio/${encodeURIComponent(track.id)}`);
    return audio;
  }

  private applySeek(audio: HTMLAudioElement): void {
    if (this.pendingSeek === null || audio.readyState < 1) return;
    const target = Math.max(
      0,
      seconds(audio.duration) > 0
        ? Math.min(audio.duration, this.pendingSeek)
        : this.pendingSeek,
    );
    try {
      audio.currentTime = target;
      this.pendingSeek = null;
      this.value.currentTime = target;
    } catch {
 // Metadata may still be arriving; retain the user's seek until it is available.
    }
  }

  private releaseSong(): void {
    this.cancelSongFade();
    const old = this.song;
    this.song = undefined;
    this.songTrackId = undefined;
    this.songGain = 1;
    this.pendingSeek = null;
    if (!old) return;
    old.pause();
    old.removeAttribute("src");
    old.load();
  }

  private setSongGain(gain: number): void {
    this.songGain = unit(gain);
    if (this.song) this.song.volume = unit(this.value.volume * this.songGain);
  }

  private fadeSong(audio: HTMLAudioElement, target: number): Promise<void> {
    this.cancelSongFade();
    if (this.song !== audio) return Promise.resolve();
    const start = this.songGain;
    if (audio.paused || audio.ended || Math.abs(start - target) < 0.001) {
      this.setSongGain(target);
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade & { target: number } = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve, target,
      };
      const step = () => {
        if (this.songFade !== fade) return;
        const progress = Math.min(1, (performance.now() - startedAt) / SONG_FADE_MS);
        this.setSongGain(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 16);
        else {
          this.songFade = undefined;
          resolve();
        }
      };
      this.songFade = fade;
      step();
    });
  }

  private cancelSongFade(): void {
    if (!this.songFade) return;
    const fade = this.songFade;
    this.songFade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private expectsSong(): boolean {
    return this.transport === "loading" || this.transport === "playing";
  }

  private unsupported(track: MusicTrack): string | null {
    if (!track.browserPlayable && !track.localDecodable && !isDsdTrack(track))
      return `${track.format} 无法在当前浏览器中播放，请选择浏览器支持的音频文件。`;
    return null;
  }

  private playbackError(track: MusicTrack, error: unknown): string {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError")
      return "浏览器暂未允许播放，请点击播放按钮重试。";
    if (track.onlineSource) return `${musicPlatforms[track.onlineSource.provider]}音频加载失败，请检查网络并重新点击播放，以获取新的播放地址。`;
    const media = this.song?.error;
    if (media?.code === 2)
      return "音频读取失败：请检查本地服务和音乐文件是否仍然可用。";
    if (name === "AbortError") return "歌曲播放被中断，请点击播放按钮重试。";
    if (/M4A|ALAC/i.test(`${track.format} ${track.codec ?? ""}`)) {
      return "此 M4A / ALAC 文件未能由当前浏览器解码，或文件已不可用。请检查原文件，或尝试支持该编码的浏览器。";
    }
    if (
      media?.code === 3 ||
      media?.code === 4 ||
      name === "NotSupportedError"
    ) {
      return `无法播放此 ${track.format} 文件：当前浏览器不支持它的编码，或文件已损坏、不可读取。`;
    }
    return `播放失败，请检查 ${track.format} 文件及本地音乐服务后重试。`;
  }

  private fail(message: string): void {
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); this.cancelNativeNext();
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }).catch(() => {});
    this.transport = "error";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.error = message;
    this.emit();
    void this.reconcileBgm();
  }

  private gaplessWarning(error?: unknown): void {
    this.gaplessFallback = true;
    if (!error && this.value.transitionWarning) return;
    const message = error instanceof Error ? error.message : "";
 // Server and decoder errors can contain local paths; only our fixed public
 // messages cross this UI boundary.
    this.value.transitionWarning = /本次队列改用普通播放。$/.test(message) && !/[\\/]/.test(message)
      ? message : "暂时无法保证连续音频接续，本次队列改用普通播放。";
    this.emit();
  }

  private async playGapless(track: MusicTrack, queue: readonly MusicTrack[], index: number): Promise<void> {
    void this.gapless?.trackId;
    const request = ++this.operation;
    const same = this.value.currentTrack?.id === track.id;
    const position = same ? this.pendingSeek ?? (this.gapless?.trackId === track.id ? this.gapless.position : this.value.currentTime) : 0;
    this.preparation?.abort();
    const controller = new AbortController(); this.preparation = controller;
    this.releaseSong();
    this.value.queue = [...queue]; this.value.currentTrack = track; this.value.currentIndex = index;
    this.value.currentTime = position; this.value.duration = seconds(track.duration);
    this.value.playing = false; this.value.loading = true; this.value.error = null;
    this.transport = "loading"; this.emit();
    try {
 // 无缝引擎不接 Web Audio（原因见 routeThroughEffects 的注释）。
 // 它通过 effectsQuery() 把音效参数交给服务端烘焙，走同一条 DSP 管线，
 // 因此切歌前后音效一致。
      this.gapless ??= new BrowserGaplessPlayer({
        progress: (current, position, duration) => {
          if (this.disposed || this.value.backend !== "browser" || this.value.currentTrack?.id !== current.id) return;
          this.value.currentTime = position; this.value.duration = duration; this.emit();
        },
        boundary: (current, duration) => {
          if (this.disposed || this.value.backend !== "browser" || this.value.songTransitionMode !== "gapless") return;
          const index = this.value.queue.findIndex(item => item.id === current.id);
          if (index < 0) { this.stop(); return; }
          this.value.currentTrack = current; this.value.currentIndex = index;
          this.value.currentTime = 0; this.value.duration = duration;
          this.value.playing = true; this.value.loading = false; this.transport = "playing";
          this.emit(); this.prepareSuccessor();
        },
        ended: () => {
          if (this.disposed || this.value.backend !== "browser" || this.transport !== "playing") return;
          const next = this.advance(true);
          if (next) { this.gaplessWarning(); void this.play(next.id); }
          else {
            this.transport = "idle"; this.value.playing = false;
            this.value.currentTime = this.value.duration; this.emit(); void this.reconcileBgm();
          }
        },
        interrupted: position => {
          if (this.disposed || this.value.backend !== "browser") return;
          ++this.operation; this.preparation?.abort();
          this.value.currentTime = position; this.value.playing = false; this.value.loading = false;
          this.transport = "paused"; this.emit();
        },
      }, undefined, undefined, () => this.effectsQueryString());
      this.gapless.volume(this.value.volume);
 // resume() is invoked in this synchronous gesture turn, before any await.
      const unlocked = this.gapless.unlock();
      await Promise.all([unlocked, this.reconcileBgm()]);
      if (request !== this.operation || this.disposed) return;
      await this.gapless.play(track, position, controller.signal);
      if (request !== this.operation || this.disposed) return;
      if (this.pendingSeek !== null) { this.gapless.seek(this.pendingSeek); this.pendingSeek = null; }
      this.value.duration = this.gapless.duration; this.value.currentTime = this.gapless.position;
      this.value.playing = true; this.value.loading = false; this.transport = "playing";
      this.emit(); this.prepareSuccessor();
    } catch (error) {
      if (request !== this.operation || this.disposed || controller.signal.aborted) return;
      if (error instanceof AudioClockSuspended) {
        this.value.playing = false; this.value.loading = false; this.transport = "paused";
        this.emit(); return;
      }
      this.gapless?.stop(); this.gaplessWarning(error);
      this.pendingSeek = position > 0 ? position : null;
      await this.play(track.id);
    } finally { if (this.preparation === controller) this.preparation = undefined; }
  }

  private prepareSuccessor(): void {
    if (this.disposed || this.value.songTransitionMode !== "gapless" || this.gaplessFallback || this.transport !== "playing") return;
    const next = this.peekSuccessor();
    const operation = this.operation;
    if (this.value.backend === "browser") {
      void this.gapless?.prepareNext(next).catch(error => {
        if (operation !== this.operation || this.disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        this.gaplessWarning(error);
      });
    } else {
      const cancelled = this.cancelNativeNext();
      const generation = this.nativePrepareGeneration;
      void cancelled.then(() => {
        if (generation !== this.nativePrepareGeneration || this.disposed || operation !== this.operation) return;
        const next = this.peekSuccessor();
        if (!next) return;
        this.nativePreparedId = next.id;
        return this.nativeCommand({ action: "prepareNext", trackId: next.id, afterTrackId: this.value.currentTrack?.id });
      }).catch(error => {
        if (operation !== this.operation || generation !== this.nativePrepareGeneration || this.disposed) return;
        this.nativePreparedId = undefined; this.gaplessWarning(error);
      });
    }
  }

  private cancelNativeNext(adopt = true): Promise<void> {
    const expected = this.nativePreparedId ?? this.nativeHandoffId;
    this.nativeHandoffId = adopt ? expected : undefined;
    const operation = this.operation;
    ++this.nativePrepareGeneration; this.nativePreparedId = undefined;
    if (!this.disposed && this.value.backend === "coreaudio")
      return this.nativeCommand({ action: "cancelNext" }).then(state => {
        if (adopt && !this.disposed && operation === this.operation && this.value.backend === "coreaudio") {
          this.adoptNativePosition(state, expected); this.nativeHandoffId = undefined;
        }
      }, () => {});
    return Promise.resolve();
  }

  private adoptNativePosition(state: NativeState, successor?: string): void {
    if (state.trackId !== this.value.currentTrack?.id && state.trackId === successor) {
      const index = this.value.queue.findIndex(track => track.id === state.trackId);
      if (index >= 0) { this.value.currentIndex = index; this.value.currentTrack = this.value.queue[index]; }
      else {
        this.stop(); this.value.currentTrack = null; this.value.currentIndex = -1; this.value.duration = 0;
        this.emit(); return;
      }
    }
    if (state.trackId === this.value.currentTrack?.id) {
      this.value.currentTime = state.currentTime; this.value.duration = state.duration;
    }
  }

  private async nativeCommand(command: Record<string, unknown>, keepalive = false): Promise<NativeState> {
    const response = await fetch("/api/output/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), keepalive });
    const result = await response.json() as NativeState & { error?: string };
    if (!response.ok) throw new Error(result.error || "CoreAudio 输出失败");
    return result;
  }

  private async playNative(track: MusicTrack, queue: readonly MusicTrack[], index: number): Promise<void> {
    const request = ++this.operation;
    const cancelled = this.cancelNativeNext(false);
    const same = this.value.currentTrack?.id === track.id;
    if (!same) this.pendingSeek = null;
    this.value.queue = [...queue]; this.value.currentTrack = track; this.value.currentIndex = index;
    this.value.loading = true; this.value.playing = false; this.value.error = null;
    this.value.currentTime = same ? this.value.currentTime : 0;
    this.value.duration = seconds(track.duration); this.transport = "loading"; this.emit();
    await Promise.all([cancelled, this.reconcileBgm()]);
    if (request !== this.operation || this.disposed) return;
    try {
      const state = await this.nativeCommand({ action: "play", trackId: track.id, deviceId: this.value.outputDeviceId, volume: this.value.volume, transitionMode: this.value.songTransitionMode });
      if (request !== this.operation || this.disposed) return;
      this.nativeEndedSerial = state.endedSerial;
      this.value.duration = state.duration; this.value.currentTime = state.currentTime;
      this.value.playing = state.playing; this.value.loading = false;
      this.transport = state.playing ? "playing" : "paused";
      this.emit(); this.startNativePoll();
      if (this.pendingSeek !== null) { const position = this.pendingSeek; this.pendingSeek = null; this.seek(position); }
      else this.prepareSuccessor();
    } catch (error) { if (request === this.operation && !this.disposed) this.fail(error instanceof Error ? error.message : "CoreAudio 播放失败"); }
  }

  private startNativePoll(): void {
    this.stopNativePoll();
    const epoch = this.nativePollEpoch;
    const poll = async () => {
      if (this.disposed || this.value.backend !== "coreaudio" || epoch !== this.nativePollEpoch) return;
      const request = this.operation;
      try {
        const response = await fetch("/api/output/state");
        const state = await response.json() as NativeState & { error?: string };
        if (!response.ok) throw new Error(state.error || "无法读取 CoreAudio 状态");
        if (this.disposed || this.value.backend !== "coreaudio" || epoch !== this.nativePollEpoch) return;
        if (request === this.operation && this.transport === "playing" && state.trackId !== this.value.currentTrack?.id) {
          const index = this.value.queue.findIndex(track => track.id === state.trackId);
          if ((state.trackId === this.nativePreparedId || state.trackId === this.nativeHandoffId) && index >= 0) {
            this.value.currentTrack = this.value.queue[index]; this.value.currentIndex = index;
            if (state.playing) this.prepareSuccessor();
          } else throw new Error("CoreAudio 播放进程已重启或状态已改变，请重新播放");
        }
        if (request === this.operation && state.trackId === this.value.currentTrack?.id && this.transport !== "loading") {
          if (state.error) throw new Error(state.error);
          this.value.currentTime = state.currentTime; this.value.duration = state.duration;
          this.value.playing = state.playing;
          if (state.endedSerial !== this.nativeEndedSerial && this.transport === "playing") {
            this.nativeEndedSerial = state.endedSerial;
            const next = this.value.queue[this.value.currentIndex + 1];
            if (next) {
              if (this.value.songTransitionMode === "gapless") this.gaplessWarning();
              void this.play(next.id);
            }
            else { this.transport = "idle"; this.value.playing = false; void this.reconcileBgm(); }
          }
          this.emit();
        }
      } catch (error) {
        if (!this.disposed && request === this.operation && this.value.backend === "coreaudio" && this.expectsSong()) this.fail(error instanceof Error ? error.message : "CoreAudio 连接已断开");
      }
      if (!this.disposed && this.value.backend === "coreaudio" && epoch === this.nativePollEpoch) this.nativePoll = setTimeout(poll, 200);
    };
    this.nativePoll = setTimeout(poll, 200);
  }

  private stopNativePoll(): void { ++this.nativePollEpoch; if (this.nativePoll) clearTimeout(this.nativePoll); this.nativePoll = undefined; }

  private onGesture = (): void => {
    if (this.disposed) return;
    this.gestureReceived = true;
    if (this.effectsContext && this.effectsContext.state !== "running") {
      void this.effectsContext.resume().catch(() => {});
    }
    void this.reconcileBgm();
  };

  private onBgmError = (): void => {
    if (this.disposed) return;
    ++this.bgmOperation;
    this.cancelFade();
    this.bgm.pause();
    this.bgm.volume = 0;
    this.bgmTarget = -1;
    this.value.bgmPlaying = false;
    this.value.bgmError = "氛围配乐无法加载，歌曲播放功能仍可使用。";
    this.emit();
  };

  private reconcileBgm(): Promise<void> {
    const idle = this.transport === "idle" || this.transport === "error";
    const target =
      !this.disposed && this.gestureReceived && this.value.bgmEnabled && idle
        ? this.value.bgmVolume
        : 0;
    if (target === this.bgmTarget) return this.bgmTask;
    this.bgmTarget = target;
    const request = ++this.bgmOperation;
    this.cancelFade();
    this.bgmTask = (async () => {
      if (target > 0) {
        try {
          await this.bgm.play();
          if (this.disposed || request !== this.bgmOperation) {
            if (this.disposed || this.bgmTarget <= 0) this.bgm.pause();
            return;
          }
          this.value.bgmError = null;
          this.value.bgmPlaying = true;
          this.emit();
        } catch {
          if (!this.disposed && request === this.bgmOperation) {
            this.bgmTarget = -1;
            this.value.bgmPlaying = false;
            this.value.bgmError =
              "氛围配乐暂未获准播放或无法读取，请再次点击界面重试。";
            this.emit();
          }
          return;
        }
      }
      if (this.disposed || request !== this.bgmOperation) return;
      await this.fadeBgm(target, target > 0 ? 650 : 220);
      if (this.disposed || request !== this.bgmOperation) return;
      if (target === 0) this.bgm.pause();
      this.value.bgmPlaying = target > 0 && !this.bgm.paused;
      this.emit();
    })();
    return this.bgmTask;
  }

  private fadeBgm(target: number, duration: number): Promise<void> {
    this.cancelFade();
    const start = this.bgm.volume;
    if (this.bgm.paused || Math.abs(start - target) < 0.001) {
      this.bgm.volume = target;
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.fade !== fade) return;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / duration,
        );
        this.bgm.volume = unit(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 24);
        else {
          this.fade = undefined;
          resolve();
        }
      };
      this.fade = fade;
      step();
    });
  }

  private cancelFade(): void {
    if (!this.fade) return;
    const fade = this.fade;
    this.fade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("MusicPlayer state listener failed", error);
      }
    }
  }
}
