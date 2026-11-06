import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KuwoLoginProtocol } from './kuwo-login-protocol.mjs';
import { PlatformAuth } from './platform-auth.mjs';
import { validPlatformCredential } from './platform-login-protocols.mjs';
import { KuwoCatalog } from './kuwo-protocol.mjs';
import { NeteaseSessionStore } from './netease-session.mjs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=', 'base64');
function fixture({ pollCode = 408, redirect = 'https://www.kuwo.cn/callback?res=fixture', valid = true } = {}) {
  const calls = [];
  const protocol = new KuwoLoginProtocol(async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    if (url.pathname === '/connect/qrconnect') return new Response('<img src="/connect/qrcode/fixture_qr_key">');
    if (url.pathname.startsWith('/connect/qrcode/')) return new Response(png);
    if (url.pathname === '/connect/l/qrconnect') return new Response(`window.wx_errcode=${pollCode};window.wx_code='fixture_authorization';`);
    if (url.pathname === '/US/platform/WeixinCallback.jsp') return new Response(null, { status: 302, headers: { location: 'http://i.kuwo.cn/US_NEW/kuwo/login_by_weixin_web?code=fixture_authorization&f=web' } });
    if (url.pathname === '/US_NEW/kuwo/login_by_weixin_web') return new Response(null, { status: 302, headers: { location: redirect } });
    if (url.pathname === '/callback') {
      const headers = new Headers();
      if (valid) { headers.append('set-cookie', 'userid=12345; Domain=.kuwo.cn'); headers.append('set-cookie', 'websid=fixture_session; Domain=.kuwo.cn'); }
      return new Response('<html></html>', { headers });
    }
    if (url.pathname === '/vip/v2/sysinfo') return Response.json({ meta: { code: 200 }, data: valid ? { NICKNAME: '测试酷我' } : null });
    throw Error('Unexpected fixture request');
  });
  return { protocol, calls };
}
test('official QR configuration, waiting/scanned/expired states, no SMS or password', async () => {
  for (const [pollCode, state] of [[408, 'waiting'], [404, 'scanned'], [402, 'expired'], [403, 'expired']]) {
    const { protocol, calls } = fixture({ pollCode });
    const challenge = await protocol.start();
    assert.match(challenge.image, /^data:image\/png;base64,/);
    assert.equal(calls[0].url.searchParams.get('appid'), 'wx41c1275bb3e28427');
    assert.equal((await protocol.poll(challenge)).state, state);
    assert.ok(calls.every(c => c.url.protocol === 'https:' && !/sms|password/.test(c.url.pathname)));
  }
});
test('authorized exchange follows fixed HTTPS endpoints and validates the Kuwo account', async () => {
  const { protocol, calls } = fixture({ pollCode: 405 });
  const result = await protocol.poll(await protocol.start());
  assert.equal(result.state, 'authorized'); assert.equal(result.profile.nickname, '测试酷我');
  assert.ok(validPlatformCredential('kuwo', result.credential));
  assert.equal(calls.at(-1).url.searchParams.get('sid'), 'fixture_session');
  assert.ok(calls.every(c => c.url.protocol === 'https:'));
});
test('reject foreign redirect, missing session, expired account, unsafe credentials', async () => {
  for (const redirect of ['https://example.com/callback', 'https://www.kuwo.cn@evil.invalid/callback', 'https://www.kuwo.cn/other', 'file:///callback']) {
    const { protocol } = fixture({ pollCode: 405, redirect });
    await assert.rejects(protocol.poll(await protocol.start()), /授权跳转地址/);
  }
  const { protocol } = fixture({ pollCode: 405, valid: false });
  await assert.rejects(protocol.poll(await protocol.start()), /未返回有效/);
  await assert.rejects(protocol.profile({ uid: '12345', sid: 'fixture_session' }), e => e.status === 401);
  for (const value of [{ uid: '0', sid: 'x' }, { uid: '123', sid: 'x\r\nCookie: bad' }, { uid: '123', sid: '' }]) assert.equal(validPlatformCredential('kuwo', value), false);
});
test('authentication persists only the session, restores after restart, returns no credentials, logout invalidates', async () => {
  const { protocol } = fixture({ pollCode: 405 }); let saved = {}, now = Date.now();
  const store = { file: 'isolated-fixture', load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = {}; } };
  const auth = new PlatformAuth({ provider: 'kuwo', transport: protocol, store, now: () => now });
  const challenge = await auth.start(); assert.deepEqual(Object.keys(challenge).sort(), ['expiresAt', 'id', 'image', 'state']);
  now += 1800; const result = await auth.poll(challenge.id);
  assert.equal(result.loggedIn, true); assert.equal(saved.credential.sid, 'fixture_session');
  assert.ok(!JSON.stringify(result).includes('fixture_session'));
  const restored = new PlatformAuth({ provider: 'kuwo', transport: protocol, store });
  assert.equal((await restored.status()).loggedIn, true);
  assert.equal((await restored.logout()).loggedIn, false); assert.deepEqual(saved, {});
});
test('cancellation or logout during the exchange cannot resurrect a login', async () => {
  let finish, saved = false;
  const transport = { start: async () => ({ image: 'data:image/png;base64,' + png.toString('base64') }), poll: () => new Promise(resolve => { finish = resolve; }) };
  const auth = new PlatformAuth({ provider: 'kuwo', transport, store: { load: async () => ({}), save: async () => { saved = true; }, clear: async () => {} } });
  const challenge = await auth.start(); const pending = auth.poll(challenge.id); await auth.logout();
  finish({ state: 'authorized', credential: { uid: '123', sid: 'fixture' }, profile: { userId: '123', nickname: 'fixture' } });
  assert.equal((await pending).state, 'expired'); assert.equal(saved, false); assert.equal(auth.snapshot().loggedIn, false);
});
test('account playlists and tracks paginate without exposing the session; failures are not empty success', async () => {
  const credential = { uid: '12345', sid: 'fixture_session' }, auth = { credential, epoch: 1, ready: Promise.resolve() };
  const catalog = new KuwoCatalog({ auth, fetch: async input => {
    const url = new URL(input); assert.equal(url.hostname, 'nplserver.kuwo.cn'); assert.equal(url.searchParams.get('uid'), credential.uid);
    assert.equal(url.searchParams.get('sid'), credential.sid);
    if (url.searchParams.get('op') === 'pl3_getuserlists') return Response.json({ result: 'ok', plist: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: '歌单' + i, musicnum: 123, uid: '12345' })) });
    assert.equal(url.searchParams.get('pn'), '1');
    return Response.json({ result: 'ok', total: 123, musiclist: [{ id: '123', name: '测试歌曲', artist: '歌手', album: '专辑', duration: 200 }] });
  } });
  const first = await catalog.playlists(), next = await catalog.playlists(100), songs = await catalog.playlistTracks('1', 100);
  assert.equal(first.playlists.length, 100); assert.equal(first.hasMore, true); assert.equal(next.playlists.length, 1); assert.equal(next.hasMore, false);
  assert.equal(songs.tracks[0].onlineSource.id, 'MUSIC_123'); assert.equal(songs.tracks[0].title, '测试歌曲'); assert.equal(songs.offset, 100);
  assert.ok(!JSON.stringify({ first, next, songs }).includes(credential.sid));
  await assert.rejects(new KuwoCatalog().playlists(), e => e.status === 401);
  await assert.rejects(new KuwoCatalog({ auth, fetch: async () => Response.json({ result: 'fail', errcode: 603 }) }).playlists(), /暂时无法读取/);
});
test('late playlist replies cannot replace a different account', async () => {
  const auth = { credential: { uid: '123', sid: 'fixture' }, epoch: 1, ready: Promise.resolve() };
  const catalog = new KuwoCatalog({ auth, fetch: async () => { auth.epoch++; return Response.json({ result: 'ok', plist: [] }); } });
  await assert.rejects(catalog.playlists(), e => e.status === 409);
});
test('Windows session uses the Kuwo-specific DPAPI file and preserves other data', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.resolve('../../work/kuwo-login-20261101/dpapi-' + randomUUID());
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'preserved.txt'), 'keep');
  const store = new NeteaseSessionStore(dir, 'kuwo'), value = { credential: { uid: '123', sid: 'fixture-session-private' } };
  await store.save(value); assert.deepEqual(await new NeteaseSessionStore(dir, 'kuwo').load(), value);
  assert.ok(!(await fs.readFile(store.file)).includes(Buffer.from('fixture-session-private')));
  await store.clear(); assert.equal(await fs.readFile(path.join(dir, 'preserved.txt'), 'utf8'), 'keep');
});
