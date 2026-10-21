/**
 * QMC 解密
 * ============================================================================
 * 证据来源（**全部在当前 exe 上实测，不是旧构建的伪 C**）：
 *   依据：公开技术资料与样本实测对照
 *   当前 exe 的 PE 节表（rabin2 -S）：
 *     .text / file 0x000400 / 0x1c91000
 *     .rdata / file 0x1c90e00 / 0x89e000
 *
 * 【重要】docs/qmc-spec.md 里那份 `crypto-decompiled.c` 的地址来自**旧构建**

 * 在当前 exe 里是 ZIP 解析代码，**不是** TEA。本文件的所有地址都是当前 exe 实测。
 *
 * ── 已证实（反汇编逐条对照）────────────────────────────────────────────────
 * 1) QMC TEA 核心 = ``（当前 exe）。
 *    16 轮常量在当前 exe .text 中连续出现：VA →，顺序：
 *      0xE3779B90,0x454021D7,0xA708A81E,0x08D12E65,0x6A99B4AC,0xCC623AF3,
 *      0x2E2AC13A,0x8FF34781,0xF1BBCDC8,0x5384540F,0xB54CDA56,0x1715609D,
 *      0x78DDE6E4,0xDAA66D2B,0x3C6EF372,0x9E3779B9
 *    它们 = delta(0x9E3779B9) × k 的常量折叠；起点 0xE3779B90 = delta*16 (mod 2^32)。
 *    反汇编实证：
 *  mov r10d,[rcx]      ; key[0]
 *  bswap r10d          ; 输入 bswap（大端→小端）
 *  mov r8d,[rdx]  + bswap   ; data[0]
 *  mov eax,r10d / shl eax,4 / add eax,r9d   ; (v0<<4)+k2
 *  lea esi,[r10-0x1C886470]  ; +0xE3779B90（补码）
 *  xor esi,eax
 *  mov eax,r10d / shr eax,5 / add eax,edx   ; (v0>>5)+k3
 *  xor eax,esi / sub r11d,eax               ; v1 -= ...
 *    → 标准 TEA 解密，16 轮 × 2 次轮函数。字节序：输入输出均 bswap32。
 *
 * 2) QMC static cipher（= 酷我/QQ 的 "静态密钥" 流密码）在当前 exe 中位于
 *    `` 一带，反汇编逐条对应实现：
 *  and r11d,7                     ; (idx & 7)
 *  xor dl,4                       ; idx ^ 4
 *  rol r13b,cl                    ; 循环左移
 *  cmp r11d,4 / cmove ecx,eax   ; 旋转量 0 时退化
 *  xor byte [r10],cl              ; 输出 ^= 掩码
 *  mov rax,r8 ... imul rax,rax / add rax,0x1162E
 *                                                   ; mask = (idx² + 0x1162E) % n
 *  cmp r8,0x8000 / cmovl rax,r8   ; idx = i<0x8000 ? i : i%0x7FFF
 *    → mask(i) = rotl8(key[(pow(i)²+0x1162E) % n], (((pow(i)²+0x1162E) % n) ^ 4) & 7)
 *
 * 3) QMC 分块参数（`` 对应体）：前 **0x80 = 128 字节**特殊处理，
 *    之后按 **0x1400 = 5120 字节**分块，块内按 offset 计算。
 *
 * 4) 酷我 DES 是**标准 DES（FIPS 46-3）**。当前 exe 里存在标准表：
 * (56×int32) = DES PC-1（0 基），逐项等于 FIPS 值减 1
 * (16×int32) = DES 循环左移表 [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1]
 * (64×int32) = DES PC-2（0 基，含 -1 占位）
 *    → 直接用 node:crypto 的 des-ecb/des-cbc 即可，无需自实现。
 *
 * 5) 酷我 ekey：base64 → **728 字节**（实测 3/3 样本，%8==0，91 个 DES 块），
 *    尾部 8 字节在三样本中**完全相同**（`6a63488853e41dd1`）→ 固定尾部标记。
 *
 * ── ⚠️ 未解（本文件不编造，运行时如实抛错）────────────────────────────────
 * A) **kuwo_feistel.rs 的位重排表**：当前 exe 中尚未定位到干净的位索引表。
 *    （注意：// 是 **DES 内部表**，不是它。）
 * B) **ekey → QMC 原始密钥 的 DES 密钥**：候选密钥串（"yeelion"/"kwplayer" 等）
 *    均未通过校验。ekey 中也不含明文密钥。
 * C) **RC4 / mapCipher 的密钥材料**：分支骨架已实现，密钥来源未解。
 *
 * 由 (A)(B) 可知：**酷我 mflac 的端到端解密目前无法完成**。因此
 * `decryptBuffer` 对酷我加密格式会抛出 `EKEY_UNRESOLVED`，绝不返回垃圾数据。
 * 这符合 exe 的失败语义（`无法从酷我 ekey 中提取 QMC 原始密钥`、
 * `音频解密结果校验失败`），也符合"绝不降级成试听"。
 *
 * 反解出的部分 QMC 密钥字节（供后续攻坚，见 verifyNotes）：
 *   由 FLAC 明文头 `66 4C 61 43 00 00 00 22` 反推，n=128 时得到 8 个**分散**下标：
 *     key[46]=0x13 key[47]=0x2B key[50]=0xC4 key[55]=0x06
 *     key[62]=0x4D key[71]=0x69 key[82]=0xD0 key[95]=0xA6
 *   （分散 → 证明它不是 8 字节周期密钥；8 字节周期 XOR 只能对上文件头，
 *     正文会解出垃圾 STREAMINFO，实测 sampleRate=192048/channels=3/时长 58h。）
 * ============================================================================
 */
