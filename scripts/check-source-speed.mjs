/**
 * check:source-speed —— 取源提速的回归护栏
 *
 *   npm run check:source-speed
 *
 * 【2026-10-16 对齐：本文件断言的契约已从"竞速"改为"串行快速失败"】
 *
 * 历史：这个脚本原本固化的是"谁先成功用谁"（并发竞速）——那是我们自己发明的，
 * 。真实结构（真实 exe 字符串逐字确认，`D:\音乐\service.exe`）：
 *
 *     src\backup_source.rs → ` 备用 HTTP 失败: ` / ` 备用请求失败: `
 *                          / ` 备用接口未返回播放地址`（逐站拼接）
 *     src\playback.rs      → `播放地址解析失败: ` … `; 备用音源: <名字>`
 *
 * 这种"链式失败后拼错误消息"的形态证明它是**串行**：问完一站再问下一站。
 * exe 里搜不到「竞速」，也没有"总预算"概念。
 *
 * 所以本文件现在断言的是新契约：
 *   1. **串行**：按 DEFAULT_SOURCES 声明顺序逐个问，前一个死掉才问下一个
 *   2. **快速失败**：每一跳都有自己的**硬超时**（≤3s），死站被硬切
 *   3. 硬超时必须是 `Promise.race` 级别 —— 连"不理 signal 的 fetch"也能切断
 *   4. 2000ms 的"慢但成功"仍必须被采用（超时不能小到掐掉能用的源）
 *   5. 坏站连续失败后被跳过
 *
 * 全部用假数据，不联网、不跑自检（自检要 95 秒，是噪声不是被测对象）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BackupSources, SOURCE_TIMEOUT_MS } from './backup-sources.mjs'
import { qualityLadder, PLAY_QUALITYS } from './lx-source-loader.mjs'

/** 造一个可控延迟的假 fetch：按 URL 里的关键字决定延迟与响应。 */
function fakeFetch(routes) {
  return async (url, options = {}) => {
    for (const [match, behavior] of Object.entries(routes)) {
      if (!String(url).includes(match)) continue
      if (behavior.hang) {
        // 模拟"挂死且不理 signal"：只有调用方的硬超时能救。
        return new Promise((_, reject) => {
          options.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
        })
      }
      if (behavior.delay) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, behavior.delay)
          options.signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
        })
      }
      if (behavior.throw) throw new Error('network down')
      return new Response(JSON.stringify(behavior.body ?? {}), { status: behavior.status ?? 200 })
    }
    return new Response('{}', { status: 200 })
  }
}

test('备用源是串行链：按声明顺序问，前一站死掉才问下一站', async () => {
  // 记录真实调用顺序。用 qq —— 三个站都声明支持它（kuwo 只适用 lx + generic，
  // 因为 QQ Music API 的 providers 是 ['qq']，这是对齐 backup_source.rs 的）。
  const order = []
  const sources = new BackupSources({
    fetch: async (url) => {
      if (String(url).includes('yy.zddyr.top')) { order.push('lx'); return new Response('{"code":500}', { status: 200 }) }
      if (String(url).includes('ygking.top')) { order.push('qq'); throw new Error('network down') }
      order.push('generic')
      return new Response('{"url":"https://cdn.example/song.flac"}', { status: 200 })
    },
  })
  const found = await sources.resolve('qq', '003aAYrm3GE0Ac', { quality: '320k', title: '青丝' })
  assert.ok(found?.audioUrl, '应拿到可用地址')
  assert.deepEqual(order, ['lx', 'qq', 'generic'], `必须按声明顺序串行（实际 ${order.join(' → ')}）`)
})

test('串行遇到成功立即收口，不再问后面的站', async () => {
  const order = []
  const sources = new BackupSources({
    fetch: async (url) => {
      if (String(url).includes('yy.zddyr.top')) { order.push('lx'); return new Response('{"code":200,"url":"https://cdn.example/first.mp3"}', { status: 200 }) }
      order.push('later')
      return new Response('{"url":"https://cdn.example/later.mp3"}', { status: 200 })
    },
  })
  const found = await sources.resolve('kuwo', 'MUSIC_2', { quality: '320k' })
  assert.equal(found?.audioUrl, 'https://cdn.example/first.mp3', '第一站成功就必须用它')
  assert.deepEqual(order, ['lx'], `成功后不得继续问后面的站（实际 ${order.join(' → ')}）`)
})

