/** Portable byte-oriented primitives. No Node imports or native extensions. */
export const utf8 = value => new TextEncoder().encode(String(value));
export const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
export function unhex(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[\da-f]*$/i.test(value))
    throw new TypeError('Expected an even-length hexadecimal string');
  return Uint8Array.from(value.match(/../g) ?? [], x => Number.parseInt(x, 16));
}
export function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
export function u32le(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
const rotate = (v, n) => (v << n) | (v >>> (32 - n));
const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
const md5K = Uint32Array.from({length:64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
export function md5(input) {
  const length = input.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(input); padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a,b,c,d] = h;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = (a + f + md5K[i] + view.getUint32(offset + 4*g, true)) | 0;
      [a,b,c,d] = [d, (b + rotate(t, shifts[(i >>> 4)*4 + i%4])) | 0, b, c];
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
  }
  return concat(...h.map(u32le));
}
const xtime = n => ((n << 1) ^ ((n & 0x80) ? 0x11b : 0)) & 255;
function multiply(a, b) {
  let out = 0;
  for (; b; b >>>= 1, a = xtime(a)) if (b & 1) out ^= a;
  return out;
}
const rol8 = (n, shift) => ((n << shift) | (n >>> (8 - shift))) & 255;
const sbox = Uint8Array.from({length:256}, (_, n) => {
  let inverse = n ? 1 : 0;
  if (n) for (let i = 0; i < 254; i++) inverse = multiply(inverse, n);
  return inverse ^ rol8(inverse,1) ^ rol8(inverse,2) ^ rol8(inverse,3) ^ rol8(inverse,4) ^ 0x63;
});
function expandKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 16) throw new TypeError('AES-128 requires a 16-byte key');
  const expanded = new Uint8Array(176);
  expanded.set(key);
  let rcon = 1;
  for (let i = 16; i < expanded.length; i += 4) {
    let t = expanded.slice(i - 4, i);
    if (i % 16 === 0) {
      t = Uint8Array.of(sbox[t[1]] ^ rcon, sbox[t[2]], sbox[t[3]], sbox[t[0]]);
      rcon = xtime(rcon);
    }
    for (let j = 0; j < 4; j++) expanded[i+j] = expanded[i+j-16] ^ t[j];
  }
  return expanded;
}
function encryptWithSchedule(block, schedule) {
  if (block.length !== 16) throw new TypeError('AES block must be 16 bytes');
  let state = Uint8Array.from(block, (b, i) => b ^ schedule[i]);
  for (let round = 1; round <= 10; round++) {
    const substituted = Uint8Array.from(state, b => sbox[b]);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
      state[col*4+row] = substituted[((col + row) % 4)*4+row];
    if (round < 10) {
      for (let col = 0; col < 4; col++) {
        const p = col * 4;
        const [a,b,c,d] = state.slice(p, p+4), t = a ^ b ^ c ^ d;
        state[p] = a ^ t ^ xtime(a ^ b);
        state[p+1] = b ^ t ^ xtime(b ^ c);
        state[p+2] = c ^ t ^ xtime(c ^ d);
        state[p+3] = d ^ t ^ xtime(d ^ a);
      }
    }
    state = Uint8Array.from(state, (b, i) => b ^ schedule[round*16+i]);
  }
  return state;
}
export const aes128Block = (block, key) => encryptWithSchedule(block, expandKey(key));
export function aes128CbcPkcs7(plaintext, key, iv) {
  if (iv.length !== 16) throw new TypeError('AES-CBC IV must be 16 bytes');
  const padding = 16 - plaintext.length % 16;
  const padded = new Uint8Array(plaintext.length + padding);
  padded.set(plaintext); padded.fill(padding, plaintext.length);
  const schedule = expandKey(key);
  const out = new Uint8Array(padded.length);
  let previous = iv;
  for (let offset = 0; offset < padded.length; offset += 16) {
    const input = Uint8Array.from(padded.slice(offset,offset+16), (b,i) => b ^ previous[i]);
    previous = encryptWithSchedule(input, schedule);
    out.set(previous, offset);
  }
  return out;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a=bytes[i], b=bytes[i+1] ?? 0, c=bytes[i+2] ?? 0;
    result += alphabet[a>>>2] + alphabet[((a&3)<<4)|(b>>>4)];
    result += i+1<bytes.length ? alphabet[((b&15)<<2)|(c>>>6)] : '=';
    result += i+2<bytes.length ? alphabet[c&63] : '=';
  }
  return result;
}
