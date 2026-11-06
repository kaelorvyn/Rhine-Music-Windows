import {concat,u32le,base64} from './crypto.mjs';
import {decodeProtobuf} from './protobuf.mjs';
import {encryptMedusaMessage} from './medusa-message.mjs';
import {gatherMedusaBits,scatterMedusaBits} from './medusa-sparse.mjs';
import {medusaOuterCipher} from './medusa-outer.mjs';
import {buildMedusaPrefix} from './medusa-primitives.mjs';

/** Full message-to-Medusa calculation. Request serialization is not supplied here. */
export function generateMedusaFromMessage(serialized,{timestamp,random,outerRandom}={}) {
  if(!Number.isInteger(outerRandom)||outerRandom<0||outerRandom>0xffffffff)
    throw new RangeError('outerRandom must be an unsigned 32-bit integer');
  const fields=decodeProtobuf(serialized);
  const hash13=fields.find(f=>f.number===13&&f.wire===2)?.value;
  const hash14=fields.find(f=>f.number===14&&f.wire===2)?.value;
  if(hash13?.length!==20||hash14?.length!==6)
    throw new TypeError('The native Medusa profile requires its 20-byte and 6-byte digest fields');
  const packed=0x183000|((hash14[0]&63)<<6)|(hash13[0]&63);
  const frame=concat(Uint8Array.of(0x37),u32le(outerRandom),
    Uint8Array.of(1,packed&255,(packed>>>8)&255,packed>>>16),
    encryptMedusaMessage(serialized,random),new Uint8Array(2));
  const cipher=medusaOuterCipher(gatherMedusaBits(frame,111),timestamp);
  return base64(concat(buildMedusaPrefix({timestamp,random}),
    Uint8Array.of(cipher.at(-1)),scatterMedusaBits(frame,cipher.subarray(0,-1))));
}
