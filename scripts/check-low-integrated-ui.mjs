import fs from 'node:fs/promises';
let source=await fs.readFile(new URL('./check-entry-handoff-ui.mjs',import.meta.url),'utf8');
for(const name of ['esbuild','playwright'])source=source.replace(`from '${name}'`,`from '${import.meta.resolve(name)}'`);
source=source.replace("from './cover-cache.mjs'",`from '${new URL('./cover-cache.mjs',import.meta.url)}'`)
 .replace("const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : ''))","const out = path.resolve('artifacts/low-integrated')")
 .replace("response.writeHead(503); json", "response.statusCode=503; json")
 .replace("artist: 'Fixture', album: 'Test', duration: 120,", "artist: 'Fixture', album: 'Test', duration: 120, browserPlayable:true, format:'WAV',")
 .replace("provider: 'qq', id: 's'", "provider: 'qq',pageUrl:'https://example.invalid/song', id: 's'")
 .replace("if (route.startsWith('/api/')) {",`if(route==='/api/audio/capabilities'){json({devices:[],nativeAvailable:false,decoderAvailable:false});return;}
 if(route.includes('/prepare/')){json({audioUrl:'/fixture.wav'});return;}
 if(route.endsWith('/info')){response.statusCode=503;json({error:'fixture metadata unavailable'});return;}
 if(route==='/fixture.wav'){
   const length=8000*900*2,bytes=Buffer.alloc(44+length);bytes.write('RIFF');bytes.writeUInt32LE(36+length,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(length,40);
   response.setHeader('Content-Type','audio/wav');response.end(bytes);return;
 } if (route.startsWith('/api/')) {`)
 .replace('const update = ArchiveScene.prototype.update;',`const rebuild=ArchiveScene.prototype.rebuildGraphics;
 const play=MusicPlayer.prototype.play;MusicPlayer.prototype.play=function(...args){window.testPlayer=this;return play.apply(this,args);};
 ArchiveScene.prototype.rebuildGraphics=async function(...args){window.lowScene=this;
   if(window.failGraphics){window.failGraphics--;await rebuild.apply(this,args);throw Error('injected failure after GPU replacement');}
   return rebuild.apply(this,args);};
 const update = ArchiveScene.prototype.update;`)
 .replace('if (state.navigation) return value;',`if(args[1]?.musicIntro && args[2]!==false && document.querySelector('.music-app')?.dataset.musicBoot==='running'){
   (window.introSamples??=[]).push({at:performance.now(),covers:this.covers?.getStats().visibleReady,pool:this.cells.length});
 } if (state.navigation) return value;`)
 // A returning album is intentionally removed from the array and drawn as its
 // original physical group. Track that owner too, rather than flagging its
 // zeroed array slot as a missing box during a natural track change.
 .replace('const m = new THREE.Matrix4().fromArray(this.instanceBudget.pool, slot * 16);',`const returning=this.outgoing.find(item=>item.cell.lane===cell.lane && item.cell.row===cell.row);
    const m=returning ? returning.group.matrixWorld : new THREE.Matrix4().fromArray(this.instanceBudget.pool,slot*16);`)
 .replace('if (!listed.has(slot)) absent++;','if (!listed.has(slot) && !returning) absent++;')
 .replace('if (previous?.owner === owner && previous.ready && !ready) readyDrops++;','if (!returning && previous?.owner === owner && previous.ready && !ready) readyDrops++;');
