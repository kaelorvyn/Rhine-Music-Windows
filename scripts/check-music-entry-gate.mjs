import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({ stdin:{resolveDir:process.cwd(),contents:`import {MusicEntry} from './src/music-entry.ts';window.MusicEntry=MusicEntry;`},
 bundle:true,write:false,format:'iife',loader:{'.css':'empty'} });
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 await page.setContent('<main id="host"></main>');
 await page.addStyleTag({content:await fs.readFile('src/music-entry.css','utf8')});
 await page.evaluate(()=>{
  const frames=new Map();let id=0,clock=0;
  window.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};window.cancelAnimationFrame=id=>frames.delete(id);
  window.nextFrame=()=>{clock+=1000/60;const pending=[...frames];frames.clear();for(const [,fn]of pending)fn(clock);};
 });
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(async()=>{
  const results=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const fixture=(options)=>{const content=document.createElement('div');document.querySelector('#host').append(content);const entry=new MusicEntry(content,options);
   const root=document.querySelector('.rhine-loading');return{entry,root,content,dispose(){entry.dispose();content.remove();}};};
  const skipVisible=root=>getComputedStyle(root.querySelector('.opening-skip')).display!=='none';
  {
   const f=fixture();f.entry.startPreparation(false);
   for(let i=0;i<200;i++)nextFrame();f.entry.skip();
   f.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   check(f.root.dataset.state==='preparing'&&f.content.inert&&!skipVisible(f.root),'first preparation is unskippable');
   const done=f.entry.completeLoading();check(f.root.dataset.state==='playing'&&skipVisible(f.root),'film starts only after first preparation');
   for(let i=0;i<1310;i++)nextFrame();check(f.entry.active,'the original 21.92 second duration is preserved');
   for(let i=0;i<20;i++)nextFrame();await done;check(!f.entry.active&&!f.content.inert,'first prepared film opens only at its end');
   f.dispose();results.push('cold preparation and original film duration');
  }
  {
   const f=fixture();f.entry.startPreparation(true);check(f.root.dataset.state==='playing','warm film starts immediately');f.entry.skip();
   check(f.root.dataset.state==='waiting'&&f.entry.active&&f.content.inert&&!skipVisible(f.root),'early skip holds the blocking page');
   f.entry.skip();f.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   check(f.root.dataset.state==='waiting','repeated skip cannot escape waiting');
   await f.entry.completeLoading();check(!f.entry.active&&!f.content.inert,'ready skipped entry proceeds');f.dispose();results.push('warm early skip and repeated keyboard skip');
  }
  {
   const f=fixture();f.entry.startPreparation(true);for(let i=0;i<1400;i++)nextFrame();
   check(f.root.dataset.state==='waiting'&&f.content.inert,'slow preparation after natural film end stays blocked');
   await f.entry.completeLoading();f.dispose();results.push('natural film end before readiness');
  }
  {
   const f=fixture({reduced:true});f.entry.startPreparation(true);f.entry.skip();
   check(f.root.dataset.state==='preparing'&&!skipVisible(f.root),'reduced motion still blocks unready content');
   await f.entry.completeLoading();check(!f.entry.active,'reduced motion proceeds without film after preparation');f.dispose();results.push('reduced motion');
  }
  {
   const f=fixture();f.entry.startPreparation(true);f.entry.fail('fixture failure');f.entry.skip();f.entry.startPreparation(true);
   f.entry.setStatus('late startup status');
   let settled=false;const done=f.entry.completeLoading().then(()=>{settled=true;});await Promise.resolve();
   check(f.root.dataset.state==='error'&&f.root.textContent.includes('fixture failure')&&!settled,'failure stays visible even if a late operation resolves');
   f.dispose();await done;check(!f.content.inert,'disposal releases focus and waiters');results.push('failure, late completion, disposal');
  }
  return results;
 });
 assert.equal(result.length,5);console.log(JSON.stringify({passed:result}));
} finally {await browser.close();}
