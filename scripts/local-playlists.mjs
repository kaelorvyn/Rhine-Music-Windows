// 本地歌单与「我喜欢的音乐」存储。
//
// 歌单分两类：平台歌单（酷狗/酷我/网易云等账号里的）与**本地歌单**
// （自建、只存在本机，playlist.platform.local = ""）。这里实现后者：
// 新建/重命名/删除/加歌/移除/排序 + 我喜欢的音乐（收藏）。
//
// 设计要点（与项目既有存储一致）：
// * 落盘 playlists.json，走 writeJsonAtomic（原子写）避免半截文件；
// * 文件损坏时保留现场（改名 .corrupt）并以空歌单启动，不阻断整个服务；
// * 歌目**自带元数据快照** —— 在线歌的 track id 会随登录态/平台变动，
// 只存 id 会丢歌；快照让歌单在任何时候都能重新取址播放。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from './music-library.mjs'

const failure = (message, status = 400) => Object.assign(new Error(message), { status })

/** 与同量级的上限：歌单数、单歌单曲目数、名称长度。 */
export const MAX_PLAYLISTS = 500
export const MAX_SONGS_PER_PLAYLIST = 10000
export const MAX_NAME = 100
export const MAX_SONG_FIELD = 300

const FAVORITES_ID = 'favorites'
const FAVORITES_NAME = '莱茵歌单'

const EMPTY = () => ({ version: 1, playlists: [], favorites: { songs: [] } })

const clean = (value, max) => String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max)

/** 一首歌在歌单里的样子：身份 + 元数据快照 + 统计。 */
/** 封面只接受 http(s) 与 data:image，长度设上限，避免被塞进任意内容。 */
function cleanCover(value) {
  const text = String(value ?? '').trim().slice(0, 600)
  if (!text) return ''
  return /^(https?:\/\/|data:image\/)/i.test(text) ? text : ''
}

function normalizeSong(input) {
  const song = {
    id: clean(input?.id, MAX_SONG_FIELD),
    title: clean(input?.title, MAX_SONG_FIELD),
    artist: clean(input?.artist, MAX_SONG_FIELD),
    album: clean(input?.album, MAX_SONG_FIELD),
    cover: cleanCover(input?.cover),
    provider: clean(input?.provider, 40),
    onlineSourceId: clean(input?.onlineSourceId, MAX_SONG_FIELD),
    addedAt: Number.isFinite(input?.addedAt) ? Number(input.addedAt) : Date.now(),
    playCount: Number.isFinite(input?.playCount) ? Math.max(0, Math.floor(input.playCount)) : 0,
  }
  const duration = Number(input?.duration)
  if (Number.isFinite(duration) && duration > 0) song.duration = Math.min(duration, 24 * 3600)
 // 音质档位排序依据（ playlist.sort.quality「按最高音质」）。
  const rank = Number(input?.qualityRank)
  if (Number.isFinite(rank) && rank >= 0) song.qualityRank = Math.min(99, Math.floor(rank))
  return song
}

function normalizePlaylist(input) {
  const playlist = {
    id: clean(input?.id, 80) || `local-${randomUUID()}`,
    name: clean(input?.name, MAX_NAME),
    createdAt: Number.isFinite(input?.createdAt) ? Number(input.createdAt) : Date.now(),
    updatedAt: Number.isFinite(input?.updatedAt) ? Number(input.updatedAt) : Date.now(),
    songs: Array.isArray(input?.songs) ? input.songs.map(normalizeSong).filter(song => song.id) : [],
  }
  if (playlist.songs.length > MAX_SONGS_PER_PLAYLIST) playlist.songs.length = MAX_SONGS_PER_PLAYLIST
  return playlist
}

function normalize(value) {
  if (!value || typeof value !== 'object') return EMPTY()
  const playlists = Array.isArray(value.playlists) ? value.playlists.map(normalizePlaylist) : []
  const seen = new Set()
  const unique = playlists.filter(playlist => {
    if (playlist.id === FAVORITES_ID || seen.has(playlist.id)) return false
    seen.add(playlist.id)
    return true
  }).slice(0, MAX_PLAYLISTS)
  const favorites = Array.isArray(value.favorites?.songs) ? value.favorites.songs.map(normalizeSong).filter(song => song.id) : []
  return { version: 1, playlists: unique, favorites: { songs: favorites.slice(0, MAX_SONGS_PER_PLAYLIST) } }
}

