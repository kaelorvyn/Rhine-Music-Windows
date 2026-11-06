// sm3.mjs — SM3 (GB/T 32905-2016), IV verified against gmssl + hashlib
const IV = [0x7380166F, 0x4914B2B9, 0x172442D7, 0xDA8A0600,
            0xA96F30BC, 0x163138AA, 0xE38DEE4D, 0xB0FB0E4E];
const T = new Array(64);
for (let i = 0; i < 16; i++) T[i] = 0x79CC4519;
for (let i = 16; i < 64; i++) T[i] = 0x7A879D8A;

function rotl(x, n) {
    n &= 31;
    return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function p0(x) { return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0; }
function p1(x) { return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0; }
function ff(j, x, y, z) {
    return j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0;
}
function gg(j, x, y, z) {
    return j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | ((~x >>> 0) & z)) >>> 0;
}

function compress(v, block) {
    const w = new Array(68);
    for (let i = 0; i < 16; i++)
        w[i] = ((block[i*4] << 24) | (block[i*4+1] << 16) | (block[i*4+2] << 8) | block[i*4+3]) >>> 0;
    for (let j = 16; j < 68; j++)
        w[j] = (p1((w[j-16] ^ w[j-9] ^ rotl(w[j-3], 15)) >>> 0) ^ rotl(w[j-13], 7) ^ w[j-6]) >>> 0;
    const w1 = new Array(64);
    for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j+4]) >>> 0;

    let a=v[0],b=v[1],c=v[2],d=v[3],e=v[4],f=v[5],g=v[6],h=v[7];
    for (let j = 0; j < 64; j++) {
        const ss1 = rotl(((rotl(a,12) + e + rotl(T[j], j)) >>> 0), 7);
        const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
        const tt1 = ((ff(j,a,b,c) + d + ss2 + w1[j]) >>> 0);
        const tt2 = ((gg(j,e,f,g) + h + ss1 + w[j]) >>> 0);
        d=c; c=rotl(b,9); b=a; a=tt1;
        h=g; g=rotl(f,19); f=e; e=p0(tt2);
    }
    return [(v[0]^a)>>>0,(v[1]^b)>>>0,(v[2]^c)>>>0,(v[3]^d)>>>0,
            (v[4]^e)>>>0,(v[5]^f)>>>0,(v[6]^g)>>>0,(v[7]^h)>>>0];
}

export function sm3(msg) {
    const len = msg.length, bitLen = len * 8;
    const padLen = (len + 9 + 63) & ~63;
    const padded = new Uint8Array(padLen);
    padded.set(msg); padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(padLen - 4, bitLen >>> 0, false);
    let v = IV.slice();
    for (let i = 0; i < padLen; i += 64) v = compress(v, padded.slice(i, i + 64));
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, v[i], false);
    return out;
}
