import {sm3} from './sm3.mjs';
import {concat,u32le,unhex} from './crypto.mjs';
const SIGN_KEY=unhex('2b57da4d27e23ed88311e9b12cca603b5953e06abdcce54bd959a50b282d38c0');

/** Shared head-state and Blowfish key derivation for this Luna PC profile. */
export function deriveMedusaKey(random) {
  if(!Number.isInteger(random)||random<0||random>0xffffffff)
    throw new RangeError('The Medusa random value must be an unsigned 32-bit integer');
  return sm3(concat(SIGN_KEY,u32le(random),SIGN_KEY));
}
