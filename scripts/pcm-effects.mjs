// Decode-time effects for the native (CoreAudio) pipeline. The native output
// consumes an FFmpeg-decoded PCM file through a Swift child process, so the
// effects must be baked in at decode; a changed config fingerprints the cache
// key and re-decodes on the next track. Reverb and 8D surround stay
// browser-pipeline capabilities (no faithful FFmpeg mapping).
import { createHash } from 'node:crypto';

const eqFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// biquad 常量按实测频响拟合（常量表 0x141c9c2xx）。
const EQ_Q = 2.82 / 2;            // Q = 1.41
const EQ_MAX_RATIO = 0.45;        // EQ 频率上限 0.45·fs
const SHELF_MAX_RATIO = 0.4;      // 搁架频率上限 0.4·fs
const SHELF_MAX_FREQ = 8000;      // 搁架频率硬上限 8000 Hz
const BASS_FREQ_MIN = 40;         // 滑块范围
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const fixed = value => Number(value).toFixed(2);
/** 对齐：EQ 频率钳到 0.45·fs（未知采样率时按 48 kHz 估）。 */
const clampEqFrequency = (frequency, sampleRate = 48000) => Math.min(frequency, EQ_MAX_RATIO * sampleRate);
/** 对齐：搁架频率钳到 min(8000, 0.4·fs)。 */
const clampShelfFrequency = (frequency, sampleRate = 48000) =>
  Math.min(Math.max(BASS_FREQ_MIN, frequency), SHELF_MAX_FREQ, SHELF_MAX_RATIO * sampleRate);

/** FFmpeg -af chain for the config; '' means "keep the original samples". */
export function ffmpegEffectsFilter(config = {}) {
  const filters = [];
  const preamp = number(config.preampDb);
  if (preamp) filters.push(`volume=${fixed(preamp)}dB`);
  if (config.eqEnabled && Array.isArray(config.eqBands)) {
    for (let index = 0; index < eqFrequencies.length; index++) {
      const gain = number(config.eqBands[index]);
 // Q 对齐 1.41（原来是 1.1）；频率过 0.45·fs 时钳制。
      if (gain) filters.push(`equalizer=f=${fixed(clampEqFrequency(eqFrequencies[index]))}:t=q:w=${fixed(EQ_Q)}:g=${fixed(gain)}`);
    }
  }
  if (config.bassEnabled && number(config.bassGain) > 0) {
    filters.push(`bass=g=${fixed(number(config.bassGain))}:f=${fixed(clampShelfFrequency(number(config.bassFreq, 120)))}`);
  }
  const treble = number(config.trebleGain);
  if (treble) filters.push(`treble=g=${fixed(treble)}:f=${fixed(clampShelfFrequency(SHELF_MAX_FREQ))}`);
  const clarity = number(config.clarityGain);
  if (clarity) filters.push(`equalizer=f=3200:t=q:w=${fixed(EQ_Q)}:g=${fixed(clarity)}`);
  const compressor = number(config.compressor);
  if (compressor > 0) filters.push(`acompressor=threshold=-24dB:ratio=${fixed(1 + compressor / 25)}:attack=5:release=120:makeup=1`);
  const stereo = [];
  const balance = number(config.balance);
  if (balance) stereo.push(`bal_out=${fixed(Math.max(-1, Math.min(1, balance)))}`);
  if (config.widenEnabled && number(config.widenWidth, 100) !== 100) {
    stereo.push(`slev=${fixed(Math.max(0, Math.min(3, number(config.widenWidth, 100) / 100)))}`);
  }
  if (stereo.length) filters.push(`stereotools=${stereo.join(':')}`);
  if (config.reverbEnabled) {
    const mix = Math.max(0, Math.min(50, number(config.reverbMix)));
    if (mix) filters.push(`aecho=0.8:0.88:60:${fixed(mix / 100)}`);
  }
  if (config.surroundEnabled) {
    const speed = Math.max(0.05, Math.min(0.5, number(config.surroundSpeed, 0.15)));
    filters.push(`apulsator=hz=${fixed(speed)}:amount=1`);
  }
  if (config.limiterEnabled === true) filters.push('alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50');
  return filters.join(',');
}

/** Parse a numeric effects query into a config for ffmpegEffectsFilter.
 * Every value is coerced/clamped as a number — never interpolated as text — so
 * a hostile query cannot break out of the filter graph. */
export function parseEffectsQuery(params) {
  const one = (key, fallback = 0) => {
    const raw = params.get(key);
    return raw === null ? fallback : number(raw, fallback);
  };
  const list = (key) => (params.get(key) ?? '').split(',').map(value => number(value));
  return {
    preampDb: one('preamp'),
    eqEnabled: params.get('eq') !== null,
    eqBands: list('eq'),
    bassEnabled: params.get('bass') !== null,
    bassGain: one('bass'),
    bassFreq: one('bassFreq', 120),
    trebleGain: one('treble'),
    clarityGain: one('clarity'),
    compressor: one('comp'),
    balance: one('bal'),
    widenEnabled: params.get('widen') !== null,
    widenWidth: one('widen', 100),
    reverbEnabled: params.get('rev') !== null,
    reverbMix: one('rev'),
    surroundEnabled: params.get('sur') !== null,
    surroundSpeed: one('sur', 0.15),
    limiterEnabled: params.get('lim') === '1',
  };
}

/** Cache-key fingerprint: '' while the chain is neutral (shared with raw PCM). */
export function effectsFingerprint(config) {
  const filter = ffmpegEffectsFilter(config);
  return filter ? createHash('sha256').update(filter).digest('hex').slice(0, 16) : '';
}