import { Transform } from 'node:stream'

// ── 错误语义（对齐 exe 文案）────────────────────────────────────────────────

export const QMC_ERRORS = {
  ENCRYPTED_NO_KEY: '加密音频响应缺少解密密钥',
  EKEY_DECODE: 'qmc key base64 failed',
  EKEY_UNRESOLVED: '无法从酷我 ekey 中提取 QMC 原始密钥',
  EKEY_NOT_MULTIPLE_OF_8: '酷我 ekey 解密数据长度不是 8 的倍数',
  KUWO_CIPHERTEXT_INVALID: '酷我密文长度非法',
  TEA_PADDING: 'invalid TEA padding',
  RC4_KEY_EMPTY: 'qmc rc4 cipher key cannot be empty',
  MAP_KEY_EMPTY: 'qmc map cipher key cannot be empty',
  RESULT_CHECK: '音频解密结果校验失败',
  QQ_HIGH_QUALITY: 'QQ 高阶音质返回加密资源，当前桌面端暂不支持解密',
  KUWO_URL_UNCHANGED: '重新获取的酷我链接与密钥未变化，已停止重试',
  REFRESH_URL_ONCE: '[download] Kuwo decrypt failed for %s, refreshed URL once: %s',
}

/** 带 exe 语义错误码的错误类型 */
export class QmcError extends Error {
  constructor (code, message = QMC_ERRORS[code] ?? code, extra = {}) {
    super(message)
    this.name = 'QmcError'
    this.code = code
    Object.assign(this, extra)
  }
}

// ── 格式判定 ────────────────────────────────────────────────────────────────

/** 认定为「加密容器」的后缀（实测 exe 内嵌格式名） */
export const ENCRYPTED_FORMATS = new Set([
  'mflac', 'mflac0', 'mflac2', 'mflach',
  'mgg', 'mgg0', 'mgg1', 'mggl', 'mgg2',
])

/** 明文档位后缀（可直接播，无需解密） */
export const PLAIN_FORMATS = new Set([
  'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'ape', 'dsf', 'dff', 'aiff',
])

/** 归一化平台名（exe 用 netease/qq/kugou/kuwo/bodian/joox） */
const PROVIDER_ALIASES = {
  wy: 'netease', netease: 'netease', 网易: 'netease', 网易云: 'netease',
  tx: 'qq', qq: 'qq',
  kg: 'kugou', kugou: 'kugou', 酷狗: 'kugou',
  kw: 'kuwo', kuwo: 'kuwo', 酷我: 'kuwo',
  bodian: 'bodian', mg: 'bodian',
  joox: 'joox',
}

export function normalizeProvider (provider) {
  return PROVIDER_ALIASES[String(provider ?? '').toLowerCase()] ?? String(provider ?? '').toLowerCase()
}

/** 去掉前导点 / 大写归一，并剥掉 `mflac-flac` 这类复合名的主段 */
export function normalizeFormat (format) {
  const raw = String(format ?? '').trim().toLowerCase().replace(/^\./, '')
  if (!raw) return ''
  if (ENCRYPTED_FORMATS.has(raw) || PLAIN_FORMATS.has(raw)) return raw
  // 复合名如 "mflac-flac"、"mgg1-mp3"：取第一段
  const head = raw.split(/[-_]/)[0]
  return head
}

/** 该音源格式是否需要解密 */
export function isEncrypted (format) {
  return ENCRYPTED_FORMATS.has(normalizeFormat(format))
}

/**
 * 的「高阶音质」集合（QQ 高阶一律拒绝解密，静默回落明文档位）。
 * 依据 exe 原文：`QQ 高阶音质返回加密资源，当前桌面端暂不支持解密`
 */
export const HIGH_QUALITY = new Set(['master', 'hires', 'hifi', 'surround', 'jymaster', 'sky', 'jyeffect'])

/**
 * 该 (provider, format) 是否支持解密。
 *
 * 对齐的平台差异：
 *   · QQ **高阶** → false（明确拒绝，静默回落明文档位）
 *   · 酷我 → 链路已实现（DES→Feistel→QMC），但**密钥派生未解**，
 *            因此这里返回 true（协议上"支持"），实际解密会抛 EKEY_UNRESOLVED。
 *   · 其他平台加密格式 → false
 *
 * @param {string} provider
 * @param {string} format
 * @param {string} [quality] 传入音质档位时，QQ 高阶会被拒
 */
export function supportsDecrypt (provider, format, quality) {
  if (!isEncrypted(format)) return false
  const p = normalizeProvider(provider)
  if (p === 'qq') {
    // 高阶必须传 quality 才可判定；若显式给了高阶档位则拒绝。
    if (quality && HIGH_QUALITY.has(String(quality).toLowerCase())) return false
    // QQ 的 mgg/mflac 在里也走 QMC；标准档通常是明文，加密即高阶。
    return quality === undefined ? true : false
  }
  if (p === 'kuwo') return true
  return false
}

