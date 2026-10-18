import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLyrics, lyricIndex, untimedLyrics, backfillLyrics } from '../src/music-lyrics.ts';
import { NeteaseOnline } from './netease-online.mjs';

test('LRC synchronizes repeated timestamps, offsets, translations, seeks and silent intro', () => {
  const lines = parseLyrics('[offset:200]\n[00:02.2][00:08.200]重复句\n[00:05.00]中间句\n[ar:artist]', '[offset:200]\n[00:02.20]Translation');
  assert.deepEqual(lines.map(line => line.time), [2, 4.8, 8]);
  assert.equal(lines[0].translation, 'Translation');
  assert.equal(lyricIndex(lines, 0), -1);
  assert.equal(lyricIndex(lines, 4.799), 0);
  assert.equal(lyricIndex(lines, 4.8), 1);
  assert.equal(lyricIndex(lines, 20), 2);
  assert.equal(lyricIndex(lines, 2), 0, 'a backward seek restores its actual line');
  assert.equal(untimedLyrics('[ar:测试]\n无时间歌词\n第二行'), '无时间歌词\n第二行');
  assert.deepEqual(parseLyrics('[00:99.0]invalid\n[00:01.125]valid').map(line => line.time), [1.125]);
});

const song = { id: 123, name: '<合成歌曲>', ar: [{ name: '合成歌手' }], al: { id: 45, name: '合成专辑' }, dt: 120000 };
const store = { load: async () => ({}), save: async () => {}, clear: async () => {} };
test('song information retains real album fields, synced lyrics and bounded deduplicated cache', async () => {
  const calls = [];
  const api = new NeteaseOnline({ sessionStore: store, call: async method => {
    calls.push(method);
    return { body: method === 'songDetail' ? { code: 200, songs: [song] } : method === 'album' ?
      { code: 200, album: { name: '合成专辑', publishTime: Date.UTC(2020, 0, 2), company: '合成唱片', description: '<text>' } } :
      { code: 200, lrc: { lyric: '[00:01]歌词' }, tlyric: { lyric: '[00:01]Translation' } } };
  } });
  const [a, b] = await Promise.all([api.songInfo('123'), api.songInfo('123')]);
  assert.deepEqual(a, b); assert.equal(calls.length, 3);
  assert.equal(a.album.published, '2020-01-02'); assert.equal(a.album.company, '合成唱片');
  assert.equal(a.lyrics.original, '[00:01]歌词'); assert.equal(a.track.onlineSource.albumId, '45');
  assert.equal((await api.songInfo('123')).album.description, '<text>'); assert.equal(calls.length, 3);
  await assert.rejects(api.songInfo('../123'), { status: 400 });
});

test('missing lyrics do not prevent metadata, and logout rejects a stale information response', async () => {
  const api = new NeteaseOnline({ sessionStore: store, call: async method => {
    if (method === 'lyric') throw new Error('upstream failure');
    return { body: method === 'songDetail' ? { code: 200, songs: [song] } : { code: 200, album: {} } };
  } });
  const info = await api.songInfo('123');
  assert.equal(info.track.title, '<合成歌曲>'); assert.ok(info.lyrics.error); assert.equal(api.songInfoCache.size, 0);
  let release;
  const stale = new NeteaseOnline({ sessionStore: store, call: async method => method === 'songDetail' ?
    new Promise(resolve => release = resolve) : { body: { code: 200 } } });
  const pending = stale.songInfo('123');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await stale.auth.logout(); release({ body: { code: 200, songs: [song] } });
  await assert.rejects(pending, { status: 409 }); assert.equal(stale.songInfoCache.size, 0);
});

test('metadata saturation queues playback first and never exceeds four upstream requests', async () => {
  const calls = [], releases = [];
  const api = new NeteaseOnline({ timeoutMs: 1000, sessionStore: store, call: async method => {
    calls.push(method); return new Promise(resolve => releases.push(() => resolve({ body: { code: 200 } })));
  } });
  const occupied = Array.from({ length: 4 }, () => api.rawRequest('album', {}));
  const background = api.rawRequest('lyric', {}), playback = api.rawRequest('playback', {});
  releases.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(calls[4], 'playback'); assert.equal(api.active, 4);
  while (api.active || api.waiting.length) { releases.shift()?.(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all([...occupied, background, playback]); assert.equal(api.active, 0);
});

test('lyrics backfill matches across sources and keeps honest empties', async () => {
  const seen = [];
  const track = { title: '合成歌曲', artist: '测试歌手', duration: 121, onlineSource: { provider: 'netease', id: '7' } };
  const responder = value => async url => { seen.push(url); return { ok: true, json: async () => value }; };
 // 回填 + 翻译配对
  const filled = await backfillLyrics(track, responder({ original: '[00:01]跨源歌词', translated: '[00:01]Translation', source: 'kuwo', score: 90 }));
  assert.deepEqual(filled, { original: '[00:01]跨源歌词', translated: '[00:01]Translation', instrumental: false, unavailable: false });
  assert.match(seen[0], /title=%E5%90%88%E6%88%90%E6%AD%8C%E6%9B%B2/);
  assert.match(seen[0], /artist=/); assert.match(seen[0], /duration=121/);
  assert.match(seen[0], /provider=netease/); assert.match(seen[0], /id=7/);
 // 纯音乐
  assert.deepEqual(await backfillLyrics(track, responder({ instrumental: true, original: '', translated: '' })),
    { original: '', translated: '', instrumental: true, unavailable: false });
 // 全网无歌词 → null（调用方保留"暂无歌词"）
  assert.equal(await backfillLyrics(track, responder({ unavailable: true, original: '', translated: '' })), null);
  assert.equal(await backfillLyrics(track, responder(null)), null);
 // 请求失败 → null
  assert.equal(await backfillLyrics(track, async () => { throw new Error('offline'); }), null);
 // 无 onlineSource 的本地曲目不带 provider/id 也能问
  await backfillLyrics({ title: '本地曲', artist: '我', duration: 60 }, responder({ original: 'x' }));
  assert.ok(!seen.at(-1).includes('provider=')); assert.ok(!seen.at(-1).includes('id='));
});
