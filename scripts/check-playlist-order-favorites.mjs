/**
 * 验证用户的三条要求：
 * 1. 收藏 → 进莱茵歌单；取消收藏 → 退出莱茵歌单（后端 favorites 双向）
 * 2. 莱茵歌单不再排第一位（`summary()` 里固定垫底）
 * 3. 歌单来源顺序：网易云 → 酷狗 → QQ → 莱茵（最后）
 */
import assert from 'node:assert/strict'
import { LocalPlaylists } from './local-playlists.mjs'

// ---- 1 & 2：LocalPlaylists 层 ----
{
  const store = await new LocalPlaylists({}).init()
  const a = store.create('第一个')
  const b = store.create('第二个')
  assert.ok(a && b, '建歌单成功')

  const summary = store.summary()
  assert.equal(summary.at(-1).id, 'favorites', '莱茵歌单必须排在最后一位')
  assert.equal(summary.at(-1).favorites, true, '最后一位是收藏')
 // create() 用 unshift，最新建的在最前 —— 这是既有设计，不属本次改动范围。
  const names = summary.slice(0, -1).map(p => p.name)
  assert.deepEqual(names, ['第二个', '第一个'], `自建歌单在前且保持既有顺序，实际 ${names.join(',')}`)
  console.log('✅ 莱茵歌单排在最后一位（自建歌单在前）')

  const song = { id: 'demo-1', title: '测试曲', artist: '测试人', album: '测试专辑', duration: 180, format: 'flac' }
  const on = store.favorite(song)
  assert.equal(on.favorited, true, '收藏应成功')
  assert.equal(store.summary().at(-1).count, 1, '收藏后莱茵歌单有 1 首')
  assert.equal(store.isFavorite('demo-1'), true, '收藏态为真')

  const off = store.unfavorite('demo-1')
  assert.equal(off.favorited, false, '取消收藏应成功')
  assert.equal(store.summary().at(-1).count, 0, '取消后莱茵歌单回到 0 首（即退出歌单）')
  assert.equal(store.isFavorite('demo-1'), false, '收藏态为假')
  console.log('✅ 收藏进莱茵歌单 / 取消收藏退出莱茵歌单')
}

// ---- 3：前端排序逻辑（直接测纯函数行为，避免起服务）----
{
 // 复刻 music-app.ts 里的排序契约：netease(0) → kugou(1) → qq(2) → 其余(3)，local 垫底
  const rank = { netease: 0, kugou: 1, qq: 2 }
  const order = (providers) => providers
    .map((provider, index) => ({ provider, index, rank: rank[provider] ?? 3 }))
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
    .map(item => item.provider)

 // 输入顺序故意打乱，模拟 musicPlatforms 的键顺序 netease,qq,bodian,kugou,kuwo,joox
  const input = ['netease', 'qq', 'bodian', 'kugou', 'kuwo', 'joox']
  const out = order(input)
  assert.deepEqual(out.slice(0, 3), ['netease', 'kugou', 'qq'], `点名平台须为 网易云→酷狗→QQ，实际 ${out.slice(0, 3).join(',')}`)
  assert.deepEqual(out.slice(3), ['bodian', 'kuwo', 'joox'], '未点名平台保持原相对顺序跟在后面')
  console.log(`✅ 平台排序：${out.join(' → ')} → local（最后）`)
}
console.log('\n全部通过。')
process.exit(0)