/** 明文容器魔数 → 校验解密结果（exe 的「音频解密结果校验失败」判据） */
const CONTAINER_MAGIC = [
  { name: 'flac', mime: 'audio/flac', bytes: [0x66, 0x4C, 0x61, 0x43] },          // fLaC
  { name: 'ogg', mime: 'audio/ogg', bytes: [0x4F, 0x67, 0x67, 0x53] },            // OggS
  { name: 'mp3-id3', mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },             // ID3
  { name: 'mp3-frame', mime: 'audio/mpeg', bytes: [0xFF, 0xFB] },                 // MPEG1 L3
  { name: 'mp3-frame2', mime: 'audio/mpeg', bytes: [0xFF, 0xFA] },                // MPEG1 L3 no CRC
  { name: 'mp3-frame3', mime: 'audio/mpeg', bytes: [0xFF, 0xF3] },                // MPEG2
  { name: 'mp3-frame4', mime: 'audio/mpeg', bytes: [0xFF, 0xF2] },                // MPEG2 no CRC
  { name: 'm4a', mime: 'audio/mp4', bytes: [0x00, 0x00, 0x00] },                  // ftyp（放宽）
  { name: 'wav', mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46] },            // RIFF
  { name: 'dsf', mime: 'audio/x-dsf', bytes: [0x44, 0x53, 0x44, 0x20] },          // DSD
]

/**
 * 校验解密结果是否是合法音频容器。
 * 这是 exe `音频解密结果校验失败` 的落地判据，防止把垃圾当音频播出去。
 * @returns {{name:string,mime:string}|null}
 */
export function validateContainer (buf, expectFormat) {
  if (!buf || buf.length < 4) return null
  const want = PLAIN_FORMATS.has(normalizeFormat(expectFormat)) ? normalizeFormat(expectFormat) : null
  for (const c of CONTAINER_MAGIC) {
    if (c.bytes.every((b, i) => buf[i] === b)) {
      // m4a 的 0x000000 太宽泛，要求出现 'ftyp'
      if (c.name === 'm4a' && buf.subarray(4, 8).toString('latin1') !== 'ftyp') continue
      if (want && !magicMatchesFormat(c.name, want)) continue
      return { name: c.name, mime: c.mime }
    }
  }
  return null
}

function magicMatchesFormat (magicName, wantFormat) {
  const map = {
    flac: ['flac'],
    ogg: ['ogg', 'opus'],
    'mp3-id3': ['mp3'], 'mp3-frame': ['mp3'], 'mp3-frame2': ['mp3'], 'mp3-frame3': ['mp3'], 'mp3-frame4': ['mp3'],
    m4a: ['m4a', 'aac'], wav: ['wav'], dsf: ['dsf', 'dff'],
  }
  const allowed = map[magicName]
  return !allowed || allowed.includes(wantFormat)
}

// ── 基础密码原语 ────────────────────────────────────────────────────────────

const DELTA = 0x9E3779B9
const u32 = x => x >>> 0

/** 32 位字节序反转（在 TEA 输入/输出两端都做） */
export const bswap32 = x => u32(((x >>> 24) & 0xFF) | ((x >>> 8) & 0xFF00) | ((x << 8) & 0xFF0000) | ((x << 24) & 0xFF000000))

const rotl8 = (v, r) => { r &= 7; return r === 0 ? (v & 0xFF) : (((v << r) | (v >>> (8 - r))) & 0xFF) }
const rotr8 = (v, r) => { r &= 7; return r === 0 ? (v & 0xFF) : (((v >>> r) | (v << (8 - r))) & 0xFF) }

/**
 * TEA 解密 8 字节块（对齐 ``）。
 * @param {number} v0 第一个字（**已 bswap**，即函数内部的 k[0]/k[1] 语义）
 * @param {number} v1
 * @param {number[]} k 4 个 u32（来自 param_2 的 16 字节，已 bswap）
 * @returns {[number, number]}
 */
export function teaDecryptBlock (v0, v1, k) {
  let sum = u32(DELTA * 16) // 0xE3779B90
  v0 = u32(v0); v1 = u32(v1)
  const k0 = u32(k[0]), k1 = u32(k[1]), k2 = u32(k[2]), k3 = u32(k[3])
  // 注意顺序：v1 与 v0 必须用【同一个 sum】撤销，最后才 sum -= DELTA。
  // 若在两者之间就减 DELTA，v0 会用错 sum（这是首版实现的真实 bug，被单元测试抓到）。
  for (let i = 0; i < 16; i++) {
    v1 = u32(v1 - (u32(u32(v0 << 4) + k2) ^ u32(v0 + sum) ^ u32(u32(v0 >>> 5) + k3)))
    v0 = u32(v0 - (u32(u32(v1 << 4) + k0) ^ u32(v1 + sum) ^ u32(u32(v1 >>> 5) + k1)))
    sum = u32(sum - DELTA)
  }
  return [v0, v1]
}

/**
 * 用标准 TEA 解一段数据（8 字节块）。
 * 的 TEA 分支只用于 QMC 的前 0x80 字节头区，密钥 16 字节（4×u32）。
 * @param {Buffer} data 密文（长度须为 8 的倍数）
 * @param {Buffer} key16 16 字节密钥
 */
export function teaDecrypt (data, key16) {
  if (!key16 || key16.length < 16) throw new QmcError('EKEY_UNRESOLVED', 'TEA 需要 16 字节密钥')
  const out = Buffer.from(data)
  const k = []
  for (let i = 0; i < 4; i++) k.push(bswap32(key16.readUInt32LE(i * 4)))
  for (let off = 0; off + 8 <= out.length; off += 8) {
    const v0 = bswap32(out.readUInt32LE(off))
    const v1 = bswap32(out.readUInt32LE(off + 4))
    const [r0, r1] = teaDecryptBlock(v0, v1, k)
    out.writeUInt32LE(bswap32(r0), off)
    out.writeUInt32LE(bswap32(r1), off + 4)
  }
  return out
}

