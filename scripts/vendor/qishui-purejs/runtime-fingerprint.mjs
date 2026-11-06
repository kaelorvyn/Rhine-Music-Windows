import {hex, md5, utf8} from './crypto.mjs';

export function crc32(bytes) {
  if(!(bytes instanceof Uint8Array))throw new TypeError('CRC32 requires bytes');
  let value=0xffffffff;
  for(const byte of bytes){
    value^=byte;
    for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);
  }
  return (~value)>>>0;
}

/** Native UUID generator: two uint64 state words, low nibble first. */
export function uuidFromEntropy(entropy) {
  if(!(entropy instanceof Uint8Array)||entropy.length!==16)throw new TypeError('UUID requires 16 entropy bytes');
  const mask=0xffffffffffffffffn;
  const view=new DataView(entropy.buffer,entropy.byteOffset,entropy.byteLength);
  let a=view.getBigUint64(0,true),b=view.getBigUint64(8,true);
  const step=(x,y)=>{
    const shifted=x^((x<<23n)&mask);
    return (shifted^y^((y^(shifted>>13n))>>5n))&mask;
  };
  a=step(a,b);
  const first=(a+b)&mask;
  b=step(b,a);
  const second=(a+b)&mask;
  const bytes=new Uint8Array(16),out=new DataView(bytes.buffer);
  out.setBigUint64(0,first,true);out.setBigUint64(8,second,true);
  let index=0;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,kind=>{
    let nibble=(bytes[index>>>1]>>>((index&1)*4))&15;
    index++;
    if(kind==='y')nibble=(nibble&3)+8;
    return nibble.toString(16);
  });
}

export function buildEnvironmentJson(uuid,kd=0) {
  if(typeof uuid!=='string'||!/^\w{8}-\w{4}-4\w{3}-[89ab]\w{3}-\w{12}$/.test(uuid)||/[^0-9a-f-]/.test(uuid))throw new TypeError('Expected a lowercase version 4 UUID');
  if(!Number.isInteger(kd)||kd<0||kd>0x7fffffff)throw new RangeError('Invalid environment status');
  return JSON.stringify({kd,fkd:crc32(utf8(hex(md5(utf8(uuid+kd))))),pd:crc32(utf8(uuid))|0,dyn:'',do:0,tk:true});
}
