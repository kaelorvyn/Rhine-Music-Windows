// Audio effects: 音频效果链 + 前端音效面板。
// 默认配置 16 字段，见 defaultEffectsConfig
// 16 个内置预设（id/名称/描述/分类/参数）
// EQ 频率 [31,62,125,250,500,1000,2000,4000,8000,16000]
// 参数范围见 effectsRanges（与上游的滑块 min/max/step 一致）
export type EffectsConfig = {
  eqEnabled: boolean;
  eqBands: number[]; // 10 × dB gains, 31Hz … 16kHz
  bassEnabled: boolean;
  bassGain: number; // dB 0…12
  bassFreq: number; // Hz 40…250
  reverbEnabled: boolean;
  reverbMix: number; // 0…100 (%)
  widenEnabled: boolean;
  widenWidth: number; // 0…300 (%)
  surroundEnabled: boolean;
  surroundSpeed: number; // 0.05…0.5 Hz
  preampDb: number; // -24…0
  trebleGain: number; // dB -12…12
  clarityGain: number; // dB 0…6
  compressor: number; // 0…100 (%)
  balance: number; // -1…1
  limiterEnabled: boolean;
 /** Master switch: false = plain direct playback (the original audio path,
 * no Web Audio routing at all) — guaranteed audible in every environment. */
  enabled: boolean;
};
export const eqFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** 对齐原生音频模块的 biquad 常量。 */
export const eqQ = 2.82 / 2;              // Q = 1.41
export const eqMaxFrequencyRatio = 0.45;  // EQ 频率上限 0.45·fs（Nyquist 保护）
export const shelfMaxFrequencyRatio = 0.4; // 搁架频率上限 0.4·fs
export const shelfMaxFrequency = 8000;    // 搁架频率硬上限 8000 Hz
export const shelfSlope = 3 / 7;          // _搁架斜率 S
export const eqGainDivisor = 40;          // A = 10^(dB/40)
export const paramSmoothingSeconds = 0.015; // 参数平滑时间常数 15 ms
/** 对齐上游的增益→线性幅度换算（A = 10^(dB/40)）。 */
export const dbToAmplitude = (db: number): number => Math.pow(10, db / eqGainDivisor);
/** 默认配置——注意 limiterEnabled 默认 true。 */
export const defaultEffectsConfig: EffectsConfig = {
  eqEnabled: false, eqBands: Array(10).fill(0), bassEnabled: false, bassGain: 0, bassFreq: 120,
  reverbEnabled: false, reverbMix: 0, widenEnabled: false, widenWidth: 100,
  surroundEnabled: false, surroundSpeed: 0.15, preampDb: 0,
  trebleGain: 0, clarityGain: 0, compressor: 0, balance: 0, limiterEnabled: true,
  enabled: false,
};
/** 滑块范围（min/max/step）。 */
export const effectsRanges: Record<string, { min: number; max: number; step: number; unit: string }> = {
  preampDb: { min: -24, max: 0, step: 1, unit: 'dB' },
  bassGain: { min: 0, max: 12, step: 0.5, unit: 'dB' },
  bassFreq: { min: 40, max: 250, step: 5, unit: 'Hz' },
  trebleGain: { min: -12, max: 12, step: 1, unit: 'dB' },
  clarityGain: { min: 0, max: 6, step: 0.5, unit: 'dB' },
  reverbMix: { min: 0, max: 100, step: 5, unit: '%' },
  widenWidth: { min: 0, max: 300, step: 5, unit: '%' },
  surroundSpeed: { min: 0.05, max: 0.5, step: 0.05, unit: 'Hz' },
  compressor: { min: 0, max: 100, step: 5, unit: '%' },
  balance: { min: -1, max: 1, step: 0.1, unit: '' },
};
export type EffectsPreset = { id: string; name: string; description: string; tag: string; config: Partial<EffectsConfig> };
/** 16 个内置预设。 */
export const effectsPresets: EffectsPreset[] = [
  { id: 'natural', name: '自然均衡', description: '轻微整理中低频，保留录音原有音色与动态。', tag: '通用', config: { preampDb: -1, eqEnabled: true, eqBands: [0, 0, 0, -0.5, -0.3, 0, 0.3, 0, 0, 0] } },
  { id: 'vocal', name: '人声清晰', description: '减少浑浊，轻提人声存在感；齿音明显时换用柔化高频。', tag: '人声', config: { preampDb: -2.8, eqEnabled: true, eqBands: [-0.5, -0.5, -0.3, -1.2, -0.7, 0.3, 1.4, 0.6, -0.5, -0.3] } },
  { id: 'pop', name: '流行律动', description: '轻提两端，适合偏平淡的流行录音；避免过量低频。', tag: '流行', config: { preampDb: -2.5, eqEnabled: true, eqBands: [0.6, 1.2, 0.8, -0.5, -0.5, 0, 0.5, 0.6, 0.5, 0.2] } },
  { id: 'rock', name: '摇滚节奏', description: '突出鼓点和吉他轮廓，温和收敛刺耳高频。', tag: '摇滚', config: { preampDb: -2.8, eqEnabled: true, eqBands: [0.4, 1.4, 1, -0.6, -0.7, 0.2, 0.7, 0.4, -0.5, -0.5] } },
  { id: 'classic', name: '古典自然', description: '仅轻修浑浊，无混响和压缩；保留乐器空间与动态。', tag: '古典', config: { preampDb: -1, eqEnabled: true, eqBands: [0, 0, 0, -0.4, -0.2, 0, 0.2, 0.2, 0.3, 0.2] } },
  { id: 'bass', name: '深潜低频', description: '偏向低频延伸；适合低频偏薄的耳机，量感已有则慎用。', tag: '低音', config: { preampDb: -4, eqEnabled: true, eqBands: [1.8, 2.2, 1.1, -0.7, -0.5, 0, 0, 0, 0, 0] } },
  { id: 'punch', name: '鼓点冲击', description: '侧重中低频弹性，适合鼓组和贝斯；减少超低频堆积。', tag: '低音', config: { preampDb: -2.8, eqEnabled: true, eqBands: [-0.5, 0.8, 1.5, -0.6, -0.5, 0, 0.3, 0.4, 0, 0] } },
  { id: 'warm', name: '温暖耐听', description: '略增厚度并减轻高频亮度，适合偏冷、偏亮的录音。', tag: '通用', config: { preampDb: -1.8, eqEnabled: true, eqBands: [0.2, 0.5, 0.7, 0.2, -0.3, 0, -0.3, -0.6, -1.2, -0.8] } },
  { id: 'air', name: '空气细节', description: '轻提高频延伸；适合偏暗的录音，不适合本就刺耳的耳机。', tag: '通用', config: { preampDb: -2.8, eqEnabled: true, eqBands: [0, 0, 0, -0.5, -0.3, 0, 0, 0.2, 0.7, 1.6] } },
  { id: 'soft', name: '柔化高频', description: '适度降低齿音和镲片亮度；也会减少部分高频细节。', tag: '人声', config: { preampDb: -0.5, eqEnabled: true, eqBands: [0, 0, 0, 0, 0, 0, -0.2, -0.8, -2.2, -1] } },
  { id: 'clear', name: '去浑浊', description: '主要削减中低频拥挤；适合发闷的混音，偏薄录音慎用。', tag: '通用', config: { preampDb: -1.6, eqEnabled: true, eqBands: [0, 0, -0.4, -1.5, -1, 0, 0.6, 0.2, 0, 0] } },
  { id: 'acoustic', name: '木吉他纹理', description: '整理琴箱低频，轻提拨弦细节；避免夸大弦噪。', tag: '流行', config: { preampDb: -2, eqEnabled: true, eqBands: [-0.5, -0.3, 0.1, -0.8, -0.5, 0.2, 0.7, 0.8, 0.2, 0] } },
  { id: 'jazz', name: '爵士温润', description: '轻修低频厚度，温和收敛铜管和镲片亮度，无动态压缩。', tag: '古典', config: { preampDb: -1.5, eqEnabled: true, eqBands: [0, 0.3, 0.5, -0.4, -0.3, 0.2, 0.3, -0.3, -0.7, -0.4] } },
  { id: 'speaker', name: '小音箱清晰', description: '削减难以播放的超低频，突出中频；无法补回硬件缺失的低音。', tag: '通用', config: { preampDb: -2, eqEnabled: true, eqBands: [-3, -1.8, -0.4, -0.7, -0.2, 0.5, 0.8, 0.3, -0.2, -0.3] } },
  { id: 'space', name: '轻盈空间', description: '少量混响与声场加宽，适合干涩录音；外放不建议使用。', tag: '空间', config: { preampDb: -2, reverbEnabled: true, reverbMix: 4, widenEnabled: true, widenWidth: 108 } },
  { id: 'night', name: '夜间轻听', description: '温和缩小响度差；仍需手动调低音量，不能代替听力保护。', tag: '夜间', config: { preampDb: -2.5, compressor: 25 } },
];
/** 分类顺序。 */
export const effectsCategories = ['通用', '人声', '流行', '摇滚', '古典', '低音', '空间', '夜间'];
/** 对齐上游「自动预留余量」按钮算法。 */
export function autoPreamp(config: EffectsConfig): number {
  const sum = (config.eqEnabled ? Math.max(0, ...config.eqBands) : 0)
    + (config.bassEnabled ? config.bassGain : 0)
    + Math.max(0, config.trebleGain) + config.clarityGain;
  return -Math.min(24, sum + 1);
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
// A missing field must fall back to its default, never to the clamp floor:
// clamp(NaN, -24, 0) once landed on -24 and muted every song on first run.
const num = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export function normalizeEffectsConfig(value: unknown): EffectsConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<EffectsConfig>;
  const bands = Array.isArray(raw.eqBands) ? raw.eqBands : [];
  return {
    ...defaultEffectsConfig,
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => key in defaultEffectsConfig)),
    eqEnabled: !!raw.eqEnabled,
    eqBands: eqFrequencies.map((_, index) => clamp(num(bands[index], defaultEffectsConfig.eqBands[index] ?? 0), -12, 12)),
    bassEnabled: !!raw.bassEnabled, bassGain: clamp(num(raw.bassGain, defaultEffectsConfig.bassGain), 0, 12), bassFreq: clamp(num(raw.bassFreq, defaultEffectsConfig.bassFreq), 40, 250),
    trebleGain: clamp(num(raw.trebleGain, defaultEffectsConfig.trebleGain), -12, 12), clarityGain: clamp(num(raw.clarityGain, defaultEffectsConfig.clarityGain), 0, 6),
    compressor: clamp(num(raw.compressor, defaultEffectsConfig.compressor), 0, 100), balance: clamp(num(raw.balance, defaultEffectsConfig.balance), -1, 1),
    reverbEnabled: !!raw.reverbEnabled, reverbMix: clamp(num(raw.reverbMix, defaultEffectsConfig.reverbMix), 0, 100),
    widenEnabled: !!raw.widenEnabled, widenWidth: clamp(num(raw.widenWidth, defaultEffectsConfig.widenWidth), 0, 300),
    surroundEnabled: !!raw.surroundEnabled, surroundSpeed: clamp(num(raw.surroundSpeed, defaultEffectsConfig.surroundSpeed), 0.05, 0.5),
    preampDb: clamp(num(raw.preampDb, defaultEffectsConfig.preampDb), -24, 0),
 // 兼容旧字段名 limiter；上游字段名是 limiterEnabled（默认 true）
    limiterEnabled: (raw as { limiter?: boolean }).limiter !== false && raw.limiterEnabled !== false,
    enabled: !!raw.enabled,
  };
}
export function applyPreset(config: EffectsConfig, preset: EffectsPreset): EffectsConfig {
 // Picking a preset is an explicit intent to use effects: flip the master switch on.
  return normalizeEffectsConfig({ ...defaultEffectsConfig, ...preset.config, enabled: true, bassFreq: config.bassFreq, surroundSpeed: config.surroundSpeed });
}

