/**
 * LX 音源端到端验证（准确链路）：
 * 我们自己的平台搜索 → 拿到真实 song id → LX 插件取全曲地址 → 真下载校验
 *
 * LX 插件多数只提供 musicUrl（LX Music 的搜索由客户端内置），所以分工是：
 * 搜索走六平台，播放兜底走插件。
 *
 * node scripts/verify-lx-e2e.mjs <音源目录> [关键词]
 */
import { LxSourceHost } from './lx-source-host.mjs'
import { createMusicServer } from './music-server.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = process.argv[2] ?? process.env.LX_SOURCES_DIR
const keyword = process.argv[3] ?? '落了白'
if (!dir) { console.error('用法: node scripts/verify-lx-e2e.mjs <音源目录> [关键词]'); process.exit(1) }

const line = (s) => console.log(s)
const host = new LxSourceHost({ callTimeout: 60000 })
let server
try {
  line(`\n音源目录：${dir}`)
  const report = await host.loadDirectory(dir)
  const ok = report.filter((r) => r.ok)
  line(`插件加载：${ok.length} / ${report.length} 成功`)
  for (const r of report.filter((r) => !r.ok)) line(`  ✗ ${r.name}：${r.error}`)
  const sources = host.sources
  line(`平台覆盖：${[...new Set(sources.map((s) => s.source))].join(', ')}`)
  line(`可取曲源：${sources.filter((s) => s.actions.includes('musicUrl')).length} 个`)

 // 1) 用我们自己的平台搜索拿真实歌曲
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lx-verify-'))
  const created = await createMusicServer({ dataDir, autoScan: false })
  server = created.server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  line(`\n平台搜索「${keyword}」…`)
  const found = []
  for (const provider of ['kuwo', 'kugou', 'qq', 'netease']) {
    try {
      const response = await fetch(`${base}/api/online/${provider}/search?q=${encodeURIComponent(keyword)}&offset=0`, { signal: AbortSignal.timeout(20000) })
      const value = await response.json()
      const first = value.tracks?.[0]
      if (first) {
        found.push({ provider, track: first })
        line(`  ✓ ${provider}：${first.title} — ${first.artist}  (id ${first.onlineSource.id})`)
      } else line(`  · ${provider}：无结果`)
    } catch (err) {
      line(`  ✗ ${provider}：${err.message}`)
    }
  }
  if (!found.length) { line('\n平台搜索没有拿到歌曲，无法验证取曲。'); process.exitCode = 1 }

 // 2) 每个平台的歌，交给 LX 插件取全曲地址，并真下载校验
  line('\nLX 插件取曲 + 下载校验…')
  let playable = 0
  for (const { provider, track } of found) {
    const started = Date.now()
    try {
      const result = await host.resolveForProvider(provider, track.onlineSource.id, { quality: '320k', name: track.title, singer: track.artist })
      if (!result?.audioUrl) { line(`  ✗ ${provider}：${result?.error ?? '无地址'}`); continue }
      const response = await fetch(result.audioUrl, { headers: { Range: 'bytes=0-131071' }, signal: AbortSignal.timeout(20000) })
      const bytes = (await response.arrayBuffer()).byteLength
      const type = response.headers.get('content-type') ?? '?'
      if (response.ok && bytes > 1000) {
        playable++
        line(`  ✓ ${provider}  ${response.status} ${(bytes / 1024).toFixed(0)}KB ${type}  ${Date.now() - started}ms  ← ${result.plugin}`)
      } else {
        line(`  ✗ ${provider}  地址返回 ${response.status}（${bytes}B）`)
      }
    } catch (err) {
      line(`  ✗ ${provider}：${err.message}`)
    }
  }
  line(`\n可播放：${playable} / ${found.length}`)
  process.exitCode = playable > 0 ? 0 : 1
} catch (err) {
  console.error(`失败：${err.message}`)
  process.exitCode = 1
} finally {
  host.terminate()
  server?.close(); server?.closeAllConnections?.()
  process.exit(process.exitCode ?? 0)
}