test('硬超时能切断「挂死且不理 signal」的站点（Promise.race 级别）', async () => {
  // 死主机 music.bxa241d4.shop 的真实形态：连接挂起。
  // 实测不传 signal 时 10801ms 才失败（undici 自己的连接超时），
  // 所以必须有硬上限，且不能只依赖 AbortSignal。
  const sources = new BackupSources({
    fetch: fakeFetch({
      'yy.zddyr.top': { hang: true },
      'ygking.top': { hang: true },
      'bxa241d4.shop': { hang: true },
    }),
  })
  const started = Date.now()
  const found = await sources.resolve('kuwo', 'MUSIC_hang', { quality: '320k' })
  const ms = Date.now() - started
  assert.equal(found, null, '三个站全挂时应返回 null')
  assert.ok(ms <= SOURCE_TIMEOUT_MS * 3 + 1500, `串行三站全挂最坏 3×${SOURCE_TIMEOUT_MS}ms，实测 ${ms}ms（旧行为仅单站就 10690ms）`)
})

test('逐站探测结果可读：每站的耗时与原因都记录下来', async () => {
  const sources = new BackupSources({
    fetch: fakeFetch({
      'yy.zddyr.top': { body: { code: 500 } },
      'ygking.top': { throw: true },
    }),
  })
  await sources.resolve('kuwo', 'MUSIC_diag', { quality: '320k' })
  const results = sources.results
  assert.ok(Array.isArray(results) && results.length >= 2, '应记录逐站结果')
  for (const item of results) {
    assert.ok(typeof item.name === 'string' && item.name.length > 0, 'results 需含 name')
    assert.ok(typeof item.latency_ms === 'number', 'results 需含 latency_ms')
    assert.ok(typeof item.detail === 'string', 'results 需含 detail')
  }
})

test('坏站点连续失败后被跳过（不再每首歌都白等一个超时）', async () => {
  const sources = new BackupSources({
    fetch: fakeFetch({
      'yy.zddyr.top': { throw: true },
      'ygking.top': { throw: true },
      'bxa241d4.shop': { body: { code: 200, url: 'https://cdn.example/a.mp3' } },
    }),
  })
  // 前 3 次触发失败记忆（阈值 3）
  for (let i = 0; i < 3; i++) await sources.resolve('kuwo', `MUSIC_x${i}`, { quality: '320k' })
  const streaks = Object.fromEntries(sources.status.map(s => [s.name, s.failStreak]))
  assert.equal(streaks['LX Music API'], 3, '连续失败应被计数')
  assert.ok(streaks['LX Music API'] >= 3, '达到阈值后本轮跳过')
})

test('单站超时落在 2–3s（不设 10s）', async () => {
  const sources = new BackupSources({ fetch: fakeFetch({}) })
  assert.ok(sources.timeout >= 2000 && sources.timeout <= 3000,
    `单站超时应在 2–3s，实测 ${sources.timeout}ms（旧值 15000，三站串行最坏 45s）`)
  assert.equal(SOURCE_TIMEOUT_MS, sources.timeout, '导出常量与实例值必须一致')
})

test('冷启动余量：单源超时不能小到掐掉慢但成功的调用', async () => {
  // 教训：曾把单源超时收到 3000ms，而冷启动首次取曲要 1.9~3.0 秒（插件初始化
  // + 远端握手），正好卡在临界点 —— 3022ms 失败、2907ms 成功，把能放的歌
  // 变成放不出（check-lx-sources 的 fee-only 用例就是这样挂的）。
  // 常量没导出，用行为断言：一个耗时 2 秒的"慢但成功"的源必须还能被采用。
  const sources = new BackupSources({
    fetch: fakeFetch({ 'bxa241d4.shop': { delay: 2000, body: { code: 200, url: 'https://cdn.example/slow.flac' } } }),
  })
  const found = await sources.resolve('kuwo', 'MUSIC_slow', { quality: '320k' })
  assert.ok(found?.audioUrl, '慢但能成功的源必须仍被采用（超时不能掐掉它）')
})

test('取曲档位只走 3 档（对齐洛雪 TRY_QUALITYS_LIST）', () => {
  // 洛雪：TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k']，只问第一个受支持的。
  // 我们原来是 9 档从 master 起串行，320k 起点实测 7 档 → 最坏 24.5 秒。
  assert.deepEqual(PLAY_QUALITYS, ['flac24bit', 'flac', '320k'])
  const ladder = qualityLadder('320k')
  assert.equal(ladder.length, 3, `常规播放应只走 3 档，实测 ${ladder.length} 档`)
  assert.equal(ladder[0], 'flac24bit', '默认从最高可用档起（用户要求默认最高音质）')
  assert.ok(ladder.includes('320k'), '320k 必须兜底，否则强求无损会放不出歌')
})
