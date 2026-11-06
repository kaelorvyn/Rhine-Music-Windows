import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../src/music-app.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('music-app.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='prepareStartupPlaylists');
assert.ok(node);
const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const turn=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({empty=false,fail=false,delayed=false}={}){
 const songs=deferred(),window=deferred(),calls=[];
 const run=new Function('config','songs','windowGate','calls',`
 let frameDisposed=false,startupWarning='',accountActive=false,bootedPlaylists=false,accountKey='',accountView=false,demo=true,albums=[],genres=[],selected=0;
 const entry={setStatus(){}},library={albums:[]},accountStates={};
 const loggedInProviders=()=>config.empty?['netease']:[],playlistViewProviders=()=>['local'];
 const stage={classList:{add(){}}},$=()=>({}),setPlaylistAlbums=()=>calls.push('publish');
 const playlistLibrary={playlists:[],error:'',setProviders(){},
  async load(){this.playlists=[{provider:'local',id:'favorites',name:'Favorites',trackCount:1}];},
  async ensure(){calls.push('songs');if(config.delayed)await songs.promise;if(config.fail)throw Error('fixture page failure');if(config.empty)this.playlists[0].trackCount=0;this.loaded=true;},
  track(){return this.loaded&&!config.empty?{title:'Known song'}:undefined;},
  async window(){calls.push('window');if(config.delayed)await windowGate.promise;},
  albums(){return[{tracks:this.track()?[this.track()]:[],playlistCell:{playlistIndex:0,songIndex:0}}];}
 };
 ${code}
 return{run:prepareStartupPlaylists,state:()=>({accountView,bootedPlaylists,albums,selected}),dispose(){frameDisposed=true;}};
 `)({empty,fail,delayed},songs,window,calls);
 return{...run,songs,window,calls};
}
const delayed=fixture({delayed:true});let finished=false;
const pending=delayed.run().then(()=>{finished=true;});await turn();
assert.equal(finished,false);assert.equal(delayed.state().accountView,false);
delayed.songs.resolve();await turn();assert.ok(delayed.calls.includes('window'));
assert.equal(finished,false);assert.equal(delayed.state().accountView,false);
delayed.window.resolve();await pending;
assert.equal(delayed.state().accountView,true);assert.equal(delayed.state().albums[0].tracks[0].title,'Known song');
const failed=fixture({fail:true});await assert.rejects(failed.run(),/首页歌曲尚未就绪/);assert.equal(failed.state().accountView,false);
const emptied=fixture({empty:true});await emptied.run();assert.equal(emptied.state().albums[0].tracks.length,0,'a confirmed empty song page is valid even when its catalog count was stale');
const disposed=fixture({delayed:true});const late=disposed.run();await turn();disposed.dispose();disposed.songs.resolve();await late;
assert.equal(disposed.state().accountView,false);assert.ok(!disposed.calls.includes('publish'));
console.log(JSON.stringify({passed:['song-page gate','visible-window gate','local favorites without login','failed first song blocks entry','confirmed empty page','late disposed response']}));
