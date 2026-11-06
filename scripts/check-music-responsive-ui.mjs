import fs from 'node:fs/promises';
let source = await fs.readFile(new URL('./check-entry-handoff-ui.mjs', import.meta.url), 'utf8');
for (const name of ['esbuild', 'playwright']) source = source.replace(`from '${name}'`, `from '${import.meta.resolve(name)}'`);
source = source.replace("from './cover-cache.mjs'", `from '${new URL('./cover-cache.mjs', import.meta.url)}'`)
  .replace('const value = update.apply(this, args), state = window.continuity;', 'const value = update.apply(this, args), state = window.continuity; window.layoutScene=this;')
  .replace('const stop = MusicPlayer.prototype.stop;', 'const originalPlay=MusicPlayer.prototype.play;MusicPlayer.prototype.play=function(...args){window.layoutPlayer=this;return originalPlay.apply(this,args);};const stop = MusicPlayer.prototype.stop;')
  .replace('response.writeHead(503); json', 'response.statusCode=503; json')
  .replace("response.statusCode=503; json({ error: 'fixture platform unavailable' });", "json({playlists:[],hasMore:false});")
  .replace("artist: 'Fixture', album: 'Test', duration: 120,", "artist:'Fixture',album:'Test',duration:120,browserPlayable:true,format:'WAV',")
  .replace("provider: 'qq', id: 's'", "provider:'qq',pageUrl:'https://example.invalid/song',id:'s'")
  .replace("const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : ''))", "const out = path.resolve('artifacts/responsive')")
  .replace("if (route.startsWith('/api/')) {", `if(route==='/api/audio/capabilities'){json({devices:[],nativeAvailable:false,decoderAvailable:false});return;}
if(route.endsWith('/info')){json({track:{},album:{},lyrics:{original:'[00:01]测试歌词\\n[00:10]第二行',translated:'',unavailable:false}});return;}
if(route.includes('/prepare/')){json({audioUrl:'/fixture.wav'});return;}
if(route==='/fixture.wav'){const size=16000*300,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);response.setHeader('Content-Type','audio/wav');response.end(b);return;}
if (route.startsWith('/api/')) {`);
// Retained hashes are rollback artifacts, not additional active stylesheets.
const styleStart = source.indexOf('const styles = '), styleEnd = source.indexOf('const server = ', styleStart);
source = source.slice(0, styleStart) + String.raw`
const builtHtml=await fs.readFile(path.join(root,'index.html'),'utf8');
const entry=/src="(\/assets\/index-[^"]+\.js)"/.exec(builtHtml)[1];
const entryCode=await fs.readFile(path.join(root,entry.slice(1)),'utf8');
const styles=[...new Set(entryCode.match(/assets\/(?:music-app|audio)-[^"']+\.css/g))].map(file=>'<link rel="stylesheet" href="/'+file+'">').join('');
` + source.slice(styleEnd);
source = source.slice(0, source.indexOf('const page = await browser.newPage({ viewport:')) + String.raw`
const page=await browser.newPage({viewport:{width:1280,height:800},hasTouch:true}),errors=[],report=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:'lowIntegrated',qualityMode:'manual',qualityPipelineVersion:5,bgm:false,sound:false,reduced:true})));
try {
 await page.goto('http://127.0.0.1:'+server.address().port+'/?scene=archive');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done',null,{timeout:90000});
 home=true;releaseCovers();await page.evaluate(()=>continuity.navigation=true);
 await page.locator('[data-action="open"]').click();
 await page.waitForFunction(()=>rhineMusic.player.playing,{timeout:20000});
 const track=await page.evaluate(()=>rhineMusic.player.currentTrack.id);
 const audioStart=await page.evaluate(()=>rhineMusic.player.currentTime);
 for(const [width,height] of [[984,1380],[800,1100],[430,900],[390,844],[360,640],[320,568],[844,390],[900,450],[360,360],[1280,800]]) {
  await page.setViewportSize({width,height});await page.waitForTimeout(350);
  await page.evaluate(()=>{document.querySelector('#playlist-platform-picker').hidden=false;document.querySelector('#my-playlists-button').hidden=false;document.querySelector('#playlist-platform').innerHTML='网易云音乐 <i>▾</i>';});
  await page.waitForTimeout(100);
  const data=await page.evaluate(()=>{
   const selectors=['.music-header [data-action="search"]','#my-playlists-button','#playlist-platform','.music-header [data-action="settings"]','#netease-login-button','#play-pause'];
   const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
   return {layout:document.querySelector('.music-app').dataset.layout,rects:selectors.map(s=>({s,...rect(document.querySelector(s))})),header:rect(document.querySelector('.music-header')),back:rect(document.querySelector('.music-back')),content:rect(document.querySelector('#album-detail-content')),platform:document.querySelector('#playlist-platform').scrollHeight,canvases:document.querySelectorAll('#three-scene canvas').length};
  });
  for(const r of data.rects){assert.ok(r.x>=-1&&r.right<=width+1&&r.y>=0&&r.bottom<=height+1,'control inside viewport '+JSON.stringify({width,height,r}));}
  for(let a=0;a<data.rects.length;a++)for(let b=a+1;b<data.rects.length;b++){const x=data.rects[a],y=data.rects[b];assert.ok(Math.min(x.right,y.right)-Math.max(x.x,y.x)<=1||Math.min(x.bottom,y.bottom)-Math.max(x.y,y.y)<=1,'controls overlap '+JSON.stringify({width,height,x,y}));}
  assert.ok(data.back.y>=data.header.bottom-1,'return clears header');
  assert.ok(data.platform<=46,'platform stays on one line');assert.equal(data.canvases,1);
  assert.ok(data.content.h>=100,'document remains scrollable');
  assert.equal(await page.evaluate(()=>rhineMusic.player.currentTrack.id),track);
  report.push({width,height,...data});
  if([984,390,844,360].includes(width))await page.screenshot({path:path.join(out,width+'x'+height+'.png')});
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('.music-header [data-action="settings"]').click();await page.waitForTimeout(400);
 const settings=await page.evaluate(()=>{const n=document.querySelector('.settings-navigation'),p=document.querySelector('#panel-body');return{scroll:n.scrollWidth>n.clientWidth,bodyHeight:p.clientHeight,overflow:document.querySelector('.settings-window').scrollWidth>innerWidth+1};});
 assert.ok(settings.bodyHeight>100&&!settings.overflow);await page.screenshot({path:path.join(out,'settings.png')});
 const audioEnd=await page.evaluate(()=>rhineMusic.player.currentTime);assert.ok(audioEnd>audioStart&&await page.evaluate(()=>rhineMusic.player.playing));
 await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<header class="desktop-chrome" style="position:fixed;top:0;height:32px"></header>'));
 await page.waitForTimeout(100);
 const desktopTop=await page.locator('.music-header').evaluate(n=>n.getBoundingClientRect().top);assert.ok(desktopTop>=40);
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'report.json'),JSON.stringify({report,settings,errors,audioStart,audioEnd,desktopTop},null,2));console.log('Responsive UI passed: '+report.length+' viewports, settings, continuous playback, desktop chrome clearance');
} catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}
finally{releaseCovers();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
try { await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')); }
catch(error) { console.error(error.message); process.exitCode=1; }
