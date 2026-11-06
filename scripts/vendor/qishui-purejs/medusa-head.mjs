import {medusaHeadWord} from './medusa-head-word.mjs';
import {deriveMedusaKey} from './medusa-key.mjs';

/** Derive the special word and mask from this application's head RNG value. */
export function deriveMedusaHeadState(random) {
  const digest=deriveMedusaKey(random);
  const rotated=digest.map(v=>((v>>>2)|(v<<6))^0x33);
  const shifted=Uint8Array.from({length:33},(_,i)=>
    ((i?rotated[i-1]<<2:0)|(i<32?rotated[i]>>>6:0))&255);
  const branch=shifted[0]&1;
  return {specialWord:7+4*branch,mask8:shifted.slice(8+4*branch,16+4*branch)};
}

/** Complete byte operation with an explicit or derived special-word state. */
export function transformMedusaHead(input, {specialWord, mask8} = {}) {
  if (!(input instanceof Uint8Array) || input.length !== 96)
    throw new TypeError('The Medusa head requires exactly 96 bytes');
  if (!Number.isInteger(specialWord) || specialWord < 0 || specialWord >= 12)
    throw new RangeError('specialWord must identify one of the twelve words');
  if (!(mask8 instanceof Uint8Array) || mask8.length !== 8)
    throw new TypeError('The special-word mask must be explicitly supplied as eight bytes');
  const out = new Uint8Array(96);
  for (let word = 0; word < 12; word++) {
    const bytes = input.subarray(8 * word, 8 * word + 8);
    out.set(word === specialWord ? bytes.map((v, i) => v ^ mask8[i]) : medusaHeadWord(bytes), 8 * word);
  }
  return out;
}
