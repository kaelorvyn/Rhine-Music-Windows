// Reuse the existing production-scene fixture; exercise real, visible controls.
import fs from 'node:fs/promises';
let fixture = await fs.readFile(new URL('./check-music-responsive-ui.mjs', import.meta.url), 'utf8');
fixture = fixture.slice(0, fixture.indexOf("source = source.slice(0, source.indexOf('const page"));
fixture = fixture.replaceAll('import.meta.resolve(name)', `({esbuild:${JSON.stringify(import.meta.resolve('esbuild'))},playwright:${JSON.stringify(import.meta.resolve('playwright'))}})[name]`)
  .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
fixture += "\nsource=source.replace('const before = this.albums().length, operation = load.apply(this, args);','window.layoutLibrary=this;const before = this.albums().length, operation = load.apply(this, args);');\n";
const checks = String.raw`
const page=await browser.newPage({viewport:{width:1280,height:800},hasTouch:true}),errors=[],report=[];
const standard=process.argv.includes('--standard');
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(quality=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality,qualityMode:'manual',qualityPipelineVersion:5,bgm:false,sound:false,reduced:true})),standard?'balanced':'lowIntegrated');
await page.route('**/api/lx/status',route=>route.fulfill({json:{plugins:Array.from({length:21},(_,i)=>({id:'fixture-'+i,name:(i<20?'自带音源':'自行导入音源')+' Very Long Source Name '.repeat(8),enabled:true,builtin:i<20,platforms:['wy','tx'],health:{ok:false,error:'network-service-error-'.repeat(25)}})),counts:{total:21,loaded:21}}}));
// Layout checks use fixed, immediate pages; slow refresh belongs to the handoff fixture.
await page.route(/\/api\/online\/qq\/playlists(?:\?|$)/,route=>route.fulfill({json:{playlists:[{id:'test',name:'Test',trackCount:200}],hasMore:false}}));
await page.route(/\/api\/online\/qq\/playlists\/test\/tracks/,route=>{
 const offset=Number(new URL(route.request().url()).searchParams.get('offset')||0);
 return route.fulfill({json:{total:200,tracks:Array.from({length:Math.min(50,200-offset)},(_,i)=>({id:'s'+(offset+i),title:'Song '+(offset+i),artist:'Fixture',album:'Test',duration:120,browserPlayable:true,format:'WAV',onlineSource:{provider:'qq',pageUrl:'https://example.invalid/song',id:'s'+(offset+i),coverUrl:'/cover/'+(offset+i)}}))}});
});
// Model the shipped audio server's byte ranges; chunked WAV alone cannot verify seeking.
await page.route('**/fixture.wav',async route=>{
 const size=16000*300,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);
 const range=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||''),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(b.length-1,Number(range[2])):b.length-1;
 await route.fulfill({status:range?206:200,headers:{'Content-Type':'audio/wav','Accept-Ranges':'bytes','Content-Length':String(end-start+1),...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+b.length}:{})},body:b.subarray(start,end+1)});
});
const lyricRows=Array.from({length:100},(_,i)=>({time:i*2,text:i%10===9?'MixedLanguageWithoutSpaces'.repeat(8):'测试歌词'}));
const lrc=(translated=false)=>lyricRows.map(({time,text})=>'['+String(Math.floor(time/60)).padStart(2,'0')+':'+String(time%60).padStart(2,'0')+']'+(translated?'Translation 翻译歌词：'+text:text)).join('\n');
await page.route('**/api/online/*/songs/*/info',route=>route.fulfill({json:{track:{},album:{description:'LongDescriptionWithoutSpaces'.repeat(100)},lyrics:{original:lrc(),translated:lrc(true),wordLines:lyricRows.filter((_,i)=>i%3===0).map(({time,text})=>({time,text,words:[{text:text.slice(0,2),start:time,end:time+.8},{text:text.slice(2),start:time+.8,end:time+1.8}]})),unavailable:false}}}));
const box=async selector=>page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};});
const inside=(r,w,h,label)=>assert.ok(r.x>=-1&&r.y>=-1&&r.right<=w+1&&r.bottom<=h+1,label+' '+JSON.stringify(r));
const tap=async selector=>{const r=await box(selector);inside(r,...Object.values(page.viewportSize()),selector);await page.touchscreen.tap(r.x+r.w/2,r.y+r.h/2);};
const checkpoints=[];const checkpoint=async label=>{const value=await page.evaluate(()=>({time:rhineMusic.player.currentTime,id:rhineMusic.player.currentTrack?.id,playing:rhineMusic.player.playing}));checkpoints.push({label,...value});};
try {
 await page.goto('http://127.0.0.1:'+server.address().port+'/?scene=archive');
 const instrumented=bundle.outputFiles[0].text.replace(/function mountMusicDragNavigation\([^,]+,\s*([^)]+)\)\s*\{/,text=>text+' window.layoutDragOptions=arguments[1];');
 assert.ok(instrumented.includes('window.layoutDragOptions=arguments[1]'));
 await page.addScriptTag({content:instrumented});
 await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done',null,{timeout:90000});
 home=true;releaseCovers();await page.evaluate(()=>continuity.navigation=true);
 await page.locator('[data-action="open"]').click();
 await page.waitForFunction(()=>rhineMusic.player.playing,null,{timeout:20000});
 await page.waitForFunction(()=>rhineMusic.presentation.phase==='detail');
 const audioStart=await page.evaluate(()=>rhineMusic.player.currentTime);
 for(const [w,h] of (standard?[[390,844],[568,320],[1280,800]]:[[360,640],[390,844],[430,900],[625,1163],[844,390],[568,320],[320,568],[360,360],[1280,800],[1920,1080]])) {
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(300);
  const detail=await page.evaluate(()=>{
   const stage=document.querySelector('.music-app'),article=document.querySelector('#album-detail-content'),pane=document.querySelector('#song-lyric-view:not([hidden]),#song-info:not([hidden])');
   const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
   return{density:stage.dataset.detailDensity,article:rect(article),overflow:article.scrollHeight-article.clientHeight,reading:rect(pane),header:rect(document.querySelector('.music-header')),footer:rect(document.querySelector('.lyric-transport')),controls:['#song-toggle-play','[data-action="playing-prev"]','[data-action="playing-next"]','.lyric-transport .playback-seek','.song-time','#play-mode-button','#audio-effects-button','#download-button','.volume-range'].map(s=>({s,...rect(document.querySelector(s))}))};
  });
  for(const r of detail.controls)inside(r,w,h,r.s+' @'+w+'x'+h);
  assert.ok(detail.overflow<=2,'outer detail must fit '+JSON.stringify({w,h,...detail}));
  assert.ok(detail.reading.h>=36,'one readable lyric line '+JSON.stringify({w,h,...detail}));
  assert.ok(detail.footer.y>=detail.reading.bottom-1,'footer below reading pane');
  assert.ok(await page.locator('#song-lyrics').evaluate(n=>n.scrollWidth<=n.clientWidth+2),'long lyrics wrap inside their pane');
  for(const selector of ['#song-tab-info','#song-tab-lyrics']){await tap(selector);await page.waitForTimeout(50);}
  // Verify real hit testing before clicks; Playwright must not scroll a control into view.
  await tap('#song-toggle-play');await page.waitForFunction(()=>!rhineMusic.player.playing);
  await tap('#song-toggle-play');await page.waitForFunction(()=>rhineMusic.player.playing);
  await tap('#playlist-platform');await page.waitForTimeout(80);
  const button=await box('#playlist-platform'),picker=await box('#playlist-platform-picker'),menu=await box('#playlist-platform-menu');
  inside(menu,w,h,'open platform menu');assert.ok(Math.abs(button.w-picker.w)<2,'anchor width equals button');
  assert.ok(Math.abs(menu.x-button.x)<2,'menu aligns with button');assert.ok(Math.abs(menu.y-button.bottom-6)<2,'menu below button');
  await tap('#playlist-platform-menu [data-platform="all"]');await page.waitForTimeout(80);
  assert.ok(await page.locator('#playlist-platform-menu').evaluate(n=>n.hidden),'platform selection closes');
  // Long title / multiple artists / error: fixed controls retain their area.
  await page.evaluate(()=>{const a=document.querySelector('#album-detail-content');a.querySelector('h1').textContent='非常长的歌曲名称 Long Song Title — Live Recording 多语言现场版本'.repeat(3);a.querySelector('.detail-artist').textContent='歌手甲 / Singer B / 歌手丙'.repeat(8);document.querySelector('#song-view-error').textContent='请求失败：'+('long-service-error-'.repeat(50));});
  await page.waitForTimeout(120);
  const long=await page.evaluate(()=>{const a=document.querySelector('#album-detail-content'),f=document.querySelector('.lyric-transport'),t=a.querySelector('h1');return{overflow:a.scrollHeight-a.clientHeight,footer:f.getBoundingClientRect().bottom,title:t.clientHeight,line:parseFloat(getComputedStyle(t).lineHeight)};});
  assert.ok(long.overflow<=2&&long.footer<=h+1&&long.title<=long.line*2+2,'long content '+JSON.stringify({w,h,...long}));
  await page.screenshot({path:path.join(out,w+'x'+h+'-detail.png')});
  // Home navigation and callout cannot overlap or escape the screen.
  await tap('.music-back');await page.waitForFunction(()=>rhineMusic.presentation.phase==='archive');await page.waitForTimeout(100);
  await page.locator('#genre-name').evaluate(n=>n.textContent='很长的歌单名称 Long Playlist Name '.repeat(12));await page.waitForTimeout(60);
  const homeLayout=await page.evaluate(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};return{navigation:rect(document.querySelector('.music-navigation')),callout:rect(document.querySelector('.album-callout')),buttons:[...document.querySelectorAll('.album-stepper > button,.genre-stepper > button,#genre-name')].filter(n=>n.getBoundingClientRect().width&&getComputedStyle(n).visibility!=='hidden').map(n=>({action:n.dataset.action,...rect(n)}))};});
  for(const r of homeLayout.buttons)inside(r,w,h,'home '+r.action);
  assert.ok(homeLayout.callout.bottom<=homeLayout.navigation.y-4,'home card clears navigation '+JSON.stringify({w,h,...homeLayout}));
  await page.screenshot({path:path.join(out,w+'x'+h+'-home.png')});
  await tap('[data-action="open"]');await page.waitForFunction(()=>rhineMusic.presentation.phase==='detail');
  await tap('#audio-effects-button');await page.waitForTimeout(100);
  const fx=await page.locator('.fx-surface').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,columns:getComputedStyle(n.querySelector('.fx-bands')).gridTemplateColumns.split(' ').length}));
  assert.ok(fx.scroll<=fx.width+2,'effects horizontal fit '+JSON.stringify({w,h,...fx}));
  if(w<=540)assert.equal(fx.columns,5);
  await tap('[data-fx-close]');
  report.push({w,h,detail,button,picker,menu,long,homeLayout,fx});
 }
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
 const seek=await box('.lyric-transport .playback-seek');
 await page.mouse.move(seek.x+seek.w*.2,seek.y+seek.h/2);await page.mouse.down();await page.mouse.move(seek.x+seek.w*.4,seek.y+seek.h/2,{steps:5});await page.mouse.up();
 await page.waitForFunction(()=>rhineMusic.player.currentTime>100);
 await checkpoint('seek');
 const volume=await box('.volume-range');await page.mouse.move(volume.x+volume.w*.8,volume.y+volume.h/2);await page.mouse.down();await page.mouse.move(volume.x+volume.w*.3,volume.y+volume.h/2,{steps:5});await page.mouse.up();
 assert.ok(Number(await page.locator('.volume-range').inputValue())<.5,'visible volume range remains draggable');
 await checkpoint('volume');
 await tap('#playlist-platform');await tap('#playlist-platform-menu [data-platform="qq"]');await page.waitForTimeout(100);
 assert.match(await page.locator('#playlist-platform').innerText(),/QQ/);
 await checkpoint('platform QQ');
 await tap('#playlist-platform');await tap('#playlist-platform-menu [data-platform="all"]');
 await checkpoint('platform all');
 await page.locator('#playlist-platform').focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');
 assert.ok(await page.evaluate(()=>!!document.activeElement.closest('#playlist-platform-menu')),'menu options are reachable by Tab');
 // Choose the populated fixture explicitly; Tab need not land on the All option.
 await page.locator('#playlist-platform-menu [data-platform="qq"]').focus();await page.keyboard.press('Enter');
 assert.ok(await page.locator('#playlist-platform-menu').evaluate(n=>n.hidden),'native keyboard menu activation and selection');
 assert.match(await page.locator('#playlist-platform').innerText(),/QQ/);
 await page.waitForFunction(()=>rhineMusic.selectedAlbum?.tracks?.length>0,null,{timeout:20000});
 await tap('.music-header [data-action="settings"]');await page.waitForTimeout(150);
 const panels=[];
 for(const [w,h] of (standard?[]:[[360,640],[390,844],[568,320]])) {
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(120);
  for(const category of ['personalization','playback','audio','display','download','cache','local','library','update','developer']) {
   await page.locator('[data-category="'+category+'"]').click();
   if(category==='library') {
    await page.waitForFunction(()=>document.querySelectorAll('.lx-source-row').length===21);
    await page.locator('[data-action="lx-group-toggle"]').click();
    await page.evaluate(()=>document.querySelector('#lx-sources-status').textContent='RequestFailedWithoutSpaces'.repeat(40));
   }
   const panel=await page.locator('#panel-body').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,height:n.clientHeight}));
   assert.ok(panel.scroll<=panel.width+2,'panel horizontal fit '+JSON.stringify({w,h,category,...panel}));
   inside(await box('[data-action="close-panel"]'),w,h,'panel close');panels.push({w,h,category,...panel});
  }
 }
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(80);
 await checkpoint('settings');
 await page.locator('[data-category="library"]').click();await page.locator('#lx-sources-settings').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(out,'long-sources.png')});
 await tap('[data-action="close-panel"]');await page.waitForTimeout(80);
 await tap('.music-header [data-action="search"]');await page.waitForTimeout(100);
 await page.locator('.online-search-form input').fill('长歌曲名称与多位歌手');
 await page.setViewportSize({width:390,height:430});await page.waitForTimeout(150);
 inside(await box('.online-search-form input'),390,430,'search after available height shrinks');inside(await box('[data-action="close-panel"]'),390,430,'search close');
 await page.screenshot({path:path.join(out,'short-search.png')});await tap('[data-action="close-panel"]');
 await checkpoint('search');
 const audioBeforeBrowse=await page.evaluate(()=>rhineMusic.player.currentTime);assert.ok(audioBeforeBrowse>100&&audioBeforeBrowse>audioStart,'viewport and panel changes retain playback position');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);
 await tap('.music-back');await page.waitForFunction(()=>rhineMusic.presentation.phase==='archive');
 await page.waitForTimeout(200);
 const touchSession=await page.context().newCDPSession(page),beforeTouch=await page.evaluate(()=>rhineMusic.stats().browsePosition.row),basis=await page.evaluate(()=>layoutScene.musicBrowseBasis.row);
 const inputState=await page.evaluate(()=>({enabled:layoutDragOptions.enabled(),row:layoutDragOptions.allowed('row'),target:document.elementFromPoint(240,300)?.outerHTML.slice(0,300),data:{...document.querySelector('.music-app').dataset},selected:rhineMusic.selectedAlbum?.playlistCell,library:{providers:layoutLibrary.providers,playlists:layoutLibrary.playlists,loading:layoutLibrary.loading,error:layoutLibrary.error}}));
 const touch=async(type,x,y)=>touchSession.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:7}]});
 await touch('touchStart',240,300);
 for(let i=1;i<=8;i++){await touch('touchMove',240-basis.x*1.25*i/8,300-basis.y*1.25*i/8);await page.waitForTimeout(15);}
 await page.waitForTimeout(150);
 const held=await page.evaluate(()=>rhineMusic.stats());assert.ok(held.browseDrag&&Math.abs(held.browsePosition.row-beforeTouch-1.25)<.1,'portrait shelf follows native touch continuously '+JSON.stringify({beforeTouch,basis,held:held.browsePosition,drag:held.browseDrag,inputState}));
 await touch('touchEnd',0,0);await page.waitForFunction(()=>!rhineMusic.stats().browseDrag);
 await tap('[data-action="open"]');await page.waitForFunction(()=>rhineMusic.presentation.phase==='detail');
 const lyrics=await box('#song-lyrics');await page.mouse.move(lyrics.x+lyrics.w*.6,lyrics.y+lyrics.h*.6);
 const beforeScroll=await page.locator('#song-lyrics').evaluate(n=>n.scrollTop);await page.mouse.wheel(0,180);await page.waitForTimeout(150);
 assert.ok(await page.locator('#song-lyrics').evaluate(n=>n.scrollTop)>beforeScroll,'lyrics still scroll internally');
 assert.equal(await page.locator('#album-detail-content').evaluate(n=>n.scrollTop),0,'lyrics do not scroll outer detail');
 assert.ok(await page.locator('.lyric-word').count()>0,'word lyrics still mounted');
 const resumed=await page.evaluate(()=>rhineMusic.player.currentTime);await page.waitForTimeout(400);
 const audioEnd=await page.evaluate(()=>rhineMusic.player.currentTime);assert.ok(audioEnd>resumed&&await page.evaluate(()=>rhineMusic.player.playing),'newly opened song keeps advancing');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'report.json'),JSON.stringify({report,panels,errors,checkpoints,pipeline:await page.evaluate(()=>rhineMusic.stats().pipeline),audioStart,audioBeforeBrowse,audioEnd,touch:{before:beforeTouch,held:held.browsePosition}},null,2));
 console.log('Compact UI passed: '+report.length+' viewports, visible playback/footer controls, real menu taps, long content, home navigation, effects');
} catch(error){await page.screenshot({path:path.join(out,'failure.png')});console.error('URL '+page.url(),JSON.stringify(checkpoints));throw error;}
finally{releaseCovers();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
fixture += `\nsource = source.replace("path.resolve('artifacts/responsive')", "path.resolve('artifacts/compact-layout'+(process.argv.includes('--standard')?'-standard':''))");\nsource = source.slice(0, source.indexOf('const page = await browser.newPage({ viewport:')) + ${JSON.stringify(checks)};\ntry { await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')); } catch(error) {console.error(error.message);process.exitCode=1;}`;
await import('data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'));
