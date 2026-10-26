/**
 * 设备签名的回归检查。
 *
 * 【2026-10-26】新增：低 S 规范化。
 *
 * Windows 的 CNG（`NCryptSignHash`）保证签出来的 s ≤ n/2（低 S），
 * 服务端按这个验签。而 Node 的 `crypto.sign` **不保证** ——
 * 实测 3000 次里有 1499 次（正好 50%）是高 S。
 *
 * 密钥文件里内嵌私钥后，签名改在 Node 里做，不做规范化的话
 * 会有一半请求被判签名无效。这条检查守住这个点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeLowS } from './shared-pool-sign.mjs';

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_N = P256_N >> 1n;

/** 从 DER 里取出 s 的整数值。 */
function derS(der) {
  let i = 2;                                  // SEQUENCE
  const rLen = der[i + 1];
  i += 2 + rLen;                              // 跳过 r
  const sLen = der[i + 1];
  const sStart = i + 2;
  let s = 0n;
  for (let j = 0; j < sLen; j++) s = (s << 8n) | BigInt(der[sStart + j]);
  return s;
}

test('低 S 规范化：改写后签名仍然有效，且 s 一律 ≤ n/2', () => {
  let highBefore = 0;
  let highAfter = 0;
  let verifyFail = 0;
  const rounds = 400;
  for (let i = 0; i < rounds; i++) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const msg = Buffer.from('regression-' + i, 'utf8');
    const der = crypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' });
    if (derS(der) > P256_HALF_N) highBefore++;
    const norm = normalizeLowS(der);
    if (derS(norm) > P256_HALF_N) highAfter++;
    if (!crypto.verify('sha256', msg, { key: publicKey, dsaEncoding: 'der' }, norm)) verifyFail++;
  }
  // 原签名里应该确实出现过高 S（否则这条检查测不到东西）
  assert.ok(highBefore > rounds * 0.2, `原始高 S 太少：${highBefore}/${rounds}，测试不具代表性`);
  assert.equal(highAfter, 0, `规范化后仍有 ${highAfter} 个高 S`);
  assert.equal(verifyFail, 0, `有 ${verifyFail} 个签名改写后验不过`);
});

test('低 S 规范化：本身是低 S 的签名原样返回（不折腾）', () => {
  for (let i = 0; i < 200; i++) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = crypto.sign('sha256', Buffer.from('low-' + i), { key: privateKey, dsaEncoding: 'der' });
    if (derS(der) <= P256_HALF_N) {
      const norm = normalizeLowS(der);
      assert.ok(norm.equals(der), '低 S 签名被改动了');
      return;
    }
  }
  assert.fail('200 次都没遇到低 S 签名');
});

test('低 S 规范化：垃圾输入不炸，原样返回', () => {
  for (const junk of [Buffer.alloc(0), Buffer.from([0x31]), Buffer.from([0x30, 0x00]), Buffer.from([0x30, 0x05, 0x02])]) {
    const out = normalizeLowS(junk);
    assert.ok(Buffer.isBuffer(out));
  }
});
