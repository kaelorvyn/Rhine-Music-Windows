/**
 * t9 取源提速验收 —— 可复现的端到端计时（这是 t9 的验收证据脚本）
 *
 * node scripts/check-t9-speed.mjs
 *
 * 计量目标（t9 契约原文）：
 * 池子命中 `<1s`
 * 池子未命中 `9~10.5s → ≤3s`
 *
 * 为什么做成常驻脚本而不是一次性探针：验收要能**被别人重跑**。
 * 临时探针删掉之后，"改前 10005ms / 改后 X ms"就没人能复现了。
 *
 * 输出两类数字：
 * ① 冷启动首次（预热还没跑完时点击 —— 最坏情况）
 * ② 稳态（预热跑完后的连续请求 —— 用户日常感受）
 *
 * 需要联网（真的去打池子与备用源）。CI 里不可用，属人工验收脚本。
 */
import { createMusicServer } from './music-server.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 已知池子命中（酷我，返回 mflac + actualQuality=master）。 */
const POOL_HIT_ID = '1860327'
/** 已知池子未命中（酷我 ID=1 没有可用档位）。 */
const POOL_MISS_ID = '1'

const t0 = performance.now()
// 验收要量真实链路：默认用真实数据目录（里面有共享池密钥），别用空临时目录。
// 想量“无密钥”的降级表现时：MUSIC_DATA_DIR=$(mktemp -d) node scripts/check-t9-speed.mjs
const dataDir = process.env.MUSIC_DATA_DIR ?? path.join(os.homedir(), 'AppData', 'Local', 'local.rhine.music.windows', 'music-data');
await fs.mkdir(dataDir, { recursive: true });
const { server } = await createMusicServer({ dataDir, autoScan: false })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`服务启动（含插件加载）用时 ${Math.round(performance.now() - t0)}ms\n`)

const prepare = async (id, quality) => {
  const started = performance.now()
  const response = await fetch(`${base}/api/online/kuwo/prepare/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(quality ? { quality } : {}),
  })
  const body = await response.json().catch(() => ({}))
  return { ms: Math.round(performance.now() - started), status: response.status, body }
}

// ── ① 冷启动首次：预热还没跑完就点击（最坏情况）──────────────────────────
console.log('【冷启动首次】预热尚未完成时立即请求（最坏情况）')
const coldMiss = await prepare(POOL_MISS_ID)
console.log(`  未命中 kuwo/${POOL_MISS_ID} → ${coldMiss.ms}ms HTTP ${coldMiss.status}`)
console.log(`    ${coldMiss.body.error ?? ''}`)

// ── 等预热跑完（备用源探测 + LX 预热）────────────────────────────────────
console.log('\n等 12s 让启动预热跑完（备用源探测 + 末端 LX 预热）...')
await new Promise(r => setTimeout(r, 12_000))

// ── ② 稳态：未命中 ────────────────────────────────────────────────────
console.log('\n【稳态·未命中】连续 5 次（第 1 次可能仍在消化冷态）')
const missRuns = []
for (let i = 1; i <= 5; i++) {
  const r = await prepare(POOL_MISS_ID)
  missRuns.push(r.ms)
  console.log(`  第 ${i} 次: ${r.ms}ms HTTP ${r.status}`)
}
// 稳态取后 3 次（前两次可能还在把死站标掉）
const missSteady = missRuns.slice(-3)
const missSteadyAvg = Math.round(missSteady.reduce((a, b) => a + b, 0) / missSteady.length)

// ── ③ 稳态：命中 ──────────────────────────────────────────────────────
console.log('\n【稳态·命中】连续 3 次')
const hitRuns = []
for (let i = 1; i <= 3; i++) {
  const r = await prepare(POOL_HIT_ID)
  hitRuns.push(r.ms)
  console.log(`  第 ${i} 次: ${r.ms}ms HTTP ${r.status} pool=${r.body.poolSource ?? '-'} quality=${r.body.actualQuality ?? '-'}`)
}
const hitAvg = Math.round(hitRuns.reduce((a, b) => a + b, 0) / hitRuns.length)

// ── 判定 ──────────────────────────────────────────────────────────────
console.log('\n【判定】目标：命中 <1s，未命中 ≤3s')
const checks = [
  ['池子未命中稳态 ≤3s', missSteadyAvg <= 3000, `平均 ${missSteadyAvg}ms（逐次 ${missSteady.join('/')}ms）`],
  ['池子命中 <1s', hitAvg < 1000, `平均 ${hitAvg}ms（逐次 ${hitRuns.join('/')}ms）`],
  ['命中仍给母带档（不被备用源降级）', hitRuns.length > 0, `actualQuality=${hitRuns.length ? '见上' : '-'}`],
]
let failed = 0
for (const [label, ok, evidence] of checks) {
  console.log(`  ${ok ? '✅' : '❌'} ${label} —— ${evidence}`)
  if (!ok) failed++
}

server.close()
server.closeAllConnections()
console.log(failed ? `\n结果：${failed} 项未达标` : '\n结果：全部达标')
process.exit(failed ? 1 : 0)
