import { profiles } from './medusa-digest-table-data.mjs';

const mask = (1n << 64n) - 1n;
const tables = new Map(Object.entries(profiles).map(([selector, profile]) => [Number(selector),
  profile.tables.map(hex => {
    const data = Buffer.from(hex, 'hex');
    return Array.from({ length: 256 }, (_, i) => data.readBigUInt64LE(i * 8));
  }),
]));
const rotateRight = (value, count) => {
  const n = count & 63n;
  return ((value >> n) | (value << ((64n - n) & 63n))) & mask;
};
const transform = (state, table) => Array.from({ length: 8 }, (_, i) => {
  let value = 0n;
  for (let j = 0; j < 8; j++) {
    const index = Number((state[(i - j) & 7] >> BigInt(56 - 8 * j)) & 255n);
    value ^= table[j][index];
  }
  return value;
});

// The final four digest bytes also depend on an environment flag, so this
// function only exposes the independently verified 16-byte prefix.
export function medusaDigestTablePrefix(input, timestamp, selector) {
  const profile = profiles[selector];
  if (!Number.isInteger(selector) || !Object.hasOwn(profiles, selector)) throw new RangeError('unsupported table digest selector');
  const data = Buffer.from(input);
  if (data.length !== 52) throw new RangeError('table digest requires the observed 52-byte input');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('invalid timestamp');
  const seed = BigInt(timestamp);
  const padded = Buffer.alloc(128);
  data.copy(padded);
  padded[52] = 0x80;
  padded.writeBigUInt64BE(416n, 120);
  let hash = Array(8).fill(rotateRight(seed, seed + profile.iv));
  const order = [4, 5, 6, 7, 0, 1, 2, 3];
  const feedbackOrder = [1, 2, 3, 4, 5, 6, 7, 0];
  const table = tables.get(selector);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const message = Array.from({ length: 8 }, (_, i) => padded.readBigUInt64BE(offset + i * 8));
    let key = order.map(i => hash[i]);
    let state = order.map((i, j) => hash[i] ^ message[profile.messageOrder[j]]);
    for (let round = 1; round <= 10; round++) {
      key = transform(key, table);
      key[0] ^= rotateRight(profile.constants[round], seed + profile.rotate);
      state = transform(state, table).map((value, i) => value ^ key[i]);
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