/**
 * QMC static cipher —— 对齐 ``（见文件头 2）。
 *
 *   idx(i) = i < 0x8000 ? i : i % 0x7FFF
 *   k(i)   = (idx² + 0x1162E) % n
 *   mask   = rotl8(key[k], (k ^ 4) & 7)          // k%8==4 时旋转 4，等价于不变
 *   out[i] = in[i] ^ mask
 *
 * @param {Buffer} data
 * @param {Buffer} key
 * @param {number} [offset] 起始偏移（分块解密时用）
 */
export function staticCipher (data, key, offset = 0) {
  if (!key || key.length === 0) throw new QmcError('MAP_KEY_EMPTY', QMC_ERRORS.MAP_KEY_EMPTY)
  const n = key.length
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i++) {
    const gi = offset + i
    const idx = gi < 0x8000 ? gi : gi % 0x7FFF
    const k = ((idx * idx + 0x1162E) % n) >>> 0
    out[i] ^= rotl8(key[k], (k ^ 4) & 7)
  }
  return out
}

/**
 * QMC map cipher —— 逐字节映射：out[i] = in[i] ^ key[(offset+i) % n]
 * （的 mapCipher 分支；key 为空时按 exe 文案报错）
 */
export function mapCipher (data, key, offset = 0) {
  if (!key || key.length === 0) throw new QmcError('MAP_KEY_EMPTY', QMC_ERRORS.MAP_KEY_EMPTY)
  const n = key.length
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i++) out[i] ^= key[(offset + i) % n]
  return out
}

/**
 * QMC RC4（KSA + PRGA，状态随 offset 推进）。
 * 注意：的 RC4 分支在当前 exe 中未定位到 S-box 的栈/堆布局，
 * 这里按标准 RC4 实现骨架；密钥来源未解时不会走到这里。
 */
export function rc4Cipher (data, key, offset = 0) {
  if (!key || key.length === 0) throw new QmcError('RC4_KEY_EMPTY', QMC_ERRORS.RC4_KEY_EMPTY)
  const S = new Uint8Array(256)
  for (let i = 0; i < 256; i++) S[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xFF
    const t = S[i]; S[i] = S[j]; S[j] = t
  }
  // 按 offset 推进（QMC 分块要求同一 offset 处状态一致）
  let a = 0, b = 0, produced = 0
  const out = Buffer.from(data)
  const need = offset + out.length
  for (let i = 0; i < need; i++) {
    a = (a + 1) & 0xFF
    b = (b + S[a]) & 0xFF
    const t = S[a]; S[a] = S[b]; S[b] = t
    const ks = S[(S[a] + S[b]) & 0xFF]
    if (i >= offset) out[produced++] ^= ks
  }
  return out
}

// ── QMC 分块调度（对齐 ``：前 0x80 特殊 + 0x1400 分块）────────────

export const QMC_HEADER_SIZE = 0x80     // 128
export const QMC_BLOCK_SIZE = 0x1400    // 5120

/**
 * 逐块调用底层 cipher（cipher(data, offset) → Buffer）。
 * 前 0x80 字节单独一次，其后按 0x1400 对齐切块 —— 与反汇编的分支一致。
 */
export function chunkedDecrypt (data, cipher) {
  const out = Buffer.from(data)
  if (out.length === 0) return out
  // 头部区
  const headEnd = Math.min(QMC_HEADER_SIZE, out.length)
  cipher(out.subarray(0, headEnd), 0).copy(out, 0)
  let off = headEnd
  while (off < out.length) {
    const inBlock = off % QMC_BLOCK_SIZE
    const remain = inBlock === 0 ? QMC_BLOCK_SIZE : QMC_BLOCK_SIZE - inBlock
    const len = Math.min(remain, out.length - off)
    cipher(out.subarray(off, off + len), off).copy(out, off)
    off += len
  }
  return out
}

// ── 酷我 ekey 链路（DES → Feistel → QMC 原始密钥）────────────────────────────

/** 酷我 ekey 实测长度：base64(972 字符) → 728 字节 */
export const KUWO_EKEY_BYTES = 728

/** 三样本一致的 ekey 尾标记（实测） */
export const KUWO_EKEY_TRAILER = Buffer.from('6a63488853e41dd1', 'hex')

/**
 * base64 解码 ekey。用标准字母表（当前 exe `` = 标准
 * `A-Za-z0-9+/`）。

 */
export function decodeEkey (ekey) {
  if (!ekey) throw new QmcError('ENCRYPTED_NO_KEY')
  const cleaned = String(ekey).trim().replace(/[\r\n\s]/g, '')
  let raw
  try { raw = Buffer.from(cleaned, 'base64') } catch { throw new QmcError('EKEY_DECODE') }
  if (!raw.length) throw new QmcError('EKEY_DECODE')
  // 立即校验（回写 standardize 的失败点）
  const reencoded = raw.toString('base64').replace(/=+$/, '')
  if (reencoded !== cleaned.replace(/=+$/, '')) {
    // 容忍 padding 差异，但不容忍字符集错误
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) throw new QmcError('EKEY_DECODE')
  }
  if (raw.length % 8 !== 0) throw new QmcError('EKEY_NOT_MULTIPLE_OF_8')
  return raw
}

