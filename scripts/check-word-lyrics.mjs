import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWordLyrics, withWordLyrics, validWords } from './word-lyrics.mjs';
import { parseLyrics, backfillLyrics } from '../src/music-lyrics.ts';
import { convertKuwoLrc } from './lyrics.mjs';
import { NeteaseOnline } from './netease-online.mjs';

test('YRC, KRC/Qishui and QRC preserve platform segments in absolute seconds', () => {
  const expected = [{ text: 'Hello ', start: 1, end: 1.5 }, { text: '世界', start: 1.8, end: 3 }];
  for (const raw of ['[1000,2000](1000,500,0)Hello (1800,1200,0)世界', '[1000,2000]<0,500,0>Hello <800,1200,0>世界', '[1000,2000]Hello (1000,500)世界(1800,1200)']) {
    const result = withWordLyrics({ original: raw });
    assert.deepEqual(result.wordLines[0].words, expected);
    assert.deepEqual(parseLyrics(result.original, '', result.wordLines)[0].words, expected);
  }
});
test('mixed/invalid timings fall back by line; no fabricated durations', () => {
  const lines = parseLyrics('[1000,1000]<0,500,0>好<500,500,0>的\n[3000,1000]<0,-1,0>坏\n[5000,1000]整句');
  assert.equal(lines.length, 3); assert.equal(lines[0].words.length, 2);
  assert.equal(lines[1].words, undefined); assert.equal(lines[1].text, '坏'); assert.equal(lines[2].words, undefined);
  assert.equal(validWords('x', [null], 0), false);
  assert.equal(parseLyrics('[00:01]原文', '', [{ time: 1, text: '另一首', words: [{ text: '另一首', start: 1, end: 2 }] }])[0].words, undefined);
  assert.equal(parseLyrics('[00:01]原文', '', [null])[0].words, undefined);
});
test('Kuwo encoded start/duration retains translations and zero timing stays untimed', () => {
  const result = convertKuwoLrc('[kuwo:13]\n[00:01.000]<100,-100>你<350,50>好\n[00:01.000]<0,0>Hello');
  assert.deepEqual(result.wordLines[0].words, [{ text: '你', start: 1, end: 1.1 }, { text: '好', start: 1.2, end: 1.35 }]);
  assert.equal(result.translated, '[00:01.000]Hello');
});
test('NetEase new module returns YRC and old endpoint is retained on failure', async () => {
  const calls = [], song = { id: 123, name: '歌', ar: [{ name: '人' }], al: { id: 45, name: '专辑' }, dt: 120000 };
  for (const fail of [false, true]) {
    const api = new NeteaseOnline({ sessionStore: { load: async () => ({}), save: async () => {}, clear: async () => {} }, call: async method => {
      calls.push(method);
      if (method === 'songDetail') return { body: { code: 200, songs: [song] } };
      if (method === 'lyricNew' && fail) throw Error('fixture');
      return { body: { code: 200, lrc: { lyric: '[00:01]歌' }, ...(method === 'lyricNew' ? { yrc: { lyric: '[1000,2000](1000,2000,0)歌' } } : {}) } };
    } });
    const info = await api.songInfo('123');
    assert.equal(Boolean(info.lyrics.wordLines?.[0].words), !fail);
    assert.match(info.lyrics.original, /歌/);
  }
  assert.ok(calls.includes('lyric'));
});
test('backfill passes optional word data without changing source preference', async () => {
  const wordLines = parseWordLyrics('[1000,500]<0,500,0>字');
  const value = await backfillLyrics({ title: '歌', artist: '人', duration: 2 }, async () => ({ ok: true, json: async () => ({ original: '[00:01]字', wordLines }) }));
  assert.deepEqual(value.wordLines, wordLines);
});
