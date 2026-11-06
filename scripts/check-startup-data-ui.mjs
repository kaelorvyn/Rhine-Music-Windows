// Exercise the production startup, real GPU pipeline and pointer interactions
// with account/song responses held until the test explicitly releases them.
import fs from 'node:fs/promises';
let fixture = await fs.readFile(new URL('./check-entry-handoff-ui.mjs', import.meta.url), 'utf8');
for (const name of ['esbuild','playwright']) fixture=fixture.replace(`from '${name}'`,`from '${import.meta.resolve(name)}'`);
fixture=fixture.replace("from './cover-cache.mjs'",`from '${new URL('./cover-cache.mjs',import.meta.url)}'`)
 .replace("const out = path.resolve('artifacts/entry-continuity', scenario + (navigationOnly ? '-navigation' : ''))","const out = path.resolve('artifacts/startup-data-gate')")
 .replace('const update = ArchiveScene.prototype.update;',`
import { MusicEntry } from './src/music-entry.ts';
window.dataGate={sceneLoads:0,releases:[]};
const sceneLoad=ArchiveScene.prototype.load;
ArchiveScene.prototype.load=function(...args){dataGate.sceneLoads++;return sceneLoad.apply(this,args);};
const complete=MusicEntry.prototype.completeLoading;
MusicEntry.prototype.completeLoading=function(...args){dataGate.releases.push({at:performance.now(),track:window.rhineMusic?.selectedAlbum?.tracks[0]?.title});return complete.apply(this,args);};
const update = ArchiveScene.prototype.update;`)
 .replace('const server = http.createServer',`
let releaseAuth,releaseSongs,waitingAuth=false,waitingSongs=false,requestMode='slow';
const authGate=new Promise(resolve=>{releaseAuth=resolve;}),songsGate=new Promise(resolve=>{releaseSongs=resolve;});
const server = http.createServer`)
 .replace("if (route.includes('/auth/status')) {","if (route.includes('/auth/status')) { if(requestMode==='slow'){waitingAuth=true;await authGate;}")
 .replace("if (route.startsWith('/api/')) {", "if(route==='/api/audio/capabilities'){json({decoderAvailable:false,nativeAvailable:false,devices:[]});return;} if (route.startsWith('/api/')) {")
 .replace("if (route === '/api/online/qq/playlists/test/tracks') {",`if (route === '/api/online/qq/playlists/test/tracks') {
 if(requestMode==='failed'){response.writeHead(503);json({error:'fixture songs unavailable'});return;}
 if(requestMode==='slow'){waitingSongs=true;await songsGate;}`);
fixture=fixture.replaceAll('response.writeHead(503);','response.statusCode=503;');
const tail=fixture.indexOf('const page = await browser.newPage({ viewport:');
if(tail<0)throw Error('Fixture test boundary changed');
fixture=fixture.slice(0,tail)+`
const waitFor=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('fixture request did not start');};
const reports=[];
try{
 const page=await browser.newPage({viewport:{width:1680,height:960}}),errors=[];
 page.on('pageerror',error=>errors.push(error.stack || error.message));
 await page.addInitScript(()=>localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:'balanced',qualityMode:'manual',qualityPipelineVersion:5,frameRate:60,bgm:false,sound:false,arrayMode:'realistic'})));
 await page.goto('http://127.0.0.1:'+server.address().port+'/?scene=archive');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await waitFor(()=>waitingAuth);
 await page.waitForTimeout(850);
 const auth=await page.evaluate(()=>({state:document.querySelector('.rhine-loading').dataset.state,sceneLoads:dataGate.sceneLoads,releases:dataGate.releases.length,inert:document.querySelector('#stage').inert}));
 assert.equal(auth.sceneLoads,0);assert.equal(auth.releases,0);assert.equal(auth.inert,true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.rhine-loading').getAttribute('data-state'),'preparing');
 releaseAuth();await waitFor(()=>waitingSongs);await page.waitForTimeout(250);
 const songs=await page.evaluate(()=>({state:document.querySelector('.rhine-loading').dataset.state,sceneLoads:dataGate.sceneLoads,releases:dataGate.releases.length,status:document.querySelector('.opening-status').textContent}));
 assert.equal(songs.sceneLoads,0);assert.equal(songs.releases,0);assert.equal(songs.state,'preparing');
 await page.screenshot({path:path.join(out,'waiting-for-song-data.png')});
 releaseSongs();
 await page.waitForFunction(()=>document.querySelector('.music-app')?.dataset.musicBoot==='done',null,{timeout:90000});
 home=true;releaseCovers();
 const ready=await page.evaluate(()=>({releases:dataGate.releases,selected:rhineMusic.selectedAlbum?.tracks[0]?.title,auth:document.querySelector('#netease-login-button').dataset.auth,faults:continuity.faults}));
 assert.equal(ready.selected,'Song 0');assert.equal(ready.releases[0].track,'Song 0');assert.equal(ready.auth,'in');assert.deepEqual(ready.faults,[]);
 await page.locator('[data-action="settings"]').first().click();
 await page.locator('.settings-window').waitFor({state:'visible'});
 await page.locator('[data-action="close-panel"]').click();
 await page.locator('.settings-window').waitFor({state:'detached'});
 await page.evaluate(()=>{continuity.navigation=true;});
 await page.locator('.album-stepper [data-action="prev"]').click();
 await page.waitForFunction(()=>rhineMusic.selectedAlbum?.playlistCell?.songIndex===199,null,{timeout:10000});
 await page.locator('.album-stepper [data-action="next"]').click();
 await page.waitForFunction(()=>rhineMusic.selectedAlbum?.playlistCell?.songIndex===0,null,{timeout:10000});
 assert.deepEqual(errors,[]);
 reports.push({scenario:'slow-auth-and-songs',auth,songs,ready,settingsPointerClick:true,firstLastButtonClicks:true,errors});
 await page.screenshot({path:path.join(out,'interactive-home.png')});await page.close();
 requestMode='failed';
 const failed=await browser.newPage(),failureErrors=[];
 failed.on('pageerror',error=>failureErrors.push(error.message));
 await failed.goto('http://127.0.0.1:'+server.address().port+'/?scene=archive');await failed.addScriptTag({content:bundle.outputFiles[0].text});
 await failed.waitForFunction(()=>document.querySelector('.rhine-loading')?.dataset.state==='error',null,{timeout:15000});
 const failure=await failed.evaluate(()=>({message:document.querySelector('.opening-status').textContent,loads:dataGate.sceneLoads,releases:dataGate.releases.length,inert:document.querySelector('#stage').inert}));
 assert.equal(failure.loads,0);assert.equal(failure.releases,0);assert.equal(failure.inert,true);assert.ok(failure.message.includes('首页歌曲尚未就绪'));
 assert.equal(await failed.locator('.opening-skip').isVisible(),false);assert.equal(await failed.locator('.opening-retry').isVisible(),true);assert.deepEqual(failureErrors,[]);
 reports.push({scenario:'songs-fail',...failure,errors:failureErrors});
 await failed.screenshot({path:path.join(out,'song-failure.png')});
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));
}finally{releaseAuth();releaseSongs();releaseCovers();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
`;
try{await import('data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'));}
catch(error){console.error(error.message);process.exitCode=1;}
