import crypto from 'node:crypto'

const MAGIC = Buffer.from('RHK1', 'ascii')
const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES + TAG_BYTES

const KEY_PARTS = ['n8EPJmMoSyhgyvSv4bNIOA==', 'kGKzSi4A4dHYb/1Up3bPmw==']

let cachedKey = null
function appKey() {
  if (!cachedKey) {
    const parts = KEY_PARTS.map((part) => Buffer.from(part, 'base64'))
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    if (total !== 32) throw new Error('密钥文件加密配置损坏')
    cachedKey = Buffer.concat(parts)
  }
  return cachedKey
}

export class KeyFileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KeyFileError'
  }
}

export function isEnvelope(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= HEADER_BYTES && buffer.subarray(0, 4).equals(MAGIC)
}

export function looksPlainJson(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false
  const first = buffer[0]
  return first === 0x7b || first === 0xef || first === 0x20 || first === 0x09 || first === 0x0a || first === 0x0d
}

export function encode(value) {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey(), nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body])
}

export function decode(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new KeyFileError('密钥文件是空的')

  if (looksPlainJson(buffer)) {
    try {
      return { value: JSON.parse(buffer.toString('utf8')), plaintext: true }
    } catch {
      throw new KeyFileError('密钥文件内容已损坏')
    }
  }

  if (!isEnvelope(buffer)) throw new KeyFileError('这不是有效的密钥文件')
  if (buffer[MAGIC.length] !== VERSION) throw new KeyFileError('密钥文件版本过新，请升级到最新版本')

  const nonceStart = MAGIC.length + 1
  const tagStart = nonceStart + NONCE_BYTES
  const bodyStart = tagStart + TAG_BYTES
  const nonce = buffer.subarray(nonceStart, tagStart)
  const tag = buffer.subarray(tagStart, bodyStart)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', appKey(), nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(buffer.subarray(bodyStart)), decipher.final()])
    return { value: JSON.parse(plaintext.toString('utf8')), plaintext: false }
  } catch {
    throw new KeyFileError('密钥文件已损坏或被改动')
  }
}

export function decodeToObject(buffer) {
  return decode(buffer).value
}

export function encodeFileHeaderBytes() {
  return HEADER_BYTES
}
