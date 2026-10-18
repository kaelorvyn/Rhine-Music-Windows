// 本地歌单存储（本地歌单能力）的单元测试。
// 覆盖：CRUD 往返、去重、排序规则、收藏、损坏恢复、上限、边界输入。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalPlaylists, sortSongs, MAX_PLAYLISTS } from './local-playlists.mjs';

const song = (id, extra = {}) => ({ id, title: `曲目 ${id}`, artist: '歌手', album: '专辑', provider: 'kugou', onlineSourceId: `${id}.1`, duration: 200, ...extra });
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rhine-playlists-'));

test('新建歌单：留空用默认名称，创建后可读回', async () => {
  const dir = await temp();
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  const playlist = store.create('');
  assert.equal(playlist.name, '新歌单 1', '留空时用默认名称');
  store.create('  我的歌单  ');
 // 用户要求：莱茵歌单（收藏）垫底，不再抢在自建歌单前面；自建歌单最近的在前。
  assert.deepEqual(store.summary().map(item => item.name), ['我的歌单', '新歌单 1', '莱茵歌单'],
    '自建歌单在前（最近的在前），收藏固定排在最后');
  await store.save();
  const reopened = await new LocalPlaylists({ dataDir: dir }).init();
  assert.deepEqual(reopened.summary().map(item => item.name), ['我的歌单', '新歌单 1', '莱茵歌单'], '重启后歌单还在');
});

test('加歌去重：重复曲目计入 skipped，并报 allExist', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  const { id } = store.create('测试');
  assert.deepEqual(store.addSongs(id, [song('a'), song('b'), song('a')]), { added: 2, skipped: 1, total: 2, allExist: false });
  assert.deepEqual(store.addSongs(id, [song('a')]), { added: 0, skipped: 1, total: 2, allExist: true }, '全是重复时 allExist 为真');
  assert.equal(store.songs(id).total, 2);
});

test('元数据快照：在线歌的身份信息随歌单一起保存', async () => {
  const dir = await temp();
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  const { id } = store.create('快照');
  store.addSongs(id, [{ id: 'kugou-HASH.42', title: '晴天', artist: '周杰伦', album: '叶惠美', provider: 'kugou', onlineSourceId: 'HASH.42', duration: 269 }]);
  await store.save();
  const reopened = await new LocalPlaylists({ dataDir: dir }).init();
  const [track] = reopened.songs(id).tracks;
  assert.equal(track.title, '晴天');
  assert.equal(track.artist, '周杰伦');
  assert.equal(track.provider, 'kugou');
  assert.equal(track.onlineSourceId, 'HASH.42', '在线音源标识保留，重放时据此重新取址');
  assert.equal(track.duration, 269);
});

test('排序规则：添加时间/艺术家/播放次数/名称/平台/音质 + 升降序', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  const { id } = store.create('排序');
  store.addSongs(id, [
 // 艺术家刻意不按插入顺序排列，确保排序真的生效（阿 < 波 < 册）。
    song('a', { title: 'C', artist: '波', provider: 'kugou', addedAt: 300, playCount: 1, qualityRank: 1 }),
    song('b', { title: 'A', artist: '阿', provider: 'netease', addedAt: 100, playCount: 9, qualityRank: 3 }),
    song('c', { title: 'B', artist: '册', provider: 'kuwo', addedAt: 200, playCount: 5, qualityRank: 2 }),
  ]);
  const ids = options => store.songs(id, options).tracks.map(track => track.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c'], '默认保持手工次序');
  assert.deepEqual(ids({ sort: 'addedAt' }), ['b', 'c', 'a'], '按添加时间升序');
  assert.deepEqual(ids({ sort: 'addedAt', direction: 'descending' }), ['a', 'c', 'b'], '按添加时间降序');
  assert.deepEqual(ids({ sort: 'playCount' }), ['a', 'c', 'b'], '按播放次数升序');
  assert.deepEqual(ids({ sort: 'name' }), ['b', 'c', 'a'], '按名称升序（A/B/C）');
  assert.deepEqual(ids({ sort: 'artist' }), ['b', 'a', 'c'], '按艺术家升序（阿/波/册）');
  assert.deepEqual(ids({ sort: 'platform' }), ['a', 'c', 'b'], '按平台升序（kugou/kuwo/netease）');
  assert.deepEqual(ids({ sort: 'quality', direction: 'descending' }), ['b', 'c', 'a'], '按最高音质降序');
});

