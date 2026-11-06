import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMusicServer } from './music-server.mjs';
import { PlatformAuth } from './platform-auth.mjs';
import { KuwoCatalog } from './kuwo-protocol.mjs';

const dataDir = path.resolve('../../work/kuwo-login-20261101/http-fixture');
await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'lx-config.json'), '{"enabled":false}');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=';
const auth = new PlatformAuth({ provider: 'kuwo', store: { load: async () => ({}), save: async () => {}, clear: async () => {} }, transport: {
  start: async () => ({ image }), poll: async () => ({ state: 'authorized', credential: { uid: '123', sid: 'private-fixture' }, profile: { userId: '123', nickname: '酷我测试用户' } }),
  profile: async () => ({ userId: '123', nickname: '酷我测试用户' }),
} });
const catalog = new KuwoCatalog({ auth, fetch: async input => {
  const url = new URL(input);
  return Response.json(url.searchParams.get('op') === 'pl3_getuserlists'
    ? { result: 'ok', plist: [{ id: '1', title: '我的酷我歌单', musicnum: 1, uid: '123' }] }
    : { result: 'ok', total: 1, musiclist: [{ id: 123, name: '测试歌曲', artist: '测试歌手' }] });
} });
const app = await createMusicServer({ dataDir, defaultRoots: [], autoScan: false, platformAuth: { kuwo: auth }, catalogs: { kuwo: catalog } });
app.server.removeAllListeners('listening'); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const call = async (suffix, value) => {
  const res = await fetch(base + '/api/online/kuwo/' + suffix, value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {});
  return { status: res.status, body: await res.json() };
};
try {
  assert.equal((await call('auth/status')).body.loggedIn, false);
  assert.equal((await call('playlists')).status, 401);
  assert.equal((await call('auth/start')).status, 405);
  const challenge = (await call('auth/start', {})).body;
  assert.ok(challenge.image); assert.equal(challenge.key, undefined);
  const result = (await call('auth/poll', { id: challenge.id })).body;
  assert.equal(result.loggedIn, true); assert.ok(!JSON.stringify(result).includes('private-fixture'));
  const lists = (await call('playlists')).body, songs = (await call('playlists/1/tracks')).body;
  assert.equal(lists.playlists[0].name, '我的酷我歌单'); assert.equal(songs.tracks[0].title, '测试歌曲');
  assert.equal((await call('auth/logout', {})).body.loggedIn, false); assert.equal((await call('playlists')).status, 401);
  console.log(JSON.stringify({ passed: true, realServerRoutes: true, fixtureAuthorization: true, playlistIntegration: true, userDataTouched: false }));
} finally { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
