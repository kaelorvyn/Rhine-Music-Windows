/**
 * LX 音源宿主（主线程代理）
 *
 * 把 `lx-source-loader.mjs` 的运行时关进 worker 线程：主线程只发消息、等结果。
 * 任何一次调用超时（插件把 worker 的事件循环拖死）就 terminate 掉重建，
 * 保证音乐服务主线程永远不被第三方插件阻塞。
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROBES } from './lx-source-loader.mjs'

const WORKER_PATH = fileURLToPath(new URL('./lx-source-worker.mjs', import.meta.url))
// 取曲在 worker 内部有 25s 预算；主线程超时要留余量，否则 worker 会先被杀
const DEFAULT_CALL_TIMEOUT = 45000
const RESOLVE_TIMEOUT = 40000
const SEARCH_TIMEOUT = 35000

export class LxSourceHost {
  constructor({ callTimeout = DEFAULT_CALL_TIMEOUT, restartOnTimeout = true } = {}) {
    this.callTimeout = callTimeout
    // 自检是批量任务（几十个源各试一次），要单独给宽超时，否则会被普通调用的
    // 45s 上限打断，导致 worker 被误判为卡死而重建。
    this._selfCheckTimeout = 300000
    this.restartOnTimeout = restartOnTimeout
    this._worker = null
    this._pending = new Map()
    this._nextId = 1
    this._snapshot = { enabled: false, pluginCount: 0, sources: [], report: [] }
  }

  get enabled() { return this._snapshot.enabled }
  get pluginCount() { return this._snapshot.pluginCount }
  get sources() { return this._snapshot.sources }
  get report() { return this._snapshot.report }

  _spawn() {
    if (this._worker) return this._worker
    const worker = new Worker(WORKER_PATH, { stdout: true, stderr: true })
    worker.on('message', (msg) => {
      const entry = this._pending.get(msg.id)
      if (!entry) return
      this._pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(new Error(msg.error))
    })
    worker.on('error', (err) => {
      for (const [id, entry] of this._pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`音源 worker 异常：${err.message}`))
        this._pending.delete(id)
      }
      this._worker = null
    })
    worker.on('exit', () => {
      if (this._worker !== worker) return
      this._worker = null
      for (const [id, entry] of this._pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('音源 worker 已退出'))
        this._pending.delete(id)
      }
    })
    // worker 里的 console 转发到主线程，方便看插件自己打的日志
    worker.stdout.on('data', (chunk) => process.stdout.write(chunk))
    worker.stderr.on('data', (chunk) => process.stderr.write(chunk))
    this._worker = worker
    return worker
  }

  _call(method, args = [], { timeout = this.callTimeout } = {}) {
    const worker = this._spawn()
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`音源「${method}」超时 ${timeout}ms`))
        if (this.restartOnTimeout) this.restart(`调用 ${method} 超时`)
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, method, args })
    })
  }

  /** 插件拖死 worker 时的自愈：杀掉重建，下次调用重新加载 */
  restart(reason = '') {
    if (!this._worker) return
    if (reason) console.warn(`[LX] 重建音源 worker：${reason}`)
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('音源 worker 正在重建'))
      this._pending.delete(id)
    }
    this._worker.terminate()
    this._worker = null
    this._snapshot = { enabled: false, pluginCount: 0, sources: [], report: [] }
    this._dirToReload = this._lastDir
    this._lastDir = this._lastDir
  }

  async loadDirectory(dir) {
    return this.loadDirectories([dir])
  }

  /** 内置目录 + 用户目录一起加载；后者同名覆盖前者。 */
  async loadDirectories(dirs) {
    this._lastDir = dirs
    const report = await this._call('loadDirectories', [dirs])
    this._snapshot = await this._call('snapshot', [])
    return report
  }

  /** 停用清单（id 数组）。停用的插件不参与搜索与取源。 */
  async setDisabled(ids) {
    const plugins = await this._call('setDisabled', [ids])
    this._snapshot = await this._call('snapshot', [])
    return plugins
  }

  /** 界面清单（内置标记 / 启用状态 / 自检延迟）。 */
  async listPlugins() {
    if (!this.enabled) return []
    try { return await this._call('listPlugins', []) } catch { return [] }
  }

  async clear() {
    await this._call('clear', [])
    this._snapshot = { enabled: false, pluginCount: 0, sources: [], report: [] }
  }

  async search(keyword, options = {}) {
    if (!this.enabled) return { tracks: [], total: 0, hasMore: false, failures: [] }
    return this._call('search', [keyword, options])
  }

  async resolveForProvider(provider, songId, options = {}) {
    if (!this.enabled) return null
    return this._call('resolveForProvider', [provider, songId, options])
  }

  async resolveTrackId(trackId, options = {}) {
    if (!this.enabled) return null
    return this._call('resolveTrackId', [trackId, options])
  }

  /**
   * 开机自检：让 worker 逐个音源试取地址，标出活的/死的与能给的最高音质。
   * 自检本身很慢（几十个源各试一次），必须由调用方**后台**触发，不能挡启动。
   * 超时给得比普通调用宽：这是批量任务，跑完就长期受益。
   */
  async selfCheck(options = {}) {
    if (!this.enabled) return { checked: 0, alive: 0, dead: 0 }
    // resolveId 是函数，**不能**通过 postMessage 传给 worker（会抛
    // "could not be cloned"）。所以在主线程先解析好探针真实 id，只把结果传进去。
    const { resolveId, ...rest } = options
    let probes = rest.probes
    if (typeof resolveId === 'function') {
      probes = (rest.probes ?? DEFAULT_PROBES).map((p) => ({ ...p }))
      for (const probe of probes) {
        if (probe.info) continue
        try {
          const info = await resolveId(probe.source, probe.keyword)
          if (info?.id) probe.info = info
        } catch { /* 取不到就走插件搜索那条路 */ }
      }
    }
    const result = await this._call('selfCheck', [{ ...rest, ...(probes ? { probes } : {}) }], { timeout: this._selfCheckTimeout })
    this._snapshot = await this._call('snapshot', [])
    return result
  }

  /** 自检明细（每个音源的死活与音质）。 */
  async health() {
    if (!this.enabled) return { report: null, sources: [] }
    return this._call('health', [])
  }

  /** 自检进度：前端加载页据此画进度条；没在跑时 running=false。 */
  async progress() {
    if (!this.enabled) return { running: false, done: 0, total: 0, alive: 0 }
    try { return await this._call('progress', []) } catch { return { running: false, done: 0, total: 0, alive: 0 } }
  }

  /** 自检结果快照（落盘缓存用）。 */
  async exportHealth() {
    if (!this.enabled) return { at: Date.now(), report: null, sources: {} }
    return this._call('exportHealth', [])
  }

  /** 用缓存结果恢复排序，跳过耗时的重测。 */
  async importHealth(snapshot) {
    if (!this.enabled) return false
    return this._call('importHealth', [snapshot])
  }

  /** 取曲缓存快照（落盘用，跨进程复用「歌 → 地址」）。 */
  async exportUrlCache() {
    if (!this.enabled) return { at: Date.now(), urls: {}, owners: {} }
    return this._call('exportUrlCache', [])
  }

  /** 恢复落盘的取曲缓存与串歌归属表。 */
  async importUrlCache(snapshot) {
    if (!this.enabled) return false
    return this._call('importUrlCache', [snapshot])
  }

  terminate() {
    this._worker?.terminate()
    this._worker = null
    for (const [, entry] of this._pending) clearTimeout(entry.timer)
    this._pending.clear()
  }
}

export default LxSourceHost