source=source.slice(0,source.indexOf('const page = await browser.newPage({ viewport:'))+`
const page=await browser.newPage({viewport:{width:1680,height:960}}),errors=[];
page.on('pageerror',error=>{errors.push(error.stack);console.log(error.stack);});
try{
 await page.addInitScript(()=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:'lowIntegrated',qualityMode:'manual',qualityPipelineVersion:5,frameRate:60,bgm:false,sound:false})));
 await page.goto('http://127.0.0.1:'+server.address().port+'/'+(process.argv.includes('--film')?'':'?scene=archive'));await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done'||document.querySelector('.rhine-loading')?.dataset.state==='error',null,{timeout:90000});
 if(await page.locator('.rhine-loading[data-state="error"]').count())throw Error(await page.locator('.opening-status').textContent());
 home=true;releaseCovers();
 await page.waitForTimeout(1000);
 await page.screenshot({path:path.join(out,'low-home.png')});
 const initial=await page.evaluate(()=>rhineMusic.stats());
 if(process.argv.includes('--film')){const intro=await page.evaluate(()=>window.introSamples);assert.ok(intro?.length>10);assert.ok(intro[0].covers>0);await fs.writeFile(path.join(out,'intro.json'),JSON.stringify(intro));}
 assert.deepEqual(initial.passes,['RenderPass','OutputPass','CoverClarityPass']);
 assert.equal(initial.graphics.canvasAntialias,false);assert.equal(initial.covers.tileWidth,128);
 assert.equal(initial.covers.cacheLimitBytes,128*1024**2);assert.ok(initial.optimization.shelfGlass.trianglesPerCase<=200);
 await page.locator('#play-pause').click();
 await page.waitForTimeout(2000);
 console.log('Audio start',JSON.stringify(await page.evaluate(()=>({playing:rhineMusic.player.playing,error:rhineMusic.player.error,time:rhineMusic.player.currentTime}))));
 await page.waitForFunction(()=>rhineMusic.player.playing&&rhineMusic.player.currentTime>0);
 const track=await page.evaluate(()=>rhineMusic.player.currentTrack.id),audioStart=await page.evaluate(()=>rhineMusic.player.currentTime);
 assert.deepEqual(errors,[]);
 await page.locator('[data-action="settings"]').first().click();
 await page.locator('[data-category="display"]').click();
 const count=process.argv.includes('--interaction-only')?4:process.argv.includes('--quick')?2:10;
 const switches=[];
 for(let i=0;i<count;i++){
  const target=i%2===0?'balanced':'lowIntegrated';
  await page.locator('#quality-preset').selectOption(target);
  await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:60000});
  await page.waitForTimeout(200);
  const stats=await page.evaluate(()=>rhineMusic.stats());console.log(JSON.stringify({switch:i,target,pipeline:stats.pipeline,graphics:stats.graphics,covers:stats.covers?.atlasBytes}));
  assert.equal(stats.pipeline,target==='balanced'?'standard':'lowIntegrated');
  assert.equal(stats.optimization.aoKernelSamples,target==='balanced'?8:0);
  assert.equal(await page.locator('#three-scene canvas').count(),1);
  assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>rhineMusic.player.currentTrack.id),track);
  assert.equal(await page.evaluate(()=>rhineMusic.player.playing),true);
  switches.push({target,graphics:stats.graphics,atlasBytes:stats.covers.atlasBytes,selected:stats.selectedAlbumId});
 }
 assert.ok(await page.evaluate(()=>rhineMusic.player.currentTime)>audioStart+1,'the real music player keeps progressing throughout graphics replacement');
 if(!process.argv.includes('--quick')){
  if(!process.argv.includes('--interaction-only')){
   await page.locator('#quality-preset').selectOption('balanced');
   await page.waitForSelector('.graphics-preparation');
   await page.evaluate(()=>testPlayer.song.dispatchEvent(new Event('ended')));
   await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:90000});
   await page.waitForFunction(()=>rhineMusic.player.currentTrack?.id==='s1'&&rhineMusic.selectedAlbum.playlistCell.songIndex===1);
   await page.locator('#quality-preset').selectOption('lowIntegrated');
   await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:90000});
   await page.evaluate(()=>window.failGraphics=1);
   await page.locator('#quality-preset').selectOption('balanced');
   await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:90000});
   assert.equal(await page.evaluate(()=>rhineMusic.stats().pipeline),'lowIntegrated','failure after allocation rolls back');
   await page.evaluate(()=>window.failGraphics=2);
   await page.locator('#quality-preset').selectOption('balanced');
   await page.getByRole('button',{name:'恢复原画质',exact:true}).waitFor({timeout:90000});
   await page.getByRole('button',{name:'恢复原画质',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:90000});
   assert.equal(await page.locator('#music-panel-root').getAttribute('inert'),null);
   assert.equal(await page.evaluate(()=>rhineMusic.stats().pipeline),'lowIntegrated');
   // Latest request wins even when a request arrives during allocation.
   await page.locator('#quality-preset').selectOption('balanced');await page.waitForSelector('.graphics-preparation');
   await page.locator('#quality-preset').evaluate(el=>{el.value='lowIntegrated';el.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.waitForFunction(()=>!document.querySelector('.graphics-preparation')&&rhineMusic.stats().pipeline==='lowIntegrated',null,{timeout:90000});
   // Observe a fresh generation after the intentional context-loss exercises.
   await page.evaluate(()=>{continuity.frames=[];continuity.faults=[];continuity.seen.clear();continuity.roiSeen=false;continuity.first=null;});
   await page.waitForTimeout(30500);
   const continuityResult=await page.evaluate(()=>({frames:continuity.frames.length,faults:continuity.faults,roiSeen:continuity.roiSeen}));
   await fs.writeFile(path.join(out,'continuity.json'),JSON.stringify(continuityResult,null,2));
   assert.equal(continuityResult.faults.length,0,JSON.stringify(continuityResult.faults.slice(0,3)));assert.ok(continuityResult.frames>100);assert.ok(continuityResult.roiSeen);
  }
   await page.evaluate(()=>continuity.navigation=true);
   await page.locator('[data-action="close-panel"]').click();await page.waitForTimeout(500);
   if(await page.evaluate(()=>rhineMusic.selectedAlbum.playlistCell.songIndex)!==0){await page.locator('[data-action="prev"]').first().click();await page.waitForFunction(()=>rhineMusic.selectedAlbum.playlistCell.songIndex===0);}
   await page.locator('[data-action="prev"]').first().click();
   await page.waitForFunction(()=>rhineMusic.selectedAlbum.playlistCell.songIndex===199);
   await page.locator('[data-action="next"]').first().click();await page.waitForFunction(()=>rhineMusic.selectedAlbum.playlistCell.songIndex===0);
   await page.locator('.open-album').click();await page.waitForFunction(()=>rhineMusic.presentation.phase==='detail');
   await page.locator('.music-back').click();await page.waitForFunction(()=>rhineMusic.presentation.phase==='archive');
   await page.locator('[data-action="settings"]').first().click();await page.locator('[data-category="personalization"]').click();
   for(const theme of ['night','dusk','day']){await page.locator('[data-theme="'+theme+'"]').click();await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>rhineMusic.stats().theme),theme);await page.screenshot({path:path.join(out,theme+'.png')});}
 }
 await fs.writeFile(path.join(out,'report-'+scenario+(process.argv.includes('--film')?'-film':'')+(process.argv.includes('--interaction-only')?'-interaction':'')+'.json'),JSON.stringify({initial,switches,full:count===10,audio:{track,start:audioStart,end:await page.evaluate(()=>rhineMusic.player.currentTime)},origins,errors},null,2));
 await fs.writeFile(path.join(out,'errors.json'),JSON.stringify(errors));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.json'),JSON.stringify(await page.evaluate(()=>({stats:rhineMusic.stats(),presentation:rhineMusic.presentation,selected:rhineMusic.selectedAlbum?.playlistCell})),null,2));throw error;}
finally{releaseCovers();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
try{await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}catch(error){console.error(error.message);process.exitCode=1;}