/**
 * 标准 DES 解密（酷我 ekey 用 ECB 语义的 8 字节块）。
 *
 * 为什么不用 node:crypto：本机 Node 24 的 OpenSSL 3.5 未启用 legacy provider，
 * `des-ecb` / `des-cbc` 都抛 `error:0308010C:digital envelope routines::unsupported`
 * （已实测 `getCiphers()` 中不含 des-*）。故这里用纯 JS 实现。
 *
 * 正确性已用 FIPS PUB 46-3 官方向量验证（见 scripts/_verify-qmc.mjs）：
 *   desDecrypt(3fa40e8a984d4815, 0123456789abcdef) === "Now is t"
 * 表项与标准 DES 的 8 张表逐项一致（PC-1/PC-2/移位/IP/E/P/FP；S 盒 512B）。
 */
const DES_IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7]
const DES_FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25]
const DES_E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1]
const DES_P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25]
const DES_PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4]
const DES_PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32]
const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const DES_SBOX = [
  14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
// 表项是 1-based（FIPS 惯例，取输出第 t 位为输入第 t 位、从 MSB 数）。
// 故输入位下标 = inBits - t（**不是** inBits - 1 - t —— 后者是 0-based 表的算法，
// 二者差 1，会让 DES 完全失效。此处被 FIPS 向量测试抓出）。
const desPermute = (value, table, inBits) => { let out = 0n; const v = BigInt(value); for (const t of table) { out <<= 1n; if (t >= 0 && ((v >> BigInt(inBits - t)) & 1n)) out |= 1n } return out }
const desRotl28 = (v, n) => ((v << BigInt(n)) | (v >> BigInt(28 - n))) & 0xFFFFFFFn
const desF = (r, subkey) => {
  const x = desPermute(r, DES_E, 32) ^ subkey
  let s = 0n
  for (let i = 0; i < 8; i++) {
    const six = Number((x >> BigInt((7 - i) * 6)) & 0x3Fn)
    s = (s << 4n) | BigInt(DES_SBOX[i * 64 + (((six & 0x20) >> 4) | (six & 1)) * 16 + ((six >> 1) & 0xF)])
  }
  return desPermute(s, DES_P, 32)
}
const desSubkeys = key8 => {
  const p = desPermute(key8.readBigUInt64BE(0), DES_PC1, 64)
  let c = (p >> 28n) & 0xFFFFFFFn, d = p & 0xFFFFFFFn
  const ks = []
  for (let i = 0; i < 16; i++) {
    c = desRotl28(c, DES_SHIFTS[i]); d = desRotl28(d, DES_SHIFTS[i])
    ks.push(desPermute((c << 28n) | d, DES_PC2, 56))
  }
  return ks
}
export function desDecrypt (data, key8, { encrypt = false } = {}) {
  if (!key8 || key8.length < 8) throw new QmcError('EKEY_UNRESOLVED', 'DES 需要 8 字节密钥')
  const ks = desSubkeys(key8)
  const out = Buffer.alloc(data.length)
  for (let off = 0; off + 8 <= data.length; off += 8) {
    const x = desPermute(data.readBigUInt64BE(off), DES_IP, 64)
    let l = (x >> 32n) & 0xFFFFFFFFn, r = x & 0xFFFFFFFFn
    for (let i = 0; i < 16; i++) {
      const next = l ^ desF(r, ks[encrypt ? i : 15 - i])
      l = r; r = next
    }
    out.writeBigUInt64BE(desPermute((r << 32n) | l, DES_FP, 64), off)
  }
  return out
}

/** DES 自检（FIPS 向量）—— 供诊断脚本确认实现未退化 */
export function desSelfTest () {
  const got = desDecrypt(Buffer.from('3fa40e8a984d4815', 'hex'), Buffer.from('0123456789abcdef', 'hex'))
  return got.toString('latin1') === 'Now is t'
}

/**
 * kuwo_feistel 位重排（`src\crypto\kuwo_feistel.rs`）。
 *
 * ⚠️ **未解**：当前 exe 里没有定位到干净的位索引表。
 * 函数骨架：
 *     for (i = 0; i < 28; i++) {           // lVar7 从 0xE0(224) 递减，步长 8
 *       b1 = T1[i]; if (b1 >= 0 && (x >> (b1 & 63)) & 1) y |= 1 << i
 *       b2 = T2[i]; if (b2 >= 0 && (x >> (b2 & 63)) & 1) y |= 2 << i
 *     }
 * 传入真实位表即可启用；未传则按 exe 文案抛错，**绝不编造常量**。
 *
 * @param {bigint} x 输入（低位 64 位有效）
 * @param {{t1:number[],t2:number[]}} tables 位表（各 28 项）
 */
export function feistelBitPermute (x, tables) {
  if (!tables?.t1 || !tables?.t2) {
    throw new QmcError('EKEY_UNRESOLVED',
      QMC_ERRORS.EKEY_UNRESOLVED + '（kuwo_feistel 位重排表未定位）')
  }
  const { t1, t2 } = tables
  let y = 0n
  for (let i = 0; i < 28; i++) {
    const b1 = t1[i]
    if (b1 >= 0 && ((x >> BigInt(b1 & 63)) & 1n)) y |= 1n << BigInt(i)
    const b2 = t2[i]
    if (b2 >= 0 && ((x >> BigInt(b2 & 63)) & 1n)) y |= 2n << BigInt(i)
  }
  return y
}

/** 未解项登记表：供前端/诊断决定是否尝试解密 */
export const QMC_UNRESOLVED = Object.freeze({
  kuwoFeistelBitTable: true,   // 位重排表未定位
  kuwoEkeyDesKey: true,        // ekey 的 DES 密钥未解
  rc4KeyMaterial: true,        // RC4/map 密钥来源未解
})

/**
 * 酷我 QMC 攻坚的**已证伪**清单 —— 记录「什么不行」，避免后人重复踩坑。
 * 每条都有实测证据，不是推测。
 */
export const KUWO_RULED_OUT = Object.freeze({
  desKeyYlzsxkwmOnEkey: {
    claim: '"ylzsxkwm"（硬编码 8 字节）作为 DES 密钥直接解 ekey',
    verdict: 'false',
    evidence: '真实 728B ekey 上 11 个候选密钥 × 3 种输入 × 加/解密全试：输出可打印率 ≈37.9%（随机水平），无结构化结果。' +
      '该常量与 PC-1 表相邻且恰 8 字节，确是 DES 密钥候选，但**不作用于 ekey**。',
  },
  desTablesNotEkeySpecific: {
    claim: '/ 等表可用于还原 ekey 链路',
    verdict: 'partial',
    evidence: '8 张表逐项等于标准 FIPS DES 表（PC-1/PC-2/移位/IP/E/P/FP + 512B S 盒），' +
      '即该函数是**标准 DES**，没有酷我私有变形 —— 因此表本身不能解释 ekey 为何解不出。',
  },
  positionFixedKeystream: {
    claim: 'QMC 掩码 mask(i) 是仅依赖位置 i 的函数（静态密码 / map cipher 变体）',
    verdict: 'false',
    evidence: '用真·密文/明文对（ cache 与 Music/*.flac 同曲同档交叉确认）反推掩码：' +
      '熵 7.955 bit/字节（随机 8.0）、最长 0 游程 = 1、相邻不等率 0.9944（随机 0.9961）、' +
      '任意周期自相关 ≤0.03（20 万对样本）。⇒ 掩码按文件/ekey 派生，非位置函数。',
  },
  maskSharedAcrossFiles: {
    claim: '不同歌曲共用同一掩码（可用作 two-time pad 解密任何文件）',
    verdict: 'false',
    evidence: '三对独立样本在同一全局偏移处掩码相同率 = 0.00389 / 0.00401 / 0.00407（随机 0.00391）。',
  },
  framesUnencrypted: {
    claim: '只有容器头被改写，音频帧本身未加密（可直接换容器）',
    verdict: 'false',
    evidence: '密文与明文公共前缀 = 0、公共后缀 = 0；中段 8KB 块在对方文件中均不存在；' +
      '帧区按尺寸差对齐后相等率 ≈0.0039（随机）。⇒ 帧区整体被加密。',
  },
  staticCipherIndexReduction: {
    claim: 'static cipher 的 k=(idx²+0x1162E)%n 用归约后 idx，可从掩码反解 n 与密钥',
    verdict: 'false',
    evidence: '对 n≤8192 全扫，无任何 n 满足「同 k 必同字节」；周期 0x7FFF 自相关 0.00389（随机）。',
  },
})

/** 已知的部分 QMC 密钥字节（n=128 时），由 FLAC 明文头反推 —— 供后续攻坚 */
export const KNOWN_QMC_KEY_BYTES = Object.freeze({
  n: 128,
  bytes: Object.freeze({ 46: 0x13, 47: 0x2B, 50: 0xC4, 55: 0x06, 62: 0x4D, 71: 0x69, 82: 0xD0, 95: 0xA6 }),
  evidence: 'FLAC 明文头 66 4C 61 43 00 00 00 22 反推；分散下标证明不是 8 字节周期密钥',
})

/**
 * ★ 明文回落档位：酷我池实测对照表（队长实测，2026-10）
 *   master   → mflac  + ekey  🔒 需 QMC
 *   hifi     → mflac  + ekey  🔒 需 QMC
 *   lossless → flac   无 ekey  ✅ 明文，头部 66 4C 61 43 合规，可直接播/下载
 * 因此解密不可用时回落到 lossless 即可满足「真无损」需求。
 */
export const PLAINTEXT_FALLBACK_QUALITY = 'lossless'

/**
 * 从酷我 ekey 派生 QMC 原始密钥。
 *
 * 流水线（对齐 exe）：ekey → base64 → DES → Feistel 位重排 → 提取 QMC 密钥
 *
 * ⚠️ DES 密钥与 Feistel 位表均**未解**，因此本函数在缺少这两项时抛
 * `EKEY_UNRESOLVED`（exe 原文：`无法从酷我 ekey 中提取 QMC 原始密钥`）。
 *
 * @param {string} ekey
 * @param {{desKey?:Buffer, feistelTables?:{t1:number[],t2:number[]}}} [opts]
 */
export function deriveKuwoQmcKey (ekey, opts = {}) {
  const raw = decodeEkey(ekey)
  if (!opts.desKey || !opts.feistelTables) {
    throw new QmcError('EKEY_UNRESOLVED', QMC_ERRORS.EKEY_UNRESOLVED, {
      ekeyBytes: raw.length,
      unresolved: ['kuwoEkeyDesKey', 'kuwoFeistelBitTable'],
    })
  }
  const step1 = desDecrypt(raw, opts.desKey)
  // Feistel 位重排：逐 8 字节块
  const out = Buffer.from(step1)
  for (let off = 0; off + 8 <= out.length; off += 8) {
    const x = out.readBigUInt64LE(off)
    out.writeBigUInt64LE(feistelBitPermute(x, opts.feistelTables), off)
  }
  return out
}

// ── 顶层 API ────────────────────────────────────────────────────────────────

/**
 * 解密一段（或整段）加密音频。
 *
 * @param {Buffer} buf 密文
 * @param {string} format 音源格式（mflac/mgg/...）
 * @param {string} ekey base64 ekey（酷我）
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.quality] 音质档位（QQ 高阶拒绝判定）
 * @param {Buffer} [opts.desKey]
 * @param {{t1:number[],t2:number[]}} [opts.feistelTables]
 * @param {Buffer} [opts.qmcKey] 已拿到的 QMC 原始密钥（跳过 ekey 链路）
 * @param {'static'|'map'|'rc4'|'tea'} [opts.cipher] 强制指定密码类型
 * @returns {Buffer} 明文
 * @throws {QmcError}
 */
export function decryptBuffer (buf, format, ekey, opts = {}) {
  const provider = normalizeProvider(opts.provider)
  const fmt = normalizeFormat(format)
  if (!isEncrypted(fmt)) return buf   // 明文档位原样返回

  // QQ 高阶：对齐拒绝
  if (provider === 'qq' && opts.quality && HIGH_QUALITY.has(String(opts.quality).toLowerCase())) {
    throw new QmcError('QQ_HIGH_QUALITY', QMC_ERRORS.QQ_HIGH_QUALITY)
  }
  if (provider === 'qq' && !opts.qmcKey && !ekey) {
    throw new QmcError('ENCRYPTED_NO_KEY', QMC_ERRORS.ENCRYPTED_NO_KEY)
  }

  let qmcKey = opts.qmcKey ?? null

  if (!qmcKey && provider === 'kuwo') {
    // 酷我：ekey 链路（DES → Feistel → 提取）。未解项会在此抛 EKEY_UNRESOLVED。
    qmcKey = deriveKuwoQmcKey(ekey, { desKey: opts.desKey, feistelTables: opts.feistelTables })
  }
  if (!qmcKey) {
    if (!ekey) throw new QmcError('ENCRYPTED_NO_KEY', QMC_ERRORS.ENCRYPTED_NO_KEY)
    // 非酷我加密格式：ekey 本身按 QMC 原始密钥用（QQ 语义）
    qmcKey = decodeEkey(ekey)
  }

  const cipherName = opts.cipher ?? (qmcKey.length === 16 ? 'tea' : 'static')
  let out
  if (cipherName === 'tea') out = teaDecrypt(buf, qmcKey.subarray(0, 16))
  else if (cipherName === 'map') out = chunkedDecrypt(buf, (d, off) => mapCipher(d, qmcKey, off))
  else if (cipherName === 'rc4') out = chunkedDecrypt(buf, (d, off) => rc4Cipher(d, qmcKey, off))
  else out = chunkedDecrypt(buf, (d, off) => staticCipher(d, qmcKey, off))

  return out
}

/**
 * ★ 安全降级入口（供播放/下载链路统一调用）。
 *
 * 语义（队长要求：永不产出垃圾文件）：
 *   1. 明文档位（flac/mp3/...）→ 直通，`decrypted:false, degraded:false`
 *   2. 加密档位但解密可用     → 返回明文，`decrypted:true`
 *   3. 加密档位且解密不可用   → **抛 QmcError**，并带 `fallbackQuality:'lossless'`，
 *      由上层回落去请求明文无损档位；**绝不返回半成品/垃圾字节**。
 *
 * 之所以这样设计：酷我 `master`/`hifi` 档位返回 mflac（加密，需 QMC），
 * 而 `lossless` 档位返回**明文 flac**（已实测头部 `66 4c 61 43 …` 合规）——
 * 因此解密不可用时，回落到明文档位即可满足「真无损」诉求。
 *
 * @param {Buffer} buf 下载到的字节
 * @param {object} o
 * @param {string} o.format 音源 format 字段
 * @param {string} [o.ekey]
 * @param {string} [o.provider]
 * @param {string} [o.quality]
 * @param {string} [o.fallbackQuality='lossless'] 回落档位
 * @param {Buffer} [o.qmcKey] 已拿到的 QMC 原始密钥
 * @param {Buffer} [o.desKey]
 * @param {{t1:number[],t2:number[]}} [o.feistelTables]
 * @returns {{buf:Buffer, decrypted:boolean, degraded:boolean, container:object|null}}
 */
export function decryptOrFallback (buf, o = {}) {
  const fmt = normalizeFormat(o.format)
  const fallbackQuality = o.fallbackQuality ?? 'lossless'
  // 1) 明文直通
  if (!isEncrypted(fmt)) {
    return { buf, decrypted: false, degraded: false, container: validateContainer(buf) }
  }
  // 2) 尝试解密
  let plain
  try {
    plain = decryptBuffer(buf, fmt, o.ekey, o)
  } catch (error) {
    // 3) 不可解密 → 明确报错 + 告知回落档位（不返回垃圾）
    if (error instanceof QmcError) {
      error.fallbackQuality = fallbackQuality
      error.encryptedFormat = fmt
      throw error
    }
    throw new QmcError('EKEY_UNRESOLVED', QMC_ERRORS.EKEY_UNRESOLVED, {
      cause: error?.message, fallbackQuality, encryptedFormat: fmt,
    })
  }
  // 解密成功也必须校验容器，杜绝“解出垃圾却当成成功”
  const container = assertDecrypted(plain, fmt)
  return { buf: plain, decrypted: true, degraded: false, container }
}

/**
 * 解密失败时的回落决策（纯函数，便于单测）：
 * 给加密档位 → 返回应改请求的档位；给明文档位 → null（无需回落）。
 */
export function fallbackFor (format, quality) {
  const fmt = normalizeFormat(format)
  if (!isEncrypted(fmt)) return null
  return { quality: 'lossless', reason: QMC_ERRORS.EKEY_UNRESOLVED }
}

/**
 * 解密结果校验（对齐 exe：`音频解密结果校验失败`）。
 * @returns {{name:string,mime:string}}
 */
export function assertDecrypted (plain, expectFormat) {
  const hit = validateContainer(plain, expectFormat)
  if (!hit) {
    throw new QmcError('RESULT_CHECK', QMC_ERRORS.RESULT_CHECK, {
      head: plain?.subarray?.(0, 16)?.toString('hex') ?? null,
    })
  }
  return hit
}

/**
 * 解密失败重试策略（对齐 exe）：
 *   解密失败 → **重新取一次 URL**；若 URL 与密钥**未变化** → 停止重试，如实报错。
 *   绝不无限重试、绝不降级成试听。
 *
 * @param {object} o
 * @param {() => Promise<Buffer>} o.download 取密文
 * @param {(attempt:number) => Promise<{audioUrl:string, ekey:string}>} o.refresh 重取 URL+密钥
 * @param {string} o.audioUrl 当前 URL
 * @param {string} o.ekey 当前密钥
 * @param {(buf:Buffer) => Buffer} o.decrypt 解密
 * @param {string} [o.label]
 */
export async function decryptWithRetry ({ download, refresh, audioUrl, ekey, decrypt, label = '' }) {
  // 下载与解密都必须包在 try 内：下载失败同样要能触发「重取一次 URL」，
  // 否则首个下截一挂就直接抛出，重试策略形同虚设（单元测试抓到的真实 bug）。
  let firstError = null
  try {
    const first = await download(audioUrl)
    return { plain: decrypt(first), audioUrl, ekey, attempts: 1 }
  } catch (error) {
    firstError = error
  }

  // 解密/下载失败 → 重新取一次 URL（**只一次**）
  let refreshed
  try { refreshed = await refresh(1) } catch { refreshed = null }
  if (!refreshed?.audioUrl) throw firstError
  // URL 与密钥都未变化 → 停止重试，如实报错（exe 原文）
  if (refreshed.audioUrl === audioUrl && String(refreshed.ekey ?? '') === String(ekey ?? '')) {
    throw new QmcError('KUWO_URL_UNCHANGED', QMC_ERRORS.KUWO_URL_UNCHANGED, { label, cause: firstError?.message })
  }

  // 二次下载也可能失败：同样要归一成 QmcError，不要漏出原始错误类型
  let second
  try {
    second = await download(refreshed.audioUrl)
  } catch (e) {
    throw new QmcError(e?.code ?? 'RESULT_CHECK', e?.message ?? QMC_ERRORS.RESULT_CHECK, { label, attempts: 2 })
  }
  try {
    return { plain: decrypt(second), audioUrl: refreshed.audioUrl, ekey: refreshed.ekey, attempts: 2 }
  } catch (e) {
    throw new QmcError(e.code ?? 'RESULT_CHECK', e.message ?? QMC_ERRORS.RESULT_CHECK, { label, attempts: 2 })
  }
}

/**
 * 流式解密：把密文流经 Transform 逐块解密输出（供 Range 场景边下边解）。
 * 使用 `chunkedDecrypt` 的同一 offset 语义，保证与整段解密逐字节一致。
 *
 * @param {object} o
 * @param {Buffer} o.qmcKey QMC 原始密钥
 * @param {'static'|'map'|'rc4'|'tea'} [o.cipher]
 * @param {number} [o.offset] 起始偏移
 */
export function createDecryptStream ({ qmcKey, cipher = 'static', offset = 0 } = {}) {
  if (!qmcKey || qmcKey.length === 0) throw new QmcError('MAP_KEY_EMPTY', QMC_ERRORS.MAP_KEY_EMPTY)
  let pos = offset
  return new Transform({
    transform (chunk, _enc, cb) {
      try {
        let out
        if (cipher === 'tea') out = teaDecrypt(chunk, qmcKey.subarray(0, 16))
        else if (cipher === 'map') out = mapCipher(chunk, qmcKey, pos)
        else if (cipher === 'rc4') out = rc4Cipher(chunk, qmcKey, pos)
        else out = staticCipher(chunk, qmcKey, pos)
        pos += chunk.length
        cb(null, out)
      } catch (e) { cb(e) }
    },
  })
}

// ── 磁盘缓存 + cacheKey（供 /api/decoded-audio/ 路由使用）────────────────────

/**
 * cacheKey：源地址 + ekey + 格式 + 音质的稳定摘要。
 * 同一首歌同一档位重复请求 → 同一个 key → 命中同一份解密缓存。
 */
export function cacheKeyFor ({ audioUrl, ekey, format, quality, provider } = {}) {
  const parts = [String(provider ?? ''), String(format ?? ''), String(quality ?? ''), String(ekey ?? ''), String(audioUrl ?? '')]
  let h1 = 0x811C9DC5, h2 = 0x01000193
  const s = parts.join('\u0000')
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85EBCA6B) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 24)
}

export default {
  isEncrypted, supportsDecrypt, decryptBuffer, createDecryptStream,
  validateContainer, assertDecrypted, decryptWithRetry, cacheKeyFor,
  normalizeProvider, normalizeFormat, decodeEkey, deriveKuwoQmcKey,
  teaDecrypt, teaDecryptBlock, staticCipher, mapCipher, rc4Cipher, chunkedDecrypt,
  QMC_ERRORS, QmcError, QMC_UNRESOLVED, KNOWN_QMC_KEY_BYTES,
}
