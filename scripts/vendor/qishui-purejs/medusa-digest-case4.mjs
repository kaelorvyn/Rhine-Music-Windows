import { tablesHex, roundConstants } from './medusa-digest-case4-data.mjs';

const mask = (1n << 64n) - 1n;
const tables = tablesHex.map(hex => {
  const data = Buffer.from(hex, 'hex');
  return Array.from({ length: 256 }, (_, i) => data.readBigUInt64LE(i * 8));
});
const rotateRight = (value, count) => {
  const n = count & 63n;
  return ((value >> n) | (value << ((64n - n) & 63n))) & mask;
};
const transform = state => Array.from({ length: 8 }, (_, i) => {
  let value = 0n;
  for (let j = 0; j < 8; j++) {
    const index = Number((state[(i - j) & 7] >> BigInt(56 - 8 * j)) & 255n);
    value ^= tables[j][index];
  }
  return value;
});

// Produces the first 16 digest bytes for selector 4; the final four bytes
// depend on a separately observed environment flag and are not assumed here.
export function medusaDigestCase4Prefix(input, timestamp) {
  const data = Buffer.from(input);
  if (data.length !== 52) throw new RangeError('case 4 requires the observed 52-byte input');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('invalid timestamp');
  const seed = BigInt(timestamp);
  const padded = Buffer.alloc(128);
  data.copy(padded);
  padded[52] = 0x80;
  padded.writeBigUInt64BE(416n, 120);
  let hash = Array(8).fill(rotateRight(seed, seed + 12n));
  const order = [4, 5, 6, 7, 0, 1, 2, 3];
  const messageOrder = [4, 5, 3, 1, 7, 6, 2, 0];
  const feedbackOrder = [1, 2, 3, 4, 5, 6, 7, 0];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const message = Array.from({ length: 8 }, (_, i) => padded.readBigUInt64BE(offset + i * 8));
    let key = order.map(i => hash[i]);
    let state = order.map((i, j) => hash[i] ^ message[messageOrder[j]]);
    for (let round = 1; round <= 10; round++) {
      key = transform(key);
      key[0] ^= rotateRight(roundConstants[round], seed + 13n);
      state = transform(state).map((value, i) => value ^ key[i]);
    }
    hash = hash.map((value, i) => value ^ state[i] ^ message[feedbackOrder[i]]);
  }
  const output = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    const combined = hash[3 - i] ^ hash[7 - i];
    for (let j = 0; j < 4; j++) output[i * 4 + j] = Number((combined >> BigInt([8, 24, 40, 48][j])) & 255n);
  }
  return output;
}