test('排序不改磁盘次序：规则只影响展示', async () => {
  const dir = await temp();
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  const { id } = store.create('只读排序');
  store.addSongs(id, [song('a', { playCount: 1 }), song('b', { playCount: 9 })]);
  store.songs(id, { sort: 'playCount', direction: 'descending' });
  await store.save();
  const reopened = await new LocalPlaylists({ dataDir: dir }).init();
  assert.deepEqual(reopened.songs(id).tracks.map(track => track.id), ['a', 'b'], '展示排序没写回磁盘');
});

test('自由排序：给定次序生效，未列出的接在后面', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  const { id } = store.create('自由');
  store.addSongs(id, [song('a'), song('b'), song('c')]);
  store.reorder(id, ['c', 'a']);
  assert.deepEqual(store.songs(id).tracks.map(track => track.id), ['c', 'a', 'b']);
});

test('收藏：莱茵歌单去重、可取消、可查询', async () => {
  const dir = await temp();
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  assert.deepEqual(store.favorite(song('x')), { favorited: true, existed: false, total: 1 });
  assert.deepEqual(store.favorite(song('x')), { favorited: true, existed: true, total: 1 }, '重复收藏不新增');
  assert.equal(store.isFavorite('x'), true);
  await store.save();
  const reopened = await new LocalPlaylists({ dataDir: dir }).init();
  assert.equal(reopened.isFavorite('x'), true, '收藏重启后还在');
  assert.deepEqual(reopened.unfavorite('x'), { favorited: false, removed: 1, total: 0 });
  assert.equal(reopened.isFavorite('x'), false);
});

test('保护：收藏不能重命名/删除，未知歌单报 404', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  assert.throws(() => store.rename('favorites', '改名'), /不能重命名/);
  assert.throws(() => store.remove('favorites'), /不能删除/);
  assert.throws(() => store.songs('nope'), error => error.status === 404);
  assert.throws(() => store.rename('nope', 'x'), error => error.status === 404);
  assert.throws(() => store.addSongs('nope', [song('a')]), error => error.status === 404);
  assert.throws(() => store.removeSongs('nope', ['a']), error => error.status === 404);
});

test('空名称与超长名称：空名拒绝，超长截断', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  const { id } = store.create('起点');
  assert.throws(() => store.rename(id, '   '), /不能为空/);
  const long = store.rename(id, '长'.repeat(500));
  assert.equal(long.name.length, 100, '名称截断到 100 字符');
});

test('移除歌曲与播放计数', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  const { id } = store.create('计数');
  store.addSongs(id, [song('a'), song('b')]);
  assert.deepEqual(store.countPlay(id, 'a'), { playCount: 1 });
  assert.deepEqual(store.countPlay(id, 'a'), { playCount: 2 });
  assert.deepEqual(store.removeSongs(id, ['a']), { removed: 1, total: 1 });
  assert.deepEqual(store.removeSongs(id, ['zzz']), { removed: 0, total: 1 });
});

test('歌单数量上限', async () => {
  const store = await new LocalPlaylists({ dataDir: await temp() }).init();
  for (let index = 0; index < MAX_PLAYLISTS; index++) store.create(`歌单 ${index}`);
  assert.equal(store.summary().length, MAX_PLAYLISTS + 1, '含收藏共 501 条');
  assert.throws(() => store.create('超额'), /最多只能建/);
});

test('损坏文件：保留现场并以空歌单启动', async () => {
  const dir = await temp();
  await fs.writeFile(path.join(dir, 'playlists.json'), '{ 这不是 JSON');
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  assert.equal(store.summary().length, 1, '只剩收藏，服务照常起');
  assert.ok(store.corruptBackup, '损坏文件已改名保留');
  const files = await fs.readdir(dir);
  assert.ok(files.some(name => name.includes('.corrupt-')), '磁盘上留有现场');
});

test('并发写盘：最终文件是最后一个快照', async () => {
  const dir = await temp();
  const store = await new LocalPlaylists({ dataDir: dir }).init();
  const { id } = store.create('并发');
  store.addSongs(id, [song('a')]);
  const first = store.save();
  store.addSongs(id, [song('b')]);
  await Promise.all([first, store.save()]);
  const reopened = await new LocalPlaylists({ dataDir: dir }).init();
  assert.equal(reopened.songs(id).total, 2, '没有丢更新，也没有留下半截文件');
});

test('sortSongs 对未知规则原样返回，不改入参', () => {
  const input = [song('a'), song('b')];
  const output = sortSongs(input, 'nope');
  assert.deepEqual(output.map(item => item.id), ['a', 'b']);
  assert.notEqual(output, input, '返回新数组，不改调用方数据');
});
