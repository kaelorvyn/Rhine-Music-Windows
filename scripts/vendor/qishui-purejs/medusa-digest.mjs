import { medusaDigestMd5Prefix } from './medusa-digest-md5.mjs';
import { medusaDigestShaPrefix } from './medusa-digest-sha.mjs';
import { medusaDigestTablePrefix } from './medusa-digest-table.mjs';
import { sm3 } from './sm3.mjs';

// query is the exact raw URL query without '?' and stub is the decoded
// 16-byte X-SS-STUB. Header lookup and missing-stub behavior remain separate.
export function buildMedusaDigestInput(query, stub, timestamp) {
  if (typeof query !== 'string') throw new TypeError('raw query must be a string');
  const stubBytes = Buffer.from(stub);
  if (stubBytes.length !== 16) throw new RangeError('stub must contain 16 bytes');
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) throw new RangeError('invalid timestamp');
  const input = Buffer.alloc(52);
  Buffer.from(sm3(Buffer.from(query, 'utf8'))).copy(input);
  stubBytes.copy(input, 32);
  input.writeUInt32LE(timestamp, 48);
  return input;
}

// The 52-byte input is query SM3 || request stub || u32le(timestamp).
export function deriveMedusaDigestSelector(input) {
  const data = Buffer.from(input);
  if (data.length !== 52) throw new RangeError('digest selector requires 52 bytes');
  let hash = 0x20230928;
  for (let i = 0; i < data.length; i++) {
    hash = (i & 1) ? hash ^ ~((hash << 12) ^ (hash >>> 7) ^ data[i])
      : hash ^ (hash << 6) ^ (hash >>> 4) ^ data[i];
    hash >>>= 0;
  }
  return hash & 15;
}

// Low-level entry point; the connected SDK supplies its derived runtime flag.
export function medusaDigestFromInput(input, timestamp, environmentFlag) {
  return medusaDigest(input, timestamp, deriveMedusaDigestSelector(input), environmentFlag);
}

// The native environment lookup returns a signed integer; only positivity
// affects this byte. runtime-integers.mjs supplies the connected lookup state.
export function medusaEnvironmentFlag(lookupResult) {
  if (!Number.isInteger(lookupResult) || lookupResult < -0x80000000 || lookupResult > 0x7fffffff)
    throw new RangeError('environment lookup result must be int32');
  return lookupResult > 0 ? 1 : 0;
}

export function medusaDigest(input, timestamp, selector, environmentFlag) {
  if (!Number.isInteger(selector) || selector < 0 || selector > 15) throw new RangeError('invalid digest selector');
  if (environmentFlag !== 0 && environmentFlag !== 1) throw new RangeError('environment flag must be 0 or 1');
  const calculate = [medusaDigestShaPrefix, medusaDigestTablePrefix, medusaDigestMd5Prefix][selector % 3];
  const prefix = calculate(input, timestamp, selector);
  let hash = 0x20220420;
  for (let i = 0; i < 12; i++) {
    hash = (i & 1) ? hash ^ ~((hash << 11) ^ (hash >>> 5) ^ prefix[i])
      : hash ^ (hash << 7) ^ (hash >>> 3) ^ prefix[i];
    hash >>>= 0;
  }
  const result = Buffer.alloc(20);
  prefix.copy(result);
  result.writeUInt32LE(hash, 16);
  result[16] |= 4;
  result[19] ^= environmentFlag;
  return result;
}
