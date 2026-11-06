import fs from 'node:fs/promises';
let source=await fs.readFile(new URL('./check-entry-handoff-ui.mjs',import.meta.url),'utf8');
for(const name of ['esbuild','playwright'])source=source.replace(`from '${name}'`,`from '${import.meta.resolve(name)}'`);
source=source.replace("from './cover-cache.mjs'",`from '${new URL('./cover-cache.mjs',import.meta.url)}'`)
 .replace("const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : ''))","const out = path.resolve('artifacts/music-drag')")
 .replace('const value = update.apply(this, args), state = window.continuity;','const value = update.apply(this, args), state = window.continuity; window.dragScene=this;')
 .replace('const stop = MusicPlayer.prototype.stop;',`const play=MusicPlayer.prototype.play;MusicPlayer.prototype.play=function(...args){window.dragPlayer=this;return play.apply(this,args);};const stop = MusicPlayer.prototype.stop;`)
 .replace('response.writeHead(503); json','response.statusCode=503; json')
 .replace("artist: 'Fixture', album: 'Test', duration: 120,", "artist: 'Fixture', album: 'Test', duration: 120,browserPlayable:true,format:'WAV',")
 .replace("provider: 'qq', id: 's'", "provider:'qq',pageUrl:'https://example.invalid/song',id:'s'")
 .replace("[{ id: 'test', name: 'Test', trackCount: 200 }]", "[{id:'test',name:'First',trackCount:12},{id:'second',name:'Second',trackCount:200}]")
 .replace("route === '/api/online/qq/playlists/test/tracks'", "/^\\/api\\/online\\/qq\\/playlists\\/(test|second)\\/tracks$/.test(route)")
 .replace('json({ total: 200, tracks:', "json({total:route.includes('/second/')?200:12,tracks:")
 .replace('Math.min(50, 200 - offset)',"Math.max(0,Math.min(50,(route.includes('/second/')?200:12)-offset))")
 .replace("if (route.startsWith('/api/')) {",`if(route==='/api/audio/capabilities'){json({devices:[],nativeAvailable:false,decoderAvailable:false});return;}
 if(route.endsWith('/info')){response.statusCode=503;json({error:'fixture'});return;}
 if(route.includes('/prepare/')){json({audioUrl:'/fixture.wav'});return;}
 if(route==='/fixture.wav'){const size=16000*300,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);response.setHeader('Content-Type','audio/wav');response.end(b);return;}
 if (route.startsWith('/api/')) {`);
