// 本地歌单 HTTP 路由测试：走真实 http 服务，验证前端会用的每一个端点。
// 覆盖：列表/新建/更名/删除、加歌去重、排序查询、收藏往返、错误状态码。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMusicServer } from './music-server.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-playlist-http-'));
// 关掉备用音源与在线服务：本测试只关心本地歌单，不碰外网。
await fs.writeFile(path.join(directory, 'backup-sources-config.json'), JSON.stringify({ enabled: false }));
const { server } = await createMusicServer({
  dataDir: directory, autoScan: false,
  catalogs: {},
  online: { search: async () => ({ provider: 'netease', query: '', offset: 0, limit: 20, total: 0, hasMore: false, tracks: [] }) },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, url, body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

const song = (id, extra = {}) => ({ id, title: `曲目 ${id}`, artist: '歌手', album: '专辑', provider: 'kugou', onlineSourceId: `${id}.1`, duration: 200, ...extra });

let failures = 0;
const step = async (name, run) => {
  try { await run(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}\n    ${error.message}`); }
};

// 初始状态：只有收藏
let created;
await step('GET /api/playlists/local 初始只有收藏', async () => {
  const { status, body } = await call('GET', '/api/playlists/local');
  assert.equal(status, 200);
  assert.deepEqual(body.playlists.map(item => item.name), ['莱茵歌单']);
});

await step('POST 新建歌单', async () => {
  const { status, body } = await call('POST', '/api/playlists/local', { name: '通勤' });
  assert.equal(status, 200);
  assert.equal(body.playlist.name, '通勤');
  created = body.playlist.id;
});

await step('POST 新建留空用默认名', async () => {
  const { body } = await call('POST', '/api/playlists/local', {});
  assert.equal(body.playlist.name, '新歌单 2');
});

await step('POST 加歌（含重复）', async () => {
  const { status, body } = await call('POST', `/api/playlists/local/${created}/songs`, { songs: [song('a'), song('b'), song('a')] });
  assert.equal(status, 200);
  assert.deepEqual({ added: body.added, skipped: body.skipped }, { added: 2, skipped: 1 });
});

await step('GET 取曲目带元数据快照', async () => {
  const { body } = await call('GET', `/api/playlists/local/${created}?limit=50`);
  assert.equal(body.total, 2);
  assert.equal(body.tracks[0].title, '曲目 a');
  assert.equal(body.tracks[0].onlineSourceId, 'a.1');
});

await step('GET 排序参数生效', async () => {
  await call('POST', `/api/playlists/local/${created}/songs`, { songs: [song('c', { title: 'A', playCount: 99 })] });
  const asc = await call('GET', `/api/playlists/local/${created}?sort=playCount`);
  assert.deepEqual(asc.body.tracks.map(t => t.id), ['a', 'b', 'c'], '按播放次数升序');
  const desc = await call('GET', `/api/playlists/local/${created}?sort=playCount&direction=descending`);
  assert.deepEqual(desc.body.tracks.map(t => t.id), ['c', 'a', 'b'], '按播放次数降序');
});

await step('GET 未知排序规则报 400', async () => {
  const { status, body } = await call('GET', `/api/playlists/local/${created}?sort=乱写`);
  assert.equal(status, 400);
  assert.match(body.error, /不支持的排序规则/);
});

await step('POST order 自由排序', async () => {
  const { status } = await call('POST', `/api/playlists/local/${created}/order`, { ids: ['c', 'a'] });
  assert.equal(status, 200);
  const { body } = await call('GET', `/api/playlists/local/${created}`);
  assert.deepEqual(body.tracks.map(t => t.id), ['c', 'a', 'b'], '未列出的接在后面');
});

await step('DELETE songs 移除曲目', async () => {
  const { body } = await call('DELETE', `/api/playlists/local/${created}/songs`, { ids: ['b'] });
  assert.equal(body.removed, 1);
  assert.equal(body.total, 2);
});

await step('POST play 记播放次数', async () => {
  const first = await call('POST', `/api/playlists/local/${created}/play`, { songId: 'a' });
  assert.equal(first.body.playCount, 1);
  const second = await call('POST', `/api/playlists/local/${created}/play`, { songId: 'a' });
  assert.equal(second.body.playCount, 2);
});

await step('PATCH 更名', async () => {
  const { status, body } = await call('PATCH', `/api/playlists/local/${created}`, { name: '通勤歌单' });
  assert.equal(status, 200);
  assert.equal(body.playlist.name, '通勤歌单');
});

await step('PATCH 空名报 400', async () => {
  const { status } = await call('PATCH', `/api/playlists/local/${created}`, { name: '  ' });
  assert.equal(status, 400);
});

await step('收藏往返（莱茵歌单）', async () => {
  const add = await call('POST', '/api/playlists/favorites', { song: song('fav1') });
  assert.deepEqual({ favorited: add.body.favorited, existed: add.body.existed }, { favorited: true, existed: false });
  const again = await call('POST', '/api/playlists/favorites', { song: song('fav1') });
  assert.equal(again.body.existed, true, '重复收藏不新增');
  const list = await call('GET', '/api/playlists/local/favorites');
  assert.equal(list.body.total, 1);
  const off = await call('DELETE', '/api/playlists/favorites/fav1');
  assert.equal(off.body.removed, 1);
});

await step('收藏不能更名/删除（405 之外的保护）', async () => {
  const rename = await call('PATCH', '/api/playlists/local/favorites', { name: 'x' });
  assert.equal(rename.status, 404);
  const remove = await call('DELETE', '/api/playlists/local/favorites');
  assert.equal(remove.status, 404);
});

await step('未知歌单报 404', async () => {
  const { status } = await call('GET', '/api/playlists/local/nope-1234');
  assert.equal(status, 404);
});

await step('DELETE 删除歌单', async () => {
  const { status } = await call('DELETE', `/api/playlists/local/${created}`);
  assert.equal(status, 200);
  const list = await call('GET', '/api/playlists/local');
  assert.ok(!list.body.playlists.some(item => item.id === created), '删除后不再出现');
});

await step('重启后数据仍在（落盘生效）', async () => {
  const before = (await call('GET', '/api/playlists/local')).body.playlists.map(item => item.name);
  server.close(); server.closeAllConnections?.();
  const { server: restarted } = await createMusicServer({ dataDir: directory, autoScan: false, catalogs: {}, online: { search: async () => ({ provider: 'netease', query: '', offset: 0, limit: 20, total: 0, hasMore: false, tracks: [] }) } });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${restarted.address().port}/api/playlists/local`);
  const after = (await response.json()).playlists.map(item => item.name);
  restarted.close(); restarted.closeAllConnections?.();
  assert.deepEqual(after, before, '重启后歌单列表一致');
});

await fs.rm(directory, { recursive: true, force: true });
if (failures) { console.error(`\n本地歌单路由：${failures} 项失败`); process.exit(1); }
console.log('\n本地歌单路由：全部通过（新建/更名/删除/加歌去重/排序/自由排序/播放计数/收藏/错误码/持久化）');
