// 汽水音乐适配器契约测试（全部用合成 fixture，不联网）。
// 覆盖三件容易回归的事：
//   1. duration 单位（Luna 给毫秒，MusicTrack 要秒）
//   2. 试听片段的判定边界（拿不到整首时必须如实报错，交给换源兜底）
//   3. 账号歌单的 cursor 分页要摊平成前端的 offset 契约
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qishuiTrack, QishuiCatalog } from './qishui-catalog.mjs';
import { validQishuiCredential } from './qishui-protocol.mjs';

const COVER = {
  uri: 'tos-cn-i-b829550vbb/b2cbd90873404bcab5de9e6213cc38c0',
  urls: ['https://p3-luna.douyinpic.com/img/', 'https://p6-luna.douyinpic.com/img/'],
  template_prefix: 'tplv-b829550vbb',
};
const COVER_URL = 'https://p3-luna.douyinpic.com/img/tos-cn-i-b829550vbb/b2cbd90873404bcab5de9e6213cc38c0~tplv-b829550vbb-15.webp';

const lunaTrack = (over = {}) => ({
  id: '6732580534901278722',
  name: 'Hora',
  duration: 218133,
  vid: 'v10ad6e80000c0kbd3jq9rn6nc6k5k9g',
  album: { id: '7311', name: 'Hora', url_cover: COVER },
  artists: [{ name: 'MIMiNARI' }, { name: 'あるふぁきゅん。' }],
  label_info: { only_vip_playable: true },
  preview: { duration: 29, vid: 'v10ad6g50000d3nl97fog65j8je8fk60' },
  ...over,
});

