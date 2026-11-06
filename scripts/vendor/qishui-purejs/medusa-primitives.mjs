/** Only stages independently matched to local native captures are exposed here. */
import {concat, u32le} from './crypto.mjs';

const words=[0,0xfa5fe8f4,0x3bdcd7d4,0x70c82ad5,0x1861cf54];

export function buildMedusaPrefix({timestamp,random}) {
  for (const [name,value] of Object.entries({timestamp,random}))
    if (!Number.isInteger(value) || value<0 || value>0xffffffff)
      throw new TypeError(`${name} must be a uint32`);
  // The first word is an encoded timestamp, not the actual input timestamp.
  const encoded=(timestamp ^ 3) >>> 0;
  return concat(...words.map(mask=>u32le((encoded ^ mask) >>> 0)),
    u32le(random).slice(0,2),Uint8Array.of(3,1));
}

export function reverseXor(input,key4) {
  if (!(key4 instanceof Uint8Array) || key4.length!==4)
    throw new TypeError('reverseXor requires an explicitly supplied four-byte key');
  return Uint8Array.from({length:input.length},(_,i)=>input[input.length-1-i]^key4[i&3]);
}

/** The connected Luna PC implementation is available from bdms.mjs. */
export const MEDUSA_IMPLEMENTATION_COMPLETE=true;
