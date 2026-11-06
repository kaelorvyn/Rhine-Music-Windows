import {P_INITIAL,S_INITIAL} from './blowfish-constants.mjs';

/** Standard Blowfish, using unsigned 32-bit arithmetic and big-endian blocks. */
export class Blowfish {
  constructor(key) {
    if (!(key instanceof Uint8Array) || key.length<1 || key.length>56)
      throw new TypeError('Blowfish key must contain 1 to 56 bytes');
    this.p=P_INITIAL.slice(); this.s=S_INITIAL.slice();
    let k=0;
    for(let i=0;i<18;i++) {
      let word=0;
      for(let j=0;j<4;j++) {word=(word<<8)|key[k];k=(k+1)%key.length;}
      this.p[i]^=word;
    }
    let left=0,right=0;
    for(const table of [this.p,this.s]) {
      for(let i=0;i<table.length;i+=2) {
        [left,right]=this.encryptWords(left,right);
        table[i]=left;table[i+1]=right;
      }
    }
  }
  f(x) {
    const s=this.s;
    return ((((s[x>>>24]+s[256+((x>>>16)&255)])|0)^s[512+((x>>>8)&255)])+s[768+(x&255)])|0;
  }
  encryptWords(left,right) {
    const p=this.p;
    left^=p[0];
    for(let i=1;i<=16;i+=2) {
      right^=this.f(left)^p[i];
      left^=this.f(right)^p[i+1];
    }
    return [(right^p[17])>>>0,left>>>0];
  }
  encryptBlock(bytes) {
    if(bytes.length!==8)throw new RangeError('Blowfish block must contain 8 bytes');
    const input=new DataView(bytes.buffer,bytes.byteOffset,8);
    const [left,right]=this.encryptWords(input.getUint32(0),input.getUint32(4));
    const out=new Uint8Array(8),view=new DataView(out.buffer);
    view.setUint32(0,left);view.setUint32(4,right);
    return out;
  }
}

/** Native Medusa framing: encrypted zero block followed by CBC of PKCS#7 data.
 * The native random IV cancels against its prepended copy in the first block.
 */
export function medusaBlowfish(plaintext,key) {
  const cipher=new Blowfish(key),pad=8-(plaintext.length%8);
  const out=new Uint8Array(8+plaintext.length+pad);
  out.set(plaintext,8);out.fill(pad,8+plaintext.length);
  let previous=new Uint8Array(8);
  for(let i=0;i<out.length;i+=8) {
    const block=out.subarray(i,i+8);
    for(let j=0;j<8;j++)block[j]^=previous[j];
    previous=cipher.encryptBlock(block);block.set(previous);
  }
  return out;
}
