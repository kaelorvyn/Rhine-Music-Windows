import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { setPlaylistAlbums, setMusicAlbums, records, playlistRows, playlistPosition, playlistTemplate } from '../src/data.ts';
import { fileAtCell } from '../src/archive-loop.ts';

const source = await fs.readFile(new URL('../src/scene.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('scene.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const scene = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const methods = ['actualCell', 'recordAtCell'].map(name => scene.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === name).getText(tree)).join('\n');
const compiled = ts.transpileModule(`return { ${methods} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function fixture(total) {
  setPlaylistAlbums([{ id: 'pending', title: 'Playlist', artist: '', genreId: '', rawGenres: [], folder: '', tracks: [], producers: [],
    playlistCell: { playlistId: 'test', provider: 'local', playlistIndex: 0, playlistName: 'Playlist', songIndex: 0, total } }], ['Playlist']);
  const instance = new Function('records', 'playlistRows', 'playlistPosition', 'playlistTemplate', 'fileAtCell', 'playlistCoverPreload', compiled)(
    records, playlistRows, playlistPosition, playlistTemplate, fileAtCell,
    { coverAt: (_provider, _id, song) => `/api/cached-cover/${song}` });
  instance.placeholderPrints = new Map(); return instance;
}
try {
  const instance = fixture(50000);
  assert.equal(records.length, 1, 'A large playlist does not allocate one record/model per unknown song');
  for (let row = -100; row < 1600; row++) {
    const cell = { lane: 2, row }, position = playlistPosition(cell.lane, cell.row);
    assert.equal(instance.actualCell(cell), true, 'Unloaded pages retain physical geometry');
    assert.equal(instance.recordAtCell(cell).album.coverUrl, `/api/cached-cover/${position.songIndex}`);
  }
  assert.equal(instance.placeholderPrints.size, 1024, 'Fallback prints have a bounded cache');
  const empty = fixture(0);
  assert.equal(empty.actualCell({ lane: 2, row: 12 }), false);
  console.log('Playlist placeholders: 50000 logical positions, one loaded record, cached cover lookup, bounded prints, loop seams and empty playlists passed.');
} finally { setMusicAlbums([]); }


const app = await fs.readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const appTree = ts.createSourceFile('music-app.ts', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const rebuild = appTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'rebuildPlaylistGrid').getText(appTree);
const body = ts.transpileModule(`let playlistRebuildPending = false; ${rebuild}; return rebuildPlaylistGrid().then(() => playlistRebuildPending);`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
for (const [active, preparing] of [[true, false], [false, true]]) {
  assert.equal(await new Function('boot', 'startupAccountsPending', body)({ active }, preparing), true,
    'Playlist arrivals never rebuild the wall during either startup animation');
}
console.log('Startup playlist structure is deferred until animation handoff.');