/** 歌单排序规则（对齐 playlist.sort.*）：按添加时间/艺术家/播放次数/名称/平台/最高音质。 */
export const SORT_KEYS = ['addedAt', 'artist', 'playCount', 'name', 'platform', 'quality']

/** 名称排序按中文习惯：localeCompare('zh') 让「阿」在「波」前，而不是按码点。 */
const byText = (a, b, key) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'zh')

/**
 * 对歌单内的曲目排序。默认顺序（'default'）保持用户手工排的次序，
 * 其余规则只影响**展示顺序**，不改磁盘上的原始次序。
 */
export function sortSongs(songs, key = 'default', direction = 'ascending') {
  if (!SORT_KEYS.includes(key)) return [...songs]
  const sign = direction === 'descending' ? -1 : 1
  const compare = (a, b) => {
    switch (key) {
      case 'addedAt': return sign * ((a.addedAt ?? 0) - (b.addedAt ?? 0))
      case 'playCount': return sign * ((a.playCount ?? 0) - (b.playCount ?? 0))
      case 'artist': return sign * byText(a, b, 'artist')
      case 'platform': return sign * byText(a, b, 'provider')
      case 'name': return sign * byText(a, b, 'title')
 // 按最高音质：没有音质信息的排最后（用 -1 垫底），升序=低到高。
      case 'quality': return sign * ((a.qualityRank ?? -1) - (b.qualityRank ?? -1))
      default: return 0
    }
  }
 // 稳定排序：同值保持原有手工次序。
  return songs.map((song, index) => ({ song, index })).sort((a, b) => compare(a.song, b.song) || a.index - b.index).map(entry => entry.song)
}

