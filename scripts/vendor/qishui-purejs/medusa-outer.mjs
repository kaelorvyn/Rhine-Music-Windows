/** Luna PC's time-selected outer cipher: two substitution rounds and CBC framing.
 * Constants are SDK algorithm data, not cached request signatures.
 */
import {md5, unhex} from './crypto.mjs';

import {OUTER_PROFILES} from './medusa-outer-constants.mjs';
const PROFILES=OUTER_PROFILES.map(p=>({...p,sbox:unhex(p.sbox),keys:p.keys.map(unhex)}));
const IV=md5(unhex('5953e06abdcce54bd959a50b282d38c0'));
const xtime=x=>((x<<1)^((x&128)?0x11b:0))&255;
const xor=(a,b)=>Uint8Array.from(a,(v,i)=>v^b[i]);
const substitute=(a,p)=>Uint8Array.from(p.permutation,i=>p.sbox[a[i]]);

function mix(input,rows) {
  const out=new Uint8Array(16);
  for(let col=0;col<4;col++) {
    const row=rows[col],a=input[row],b=input[4+row],c=input[8+row],d=input[12+row];
    const t=a^b^c^d;
    out[col]=a^t^xtime(a^b);
    out[4+col]=b^t^xtime(b^c);
    out[8+col]=c^t^xtime(c^d);
    out[12+col]=d^t^xtime(d^a);
  }
  return out;
}

function block(input,p) {
  let state=substitute(xor(input,p.keys[0]),p);
  state=substitute(xor(mix(state,p.rows),p.keys[1]),p);
  return xor(xor(state,p.keys[2]),p.keys[3]);
}

export function medusaOuterCipher(input,timestamp) {
  if(!Number.isInteger(timestamp)||timestamp<0||timestamp>0xffffffff)throw new RangeError('timestamp must be an unsigned 32-bit integer');
  const profile=PROFILES[timestamp&3];
  if(!(input instanceof Uint8Array))throw new TypeError('The outer cipher requires byte input');
  const padding=16-input.length%16,padded=new Uint8Array(input.length+padding);
  padded.set(input);padded.fill(padding,input.length);
  const out=new Uint8Array(padded.length);let previous=IV;
  for(let offset=0;offset<padded.length;offset+=16) {
    previous=block(xor(padded.subarray(offset,offset+16),previous),profile);
    out.set(previous,offset);
  }
  return out;
}
