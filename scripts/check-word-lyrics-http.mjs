import { createMusicServer } from './music-server.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = await fs.mkdtemp(new URL('../../../work/word-lyrics-http-', import.meta.url));
await fs.writeFile(new URL('lx-config.json', 'file:///' + directory.replaceAll('\\', '/') + '/'), '{"enabled":false}');
await fs.writeFile(new URL('backup-sources-config.json', 'file:///' + directory.replaceAll('\\', '/') + '/'), '{"enabled":false,"sources":[]}');
const info = original => ({ track: { id: 'test' }, album: {}, lyrics: { original, translated: '', unavailable: false, instrumental: false } });
let searches = 0;
const { server } = await createMusicServer({ dataDir: directory, autoScan: false,
  online: { songInfo: async id => info(id === '123' ? '[1000,2000](1000,2000,0)歌词' : '[00:01]整句'), auth: { status: async () => ({ loggedIn: false }) } },
  catalogs: { kuwo: { search: async () => { searches++; return { tracks: [] }; } } },
});
server.removeAllListeners('listening'); // Synthetic route test: no background platform probes.
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = 'http://127.0.0.1:' + server.address().port;
  const timed = await (await fetch(base + '/api/online/netease/songs/123/info')).json();
  assert.equal(timed.lyrics.wordLines[0].words[0].end, 3);
  assert.equal(timed.lyrics.original, '[00:01.000]歌词');
  const filled = await (await fetch(base + '/api/lyrics?provider=netease&id=123&title=test')).json();
  assert.equal(filled.wordLines[0].words[0].text, '歌词');
  const ordinary = await (await fetch(base + '/api/lyrics?provider=netease&id=124&title=test')).json();
  assert.equal(ordinary.original, '[00:01]整句'); assert.equal(ordinary.wordLines, undefined); assert.equal(searches, 0);
  console.log('Word lyric HTTP routes and source preference passed');
} finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