export class LocalPlaylists {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir
    this.file = dataDir ? path.join(dataDir, 'playlists.json') : null
    this.data = EMPTY()
    this.saveChain = Promise.resolve()
  }

  async init() {
    if (!this.file) return this
    try {
      this.data = normalize(await readJson(this.file, EMPTY()))
    } catch (error) {
 // 损坏时保住现场再以空库启动：用户还有机会手工抢救，服务不会起不来。
      const backup = `${this.file}.corrupt-${Date.now()}`
      await import('node:fs/promises').then(fs => fs.rename(this.file, backup).catch(() => {}))
      this.data = EMPTY()
      this.corruptBackup = backup
    }
    return this
  }

 /** 串行化写盘：并发修改不能留下比新快照更旧的磁盘内容。 */
  save() {
    if (!this.file) return this.saveChain
    const snapshot = structuredClone(this.data)
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeJsonAtomic(this.file, snapshot))
    return this.saveChain
  }

 /** 只读快照（歌单列表 + 曲目数），不含曲目内容。
 *
 * 用户要求：莱茵歌单（收藏）**排在最后**，不要抢在自建歌单前面。
 * 自建歌单按创建时间升序在前，收藏固定垫底。 */
  summary() {
    const favorites = this.data.favorites.songs
    return [
      ...this.data.playlists.map(playlist => ({
        id: playlist.id, name: playlist.name, count: playlist.songs.length,
        favorites: false, createdAt: playlist.createdAt, updatedAt: playlist.updatedAt,
      })),
      { id: FAVORITES_ID, name: FAVORITES_NAME, count: favorites.length, favorites: true, createdAt: 0, updatedAt: 0 },
    ]
  }

  privatePlaylist(id) {
    if (id === FAVORITES_ID) return this.data.favorites
    return this.data.playlists.find(playlist => playlist.id === id)
  }

  songs(id, { offset = 0, limit = 1000, sort = 'default', direction = 'ascending' } = {}) {
    const playlist = this.privatePlaylist(id)
    if (!playlist) throw failure('这个歌单不存在。', 404)
    const ordered = sortSongs(playlist.songs, sort, direction)
    const start = Math.max(0, Math.floor(offset))
    // 上限跟着存储上限走：原来这里硬编码 Math.min(limit, 500)，默认 limit 又是
    // 100，于是存了上千首的歌单在界面上只能看到前面一小截。
    return { tracks: ordered.slice(start, start + Math.max(1, Math.min(limit, MAX_SONGS_PER_PLAYLIST))), total: ordered.length }
  }

  create(name) {
    if (this.data.playlists.length >= MAX_PLAYLISTS) throw failure(`最多只能建 ${MAX_PLAYLISTS} 个歌单。`)
    const now = Date.now()
    const playlist = {
      id: `local-${randomUUID()}`,
 // 留空用默认名称（ playlist.defaultName「留空使用默认名称」）。
      name: clean(name, MAX_NAME) || `新歌单 ${this.data.playlists.length + 1}`,
      createdAt: now, updatedAt: now, songs: [],
    }
    this.data.playlists.unshift(playlist)
    return playlist
  }

  rename(id, name) {
    const playlist = this.data.playlists.find(item => item.id === id)
    if (!playlist) throw failure(id === FAVORITES_ID ? '「莱茵歌单」不能重命名。' : '只有自建歌单支持更名。', 404)
    const next = clean(name, MAX_NAME)
    if (!next) throw failure('歌单名称不能为空。')
    playlist.name = next
    playlist.updatedAt = Date.now()
    return playlist
  }

  remove(id) {
    if (id === FAVORITES_ID) throw failure('「莱茵歌单」不能删除。', 404)
    const index = this.data.playlists.findIndex(item => item.id === id)
    if (index < 0) throw failure('这个歌单不存在。', 404)
    return this.data.playlists.splice(index, 1)[0]
  }

 /** 加歌：按 id 去重，返回 added/skipped 供前端提示「部分歌曲已存在」。 */
  addSongs(id, songs) {
    const playlist = this.privatePlaylist(id)
    if (!playlist) throw failure('这个歌单不存在。', 404)
    const incoming = (Array.isArray(songs) ? songs : []).map(normalizeSong).filter(song => song.id)
    if (!incoming.length) throw failure('没有可添加的歌曲。')
    const existing = new Set(playlist.songs.map(song => song.id))
    let added = 0, skipped = 0
    for (const song of incoming) {
      if (existing.has(song.id)) { skipped++; continue }
      if (playlist.songs.length >= MAX_SONGS_PER_PLAYLIST) break
      existing.add(song.id)
      playlist.songs.push(song)
      added++
    }
    if (added) playlist.updatedAt = Date.now()
    return { added, skipped, total: playlist.songs.length, allExist: added === 0 && skipped > 0 }
  }

  removeSongs(id, ids) {
    const playlist = this.privatePlaylist(id)
    if (!playlist) throw failure('这个歌单不存在。', 404)
    const drop = new Set((Array.isArray(ids) ? ids : []).map(value => String(value)))
    const before = playlist.songs.length
    playlist.songs = playlist.songs.filter(song => !drop.has(song.id))
    const removed = before - playlist.songs.length
    if (removed) playlist.updatedAt = Date.now()
    return { removed, total: playlist.songs.length }
  }

 /** 自由排序：按给定 id 次序重排，未列出的曲目保持原相对次序接在后面。 */
  reorder(id, ids) {
    const playlist = this.privatePlaylist(id)
    if (!playlist) throw failure('这个歌单不存在。', 404)
    const order = new Map((Array.isArray(ids) ? ids : []).map((value, index) => [String(value), index]))
    const rank = song => order.has(song.id) ? order.get(song.id) : Number.MAX_SAFE_INTEGER
    playlist.songs = playlist.songs.map((song, index) => ({ song, index }))
      .sort((a, b) => rank(a.song) - rank(b.song) || a.index - b.index).map(entry => entry.song)
    playlist.updatedAt = Date.now()
    return { total: playlist.songs.length }
  }

 /** 播放计数（ playlist.sort.playCount 排序依据）。 */
  countPlay(id, songId) {
    const playlist = this.privatePlaylist(id)
    const song = playlist?.songs.find(item => item.id === songId)
    if (!song) return { playCount: 0 }
    song.playCount = (song.playCount ?? 0) + 1
    return { playCount: song.playCount }
  }

 /** 收藏（莱茵歌单）：同一首只留一条，返回最终状态。 */
  favorite(song) {
    const normalized = normalizeSong(song)
    if (!normalized.id) throw failure('这首歌缺少标识，无法收藏。')
    const songs = this.data.favorites.songs
    if (songs.some(item => item.id === normalized.id)) return { favorited: true, existed: true, total: songs.length }
    if (songs.length >= MAX_SONGS_PER_PLAYLIST) throw failure('「莱茵歌单」已满。')
    songs.unshift(normalized)
    return { favorited: true, existed: false, total: songs.length }
  }

  unfavorite(songId) {
    const songs = this.data.favorites.songs
    const before = songs.length
    this.data.favorites.songs = songs.filter(song => song.id !== songId)
    return { favorited: false, removed: before - this.data.favorites.songs.length, total: this.data.favorites.songs.length }
  }

  isFavorite(songId) {
    return this.data.favorites.songs.some(song => song.id === songId)
  }
}
