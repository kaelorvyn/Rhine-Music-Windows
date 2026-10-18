// JOOX adapter contract tests on synthetic fixtures: Base64(UTF-8) name
// decoding, evidence-based quality/fee mapping, search paging and the
// honest playback boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeName, jooxTrack, JooxCatalog } from './joox-protocol.mjs';

const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const songInfo = (over = {}) => ({
  songid: '97773', albumid: '8220', singerid: '4558',
  songname: b64('晴天'), singername: b64('周杰倫'), albumname: b64('葉惠美'),
  playtime: 269, size: 55296047, n128Size: 4317292, size320: 10792943,
  kbps_map: '{"128":4317292,"320":10792943}', subscript: '[]', url: null,
  mv_flag: 1, vid: '3602826', album_url: 'https://image.joox.com/cover/1000', ...over,
});

test('decodeName turns Base64(UTF-8) back into text and passes plain text', () => {
  assert.equal(decodeName(b64('晴天')), '晴天');
  assert.equal(decodeName(''), '');
  assert.equal(decodeName('Plain Title'), 'Plain Title', 'non-base64 text is untouched');
});

test('jooxTrack maps fields with evidence-based quality and VIP badges', () => {
  const track = jooxTrack(songInfo());
  assert.equal(track.id, 'joox-97773');
  assert.equal(track.title, '晴天');
  assert.equal(track.artist, '周杰倫');
  assert.equal(track.duration, 269);
  const source = track.onlineSource;
  assert.equal(source.provider, 'joox');
  assert.equal(source.albumTitle, '葉惠美');
  assert.equal(source.coverUrl, 'https://image.joox.com/cover/1000');
  assert.equal(source.qualityLabel, '高品', 'a 320 key in kbps_map is high-tier evidence');
  assert.equal(source.fee, 0);
  assert.equal(source.original, false, 'no original evidence stays false');
  assert.equal(jooxTrack(songInfo({ kbps_map: '{"flac":99}' })).onlineSource.qualityLabel, '无损');
  assert.equal(jooxTrack(songInfo({ kbps_map: 'broken' })).onlineSource.qualityLabel, '标准');
  const vip = jooxTrack(songInfo({ subscript: JSON.stringify([{ title: b64('VIP'), type: 1 }, { title: b64('独家'), type: 2 }]) }));
  assert.equal(vip.onlineSource.fee, 1, 'a decoded VIP badge is fee evidence');
  assert.equal(jooxTrack({}), null);
});

test('search walks the aggregation list and pages with offset', async () => {
  const fixture = { common: { iRet: 0, sErr: '' }, sum: 45, song_aggregation_list: [{ item_list: [{ song_info: songInfo() }, { song_info: songInfo({ songid: '97774', songname: b64('第二首') }) }] }] };
  const calls = [];
  const catalog = new JooxCatalog({ fetch: async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(fixture), { status: 200 });
  } });
  const result = await catalog.search('晴天');
  assert.equal(result.provider, 'joox');
  assert.equal(result.total, 45);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.tracks.map(track => track.title), ['晴天', '第二首']);
  assert.match(calls[0], /keyword=/, 'the keyword travels in the query');
  assert.match(calls[0], /search_id=/, 'search_id is always present per the binary contract');

  const failed = new JooxCatalog({ fetch: async () => new Response(JSON.stringify({ common: { iRet: -1, sErr: 'boom' } }), { status: 200 }) });
  await assert.rejects(() => failed.search('晴天'), /搜索暂时不可用/);
  await assert.rejects(() => catalog.search(''), /搜索词/);
});

test('playback refuses honestly so source fallback takes over', async () => {
  const catalog = new JooxCatalog({ fetch: async () => new Response('{}', { status: 500 }) });
  await assert.rejects(() => catalog.prepare('joox-97773'), /未提供这首歌的播放地址.*换源/);
  await assert.rejects(() => catalog.songInfo('joox-97773'), /尚未接入/);
  await assert.rejects(() => catalog.playlists(), /尚未接入/);
});
