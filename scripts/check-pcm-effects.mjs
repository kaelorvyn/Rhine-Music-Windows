// Decode-time effects mapping for the native pipeline: FFmpeg filter chain,
// cache fingerprint and neutral-config passthrough (pure functions, no FFmpeg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegEffectsFilter, effectsFingerprint } from './pcm-effects.mjs';

test('neutral configs keep the original samples', () => {
  assert.equal(ffmpegEffectsFilter({}), '');
  assert.equal(ffmpegEffectsFilter({ preampDb: 0, eqEnabled: false, eqBands: Array(10).fill(0), compressor: 0, balance: 0, widenEnabled: false, widenWidth: 100 }), '');
  assert.equal(effectsFingerprint({}), '', 'neutral effects share the raw PCM cache');
});

test('preamp, EQ bands and bass map to FFmpeg filters', () => {
  const filter = ffmpegEffectsFilter({ preampDb: -4, eqEnabled: true, eqBands: [0, 0, 2, 0, -1, 0, 0, 0, 0, 3], bassEnabled: true, bassGain: 6, bassFreq: 120 });
  assert.match(filter, /volume=-4\.00dB/);
  assert.match(filter, /equalizer=f=125.00:t=q:w=1.41:g=2\.00/);
  assert.match(filter, /equalizer=f=500.00:t=q:w=1.41:g=-1\.00/);
  assert.match(filter, /equalizer=f=16000.00:t=q:w=1.41:g=3\.00/);
  assert.match(filter, /bass=g=6\.00:f=120\.00/);
  assert.ok(!filter.includes('f=31:'), 'zero bands stay out of the chain');
  assert.ok(!filter.includes('f=250:'), 'zero bands stay out of the chain');
});

test('treble, clarity, compressor and stereo map to FFmpeg filters', () => {
  const filter = ffmpegEffectsFilter({ trebleGain: 2, clarityGain: -1.5, compressor: 50, balance: -0.25, widenEnabled: true, widenWidth: 140 });
  assert.match(filter, /treble=g=2\.00:f=8000/);
  assert.match(filter, /equalizer=f=3200:t=q:w=1.41:g=-1\.50/);
  assert.match(filter, /acompressor=threshold=-24dB:ratio=3\.00/);
  assert.match(filter, /stereotools=bal_out=-0\.25:slev=1\.40/);
});

test('disabled sections never reach the chain and fingerprints follow the filter', () => {
  const off = ffmpegEffectsFilter({ bassEnabled: false, bassGain: 12, widenEnabled: false, widenWidth: 200, compressor: 0 });
  assert.equal(off, '', 'disabled sections contribute nothing');
  const withBass = { bassEnabled: true, bassGain: 6 };
  assert.ok(effectsFingerprint(withBass));
  assert.equal(effectsFingerprint(withBass), effectsFingerprint({ ...withBass, bassFreq: 120 }), 'clamped-identical filters share the cache');
  assert.notEqual(effectsFingerprint(withBass), effectsFingerprint({ ...withBass, bassGain: 3 }));
});
