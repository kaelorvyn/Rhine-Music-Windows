import { constants, profiles } from './medusa-digest-sha-data.mjs';

const initial = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
  0x3aab4d10, 0xb31d643a, 0xab4fabed, 0x804b3850];
const padding = Buffer.from('fa4561d7c275611a7fe36db35753be7b5f7c6bdf4a7ab45ab214ad2dc44d52882b56d71a147f5f0c57681c153a1a6107a08066f616eba52cffde767d475dd8d6', 'hex');
const ror = (value, shift) => (value >>> (shift & 31)) | (value << ((32 - shift) & 31));
const ror8 = (value, shift) => ((value >>> (shift & 7)) | (value << ((8 - shift) & 7))) & 255;

// The independently verified part is the first 16 bytes of the digest.
export function medusaDigestShaPrefix(input, timestamp, selector) {
  if (!Number.isInteger(selector) || !Object.hasOwn(profiles, selector)) throw new RangeError('unsupported SHA-shaped digest selector');
  const data = Buffer.from(input);
  if (data.length !== 52) throw new RangeError('SHA-shaped digest requires the observed 52-byte input');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('invalid timestamp');
  const [iv, constantRotate, padRotate, start, rounds, hIndex, choiceIndices, majorityIndices, output, added] = profiles[selector];
  const h = initial.map(value => ror(value, timestamp + iv));
  const k = constants.map(value => ror(value, timestamp + constantRotate));
  const block = Buffer.alloc(64);
  data.copy(block);
  for (let i = 0; i < 4; i++) block[52 + i] = ror8(padding[i], timestamp + padRotate);
  block.writeBigUInt64BE(416n, 56);
  const w = Array.from({ length: 16 }, (_, i) => block.readUInt32BE(i * 4));
  for (let i = 16; i < 128; i++) {
    const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w.push((w[i - 16] + s0 + w[i - 7] + s1) >>> 0);
  }
  let z = h.slice();
  for (let index = start; index < start + rounds; index++) {
    const [e, f, g] = choiceIndices.map(i => z[i]);
    const [a, b, c] = majorityIndices.map(i => z[i]);
    const s1 = ror(e, 6) ^ ror(e, 25) ^ ror(e, 11);
    const t1 = (z[hIndex] + k[index & 63] + w[index & 127] + (g ^ (e & (f ^ g))) + s1) >>> 0;
    const s0 = ror(a, 2) ^ ror(a, 22) ^ ror(a, 13);
    const t2 = (s0 + ((a & b) | (c & (a | b)))) >>> 0;
    const next = z.map((_, i) => z[(i - 1) & 7]);
    next[output] = (t1 + t2) >>> 0;
    next[added] = (next[added] + t1) >>> 0;
    z = next;
  }
  const raw = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) raw.writeUInt32BE((h[i] + z[i]) >>> 0, i * 4);
  return Buffer.from(raw.subarray(0, 16).map((value, i) => value ^ raw[16 + i]));
}
