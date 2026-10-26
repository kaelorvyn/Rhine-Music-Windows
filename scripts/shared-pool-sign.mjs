/**
 * 设备签名的低 S 规范化。
 *
 * 【2026-10-26】为什么需要这个：
 *
 * 服务端验签按「低 S」的标准来（s ≤ n/2）。Windows 的 CNG
 * （`NCryptSignHash`）天然保证这一点，所以用系统密钥容器签名时一直是对的。
 *
 * 但密钥文件里内嵌私钥之后，签名改在 Node 里做 —— 而 Node 的
 * `crypto.sign` **不保证**低 S。实测 3000 次里 1499 次（正好 50%）是高 S。
 * 不做这一步，一半请求会被判签名无效，而且表现为「时好时坏」，极难排查。
 *
 * 高 S 的等价签名是 (r, n − s)：r 不变，s 换成 n − s，签名依旧有效。
 */

/** P-256 曲线的阶 n。 */
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** n/2 —— s 不超过它就是低 S。 */
const P256_HALF_N = P256_N >> 1n;

/** DER 的 INTEGER 编码：最短形式，最高位为 1 时前面补 0x00（否则会被当成负数）。 */
function derInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  let p = 0;
  while (p < bytes.length - 1 && bytes[p] === 0) p++;
  bytes = bytes.subarray(p);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

/**
 * 把一份 DER 签名的 s 规范化成低 S。
 *
 * 已经是低 S 的原样返回（同一个 Buffer 引用）。
 * 输入不是合法 ECDSA 签名时也原样返回 —— 宁可原样交给服务端报错，
 * 也不要自己造出一个更糟的签名。
 */
export function normalizeLowS(der) {
  try {
    if (!Buffer.isBuffer(der) || der.length < 8) return der;
    if (der[0] !== 0x30) return der;
    let i = 2;                        // 跳过 SEQUENCE 头
    if (der[i] !== 0x02) return der;  // INTEGER r
    const rLen = der[i + 1];
    const rBytes = der.subarray(i + 2, i + 2 + rLen);
    i += 2 + rLen;
    if (der[i] !== 0x02) return der;  // INTEGER s
    const sLen = der[i + 1];
    const sBytes = der.subarray(i + 2, i + 2 + sLen);
    let s = 0n;
    for (const b of sBytes) s = (s << 8n) | BigInt(b);
    if (s <= P256_HALF_N) return der;
    // 高 S → 等价的低 S：s' = n − s
    const rVal = rBytes.length ? BigInt('0x' + rBytes.toString('hex')) : 0n;
    const body = Buffer.concat([derInteger(rVal), derInteger(P256_N - s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  } catch {
    return der;
  }
}
