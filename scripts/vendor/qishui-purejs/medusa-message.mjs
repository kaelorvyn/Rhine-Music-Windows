import {concat} from './crypto.mjs';
import {deriveMedusaKey} from './medusa-key.mjs';
import {deriveMedusaHeadState,transformMedusaHead} from './medusa-head.mjs';
import {medusaBlowfish} from './blowfish.mjs';
import {reverseXor} from './medusa-primitives.mjs';

/** Encrypt serialized message bytes through the native reverse/complement stage.
 * Request serialization and the subsequent outer framing are separate stages.
 */
export function encryptMedusaMessage(serialized,random) {
  if(!(serialized instanceof Uint8Array)||serialized.length<96)
    throw new TypeError('The serialized Medusa message requires at least 96 bytes');
  const head=transformMedusaHead(serialized.subarray(0,96),deriveMedusaHeadState(random));
  const tail=medusaBlowfish(serialized.subarray(96),deriveMedusaKey(random));
  return reverseXor(concat(new Uint8Array(8),head,tail),new Uint8Array(4).fill(255));
}
