/**
 * 后端联通性验收：0.1.6 三件事的端到端检查。
 *   1. 加密密钥能导入，状态里只有到期时间、没有账号名；
 *   2. 连通性检测接口返回线路 + 平台上游；
 *   3. 音源清单/停用/移除/计数按新契约工作（内置不可移除）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMusicServer } from './music-server.mjs'

const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail ? '：' + detail : ''}`)
}

const keyPath = 'C:/Users/Administrator/Desktop/Rhine-共享音源.rhinekey'
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rhine-016-'))
const { server } = await createMusicServer({ dataDir, autoScan: false })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (route, init) => {
  const response = await fetch(base + route, init)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

try {
  // ── 1. 密钥：加密导入
  const raw = fs.readFileSync(keyPath)
  check('密钥文件是加密信封', raw.subarray(0, 4).toString('ascii') === 'RHK1', `实际 ${raw.subarray(0, 4).toString('hex')}`)
  const printable = [...raw].filter((b) => b >= 32 && b <= 126).length / raw.length
  check('密钥文件不是可读文本', printable < 0.6, `可打印 ${(printable * 100).toFixed(0)}%`)

  const imported = await call('/api/pool/credential/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: raw.toString('base64') }),
  })
  check('导入成功', imported.status === 200, `${imported.status} ${JSON.stringify(imported.body).slice(0, 120)}`)
  check('导入后已配置', imported.body?.configured === true)
  check('状态含到期时间', typeof imported.body?.expiresAt === 'string')
  check('状态不含账号名', !Object.hasOwn(imported.body ?? {}, 'account'), JSON.stringify(Object.keys(imported.body ?? {})))

  // ── 2. 音源管理
  // 插件加载是后台进行的（不挡服务启动），这里等它落地再断言。
  let status = await call('/api/lx/status')
  for (let attempt = 0; attempt < 60 && !(status.body?.plugins ?? []).length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    status = await call('/api/lx/status')
  }
  check('音源状态 200', status.status === 200)
  check('返回插件清单', Array.isArray(status.body?.plugins) && status.body.plugins.length > 0, `总数 ${status.body?.plugins?.length}`)
  check('返回计数', status.body?.counts?.total === status.body?.plugins?.length)
  check('清单带内置标记', status.body.plugins.some((plugin) => plugin.builtin === true))
  console.log(`  音源：已加载 ${status.body?.counts?.loaded}/${status.body?.counts?.total}`)

  const builtin = status.body.plugins.find((plugin) => plugin.builtin)
  const removeBuiltin = await call('/api/lx/sources/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: builtin.id }),
  })
  check('内置音源拒绝移除', removeBuiltin.status === 403, `实际 ${removeBuiltin.status}`)

  const toggled = await call('/api/lx/sources/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: builtin.id, enabled: false }),
  })
  check('停用成功', toggled.status === 200 && toggled.body.counts.loaded === status.body.counts.loaded - 1,
    `loaded ${toggled.body?.counts?.loaded}`)
  const reenabled = await call('/api/lx/sources/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: builtin.id, enabled: true }),
  })
  check('重新启用恢复计数', reenabled.body?.counts?.loaded === status.body.counts.loaded)

  // 添加一份用户音源（最小可用插件），再移除
  const pluginSource = `module.exports = { name: '验收测试音源', version: '0.0.1',
  sources: { kw: { name: '测试', actions: ['musicUrl'], qualitys: ['128k'] } },
  async musicUrl() { return '' } }`
  const added = await call('/api/lx/sources/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'verification-plugin.js', text: pluginSource }] }),
  })
  check('添加用户音源成功', added.status === 200, JSON.stringify(added.body).slice(0, 160))
  const userAdded = (added.body?.plugins ?? []).find((plugin) => plugin.builtin === false)
  if (userAdded) {
    check('用户音源标记为非内置', userAdded.builtin === false)
    const removed = await call('/api/lx/sources/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: userAdded.id }),
    })
    check('用户音源可以移除', removed.status === 200, `实际 ${removed.status}`)
  }
  // ── 3. 连通性检测（放在音源加载之后：加载期会挤占带宽）
  const probe = await call('/api/pool/lines/probe?scope=all', { method: 'POST' })
  check('探测接口 200', probe.status === 200)
  const lines = probe.body?.results ?? []
  const upstreams = probe.body?.upstreams ?? []
  check('线路只有活的那条', lines.length >= 1 && lines.every((line) => line.reachable), JSON.stringify(lines))
  check('探测结果带 host', lines.every((line) => typeof line.host === 'string'), JSON.stringify(lines))
  check('四个平台上游都有结论', upstreams.length === 4, `实际 ${upstreams.length}`)
  const alive = upstreams.filter((item) => item.ok)
  check('至少两个平台上游可用', alive.length >= 2, upstreams.map((u) => `${u.platform}:${u.ok}`).join(' '))
  console.log('  线路：' + lines.map((line) => `${line.host} ${line.latency_ms}ms`).join('，'))
  console.log('  上游：' + upstreams.map((u) => `${u.platform} ${u.ok ? u.latency_ms + 'ms ' + (u.quality ?? '') : '超时'}`).join('，'))

} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(failures.length ? 1 : 0)
}

if (failures.length) {
  console.error('✗ 后端验收未通过：')
  for (const line of failures) console.error('  · ' + line)
  process.exit(1)
}
