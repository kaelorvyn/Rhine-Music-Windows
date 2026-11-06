import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MAX_DLL = 32 * 1024 * 1024
const METHODS = new Set(['status', 'lines', 'probeLines', 'probeUpstreams', 'resolve', 'invalidate', 'shutdown'])
const genericError = () => new Error('共享音源模块不可用，请检查模块版本或重新导入')

export function validateModule(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 256 || bytes.length > MAX_DLL || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('请选择有效的 Windows DLL 模块')
  const pe = bytes.readUInt32LE(0x3c)
  if (pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550 || !(bytes.readUInt16LE(pe + 22) & 0x2000)) throw new Error('文件不是有效的 DLL 模块')
  if (bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('模块架构不匹配，需要 Windows x64 DLL')
}

export class PoolModuleHost {
  constructor(file, { executable, timeoutMs = 45000 } = {}) {
    this.file = path.resolve(file)
    this.executable = executable
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.nextId = 0
    this.child = null
  }
  async start() {
    if (this.child) return
    if (!this.starting) this.starting = this.startProcess().finally(() => { this.starting = null })
    return this.starting
  }
  async startProcess() {
    if (this.child) return
    const candidates = this.executable ? [this.executable] : [path.join(ROOT, 'native', 'rhine-pool-host.exe'), path.join(ROOT, 'native', 'rhine-pool-host', 'target', 'release', 'rhine-pool-host.exe')]
    let executable
    for (const candidate of candidates) if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) { executable = candidate; break }
    if (!executable) throw new Error('缺少共享音源模块调用器')
    const child = spawn(executable, [this.file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    const fail = () => {
      if (this.child !== child) return
      this.child = null
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(genericError()) }
      this.pending.clear()
    }
    child.once('error', fail)
    child.once('exit', fail)
    child.stdin.on('error', fail)
    // ponytail: the native host caps each reply at 2 MiB; reject oversized lines here too.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) { this.close(); return }
      let reply
      try { reply = JSON.parse(line) } catch { this.close(); return }
      const item = this.pending.get(reply.id)
      if (!item) return
      this.pending.delete(reply.id)
      clearTimeout(item.timer)
      if (reply.ok) item.resolve(reply.result)
      else item.reject(genericError())
    })
  }
  async call(method, args = {}) {
    if (!METHODS.has(method)) throw new Error('不支持的模块操作')
    await this.start()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(genericError()) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => { if (error) this.close() })
    })
  }
  close() {
    const child = this.child
    this.child = null
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(genericError()) }
    this.pending.clear()
    if (child) { child.stdin.destroy(); child.kill() }
  }
}

let active = null
let cachedStatus = { configured: false, expiresAt: null, importedAt: null }
export function moduleStatus() { return { ...cachedStatus } }
export function closeModule() {
  active?.close()
  active = null
  cachedStatus = { configured: false, expiresAt: null, importedAt: null }
}
function statusOf(value, importedAt) {
  if (!value || value.moduleVersion !== 1 || typeof value.configured !== 'boolean') throw genericError()
  const expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : null
  const expired = expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
  return { configured: value.configured && !expired, expiresAt, importedAt, moduleVersion: 1 }
}
export async function loadModule(dataDir) {
  closeModule()
  let candidate
  try {
    const config = JSON.parse(await fs.readFile(path.join(dataDir, 'pool-module.json'), 'utf8'))
    if (!/^module-[a-f0-9-]+\.dll$/.test(config.file)) return false
    const file = path.join(dataDir, 'pool-modules', config.file)
    validateModule(await fs.readFile(file))
    candidate = new PoolModuleHost(file)
    const status = statusOf(await candidate.call('status'), config.importedAt ?? null)
    if (!status.configured) { candidate.close(); return false }
    active = candidate
    cachedStatus = status
    return true
  } catch { candidate?.close(); return false }
}
export async function importModule(dataDir, bytes) {
  validateModule(bytes)
  const dir = path.join(dataDir, 'pool-modules')
  await fs.mkdir(dir, { recursive: true })
  const file = `module-${randomUUID()}.dll`
  await fs.writeFile(path.join(dir, file), bytes, { flag: 'wx' })
  const candidate = new PoolModuleHost(path.join(dir, file))
  try {
    const importedAt = new Date().toISOString()
    const status = statusOf(await candidate.call('status'), importedAt)
    if (!status.configured) throw new Error('模块未配置或已过期')
    const staging = path.join(dataDir, `pool-module-${randomUUID()}.tmp`)
    await fs.writeFile(staging, JSON.stringify({ file, importedAt }), { flag: 'wx' })
    await fs.rename(staging, path.join(dataDir, 'pool-module.json'))
    active?.close()
    active = candidate
    cachedStatus = status
    return moduleStatus()
  } catch (error) { candidate.close(); throw error }
}
export async function removeModule(dataDir) {
  closeModule()
  // Imported DLL files are retained; removing the manifest revokes application use.
  await fs.rm(path.join(dataDir, 'pool-module.json'), { force: true })
  return moduleStatus()
}
export async function callModule(method, args) {
  if (!active || !cachedStatus.configured) throw genericError()
  if (cachedStatus.expiresAt && Date.parse(cachedStatus.expiresAt) <= Date.now()) { closeModule(); throw genericError() }
  try { return await active.call(method, args) }
  catch { if (!active?.child) closeModule(); throw genericError() }
}
