import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const code = await build({ entryPoints: ['src/music-song-view.ts'], bundle: true, write: false, format: 'iife', globalName: 'LyricTest' });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<div class="music-app" style="--ink:#242722;--accent:#b9652c;--muted:#777"><main></main><div id="mini"><span data-mini-lyric></span></div></div>');
  await page.addStyleTag({ content: await fs.readFile('src/music-song-view.css', 'utf8') });
  await page.addScriptTag({ content: code.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const track = { id: 'test', title: '测试歌曲', artist: '测试歌手', duration: 20, onlineSource: { provider: 'netease', id: '123', pageUrl: 'https://music.163.com/', albumTitle: '专辑' } };
    const album = { id: 'album', title: '测试歌曲', artist: '测试歌手', tracks: [track] };
    const lines = [{ time: 1, text: '你Hello 世界', translation: 'Translation', words: [
      { text: '你', start: 1, end: 2 }, { text: 'Hello ', start: 2.5, end: 4 }, { text: '世界', start: 4, end: 6 }] }, { time: 8, text: '整句歌词' }];
    const state = { transport: 'playing', playing: true, currentTrack: track, queue: [track], mode: 'order', currentTime: 1.5, duration: 20, loading: false, volume: .5 };
    let clock = 1.5, seeked;
    const view = new LyricTest.MusicSongView(document.querySelector('#mini'), t => seeked = t, () => true, () => clock);
    view.cache.set('netease:123', { at: Date.now(), lyricAt: 1, lines, info: { track, album: {}, lyrics: { original: '[00:01]你Hello 世界\n[00:08]整句歌词', translated: '', unavailable: false } } });
    document.querySelector('main').innerHTML = view.markup(album); view.mount(album, state, true);
    const original = document.querySelector('.lyric-line'), word = original.querySelector('.lyric-word');
    view.update({ ...state, playing: false, transport: 'paused' }, true);
    const half = word.style.getPropertyValue('--word-progress');
    view.update({ ...state, currentTime: 2.2 }, true);
    const gap = [...original.querySelectorAll('.lyric-word')].map(n => n.style.getPropertyValue('--word-progress'));
    view.update({ ...state, currentTime: 1.25, playing: false }, true);
    const backwards = word.style.getPropertyValue('--word-progress');
    original.click();
    view.update({ ...state, currentTime: 8.5, playing: false }, true);
    const plain = document.querySelector('.current').textContent;
    view.update(state, false); clock = 1.75;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const miniProgress = document.querySelector('[data-mini-lyric] .lyric-word').style.getPropertyValue('--word-progress');
    view.update({ ...state, playing: false }, false);
    const stopped = view.wordFrame === undefined;
    const sameNode = original === document.querySelector('.lyric-line');
    view.update({ ...state, currentTime: 1.75, playing: false }, true);
    window.lyricFixture = { view, state };
    view.dispose();
    return { half, gap, backwards, plain, seeked, miniProgress, stopped, sameNode, disposed: view.wordFrame === undefined };
  });
  assert.equal(result.half, '50.00%'); assert.deepEqual(result.gap, ['100.00%', '0.00%', '0.00%']);
  assert.equal(result.backwards, '25.00%'); assert.equal(result.seeked, 1);
  assert.equal(result.plain, '整句歌词'); assert.equal(result.miniProgress, '75.00%');
  assert.ok(result.stopped && result.sameNode && result.disposed); assert.deepEqual(errors, []);
  await fs.mkdir('artifacts/word-lyrics', { recursive: true });
  await page.screenshot({ path: 'artifacts/word-lyrics/display.png' });
  await fs.writeFile('artifacts/word-lyrics/ui-report.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log('Word lyrics UI passed', result);
} finally { await browser.close(); }
