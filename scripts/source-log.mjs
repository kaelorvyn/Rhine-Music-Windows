/**
 * 取源日志：把「每首歌经过哪些音源、每一跳花了多久、为什么失败」落盘。
 *
 * 为什么要单独一个文件：
 *  1. Tauri 打包后没有控制台，`MUSIC_DEBUG_RESOLVE` 打出来的东西用户看不到，
 *     事后也没法回看 —— 排「某些歌很慢」这类问题必须有历史记录。
 *  2. 一条记录要能同时回答三件事：这首歌最后用了哪个源、整条链总耗时多少、
 *     卡在哪一跳。控制台日志是散行，拼不出这个结构。
 *
 * 落盘位置：`<dataDir>/source-log.jsonl`（JSONL：一行一首歌，可直接追加）。
 * 只在启动时读回最后一段用于「最近播放」面板，写入是纯追加，不影响播放路径。
 *
 * 设计取向：**绝不阻塞播放**。写盘失败、目录不存在、磁盘满，都只记一次内部
 * 错误然后继续 —— 日志坏了不能连带播放坏掉。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 日志文件保留条数上限。一首歌一条，6000 条足够回溯很久又不至于撑爆磁盘。 */
const MAX_ENTRIES = 6000
/** 单条记录里 attempts 的条数上限（正常 3~4 跳，留余量防异常膨胀）。 */
const MAX_ATTEMPTS = 24

const clamp = (value, max) => String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max)

export class SourceLog {
  constructor({ dataDir, maxEntries = MAX_ENTRIES } = {}) {
    this.file = dataDir ? path.join(dataDir, 'source-log.jsonl') : null
    this.maxEntries = maxEntries
    /** 内存里的最近记录（新的在前），供 /api/source-log 读取。 */
    this.entries = []
    this.writeChain = Promise.resolve()
    this.writeError = ''
    this.dropped = 0
  }

  /** 读回最近记录。文件损坏时从空开始，并把坏文件改名留证。 */
  async init() {
    if (!this.file) return this
    // 目录可能还不存在（首次运行 / 便携版没带 music-data-v3）：
    // 先建出来，否则后面每次 append 都会 ENOENT —— 那就等于日志从未生效。
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {})
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const entries = []
      for (const line of lines.slice(-this.maxEntries)) {
        try {
          const entry = JSON.parse(line)
          if (entry && typeof entry === 'object' && entry.id) entries.push(entry)
        } catch { /* 单行坏了跳过，不连累整个文件 */ }
      }
      this.entries = entries.reverse()
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 文件存在但读不动/解析失败：留证再用空库起步。
        await fs.promises.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
        this.writeError = `读取失败：${error?.message ?? error}`
      }
    }
    return this
  }

  /** 追加一条取源记录。返回落库后的对象，便于调用方回传给前端。 */
  record(entry) {
    const normalized = this.normalize(entry)
    this.entries.unshift(normalized)
    if (this.entries.length > this.maxEntries) {
      this.dropped += this.entries.length - this.maxEntries
      this.entries.length = this.maxEntries
    }
    this.append(normalized)
    return normalized
  }

  /** 结构归一 + 裁剪，保证落盘的东西永远是同一个形状。 */
  normalize(entry) {
    const attempts = Array.isArray(entry?.attempts) ? entry.attempts : []
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      // 歌曲身份：能看出是哪首歌就够了，不存整份元数据。
      provider: clamp(entry?.provider, 40),
      songId: clamp(entry?.songId, 300),
      title: clamp(entry?.title, 300),
      artist: clamp(entry?.artist, 200),
      quality: clamp(entry?.quality, 20),
      // 结论
      source: clamp(entry?.source, 40),          // 命中的跳名，空 = 全链未命中
      ok: Boolean(entry?.ok),
      totalMs: Number(entry?.totalMs) || 0,
      // 逐跳明细
      attempts: attempts.slice(0, MAX_ATTEMPTS).map((item) => ({
        name: clamp(item?.name, 60),
        ok: Boolean(item?.ok),
        skipped: Boolean(item?.skipped),
        latencyMs: Number(item?.latencyMs ?? item?.latency_ms) || 0,
        detail: clamp(item?.detail, 400),
        // 备用音源会报出具体是哪个站赢了/失败了
        sourceName: clamp(item?.sourceName ?? item?.backupSource, 80),
      })),
      // 失败时的整体错误文案（前端可以直接展示）
      error: clamp(entry?.error, 400),
    }
  }

  append(entry) {
    if (!this.file) return
    const line = `${JSON.stringify(entry)}\n`
    // 串行写入，避免并发互相截断；错误只记一次，不往上抛。
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => fs.promises.appendFile(this.file, line, 'utf8'))
      .catch((error) => { this.writeError = `写入失败：${error?.message ?? error}` })
  }

  /** 最近记录，支持按键过滤（排查某首歌/某个音源时用）。 */
  recent({ limit = 200, provider = '', query = '', onlyFailed = false } = {}) {
    const needle = query.trim().toLowerCase()
    let list = this.entries
    if (provider) list = list.filter((item) => item.provider === provider)
    if (onlyFailed) list = list.filter((item) => !item.ok)
    if (needle) {
      list = list.filter((item) =>
        [item.title, item.artist, item.songId, item.source, item.error]
          .join(' ').toLowerCase().includes(needle))
    }
    return list.slice(0, Math.max(1, Math.min(2000, limit)))
  }

  /** 统计：各音源命中次数 / 平均耗时 / 超时次数，一眼看出哪个源在拖后腿。 */
  stats() {
    const bySource = new Map()
    let totalMs = 0
    let failed = 0
    for (const entry of this.entries) {
      totalMs += entry.totalMs
      if (!entry.ok) failed++
      for (const attempt of entry.attempts) {
        if (attempt.skipped) continue
        const bucket = bySource.get(attempt.name) ?? { name: attempt.name, tried: 0, hits: 0, timeouts: 0, totalMs: 0 }
        bucket.tried++
        if (attempt.ok) bucket.hits++
        if (/超时/.test(attempt.detail)) bucket.timeouts++
        bucket.totalMs += attempt.latencyMs
        bySource.set(attempt.name, bucket)
      }
    }
    return {
      entries: this.entries.length,
      failed,
      avgTotalMs: this.entries.length ? Math.round(totalMs / this.entries.length) : 0,
      writeError: this.writeError,
      dropped: this.dropped,
      bySource: [...bySource.values()]
        .map((bucket) => ({ ...bucket, avgMs: bucket.tried ? Math.round(bucket.totalMs / bucket.tried) : 0 }))
        .sort((a, b) => b.tried - a.tried),
    }
  }

  clear() {
    this.entries = []
    this.dropped = 0
    if (!this.file) return Promise.resolve()
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => fs.promises.rm(this.file, { force: true }))
      .catch((error) => { this.writeError = `清空失败：${error?.message ?? error}` })
    return this.writeChain
  }
}