function impulseResponse(context: BaseAudioContext, seconds = 1.8): AudioBuffer {
  const rate = context.sampleRate, length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.6);
  }
  return buffer;
}

/** Always-connected chain; bypassing happens by neutral node parameters. */
export class AudioEffectsChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly context: BaseAudioContext;
  private readonly preamp: GainNode;
  private readonly eq: BiquadFilterNode[];
  private readonly bass: BiquadFilterNode;
  private readonly treble: BiquadFilterNode;
  private readonly clarity: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly balance: StereoPannerNode;
  private readonly widenIn: GainNode;
  private readonly sideGain: GainNode;
  private readonly widenOut: ChannelMergerNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly surround: StereoPannerNode;
  private readonly surroundLfo: OscillatorNode;
  private readonly surroundDepth: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  constructor(context: BaseAudioContext) {
    this.context = context;
    this.preamp = context.createGain();
    const eq: BiquadFilterNode[] = [];
    eqFrequencies.forEach((frequency, index) => {
      const filter = context.createBiquadFilter();
 // 对齐原生音频实现：Q = 1.41。
      filter.type = 'peaking'; filter.frequency.value = frequency; filter.Q.value = eqQ;
      filter.gain.value = 0;
      if (index > 0) eq[index - 1].connect(filter);
      eq.push(filter);
    });
    this.eq = eq;
 // 对齐上游：低频搁架 bassFreq、高频搁架 8000 Hz。
    this.bass = context.createBiquadFilter(); this.bass.type = 'lowshelf'; this.bass.frequency.value = 120;
    this.treble = context.createBiquadFilter(); this.treble.type = 'highshelf'; this.treble.frequency.value = shelfMaxFrequency;
    this.clarity = context.createBiquadFilter(); this.clarity.type = 'peaking'; this.clarity.frequency.value = 3200; this.clarity.Q.value = eqQ;
    this.compressor = context.createDynamicsCompressor();
    this.balance = (context as AudioContext).createStereoPanner ? context.createStereoPanner() : (context.createGain() as unknown as StereoPannerNode);
 // Widener: mid passes through, side is scaled around the channel pair.
    this.widenIn = context.createGain();
    const splitter = context.createChannelSplitter(2), merger = context.createChannelMerger(2);
    const leftGain = context.createGain(), rightGain = context.createGain();
    this.sideGain = context.createGain();
    const leftSide = context.createGain(), rightSide = context.createGain();
    leftSide.gain.value = 0.5; rightSide.gain.value = -0.5;
    splitter.connect(leftGain, 0); splitter.connect(rightGain, 1);
    splitter.connect(leftSide, 0); splitter.connect(rightSide, 1);
    leftSide.connect(this.sideGain); rightSide.connect(this.sideGain);
    this.sideGain.connect(merger, 0, 0); this.sideGain.connect(merger, 0, 1);
    leftGain.connect(merger, 0, 0); rightGain.connect(merger, 0, 1);
    this.widenIn.connect(splitter);
    this.widenOut = merger;
    this.dry = context.createGain();
    this.wet = context.createGain(); this.wet.gain.value = 0;
    this.convolver = context.createConvolver(); this.convolver.buffer = impulseResponse(context);
    this.surround = (context as AudioContext).createStereoPanner ? context.createStereoPanner() : (context.createGain() as unknown as StereoPannerNode);
    this.surroundLfo = context.createOscillator(); this.surroundLfo.frequency.value = 0.15;
    this.surroundDepth = context.createGain(); this.surroundDepth.gain.value = 0;
    this.surroundLfo.connect(this.surroundDepth); this.surroundDepth.connect((this.surround as StereoPannerNode).pan);
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.limiter.connect(this.analyser); // silent tap: verifies real signal flows
    this.input = this.preamp;
    this.output = this.limiter;
    this.preamp.connect(this.eq[0]);
    this.eq[this.eq.length - 1].connect(this.bass);
    this.bass.connect(this.treble); this.treble.connect(this.clarity); this.clarity.connect(this.compressor);
    this.compressor.connect(this.balance); this.balance.connect(this.widenIn);
    this.widenOut.connect(this.dry); this.widenOut.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.dry.connect(this.surround); this.wet.connect(this.surround);
    this.surround.connect(this.limiter);
    try { this.surroundLfo.start(); } catch { /* already started */ }
  }
  apply(config: EffectsConfig): void {
    const set = (param: AudioParam, value: number) => { if (Math.abs(param.value - value) > 1e-4) param.value = value; };
    set(this.preamp.gain, Math.pow(10, config.preampDb / 20));
    this.eq.forEach((filter, index) => set(filter.gain, config.eqEnabled ? config.eqBands[index] : 0));
    set(this.bass.gain, config.bassEnabled ? config.bassGain : 0);
    set(this.bass.frequency, config.bassFreq);
    set(this.treble.gain, config.trebleGain);
    set(this.clarity.gain, config.clarityGain);
    set(this.compressor.ratio, 1 + config.compressor / 25);
    set(this.compressor.threshold, config.compressor > 0 ? -24 : 0);
    const balance = this.balance as StereoPannerNode;
    if ('pan' in balance) set(balance.pan, config.balance);
    set(this.sideGain.gain, config.widenEnabled ? clamp(config.widenWidth / 100, 0, 3) : 1);
    set(this.wet.gain, config.reverbEnabled ? config.reverbMix / 100 : 0);
    set(this.dry.gain, config.reverbEnabled ? 1 - (config.reverbMix / 100) * 0.35 : 1);
    const surround = this.surround as StereoPannerNode;
    if ('pan' in surround) {
      set(this.surroundDepth.gain, config.surroundEnabled ? 0.85 : 0);
      set(this.surroundLfo.frequency, config.surroundSpeed);
    }
    set(this.limiter.ratio, config.limiterEnabled ? 20 : 1);
    set(this.limiter.threshold, config.limiterEnabled ? -3 : 0);
  }
 /** Read-only gain snapshot for support diagnostics (audioDiagnostics hook). */
  get diagnosticGains(): { preamp: number; dry: number; wet: number } {
    return { preamp: this.preamp.gain.value, dry: this.dry.gain.value, wet: this.wet.gain.value };
  }
 /** Real-signal check for support dumps: RMS of the chain output. 0 while the
 * song plays means the graph itself is passing silence (a wiring bug); >0 with
 * the user hearing nothing means the environment's Web Audio output is dead. */
  get outputRms(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }
 /** 频谱取样（歌曲详情页的音频条）：analyser 挂在 limiter 之后，是静音取样点，
  * 所以读它不会影响发声。调用方自己持有 Uint8Array 复用，避免每帧分配。 */
  readSpectrum(target: Uint8Array): void {
    // lib.dom 把入参收窄成 Uint8Array<ArrayBuffer>；调用方传的就是普通 Uint8Array，
    // 这里只是把 SharedArrayBuffer 那个分支排除掉，运行时无差别。
    this.analyser.getByteFrequencyData(target as Uint8Array<ArrayBuffer>);
  }
  /** 分箱数量（= fftSize / 2 = 128），画几根柱子由调用方决定。 */
  get spectrumBins(): number {
    return this.analyser.frequencyBinCount;
  }
  dispose(): void {
    try { this.surroundLfo.stop(); } catch { /* not started */ }
    try { this.output.disconnect(); } catch { /* already detached */ }
    void this.context;
  }
}

const EFFECTS_KEY = 'rhine-music-effects';
export function loadEffectsConfig(): EffectsConfig {
  try { return normalizeEffectsConfig(JSON.parse(localStorage.getItem(EFFECTS_KEY) ?? '{}')); }
  catch { return { ...defaultEffectsConfig }; }
}
export function saveEffectsConfig(config: EffectsConfig): void {
  try { localStorage.setItem(EFFECTS_KEY, JSON.stringify(normalizeEffectsConfig(config))); } catch { /* storage unavailable */ }
}