source=source.slice(0,source.indexOf('const page = await browser.newPage({ viewport:'))+`
const portrait=process.argv.includes('--portrait'),viewport=portrait?{width:430,height:900}:{width:1680,height:960};
const page=await browser.newPage({viewport,hasTouch:true}),errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
const pipeline=process.argv.includes('--standard')?'balanced':'lowIntegrated';
await page.addInitScript(p=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:p,qualityMode:'manual',qualityPipelineVersion:5,frameRate:60,bgm:false,sound:false})),pipeline);
try{
 await page.goto('http://127.0.0.1:'+server.address().port+'/?scene=archive');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done',null,{timeout:90000});home=true;releaseCovers();
 await page.evaluate(()=>continuity.navigation=true);
 await page.waitForTimeout(1000);
 await page.locator('#play-pause').click();await page.waitForFunction(()=>rhineMusic.player.playing&&rhineMusic.player.currentTime>0);
 const audioStart=await page.evaluate(()=>rhineMusic.player.currentTime);let track=await page.evaluate(()=>rhineMusic.player.currentTrack.id);
 const start=await page.evaluate(()=>rhineMusic.stats());console.log('READY',pipeline,start.selectedCell);
 const vector=await page.evaluate(()=>dragScene.musicBrowseBasis.row);
 const p=portrait?{x:viewport.width*.65,y:viewport.height*.4}:{x:850,y:420};
 await page.mouse.move(p.x,p.y);await page.mouse.down();
 await page.mouse.move(p.x-vector.x*2.5,p.y-vector.y*2.5,{steps:8});await page.waitForTimeout(60);
 const held=await page.evaluate(()=>rhineMusic.stats());console.log('HELD',held.browsePosition,held.browseDrag);
 assert.ok(held.browseDrag);assert.ok(Math.abs(held.browsePosition.row-start.browsePosition.row-2.5)<.08,'shelf follows before pointerup, including fractional rows');
 assert.equal(held.selectedAlbumId,start.selectedAlbumId);assert.equal(held.returningFiles,0);
 assert.equal(await page.locator('#selection-title').getAttribute('title'),'Song '+((Math.round(held.browsePosition.row)-12+1200)%12),'title previews the nearest cached song without committing selection');
 await page.evaluate(()=>dragPlayer.song.dispatchEvent(new Event('ended')));await page.waitForFunction(()=>rhineMusic.player.currentTrack.id==='s1'&&rhineMusic.player.playing);
 assert.equal(await page.evaluate(()=>rhineMusic.stats().selectedAlbumId),start.selectedAlbumId,'natural playback advance cannot take the shelf away from a held finger');
 track=await page.evaluate(()=>rhineMusic.player.currentTrack.id);
 await page.mouse.move(p.x-vector.x*.5,p.y-vector.y*.5,{steps:5});await page.waitForTimeout(40);
 const reversed=await page.evaluate(()=>rhineMusic.stats().browsePosition.row);assert.ok(reversed<held.browsePosition.row);
 for(let i=1;i<=6;i++){await page.mouse.move(p.x-vector.x*(.5+i),p.y-vector.y*(.5+i));await page.waitForTimeout(12);}
 const released=await page.evaluate(()=>rhineMusic.stats().browsePosition.row);await page.mouse.up();await page.waitForTimeout(150);
 const inertial=await page.evaluate(()=>rhineMusic.stats().browsePosition.row);assert.ok(inertial>released+.05,'release keeps moving forward');
 await page.locator('#play-pause').click();await page.waitForFunction(()=>!rhineMusic.player.playing,null,{timeout:3000});
 await page.locator('#play-pause').click();await page.waitForFunction(()=>rhineMusic.player.playing,null,{timeout:3000});
 // Grab the moving shelf: its continuous coordinate must stop under the finger.
 await page.mouse.move(p.x,p.y);await page.mouse.down();await page.waitForTimeout(50);const grabbed=await page.evaluate(()=>rhineMusic.stats().browsePosition.row);
 await page.waitForTimeout(100);assert.ok(Math.abs(await page.evaluate(()=>rhineMusic.stats().browsePosition.row)-grabbed)<.02);
 await page.locator('#stage').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',bubbles:true});await page.mouse.up();await page.waitForFunction(()=>!rhineMusic.stats().browseDrag,null,{timeout:10000});
 const landed=await page.evaluate(()=>rhineMusic.stats());assert.equal(landed.selectedCell.row,Math.round(grabbed));assert.equal(landed.returningFiles,0);assert.equal(await page.evaluate(()=>rhineMusic.presentation.phase),'archive');
 assert.equal(await page.evaluate(()=>rhineMusic.selectedAlbum.playlistCell.songIndex),((landed.selectedCell.row-12)%12+12)%12);
 assert.equal(await page.evaluate(()=>rhineMusic.player.currentTrack.id),track);assert.ok(await page.evaluate(()=>rhineMusic.player.currentTime)>audioStart);
 // Native touch must also work over non-interactive callout text.
 const session=await page.context().newCDPSession(page),lane=await page.evaluate(()=>dragScene.musicBrowseBasis.lane);
 const touch=async(type,x,y)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:7}]});
 const q=portrait?{x:viewport.width*.85,y:viewport.height*.55}:{x:1420,y:400};await touch('touchStart',q.x,q.y);
 for(let i=1;i<=10;i++){await touch('touchMove',q.x-lane.x*i/10,q.y-lane.y*i/10);await page.waitForTimeout(20);}
 await page.waitForTimeout(150);const touchHeld=await page.evaluate(()=>rhineMusic.stats());console.log('TOUCH',touchHeld.browsePosition,touchHeld.browseDrag);
 assert.ok(touchHeld.browseDrag);assert.ok(Math.abs(touchHeld.browsePosition.lane-landed.browsePosition.lane-1)<.1);
 await touch('touchEnd',0,0);await page.waitForFunction(()=>!rhineMusic.stats().browseDrag,null,{timeout:10000});
 assert.equal(await page.evaluate(()=>rhineMusic.selectedAlbum.playlistCell.playlistId),'second');
 await page.screenshot({path:path.join(out,pipeline+'-home.png')});
 // A second touch cancels the gesture and velocity rather than flipping twice.
 await touch('touchStart',p.x,p.y);const multi=await page.evaluate(()=>dragScene.musicBrowseBasis.row);
 await touch('touchMove',p.x-multi.x,p.y-multi.y);
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x-multi.x,y:p.y-multi.y,id:7},{x:p.x-20,y:p.y+20,id:8}]});
 await touch('touchEnd',0,0);await page.waitForFunction(()=>!rhineMusic.stats().browseDrag,null,{timeout:10000});
 // Reach a page not yet fetched, without waiting for metadata during motion.
 await page.mouse.move(p.x,p.y);await page.mouse.down();const cold=await page.evaluate(()=>dragScene.musicBrowseBasis.row);
 await page.mouse.move(p.x-cold.x*6,p.y-cold.y*6,{steps:6});await page.waitForTimeout(500);await page.mouse.up();
 await page.waitForFunction(()=>!rhineMusic.stats().browseDrag,null,{timeout:10000});
 await page.locator('[data-action="settings"]').first().click();await page.locator('[data-category="playback"]').click();
 assert.equal(await page.locator('[data-key-binding="playlistPrevious"]').textContent(),'←');
 await page.locator('[data-category="personalization"]').click();assert.equal(await page.locator('#visualizer-position').inputValue(),'bottom');
 await page.locator('[data-category="display"]').click();
 const beforeControls=await page.evaluate(()=>rhineMusic.stats().selectedCell);
 const scroll=portrait?{x:viewport.width*.65,y:740}:{x:1000,y:740};
 await touch('touchStart',scroll.x,scroll.y);for(let i=1;i<=8;i++){await touch('touchMove',scroll.x,scroll.y-i*45);await page.waitForTimeout(16);}await touch('touchEnd',0,0);await page.waitForTimeout(300);
 assert.ok(await page.locator('#panel-body').evaluate(el=>el.scrollTop)>0,'settings retain native touch scrolling');
 await page.locator('[data-category="audio"]').click();const volume=page.locator('#volume');await volume.scrollIntoViewIfNeeded();const box=await volume.boundingBox();
 await page.mouse.move(box.x+box.width*.2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height/2,{steps:6});await page.mouse.up();
 assert.ok(Number(await volume.inputValue())>60);assert.deepEqual(await page.evaluate(()=>rhineMusic.stats().selectedCell),beforeControls);assert.equal(await page.evaluate(()=>rhineMusic.stats().browseDrag),null);
 if(process.argv.includes('--hot')){
   await page.locator('[data-category="display"]').click();
   for(const preset of ['balanced','lowIntegrated']){await page.locator('#quality-preset').selectOption(preset);await page.waitForFunction(()=>!document.querySelector('.graphics-preparation'),null,{timeout:60000});}
   await page.locator('[data-action="close-panel"]').click();await page.waitForTimeout(400);
   const anchor=await page.evaluate(()=>dragScene.musicBrowsePosition),basis=await page.evaluate(()=>dragScene.musicBrowseBasis.row);
   await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x-basis.x*1.5,p.y-basis.y*1.5,{steps:5});await page.waitForTimeout(50);
   assert.ok(Math.abs(await page.evaluate(()=>dragScene.musicBrowsePosition.row)-anchor.row-1.5)<.1);await page.mouse.up();await page.waitForFunction(()=>!rhineMusic.stats().browseDrag);
 }
 const final=await page.evaluate(()=>rhineMusic.stats());assert.deepEqual(errors,[]);assert.equal(await page.locator('#three-scene canvas').count(),1);
 await fs.writeFile(path.join(out,pipeline+(portrait?'-portrait':'')+'-report.json'),JSON.stringify({pipeline,portrait,hot:process.argv.includes('--hot'),held:held.browsePosition,reversed,released,inertial,grabbed,landed:landed.selectedCell,touch:touchHeld.browsePosition,final:final.selectedCell,audioStart,audioEnd:await page.evaluate(()=>rhineMusic.player.currentTime),errors},null,2));
 console.log('PASS',pipeline);
}catch(error){console.error(error.message);await page.screenshot({path:path.join(out,pipeline+'-failure.png')});await fs.writeFile(path.join(out,pipeline+'-failure.json'),JSON.stringify(await page.evaluate(()=>({stats:rhineMusic.stats(),selected:rhineMusic.selectedAlbum,phase:rhineMusic.presentation})),null,2));throw error;}
finally{releaseCovers();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
try{await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));}catch(error){console.error(String(error.message).slice(0,1200));process.exitCode=1;}
