/**
 * LX 音源宿主的 worker 线程入口。
 *
 * 音源插件是第三方代码：有的会 setInterval 轮询，有的会自校验、有的干脆
 * 死循环。这些绝不能跑在音乐服务的主线程里——否则一首歌解析卡住，整个
 * 曲库服务都跟着停摆。worker 跑挂了，宿主可以 terminate 掉重建。
 *
 * 协议：主线程 → { id, method, args }；worker → { id, ok, result | error }
 */
import { parentPort } from 'node:worker_threads'
import { LxSourceRuntime } from './lx-source-loader.mjs'

const runtime = new LxSourceRuntime({ guardRejections: true })

const METHODS = {
  loadDirectory: (args) => runtime.loadDirectory(...args),
  search: (args) => runtime.search(...args),
  resolveUrl: (args) => runtime.resolveUrl(...args),
  resolveForProvider: (args) => runtime.resolveForProvider(...args),
  resolveTrackId: (args) => runtime.resolveTrackId(...args),
  listSources: (args) => runtime.listSources(...args),
  // 开机自检：逐个插件试取地址，标出活的/死的与能给的最高音质。
  selfCheck: (args) => runtime.selfCheck(...args),
  health: () => runtime.healthSummary,
  progress: () => runtime.selfCheckProgress,
  exportHealth: () => runtime.exportHealth(),
  importHealth: (args) => runtime.importHealth(...args),
  // 取曲缓存落盘：跨进程复用「歌 → 地址」（对齐洛雪的 SQLite music_url）。
  exportUrlCache: () => runtime.exportUrlCache(),
  importUrlCache: (args) => runtime.importUrlCache(...args),
  snapshot: () => ({
    enabled: runtime.enabled,
    pluginCount: runtime.plugins.size,
    sources: runtime.listSources(),
    report: runtime.loadReport,
    selfCheck: runtime.selfCheckReport,
  }),
  clear: () => {
    runtime.plugins.clear()
    runtime.bySource.clear()
    runtime.urlCache.clear()
    runtime.health.clear()
    runtime.selfCheckReport = null
    runtime.loadReport = []
    return { cleared: true }
  },
}

parentPort.on('message', async ({ id, method, args = [] }) => {
  const impl = METHODS[method]
  if (!impl) return parentPort.postMessage({ id, ok: false, error: `未知方法 ${method}` })
  try {
    const result = await impl(args)
    parentPort.postMessage({ id, ok: true, result })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
})

parentPort.postMessage({ id: 0, ok: true, result: { ready: true } })
