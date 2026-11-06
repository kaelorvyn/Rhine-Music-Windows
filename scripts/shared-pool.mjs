// Public facade: private configuration and cryptographic operations stay in the imported DLL.
import { callModule, loadModule, closeModule, moduleStatus } from './pool-module.mjs'
export const SERVER_LINES = []
let lines = { results: [], activeId: '', activeLabel: '', allFailed: false, lastProbeAt: null }
export const credentialsReady = () => moduleStatus().configured
export const signingHealth = () => ({ ok: credentialsReady(), reason: credentialsReady() ? '' : 'module_unavailable' })
export async function loadFromImportedKey(dataDir) { return await loadModule(dataDir) ? { configured: true } : null }
export function resetPoolRuntime() { closeModule(); SERVER_LINES.length = 0; lines = { results: [], activeId: '', activeLabel: '', allFailed: false, lastProbeAt: null } }
export function serverLineState() { return { ...lines, results: lines.results.map(row => ({ ...row })) } }
const safeLine = (row, i) => ({ id: `line_${i}`, label: i ? '备用线路' : '优先线路', reachable: !!row.reachable, healthy: !!row.healthy, latency_ms: Number.isFinite(row.latency_ms) ? row.latency_ms : null, detail: row.healthy ? '可用' : '不可用' })
export async function probeServerLinesShared() {
  const result = await callModule('probeLines')
  lines = { results: (result.results ?? []).map(safeLine), activeId: /^line_\d+$/.test(result.activeId) ? result.activeId : '', activeLabel: '', allFailed: !!result.allFailed, lastProbeAt: new Date().toISOString() }
  lines.activeLabel = lines.results.find(row => row.id === lines.activeId)?.label ?? ''
  SERVER_LINES.splice(0, SERVER_LINES.length, ...lines.results.map(({id,label}) => ({id,label})))
  return serverLineState()
}
export async function probeUpstreams() {
  let result
  try { result = await callModule('probeUpstreams') } catch { result = null }
  return { upstreams: ['netease', 'qq', 'kugou', 'kuwo', 'qishui', 'joox'].map(platform => {
    const row = (result?.upstreams ?? []).find(item => item.platform === platform)
    return { platform, tested: !!row, ok: !!row?.ok, latency_ms: Number.isFinite(row?.latency_ms) ? row.latency_ms : null,
      detail: !result ? '模块检测失败，请重试或重新导入模块' : !row ? '当前模块不支持检测，请重新导入新版模块' : row.ok ? '可用' : row.detail === 'timeout' ? '检测超时，请重试' : row.detail === 'budget_exhausted' ? '本轮未检测，请重试' : '不可用' }
  }) }
}
export async function resolveSongBest(args) {
  if (!credentialsReady()) return { error: 'pool_disabled' }
  try {
    const result = await callModule('resolve', args)
    if (typeof result.audioUrl !== 'string' || !/^https?:\/\//i.test(result.audioUrl)) return { error: '共享音源未返回可用音频' }
    return { audioUrl: result.audioUrl, relayRequired: result.relayRequired === true, format: typeof result.format === 'string' ? result.format : 'unknown', ekey: typeof result.ekey === 'string' ? result.ekey : null, actualQuality: typeof result.actualQuality === 'string' ? result.actualQuality : undefined, bitrate: Number.isFinite(result.bitrate) ? result.bitrate : undefined, requestedQuality: args.quality }
  } catch { return { error: '共享音源模块不可用' } }
}
export function invalidatePoolUrlCache(provider) { if (credentialsReady()) void callModule('invalidate', { provider }).catch(() => {}); return 0 }
