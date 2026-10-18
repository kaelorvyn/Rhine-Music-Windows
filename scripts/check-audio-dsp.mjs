// Native DSP contract: EffectsConfig → FFmpeg -af mapping (scripts/pcm-effects.mjs).
// Every config field must land in the filter chain, neutral stays a pure
// passthrough, and hostile values must be coerced to numbers (no filter injection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegEffectsFilter, effectsFingerprint, parseEffectsQuery } from './pcm-effects.mjs';

test('every effects field lands in the filter chain', () => {
  const filter = ffmpegEffectsFilter({
    preampDb: -3, eqEnabled: true, eqBands: [1, 0, 0, 0, 0, 0, 0, 0, 0, 2],
    bassEnabled: true, bassGain: 6, bassFreq: 120, trebleGain: 2, clarityGain: -1.5,
    compressor: 50, balance: -0.25, widenEnabled: true, widenWidth: 140,
    reverbEnabled: true, reverbMix: 22, surroundEnabled: true, surroundSpeed: 0.15, limiterEnabled: true,
  });
  assert.match(filter, /volume=-3\.00dB/);
  assert.match(filter, /equalizer=f=31.00:t=q:w=1.41:g=1\.00/);
  assert.match(filter, /equalizer=f=16000.00:t=q:w=1.41:g=2\.00/);
  assert.match(filter, /bass=g=6\.00:f=120\.00/);
  assert.match(filter, /treble=g=2\.00:f=8000/);
  assert.match(filter, /equalizer=f=3200:t=q:w=1.41:g=-1\.50/);
  assert.match(filter, /acompressor=threshold=-24dB:ratio=3\.00/);
  assert.match(filter, /stereotools=bal_out=-0\.25:slev=1\.40/);
  assert.match(filter, /aecho=0\.8:0\.88:60:0\.22/);
  assert.match(filter, /apulsator=hz=0\.15:amount=1/);
  assert.match(filter, /alimiter=/);
});

test('neutral config keeps the original samples', () => {
  assert.equal(ffmpegEffectsFilter({}), '');
  assert.equal(effectsFingerprint({}), '', 'neutral shares the raw cache');
});

test('hostile values coerce to numbers — no filter injection', () => {
  const filter = ffmpegEffectsFilter({
    preampDb: '0;drop', balance: 'c0=1|evil', compressor: 'x', trebleGain: 'NaN',
    eqEnabled: true, eqBands: ['1)evil(', 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  assert.ok(!/evil|drop|\(/.test(filter), `hostile text leaked into: ${filter}`);
  assert.match(filter, /^equalizer=f=31.00:t=q:w=1.41:g=0\.00$|^$/);
});

test('query parsing matches the player query format', () => {
  const params = new URLSearchParams('preamp=-3&eq=2,2,1,0,-1,0,1,2,2,1&bass=6&bassFreq=120&widen=140&rev=22&sur=0.15&lim=1');
  const config = parseEffectsQuery(params);
  assert.equal(config.preampDb, -3);
  assert.equal(config.eqEnabled, true);
  assert.deepEqual(config.eqBands, [2, 2, 1, 0, -1, 0, 1, 2, 2, 1]);
  assert.equal(config.bassEnabled, true);
  assert.equal(config.bassGain, 6);
  assert.equal(config.widenWidth, 140);
  assert.equal(config.reverbMix, 22);
  assert.equal(config.surroundSpeed, 0.15);
  assert.equal(config.limiterEnabled, true);
  assert.notEqual(ffmpegEffectsFilter(config), '', 'parsed config produces a chain');
  assert.equal(parseEffectsQuery(new URLSearchParams()).preampDb, 0);
  assert.equal(ffmpegEffectsFilter(parseEffectsQuery(new URLSearchParams())), '', 'empty query stays neutral');
});

test('cache fingerprints separate configs and collapse clamped equals', () => {
  const a = { preampDb: -3, limiterEnabled: true };
  const b = { preampDb: -6, limiterEnabled: true };
  assert.notEqual(effectsFingerprint(a), effectsFingerprint(b));
  assert.equal(effectsFingerprint(a), effectsFingerprint({ preampDb: '-3', limiterEnabled: true }), 'coerced-identical shares the cache');
});
