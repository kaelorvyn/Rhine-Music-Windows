/**
 * 自检：密钥文件加密（keyfile-envelope）与凭据存储。
 *
 * 覆盖：加密往返、magic 校验、篡改必须失败、老明文兼容、落盘文件不是可读 JSON、
 * status() 不再泄露账号名。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as envelope from '../scripts/keyfile-envelope.mjs'
import * as credential from '../scripts/pool-credential.mjs'

const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail ? '：' + detail : ''}`)
}

const sample = {
  format: 3,
  token: 'header.payload.signature',
  key: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  did: 'desktop-local',
  servers: ['https://example.invalid'],
}

// ── 1. 往返
const encoded = envelope.encode(sample)
check('加密结果带 magic', encoded.subarray(0, 4).toString('ascii') === 'RHK1')
check('加密结果不是明文 JSON', encoded[0] !== 0x7b)
const decoded = envelope.decode(encoded)
check('往返取值一致', JSON.stringify(decoded.value) === JSON.stringify(sample))
check('标记为非明文', decoded.plaintext === false)

// ── 2. 二进制不可读
const printable = [...encoded].filter((byte) => byte >= 32 && byte <= 126).length / encoded.length
check('可打印字符比例低（记事本里是乱码）', printable < 0.6, `实际 ${(printable * 100).toFixed(0)}%`)

// ── 3. 篡改必须失败
const tampered = Buffer.from(encoded)
tampered[tampered.length - 1] ^= 0xff
let threw = false
try { envelope.decode(tampered) } catch { threw = true }
check('篡改一字节后解密失败', threw)

// ── 4. 老明文兼容
const legacy = Buffer.from(JSON.stringify(sample), 'utf8')
const legacyDecoded = envelope.decode(legacy)
check('老明文可读', JSON.stringify(legacyDecoded.value) === JSON.stringify(sample))
check('标记为明文', legacyDecoded.plaintext === true)

// ── 5. 垃圾输入
let rejected = 0
for (const bad of [Buffer.from('hello world'), Buffer.from('{oops'), Buffer.alloc(0)]) {
  try { envelope.decode(bad) } catch { rejected += 1 }
}
check('非法输入被拒绝', rejected === 3, `只拒绝 ${rejected}/3`)

// ── 6. 凭据落盘加密 + 状态不含账号名
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-cred-'))
try {
  const payload = credential.importKeyFile(dir, legacy)
  check('导入后拿到 importedAt', typeof payload.importedAt === 'string')
  const file = path.join(dir, credential.CREDENTIAL_FILE)
  check('落盘文件存在', fs.existsSync(file))
  const raw = fs.readFileSync(file)
  check('落盘不是可读 JSON', raw[0] !== 0x7b && envelope.isEnvelope(raw))
  check('落盘不含 token 明文', !raw.includes(Buffer.from(String(sample.token))))

  const status = credential.status(dir)
  check('status 已配置', status.configured === true)
  check('status 不返回账号名', !Object.hasOwn(status, 'account'), JSON.stringify(Object.keys(status)))

  const exported = credential.exportKeyFile(dir)
  check('导出是二进制信封', Buffer.isBuffer(exported) && envelope.isEnvelope(exported))
  check('导出可被重新导入', JSON.stringify(envelope.decode(exported).value.token) === JSON.stringify(sample.token))

  check('清除后文件消失', credential.clear(dir) && !fs.existsSync(file))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error('✗ 密钥文件加密自检未通过：')
  for (const line of failures) console.error('  · ' + line)
  process.exit(1)
}
console.log(`✓ 密钥文件加密自检通过（往返 / magic / 篡改 / 明文兼容 / 落盘密文 / 不泄露账号名）`)
console.log(`  可打印字符比例 ${(printable * 100).toFixed(0)}%，文件头 ${[...encoded.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
void crypto
