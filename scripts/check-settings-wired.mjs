// 设置面板「必须真的有效」的回归测试。
//
// 背景：设置面板里曾经有一批控件是空壳 —— 前端把值存进 localStorage，
// 但既没有后端消费，也没有前端消费：
// · 缓存上限 / 缓存位置：后端硬编码 4GB 与 music-data/，滑块白拖
// · 清理缓存按钮：data-action 没有对应处理器，点了什么都不发生
// · 渲染模式 / 无缝切歌 / 侧边栏显示我喜欢 / 显示通知 / 侧边栏管理 / MV 下载目录：
// 控制的东西在界面上根本不存在
//
// 这个测试锁定两件事：
// ① 设置面板里出现的每个 data-action，必须有处理器（前端引用次数 >= 2）
// ② 设置面板里出现的每个 data-settings-key，必须是「前端真的读」或「后端真的读」
// —— 或者是明确已知的纯前端显示项白名单
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || process.cwd()
const APP = fs.readFileSync(path.join(ROOT, 'src/music-app.ts'), 'utf8')

// 取出设置面板那一段
const start = APP.indexOf('data-settings-group="playback"')
const end = APP.indexOf("$('#panel-body').insertAdjacentHTML")
const panel = APP.slice(start, end > start ? end : start + 60000)
assert.ok(panel.length > 500, '设置面板片段应当能取到')

// 后端运行时（排除 check-*.mjs 测试）
const runtime = []
const walk = (dir) => {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!/node_modules|\.cache|target|dist|release|_layer|_probe|_audit/.test(p)) walk(p) }
    else if (/\.mjs$/.test(e.name) && !e.name.startsWith('check-') && !e.name.startsWith('_')) runtime.push(p)
  }
}
walk(path.join(ROOT, 'scripts'))
walk(path.join(ROOT, 'src'))
const backendText = runtime.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ① 每个 data-action 都要有处理器
const actions = [...new Set([...panel.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]))]
const deadActions = actions.filter((a) => (APP.match(new RegExp(escapeRe(a), 'g')) || []).length < 2)
assert.deepEqual(deadActions, [], `这些按钮没有处理器: ${deadActions.join(', ')}`)

// ② 每个 data-settings-key 都要有人读
// 纯前端显示项：值只影响界面，前端自己消费，后端不需要知道。
const FRONTEND_ONLY = new Set(['minimizeToTray']) // 走 Rust IPC，不在 scripts/ 里
const keys = [...new Set([...panel.matchAll(/data-settings-key="([^"]+)"/g)].map((m) => m[1]))]
const orphanKeys = []
for (const key of keys) {
  if (FRONTEND_ONLY.has(key)) continue
  const inFront = (APP.match(new RegExp(escapeRe(key), 'g')) || []).length >= 2
  const inBack = backendText.includes(key)
 // 缓存两项在前端通过 syncCacheSettings 下发（参数名是 limitMb/location），
 // 后端不出现 cacheLimit 字样，所以单独放行。
  const bridged = key === 'cacheLimit' || key === 'cacheLocation'
  if (!inFront && !inBack && !bridged) orphanKeys.push(key)
}
assert.deepEqual(orphanKeys, [], `这些设置没人消费: ${orphanKeys.join(', ')}`)

// ③ 缓存三件套的契约必须存在
assert.ok(APP.includes('pushCacheSettings'), '缓存偏好必须下发给后端')
assert.ok(APP.includes('clearCacheFromSettings'), '清理缓存必须有实现')
assert.ok(APP.includes('case "cache-clear"'), '清理缓存按钮必须有分支')
const desktop = fs.readFileSync(path.join(ROOT, 'src/desktop.ts'), 'utf8')
for (const fn of ['syncCacheSettings', 'clearAudioCache', 'readAudioCacheUsage']) {
  assert.ok(desktop.includes(fn), `desktop.ts 必须导出 ${fn}`)
}

// ④ 后端必须真的有这三个端点，并且上限不再硬编码
const server = fs.readFileSync(path.join(ROOT, 'scripts/music-server.mjs'), 'utf8')
for (const route of ['/api/audio/cache', '/api/audio/cache/configure', '/api/audio/cache/clear']) {
  assert.ok(server.includes(route), `后端缺端点 ${route}`)
}
const audio = fs.readFileSync(path.join(ROOT, 'scripts/music-audio.mjs'), 'utf8')
assert.ok(audio.includes('this.cacheLimitBytes'), '缓存上限必须可配置')
assert.ok(!/if \(total \+ file\.size > MAX_CACHE_BYTES\)/.test(audio), 'prune 必须用可配置上限，不能用硬编码常量')

console.log(`  ✔ ${actions.length} 个按钮全部有处理器`)
console.log(`  ✔ ${keys.length} 个设置项全部被消费`)
console.log('  ✔ 缓存上限 / 位置 / 清理 三件套前后端契约完整')
