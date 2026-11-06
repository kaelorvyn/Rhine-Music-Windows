import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MUSIC_MODEL, MUSIC_COVER } from './music-model';

/** A solid frame with an actual opening: no transparent/dithered LOD layers. */
export function createLowCaseGeometry() {
  const w = MUSIC_MODEL.width / 2, bottom = MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2;
  const top = bottom + MUSIC_MODEL.height, radius = .055;
  const shape = new THREE.Shape();
  shape.moveTo(-w + radius, bottom); shape.lineTo(w-radius,bottom);
  shape.quadraticCurveTo(w,bottom,w,bottom+radius);shape.lineTo(w,top-radius);
  shape.quadraticCurveTo(w,top,w-radius,top);shape.lineTo(-w+radius,top);
  shape.quadraticCurveTo(-w,top,-w,top-radius);shape.lineTo(-w,bottom+radius);
  shape.quadraticCurveTo(-w,bottom,-w+radius,bottom);
  const hole = new THREE.Path(), x=MUSIC_COVER.x, y=MUSIC_COVER.y, half=1.55;
  hole.moveTo(x-half,y-half);hole.lineTo(x-half,y+half);hole.lineTo(x+half,y+half);hole.lineTo(x+half,y-half);hole.closePath();
  shape.holes.push(hole);
  const frame = new THREE.ExtrudeGeometry(shape,{depth:MUSIC_MODEL.depth,steps:1,bevelEnabled:false,curveSegments:2}).translate(0,0,-MUSIC_MODEL.depth/2);
  const back = new THREE.BoxGeometry(MUSIC_MODEL.width,MUSIC_MODEL.height,.012).translate(0,MUSIC_MODEL.center.y,-.064).toNonIndexed();
  const geometry = mergeGeometries([frame,back]);frame.dispose();back.dispose();
  geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
}

export function createLowCaseMaterial() {
  return new THREE.MeshLambertMaterial({color:'#e2d6c5',side:THREE.FrontSide});
}

export function createContactShadows(count:number) {
  const material = new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    uniforms:{},vertexShader:`varying vec2 vUv;void main(){vUv=uv;vec4 p=instanceMatrix*vec4(position,1.0);p.y=-4.625;gl_Position=projectionMatrix*viewMatrix*modelMatrix*p;}`,
    fragmentShader:`varying vec2 vUv;void main(){vec2 p=(vUv-.5)*2.;float a=(1.-smoothstep(.1,1.,dot(p,p)))*.13;gl_FragColor=vec4(.19,.15,.10,a);}`});
  const geometry=new THREE.PlaneGeometry(4.45,.7).rotateX(-Math.PI/2);
  const mesh=new THREE.InstancedMesh(geometry,material,count);mesh.frustumCulled=false;mesh.renderOrder=1;return mesh;
}

/** Runtime-only budget: never modifies the user's quality or frame-rate choice. */
export class LowPixelBudget {
  pixels=640_000;
  private badSince:number|undefined;
  private goodSince:number|undefined;
  private changed=-Infinity;
  private previous:number|undefined;
  sample(now:number,cpu:number,gpu:number|null,cap:number,active:boolean) {
    const gap=this.previous===undefined?0:now-this.previous;this.previous=now;
    if(!active||gap>500){this.badSince=this.goodSince=undefined;return false;}
    const target=1000/Math.min(60,cap>0?cap:60);
    const bad=gpu!==null?gpu>target*.8:gap>target*1.25&&cpu<target*.5;
    const good=gpu!==null?gpu<target*.5:gap<target*1.1&&cpu<target*.35;
    this.badSince=bad?(this.badSince??now):undefined;this.goodSince=good?(this.goodSince??now):undefined;
    if(now-this.changed<3000)return false;
    const previous=this.pixels;
    if(this.badSince!==undefined&&now-this.badSince>=2000)this.pixels=Math.max(518400,Math.round(this.pixels*.9));
    else if(this.goodSince!==undefined&&now-this.goodSince>=8000)this.pixels=Math.min(921600,Math.round(this.pixels/ .9));
    if(previous===this.pixels)return false;
    this.changed=now;this.badSince=this.goodSince=undefined;return true;
  }
  resetSamples(){this.previous=this.badSince=this.goodSince=undefined;}
}