/** 假 fetch：按 URL 片段分派。 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    for (const [match, reply] of routes) {
      if (target.includes(match)) return reply(target, init);
    }
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('qishuiTrack 把毫秒换成秒、拼歌手、判受限曲、拼封面', () => {
  const track = qishuiTrack(lunaTrack());
  assert.equal(track.id, 'qishui-6732580534901278722');
  assert.equal(track.title, 'Hora');
  assert.equal(track.artist, 'MIMiNARI、あるふぁきゅん。');
  assert.equal(track.duration, 218, '218133ms -> 218s');
  assert.equal(track.onlineSource.provider, 'qishui');
  assert.equal(track.onlineSource.id, '6732580534901278722');
  assert.equal(track.onlineSource.albumTitle, 'Hora');
  assert.equal(track.onlineSource.coverUrl, COVER_URL);
  assert.equal(track.onlineSource.fee, 1, 'only_vip_playable=true 才是受限曲');
  assert.equal(qishuiTrack(lunaTrack({ label_info: {} })).onlineSource.fee, 0);
  assert.equal(qishuiTrack(lunaTrack({ label_info: undefined })).onlineSource.fee, 0);
  assert.equal(qishuiTrack({}), null, '没有 id 的条目不产出曲目');
});

test('songInfo 返回 { track, album, lyrics } 而不是裸 track', async () => {
  const fetch = fakeFetch([['/luna/h5/seo_track', () => json({
    seo_track: { track: lunaTrack() },
    lyric: { content: '[00:00.00]第一句' },
    track_player: { video_model: JSON.stringify({ video_duration: 218.133, video_id: lunaTrack().vid, video_list: [{ main_url: 'https://cdn/full.m4a' }] }) },
  })]]);
  const info = await new QishuiCatalog({ fetch }).songInfo('qishui-6732580534901278722');
  assert.equal(info.track.title, 'Hora');
  assert.equal(info.album.title, 'Hora');
  assert.equal(info.lyrics.original, '[00:00.00]第一句');
  assert.equal(info.lyrics.unavailable, false);
});

test('prepare 拿到整首时返回地址，且回填 fee', async () => {
  const fetch = fakeFetch([['/luna/h5/seo_track', () => json({
    seo_track: { track: lunaTrack({ label_info: {} }) },
    track_player: { video_model: JSON.stringify({ video_duration: 218.133, video_id: lunaTrack().vid, video_list: [{ main_url: 'https://cdn/full.m4a' }] }) },
  })]]);
  const result = await new QishuiCatalog({ fetch }).prepare('qishui-6732580534901278722');
  assert.equal(result.audioUrl, 'https://cdn/full.m4a');
  assert.equal(result.fee, 0);
});

test('prepare 遇到试听片段必须如实拒绝，交给换源兜底', async () => {
  const previewPayload = json({
    seo_track: { track: lunaTrack() },
    // 实测：受限曲的 video_id 等于 preview.vid，时长 29.002s
    track_player: { video_model: JSON.stringify({ video_duration: 29.002, video_id: 'v10ad6g50000d3nl97fog65j8je8fk60', video_list: [{ main_url: 'https://cdn/preview.m4a' }] }) },
  });
  const catalog = new QishuiCatalog({ fetch: fakeFetch([['/luna/h5/seo_track', () => previewPayload]]) });
  const error = await catalog.prepare('qishui-6732580534901278722').then(() => null, e => e);
  assert.ok(error, '不能把 29 秒片段当整首播');
  assert.match(error.message, /暂时没有返回这首歌的播放地址/);
  assert.doesNotMatch(error.message, /付费|会员|试听/, '用户可见文案不得出现这些字样');
  assert.equal(error.status, 403);

  // 只靠 vid 绑定也能识别（video_duration 缺失时）
  const vidOnly = new QishuiCatalog({ fetch: fakeFetch([['/luna/h5/seo_track', () => json({
    seo_track: { track: lunaTrack() },
    track_player: { video_model: JSON.stringify({ video_id: 'v10ad6g50000d3nl97fog65j8je8fk60', video_list: [{ main_url: 'https://cdn/preview.m4a' }] }) },
  })]]) });
  await assert.rejects(() => vidOnly.prepare('qishui-1'), /暂时没有返回这首歌的播放地址/);
});

test('playlists 未登录直接 401，登录后把 cursor 摊平成 offset', async () => {
  const anonymous = new QishuiCatalog({ fetch: fakeFetch([]) });
  await assert.rejects(() => anonymous.playlists(0), /请先登录汽水音乐/);

  let page = 0;
  const fetch = fakeFetch([['/luna/pc/me/playlist', () => {
    page += 1;
    return json(page === 1
      ? { playlists: [{ id: '1', title: '我喜欢', count_tracks: 2, url_cover: COVER }], next_cursor: 'c2', has_more: true }
      : { playlists: [{ id: '2', title: '日系', count_tracks: 22 }], has_more: false });
  }]]);
  const auth = { credential: { sessionid: 'abc12345' } };
  const catalog = new QishuiCatalog({ fetch, auth });
  const result = await catalog.playlists(0);
  assert.equal(result.provider, 'qishui');
  assert.deepEqual(result.playlists.map(p => p.name), ['我喜欢', '日系']);
  assert.equal(result.playlists[0].coverUrl, COVER_URL);
  assert.equal(result.playlists[0].trackCount, 2);
  assert.equal(result.playlists[1].coverUrl, undefined, '没有封面的歌单不编造地址');
  assert.equal(page, 2, 'has_more 时继续翻页');

  // 二次调用走缓存，不再请求
  await catalog.playlists(0);
  assert.equal(page, 2);
});

test('playlistTracks 过滤非曲目、按 cursor 累加、offset 切片', async () => {
  const pageOne = {
    playlist: { title: '测试歌单', count_tracks: 3 },
    media_resources: [
      { type: 'track', entity: { track_wrapper: { track: lunaTrack({ id: 'a', name: 'A' }) } } },
      { type: 'video', entity: { track_wrapper: { track: lunaTrack({ id: 'x', name: '不该出现' }) } } },
      { type: 'track', entity: { track_wrapper: { track: lunaTrack({ id: 'b', name: 'B' }) } } },
    ],
    has_more: true,
    next_cursor: '22',
  };
  const pageTwo = {
    playlist: { title: '测试歌单', count_tracks: 3 },
    media_resources: [{ type: 'track', entity: { track_wrapper: { track: lunaTrack({ id: 'c', name: 'C' }) } } }],
    has_more: false,
  };
  const seen = [];
  const fetch = fakeFetch([['/luna/playlist/detail', (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.cursor ?? '');
    return json(body.cursor ? pageTwo : pageOne);
  }]]);
  const catalog = new QishuiCatalog({ fetch });
  const result = await catalog.playlistTracks('7096700219496368135', 0);
  assert.deepEqual(result.tracks.map(t => t.title), ['A', 'B', 'C']);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(seen, ['', '22'], '第二页必须带上游标 22，而不是 offset');

  const second = await catalog.playlistTracks('7096700219496368135', 2);
  assert.deepEqual(second.tracks.map(t => t.title), ['C'], 'offset 切片在缓存上生效');
  await assert.rejects(() => catalog.playlistTracks('not-a-number', 0), /无效的歌单标识/);
});

test('validQishuiCredential 只接受形状正确的凭据', () => {
  assert.equal(validQishuiCredential({ sessionid: 'abc12345' }), true);
  assert.equal(validQishuiCredential({ sessionid: 'short' }), false);
  assert.equal(validQishuiCredential({}), false);
  assert.equal(validQishuiCredential(null), false);
  assert.equal(validQishuiCredential({ sessionid: 'abc12345', userId: '123' }), true);
  assert.equal(validQishuiCredential({ sessionid: 'abc12345', userId: 'not-numeric' }), false);
});

test('signHeaders 在原生文件缺失时原样返回，不抛错', async () => {
  // 指向一个不存在的目录：签名必须优雅退化，而不是让整个播放链路崩掉。
  process.env.RHINE_QISHUI_NATIVE = 'Z:/definitely-not-here';
  const signer = await import(`./qishui-signer.mjs?missing=${Date.now()}`);
  assert.equal(signer.signerReady(), false);
  const headers = { 'user-agent': 'x' };
  assert.equal(signer.signHeaders('https://api.qishui.com/x', headers), headers);
  delete process.env.RHINE_QISHUI_NATIVE;
});

test('mediaPlayer 未登录时直接返回 null，不发起请求', async () => {
  let calls = 0;
  const catalog = new QishuiCatalog({ fetch: async () => { calls += 1; return json({}); }, auth: {} });
  assert.equal(await catalog.mediaPlayer('6732580534901278722'), null);
  assert.equal(calls, 0, '没有登录态就不该打接口');
});

test('prepare 有签名通道时优先用它，且片段会被拒绝', async () => {
  // 签名通道给 19 秒（片段），免签名通道也是片段：必须报错而不是当整首播。
  const catalog = new QishuiCatalog({
    auth: { credential: { sessionid: 'abcdefgh12345678' } },
    fetch: async url => {
      if (String(url).includes('/luna/pc/media-player')) {
        return json({ player_infos: [{ url_player_info: 'https://vod.test/info' }] });
      }
      if (String(url).includes('vod.test')) {
        return json({ Result: { Data: { Duration: 19, PlayInfoList: [{ MainPlayUrl: 'https://cdn.test/short.m4a', Bitrate: 1000, EncryptionMethod: 0 }] } } });
      }
      return json({ seo_track: { track: { duration: 218133 } }, track_player: { video_model: JSON.stringify({ video_duration: 19 }) } });
    },
  });
  await assert.rejects(() => catalog.prepare('qishui-6732580534901278722'), /没有返回这首歌的播放地址/);
});

test('songInfo 把 QRC 逐字歌词转成标准 LRC，不把标签当正文', async () => {
  const qrc = '[880,6630]<0,470,0>隐<470,300,0>形\n[7510,4210]<0,300,0>第二<300,200,0>句\n';
  const catalog = new QishuiCatalog({
    auth: {},
    fetch: async url => (String(url).includes('seo_track')
      ? json({ seo_track: { track: lunaTrack() }, lyric: { content: qrc } })
      : json({})),
  });
  const info = await catalog.songInfo('6732580534901278722');
  const text = info.lyrics.original;
  assert.ok(text.includes('[00:00.88]隐形'), `首句应带 LRC 时间戳且去掉逐字标签，实际: ${text.split('\n')[0]}`);
  assert.ok(!/[<>]/.test(text), '不允许残留 QRC 标签');
  assert.equal(info.lyrics.instrumental, false);
});
