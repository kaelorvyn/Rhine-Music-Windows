// Reuse the real-app fixture and GPU continuity instrumentation; keep test hooks out of production.
import fs from 'node:fs/promises';
const dataReady = process.argv.includes('--data-ready');
let fixture = await fs.readFile(new URL('./check-entry-handoff-ui.mjs', import.meta.url), 'utf8');
for (const name of ['esbuild', 'playwright']) fixture = fixture.replace(`from '${name}'`, `from '${import.meta.resolve(name)}'`);
fixture = fixture.replace("from './cover-cache.mjs'", `from '${new URL('./cover-cache.mjs', import.meta.url)}'`);
fixture = fixture.replace("const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : ''))", `const out = path.resolve('${dataReady ? 'artifacts/startup-data-ready-gate' : 'artifacts/startup-gate'}')`);
fixture = fixture.replace('const update = ArchiveScene.prototype.update;', `
import { MusicEntry } from './src/music-entry.ts';
import { EntryFilm } from './src/music-entry-film.ts';
window.gate = { events: [], film: [], prepare: [] };
const note = kind => gate.events.push({kind,at:performance.now(),state:document.querySelector('.rhine-loading')?.dataset.state});
for (const method of ['startPreparation','completeLoading','skip','fail','dispose']) {
 const original = MusicEntry.prototype[method];
 MusicEntry.prototype[method] = function(...args) { note(method+':before'); const value=original.apply(this,args); note(method+':after'); return value; };
}
const filmUpdate = EntryFilm.prototype.update;
EntryFilm.prototype.update = function(time) { gate.film.push({time,at:performance.now()}); return filmUpdate.call(this,time); };
const prepare = ArchiveScene.prototype.prepareMusicRenderer;
ArchiveScene.prototype.prepareMusicRenderer = async function(...args) {
 note('prepare:begin');
 if (location.search.includes('slow=1')) await new Promise(resolve=>setTimeout(resolve,3500));
 const update = this.update;
 this.update = function(...args) { const t=performance.now(), value=update.apply(this,args); gate.prepare.push({render:args[2]!==false,ms:performance.now()-t}); return value; };
 try { return await prepare.apply(this,args); } finally { this.update=update; note('prepare:end'); }
};
const update = ArchiveScene.prototype.update;`);
fixture = fixture.replace('const browser = await chromium.launch(', 'const userDataDir = await fs.mkdtemp(path.join(out,"profile-"));\nlet browser = await chromium.launchPersistentContext(userDataDir, ');
fixture = fixture.replace('headless: true, args:', 'headless: true, viewport: { width:1680,height:960 }, args:');
const tail = fixture.indexOf('const page = await browser.newPage({ viewport:');
if (tail < 0) throw Error('Fixture changed: missing test boundary');
fixture = fixture.slice(0, tail) + `
const reports = [];
for (const page of browser.pages()) await page.close();
try {
 for (const mode of ['first','parallel','skip']) {
  if (mode!=='first') browser=await chromium.launchPersistentContext(userDataDir,{headless:true,viewport:{width:1680,height:960},args:['--use-angle=d3d11','--force_high_performance_gpu']});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:'balanced',qualityMode:'manual',qualityPipelineVersion:5,frameRate:60,bgm:false,sound:false,arrayMode:'filled'})));
  const began=Date.now();
  await page.goto('http://127.0.0.1:'+server.address().port+'/?scheduler=1'+(mode==='skip'?'&slow=1':''));
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForFunction(()=>gate.events.some(e=>e.kind==='startPreparation:after'));
  const initial=await page.locator('.rhine-loading').getAttribute('data-state');
  assert.equal(initial,mode==='first'?'preparing':'playing');
  if(mode==='first') {
   await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
   assert.equal(await page.locator('.rhine-loading').getAttribute('data-state'),'preparing');
   assert.equal(await page.locator('.opening-skip').isVisible(),false);
   assert.equal(await page.locator('.opening-notice').isVisible(),true);
   assert.equal(await page.evaluate(()=>gate.film.length),0);
   await page.screenshot({path:path.join(out,'first-preparation.png')});
  }
  if(mode==='skip') {
   await page.locator('.opening-skip').click();
   assert.equal(await page.locator('.rhine-loading').getAttribute('data-state'),'waiting');
   assert.equal(await page.locator('.opening-skip').isVisible(),false);
   await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
   await page.waitForTimeout(1000);
   assert.equal(await page.locator('.rhine-loading').getAttribute('data-state'),'waiting');
   assert.equal(await page.evaluate(()=>document.querySelector('#stage').inert),true);
   await page.screenshot({path:path.join(out,'skip-waiting.png')});
  }
  await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done',null,{timeout:120000});
  home=true;releaseCovers();
  await page.waitForTimeout(${dataReady ? "mode==='first'?30500:1500" : "1500"});
  const result=await page.evaluate(()=>({events:gate.events,film:gate.film,draws:gate.prepare,mode:document.querySelector('.music-app').dataset.startupPreparationMode,
    preparation:JSON.parse(document.querySelector('#three-scene').dataset.startupPreparation),faults:continuity.faults,roiSeen:continuity.roiSeen,
    marker:!!localStorage.getItem('rhine-graphics-prepared'),selectedTrack:rhineMusic.selectedAlbum?.tracks[0]?.title,blocked:document.querySelector('#stage').inert}));
  const prepEnd=result.events.find(e=>e.kind==='prepare:end').at;
  const firstFilm=result.film[0].at, finalFilm=result.film.at(-1).at;
  if(mode==='first')assert.ok(firstFilm>=prepEnd,'first film cannot start during graphics preparation');
  else assert.ok(firstFilm<result.events.find(e=>e.kind==='prepare:begin').at,'later preparation overlaps the film');
  if(mode==='parallel')assert.ok(prepEnd<finalFilm,'warm preparation completes before the unchanged film ends');
  assert.equal(result.mode,mode==='first'?'first':'parallel');
  assert.equal(result.marker,true); assert.equal(result.blocked,false); assert.deepEqual(errors,[]);assert.deepEqual(result.faults,[]);
  assert.equal(result.selectedTrack,'Song 0','the first visible view has actual song data');
  const gaps=result.film.slice(1).map((f,i)=>f.at-result.film[i].at).sort((a,b)=>a-b);
  const report={mode,elapsed:Date.now()-began,errors,filmStart:firstFilm,filmEnd:finalFilm,filmSeconds:result.film.at(-1).time,
   maxFilmGap:gaps.at(-1),p95FilmGap:gaps[Math.floor(gaps.length*.95)],...result};
  reports.push(report);await fs.writeFile(path.join(out,mode+'.json'),JSON.stringify(report,null,2));
  await page.screenshot({path:path.join(out,mode+'-home.png')});
  console.log(JSON.stringify({mode,elapsed:report.elapsed,preparation:result.preparation.milliseconds,filmSeconds:report.filmSeconds,maxFilmGap:report.maxFilmGap,p95FilmGap:report.p95FilmGap,draws:result.draws,errors}));
  await page.waitForTimeout(2000);await browser.close();
 }
 await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(reports.map(({film,...r})=>r),null,2));
}finally{releaseCovers();await browser.close().catch(()=>{});await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
// Data-URL module import errors otherwise dump a huge encoded URL in the console.
try { await import('data:text/javascript;base64,' + Buffer.from(fixture).toString('base64')); }
catch(error) { console.error(error.message); process.exitCode=1; }
