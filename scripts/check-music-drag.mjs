import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {MusicDragMotion,browseDragAxis} from '../src/music-drag-navigation.ts';
import {DEFAULT_KEY_BINDINGS,sanitizeKeyBindings} from '../src/music-keybindings.ts';
const basis={row:{x:66,y:18},lane:{x:332,y:-242}};
for(const [x,y,axis]of [[80,80,'row'],[-80,-80,'row'],[-80,80,'lane'],[80,-80,'lane']])assert.equal(browseDragAxis(x,y,basis),axis);
assert.equal(browseDragAxis(3,3,basis),undefined);
const positions=[];
for(const fps of [20,24,30,60,120]){
 const motion=new MusicDragMotion();motion.begin(12,68,0);motion.move(12.5,20);assert.equal(motion.position,12.5);motion.move(12.2,40);assert.equal(motion.position,12.2);
 for(let i=3;i<=8;i++)motion.move(12+i/2,i*20);
 motion.release(161);assert.equal(motion.phase,'inertia');const released=motion.position;
 for(let i=0;i<fps*5&&motion.active;i++)motion.tick(1/fps);
 assert.ok(motion.position>released);assert.equal(motion.position,Math.round(motion.position));assert.equal(motion.phase,'idle');positions.push(motion.position);
}
assert.equal(new Set(positions).size,1,'inertia and landing are independent of rendered frame rate');
const hold=new MusicDragMotion();hold.begin(12,60,0);hold.move(15.4,50);hold.release(400);assert.equal(hold.phase,'snap');hold.tick(.18);assert.equal(hold.position,15);
const boundary=new MusicDragMotion();boundary.begin(12,60,0,[12,15]);boundary.move(30,50);assert.equal(boundary.position,15);boundary.release(60);for(let i=0;i<200;i++)boundary.tick(.01);assert.equal(boundary.position,15);
const interrupt=new MusicDragMotion();interrupt.begin(12,60,0);interrupt.move(15,50);interrupt.release(51);interrupt.tick(.1);const interrupted=interrupt.position;interrupt.begin(interrupted,60,200);assert.equal(interrupt.position,interrupted);interrupt.move(interrupted-1,250);assert.ok(interrupt.position<interrupted);interrupt.cancel();interrupt.tick(.18);assert.equal(interrupt.phase,'idle');
assert.deepEqual(Object.values(DEFAULT_KEY_BINDINGS),['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight']);
const old={playlistPrevious:'ArrowUp',playlistNext:'ArrowDown',songPrevious:'ArrowLeft',songNext:'ArrowRight',seekBackward:'ArrowLeft',seekForward:'ArrowRight',boostPrimary:'ArrowLeft',boostSecondary:'ArrowRight'};
assert.deepEqual(sanitizeKeyBindings(old),old,'valid saved settings are never migrated');
const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`export {normalizeVisualizer} from './src/music-visualizer.ts';`},bundle:true,format:'esm',write:false,platform:'node'});
const {normalizeVisualizer}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
assert.deepEqual(normalizeVisualizer(undefined),{enabled:true,position:'bottom',style:'bars'});
assert.deepEqual(normalizeVisualizer({position:'progress',enabled:false,style:'dots',color:'#abcdef'}),{enabled:false,position:'progress',style:'dots',color:'#abcdef'});
console.log(JSON.stringify({diagonalDirections:4,frameRates:[20,24,30,60,120],landing:positions,continuousReverse:true,inertia:true,regrab:true,finiteBounds:true,defaults:true,savedSettings:true}));
