import { profiles, messageOrder, constants } from './medusa-digest-md5-data.mjs';

const initial = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93];
const mask = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4];
const padding = Buffer.from('8496779dd4150bf8', 'hex');
const shifts = [[7,12,17,22], [5,9,14,20], [4,11,16,23], [6,10,15,21]];
const ror = (value, shift) => (value >>> (shift & 31)) | (value << ((32 - shift) & 31));
const rol = (value, shift) => ror(value, -shift);
const ror8 = (value, shift) => ((value >>> (shift & 7)) | (value << ((8 - shift) & 7))) & 255;

// The independently verified part is the first 16 bytes of the digest.
export function medusaDigestMd5Prefix(input, timestamp, selector) {
  if (!Number.isInteger(selector) || !Object.hasOwn(profiles, selector)) throw new RangeError('unsupported MD5-shaped digest selector');
  const data = Buffer.from(input);
  if (data.length !== 52) throw new RangeError('MD5-shaped digest requires the observed 52-byte input');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('invalid timestamp');
  const [iv, padRotate, maskRotate] = profiles[selector];
  const h = initial.map(value => ror(value, timestamp + iv));
  const block = Buffer.alloc(64);
  data.copy(block);
  for (let i = 0; i < 8; i++) block[52 + i] = ror8(padding[i], timestamp + padRotate);
  block.writeUInt32LE(416, 60);
  const words = Array.from({ length: 16 }, (_, i) => block.readUInt32LE(i * 4));
  let [a,b,c,d] = h;
  for (let i = 0; i < 64; i++) {
    const group = Math.floor(i / 16);
    let f;
    if (group === 0) f = d ^ (b & (c ^ d));
    else if (group === 1) f = c ^ (d & (b ^ c));
    else if (group === 2) f = b ^ c ^ d;
    else f = c ^ (b | ~d);
    const k = ror(constants[group][i % 16], timestamp + iv + 1 + group);
    const next = (b + rol(a + f + k + words[messageOrder[selector][i]], shifts[group][i % 4])) >>> 0;
    [a,b,c,d] = [d,next,b,c];
  }
  const state = [a,b,c,d];
  const output = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) output.writeUInt32LE(((h[i] + state[i]) ^ ror(mask[i], timestamp + maskRotate)) >>> 0, i * 4);
  return output;
}
