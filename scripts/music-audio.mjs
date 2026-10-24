import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ffmpegEffectsFilter, effectsFingerprint } from './pcm-effects.mjs'

const SOURCE = fileURLToPath(new URL('../native/RhineAudio.swift', import.meta.url))
const MAX_PCM_BYTES = 2 * 1024 ** 3
const MAX_CACHE_BYTES = 4 * 1024 ** 3
// Never let a mislabeled audio file open concat/HLS playlists or secondary local paths.
const AUDIO_DEMUXERS = 'ape,wav,flac,mov,mp3,aac,aiff,ogg,wv,asf,dsf,iff'
const isDsdCodec = (codec) => /^(dsd_(lsbf|msbf)(_planar)?|dst)$/.test(codec)
const DSD_PCM_RATE = 176400
const TRANSITION_MODES = new Set(['fade-out', 'fade-in-out', 'gapless'])
const aborted = () => Object.assign(new Error('音频准备已取消'), { name: 'AbortError', status: 499 })
const failure = (message, status = 503) => Object.assign(new Error(message), { status })
const exists = async (file) => { try { await fs.access(file, constants.X_OK); return file } catch { return null } }

/** 从音频 URL 里取「定位段」：路径 + 文件名，丢掉查询串和主机名。
 *
 *  为什么要它：缓存键必须区分「同一首歌的不同音质档」，而各平台是靠 URL
 *  里的文件路径来区分的（`/resource/1307392909/trackmedia/F000001Rsv….flac`）。
 *  查询串里是每次都变的签名参数，算进键里会让缓存永不命中；主机名会随 CDN
 *  调度变化，同样不该算。只留路径，就既稳定又能换档时变化。
 */
const urlPathOf = (raw) => {
  try { return new URL(raw).pathname || raw } catch { return raw }
}
export async function findExecutable(name, override) {
  // Follow the desktop-server convention: NAME_PATH env overrides win over the
  // PATH scan (tests and shells with stale PATH still find the real binaries).
  const envOverride = override ?? process.env[`${name.toUpperCase()}_PATH`]
  if (envOverride) {
    if (!path.isAbsolute(envOverride)) throw failure(`${name} 路径必须是绝对路径`)
    return exists(envOverride)
  }
  const executableName = process.platform === 'win32' && !path.extname(name) ? `${name}.exe` : name;
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ''), executableName))]) {
    if (override && candidate === override && !path.isAbsolute(candidate)) throw failure(`${name} 路径必须是绝对路径`)
    if (await exists(candidate)) return candidate
  }
  return null
}
export async function checkedSource(descriptor) {
  if (!descriptor) throw failure('索引中没有此音频', 404)
  const [file, root] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(root, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('文件已移出配置的音乐目录', 403)
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw failure('音频文件不存在', 404)
  return { file, stat }
}
/** 给 FFmpeg 子进程用的环境：去掉所有代理变量，保证联网行为与本机代理状态无关。 */
export function proxyFreeEnv(base = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    const name = key.toLowerCase()
    if (name === 'http_proxy' || name === 'https_proxy' || name === 'all_proxy'
      || name === 'ftp_proxy' || name === 'no_proxy'
      || name === 'http_proxy_user' || name === 'http_proxy_pass') delete env[key]
  }
  return env
}

export function runProcess(binary, args, { signal, timeout = 120000, stdio } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    // 【2026-10-24 修「本机开不开代理都得能放」】
    //
    // FFmpeg 会读 http_proxy / https_proxy / all_proxy 这些环境变量，一旦有值就
    // 把 http 输入包成它内部的 httpproxy 协议去连代理。于是同一份代码：
    //   · 没开代理 → 直连，正常；
    //   · 开了代理 → 走代理，代理不通/规则不放行就整首放不了；
    //   · 代理变量还留着但程序已退出 → 直接连不上。
    // 音频是公网 CDN 的直链，走不走代理都不该由用户的 Clash 状态决定，
    // 所以对子进程一律剥掉代理变量，永远直连。用户在系统层面对代理的
    // 其他配置不受影响 —— 这里只作用于 FFmpeg / ffprobe 这两个子进程。
    const child = spawn(binary, args, {
      stdio: stdio ?? ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: proxyFreeEnv(),
    })
    let output = '', errors = '', timedOut = false, forceKill
    const kill = () => { child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 2000); forceKill.unref() }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeout)
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout?.on('data', (chunk) => { if (output.length < 1024 * 1024) output += chunk })
    child.stderr?.on('data', (chunk) => { errors = (errors + chunk).slice(-16000) })
    const clean = () => { clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', kill) }
    child.on('error', (error) => { clean(); reject(error) })
    child.on('close', (code) => {
      clean()
      if (signal?.aborted) reject(aborted())
      else if (timedOut) reject(failure('音频处理超时，请检查文件后重试'))
      else if (code !== 0) reject(failure(`音频处理失败：${errors.trim().split('\n').slice(-2).join(' ').slice(0, 500) || `exit ${code}`}`, 422))
      else resolve(output)
    })
  })
}

export class AudioDecoder {
  constructor({ dataDir, ffmpeg, ffprobe } = {}) {
    // 目录名里的版本号是**缓存格式版本**，改它等于让全部旧缓存自动作废。
    //
    // 【2026-10-18 → v041】两处键的语义都改了，旧条目不可信：
    //  · 在线音频：原键只含 `provider/id`，不含音质档，同一首歌的 flac 与
    //    母带版会互相顶替 —— 用户点原唱却放出别的版本，正是旧缓存残留导致。
    //  · 本地文件：原键含绝对路径，换盘/移库即全量失效。
    // 旧目录留着只会让「已经听错的歌」继续命中错文件，所以整体切到 v041。
    this.cacheDir = path.join(dataDir, 'audio-cache-v041')
    // 设置里的「缓存上限 / 缓存位置」以前只存在前端偏好里，后端从来不看，
    // 上限写死成 4GB、位置写死成 music-data/。这里把它们变成真正生效的字段，
    // 由 configure() 在启动与设置变更时写入。
    this.cacheLimitBytes = MAX_CACHE_BYTES
    this.dataDir = dataDir
    this.ffmpegOverride = ffmpeg; this.ffprobeOverride = ffprobe
    this.jobs = new Map(); this.leases = new Map(); this.active = 0; this.waiters = []; this.disposed = false
  }
  /** 应用设置里的缓存偏好。limitMb 与 location 都可选；返回实际生效的值。 */
  configure({ limitMb, location } = {}) {
    if (Number.isFinite(limitMb) && limitMb >= 64) {
      this.cacheLimitBytes = Math.round(limitMb) * 1024 * 1024
    }
    // 只有传了非空字符串才换目录；空 = 保持默认（dataDir/audio-cache-v041）。
    if (typeof location === 'string' && location.trim()) {
      this.cacheDir = path.join(location.trim(), 'audio-cache-v041')
      this.ready = null // 让 init 重新 mkdir 新目录
    } else if (typeof location === 'string') {
      this.cacheDir = path.join(this.dataDir, 'audio-cache-v041')
      this.ready = null
    }
    return { cacheDir: this.cacheDir, limitMb: Math.round(this.cacheLimitBytes / 1024 / 1024) }
  }
  /** 清空缓存目录：删掉所有 PCM 与元数据，返回释放的字节数与文件数。 */
  async clear() {
    let bytes = 0; let files = 0
    try {
      for (const name of await fs.readdir(this.cacheDir)) {
        if (!/^[a-f0-9]{64}\.wav(\.json)?$/.test(name)) continue
        const full = path.join(this.cacheDir, name)
        try { const st = await fs.stat(full); bytes += st.size; await fs.rm(full, { force: true }); files += 1 } catch {}
      }
    } catch {}
    return { files, bytes, cacheDir: this.cacheDir }
  }
  /** 当前缓存占用（字节 / 文件数 / 上限）。 */
  async usage() {
    let bytes = 0; let files = 0
    try {
      for (const name of await fs.readdir(this.cacheDir)) {
        if (!/^[a-f0-9]{64}\.wav$/.test(name)) continue
        try { bytes += (await fs.stat(path.join(this.cacheDir, name))).size; files += 1 } catch {}
      }
    } catch {}
    return { bytes, files, limitBytes: this.cacheLimitBytes, cacheDir: this.cacheDir }
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      this.ffmpeg = await findExecutable('ffmpeg', this.ffmpegOverride ?? process.env.FFMPEG_PATH)
      this.ffprobe = await findExecutable('ffprobe', this.ffprobeOverride ?? process.env.FFPROBE_PATH)
      if (!this.ffmpeg || !this.ffprobe) { this.error = '未找到 FFmpeg / ffprobe，请安装 FFmpeg 后重新启动'; this.ffmpeg = null; this.ffprobe = null; return }
      this.version = (await runProcess(this.ffmpeg, ['-version'], { timeout: 5000 })).split('\n')[0]
      await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
      // 顺手清掉旧的缓存目录（v040 及更早）。不清的话它们会一直占着几 GB，
      // 而用户已经不会再命中它们 —— 尤其是被错误版本污染过的那些。
      // 只在启动时做一次，失败无所谓（比如被别的实例占用）。
      this.sweepOldCaches().catch(() => {})
    })().catch((error) => { this.error = error.message; this.ffmpeg = null })
    await this.ready
    return this
  }
  async sweepOldCaches() {
    const parent = path.dirname(this.cacheDir)
    const current = path.basename(this.cacheDir)
    try {
      const names = await fs.readdir(parent)
      for (const name of names) {
        if (!/^audio-cache-v\d+$/.test(name) || name === current) continue
        await fs.rm(path.join(parent, name), { recursive: true, force: true })
      }
    } catch {}
  }
  async acquire(signal) {
    if (this.active >= 2) await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal.removeEventListener('abort', cancel); resolve() } }
      const cancel = () => { this.waiters = this.waiters.filter((item) => item !== entry); reject(aborted()) }
      signal.addEventListener('abort', cancel, { once: true }); this.waiters.push(entry)
    })
    if (signal.aborted) throw aborted()
    this.active += 1
  }
  release() { this.active -= 1; this.waiters.shift()?.resolve() }
  retain(file) {
    this.leases.set(file, (this.leases.get(file) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.leases.get(file) ?? 1) - 1
      if (remaining) this.leases.set(file, remaining)
      else this.leases.delete(file)
    }
  }
  async prepare(descriptor, { signal, retain = false, targetSampleRate, effects } = {}) {
    if (targetSampleRate !== undefined && (!Number.isInteger(targetSampleRate) || targetSampleRate < 8000 || targetSampleRate > 768000)) throw failure('无效原生输出采样率', 400)
    await this.init()
    if (this.disposed || signal?.aborted) throw aborted()
    if (!this.ffmpeg || !this.ffprobe) throw failure('未找到 FFmpeg / ffprobe。请在本机安装 FFmpeg 后重新启动；浏览器原生支持的文件仍可直接播放。')
    const { file, stat } = await checkedSource(descriptor)
    const filter = ffmpegEffectsFilter(effects)
    const fx = effectsFingerprint(effects)
    const variant = `${targetSampleRate === undefined ? '' : `:native-float32-rate-${targetSampleRate}`}${fx ? `:fx-${fx}` : ''}`
    // 【2026-10-18 缓存键不再用绝对路径】
    //
    // 原来把**完整绝对路径**塞进哈希：`D:\Music\a.flac:123:456:pcm-v4`。
    // 这有两个实际问题：
    //
    //  ① 把整棵音乐库换个盘符/改个目录名，缓存**全部作废**，用户要重新解码
    //     整个库（每首约 5 秒），表现为「移完库之后歌都放不出来了」。
    //  ② 路径里的用户名（`C:\Users\Administrator\…`）会进哈希 —— 换个账户
    //     或者便携版被拷到别人机器上，同样是全量失效。
    //
    // 但缓存键又必须能区分不同文件，否则**真会串歌**。所以不能只取文件名。
    // 折中：用「文件名 + 字节数 + 修改时间 + 文件头 4KB 的摘要」。
    //  · 文件名 + 大小 + mtime 已经足够区分绝大多数同名文件；
    //  · 头 4KB 摘要兜住「两个不同目录下有同名同大小的不同歌」这种极端情况，
    //    而这只要读 4KB，代价可以忽略（解码本身要读几十 MB）。
    // 这样文件搬家、换盘、换账户都仍然命中，只有**内容真的变了**才失效。
    const identity = await this.sourceIdentity(file, stat)
    const key = createHash('sha256').update(`${identity}:${stat.size}:${Math.round(stat.mtimeMs)}:pcm-v4-dsd17640024${variant}`).digest('hex')
    const target = path.join(this.cacheDir, `${key}.wav`)
    // Pin before decode/prune can run, including cache hits and shared jobs.
    const release = retain ? this.retain(target) : null
    let job = this.jobs.get(key)
    if (!job) {
      const controller = new AbortController()
      job = { controller, users: 0 }
      job.promise = this.decode(file, target, controller.signal, targetSampleRate, filter).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key) })
      // Consumers observe this promise; retain a rejection handler during cancellation gaps.
      job.promise.catch(() => {})
      this.jobs.set(key, job)
    }
    job.users += 1
    try { const decoded = await new Promise((resolve, reject) => {
      let finished = false
      const finish = (callback, value) => {
        if (finished) return
        finished = true; signal?.removeEventListener('abort', cancel); job.users -= 1
        if (!job.users && this.jobs.get(key) === job) { this.jobs.delete(key); job.controller.abort() }
        callback(value)
      }
      const cancel = () => finish(reject, aborted())
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) return cancel()
      job.promise.then((value) => finish(resolve, value), (error) => finish(reject, error))
    }); return release ? { ...decoded, release } : decoded }
    catch (error) { release?.(); throw error }
  }
  /** Decode a remote audio URL (online track) with effects baked in. The cache
   * key uses the stable identity (provider/song id), never the signed URL. */
  async prepareUrl(sourceUrl, { signal, effects, identity } = {}) {
    await this.init()
    if (this.disposed || signal?.aborted) throw aborted()
    if (!this.ffmpeg || !this.ffprobe) throw failure('未找到 FFmpeg / ffprobe。请在本机安装 FFmpeg 后重新启动；浏览器原生支持的文件仍可直接播放。')
    if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) throw failure('在线音频地址无效', 400)
    const filter = ffmpegEffectsFilter(effects)
    const fx = effectsFingerprint(effects)
    // 【2026-10-18 修「放原唱出来是 DJ 版」】
    //
    // 原来的键是 `url:${identity ?? sourceUrl}`。identity 由调用方传
    // `${provider}/${id}`，看起来能区分歌曲 —— 但它**只覆盖到「哪一首」，
    // 不覆盖「这一首的哪一档音质」。共享池对同一个 songId 会返回不同档位
    // （无损 flac / 母带 mflac / 高品 mp3），而这几档**时长不同**：
    //
    //     《可能》原唱     lossless 218s / 41MB
    //     《可能》母带档   214.9s / 236MB  (192kHz，前 20 秒几乎无声)
    //
    // 于是同一个 identity 先后取到两个档位时，第二次会**命中第一次缓存**，
    // 播放器拿到的是上一档的音频 —— 用户听到「点原唱放出来是另一个版本」。
    //
    // 修法：把**实际下发的 URL** 也算进键里。URL 里带着酷我/酷狗的签名和
    // 文件路径（`/resource/1307392909/trackmedia/F000001RsvMC0VovJA.flac`），
    // 足以区分同一首歌的不同档位；而签名参数每次会变，所以先剥掉查询串，
    // 只留路径 —— 路径对同一档位是稳定的，换档就变。
    const identityKey = identity ?? sourceUrl
    const locator = urlPathOf(sourceUrl)
    const key = createHash('sha256').update(`url:${identityKey}:${locator}:pcm-v4${fx ? `:fx-${fx}` : ''}`).digest('hex')
    const target = path.join(this.cacheDir, `${key}.wav`)
    // 【2026-10-24 修「开了音效网易云一律放不了」】
    //
    // 本机有 http_proxy/https_proxy 环境变量（Clash 之类）时，FFmpeg 会把
    // http 输入包成自己的内部协议 httpproxy 走代理。原来白名单写死
    // 'file,pipe,http,https,tcp,tls'，于是每首歌都死在：
    //
    //   Protocol 'httpproxy' not on whitelist 'file,pipe,http,https,tcp,tls'!
    //
    // 现象是「音效一开全平台都加载失败」，而关掉音效/浏览器直连一切正常。
    // 白名单补上 httpproxy 即可（其余协议维持最小集合）。
    return await this.decode(sourceUrl, target, signal, undefined, filter, 'file,pipe,http,https,tcp,tls,httpproxy')
  }
  /** 本地文件的缓存身份：只取路径无关的部分。
   *
   *  用「文件名（不含目录）+ 头 4KB 摘要」。不取完整路径的理由见 prepare 的
   *  注释：完整路径会让整个库在移动位置后缓存全废。但不取路径就得有别的
   *  办法区分同名文件 —— 头 4KB 摘要足够：两首不同的歌，前 4KB 一模一样
   *  的概率可以忽略；真正相同的内容本来就应该共用缓存。
   *
   *  只在读到文件时计算，读失败就退化成文件名 —— 宁可缓存命中率低一点，
   *  也不能因为读不到头就把播放打断。
   */
  async sourceIdentity(file, stat) {
    const base = path.basename(file)
    try {
      const handle = await fs.open(file, 'r')
      try {
        const length = Math.min(4096, stat.size)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, 0)
        const head = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex').slice(0, 16)
        return `${base}:${head}`
      } finally { await handle.close() }
    } catch { return base }
  }
  async decode(file, target, signal, targetSampleRate, filter = '', inputProtocols = 'file,pipe') {
    const metadataFile = `${target}.json`
    try {
      const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'))
      const stat = await fs.stat(target)
      if (stat.size > 44) {
        await fs.utimes(target, new Date(), new Date())
        return { path: target, allowedRoot: this.cacheDir, mime: 'audio/wav', ...metadata, cached: true }
      }
    } catch {}
    await this.acquire(signal)
    const temporary = `${target}.${randomUUID()}.tmp.wav`
    try {
      const probe = JSON.parse(await runProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', inputProtocols, '-format_whitelist', AUDIO_DEMUXERS, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,sample_fmt,duration:format=duration,format_name', '-of', 'json', file], { signal, timeout: 20000 }))
      const stream = probe.streams?.[0]
      if (!stream || !Number(stream.sample_rate) || !Number(stream.channels)) throw failure('文件中没有可解码的音频轨道', 422)
      const dsd = isDsdCodec(stream.codec_name)
      let duration = Number(stream.duration ?? probe.format?.duration) || 0
      // FFmpeg reports the DSD byte clock / decoded PCM rate, not the 1-bit
      // source clock. Keep that distinction in the returned technical metadata.
      const sampleRate = targetSampleRate ?? (dsd ? DSD_PCM_RATE : Number(stream.sample_rate))
      const bits = Number(stream.bits_per_raw_sample || stream.bits_per_sample) || 0
      const float = /^(flt|dbl)/.test(stream.sample_fmt)
      const codec = targetSampleRate !== undefined ? 'pcm_f32le' : dsd ? 'pcm_s24le' : float ? 'pcm_f32le' : bits > 24 ? 'pcm_s32le' : bits > 16 ? 'pcm_s24le' : 'pcm_s16le'
      const bytes = codec === 'pcm_s16le' ? 2 : codec === 'pcm_s24le' ? 3 : 4
      if (duration * sampleRate * Number(stream.channels) * bytes > MAX_PCM_BYTES) throw failure('此音频的 PCM 缓存超过 2 GiB，请拆分超长音频后播放', 422)
      // DSD is decoded for playback; the source stays read-only. The built-in
      // antialiasing resampler needs no optional libsoxr and preserves channels.
      const conversion = dsd || targetSampleRate !== undefined ? ['-af', `aresample=${sampleRate}:resampler=swr:filter_size=64`, '-ar', String(sampleRate)] : []
      await runProcess(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(dsd ? ['-xerror'] : []), '-protocol_whitelist', inputProtocols, '-format_whitelist', AUDIO_DEMUXERS, '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...(filter ? ['-af', filter] : []), ...conversion, '-c:a', codec, '-threads', '1', '-fs', String(MAX_PCM_BYTES), '-f', 'wav', '-rf64', 'never', '-y', temporary], { signal, timeout: 5 * 60 * 1000 })
      const stat = await fs.stat(temporary)
      if (stat.size >= MAX_PCM_BYTES) throw failure('PCM 缓存已达到 2 GiB 限制', 422)
      if (stat.size <= 44) throw failure('音频解码没有产生有效数据', 422)
      if (dsd || targetSampleRate !== undefined) {
        // DSF's container duration can include block padding. Use the actual
        // resulting frames for playback duration, and verify before publishing.
        const decoded = JSON.parse(await runProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,duration:format=duration', '-of', 'json', temporary], { signal, timeout: 20000 }))
        const pcm = decoded.streams?.[0]
        duration = Number(pcm?.duration ?? decoded.format?.duration)
        if (pcm?.codec_name !== codec || Number(pcm.sample_rate) !== sampleRate || pcm.channels !== stream.channels || pcm.bits_per_sample !== bytes * 8 || !Number.isFinite(duration) || duration <= 0) throw failure('解码没有产生有效的 PCM 音频', 422)
      }
      const metadata = { duration, codec: stream.codec_name, container: probe.format?.format_name, sampleRate, channels: Number(stream.channels), pcmCodec: codec, bitsPerSample: bytes * 8, bytes: stat.size,
        ...(targetSampleRate !== undefined ? { normalizedSampleRate: targetSampleRate, sourceSampleRate: Number(stream.sample_rate) } : {}),
        ...(dsd ? { conversion: 'dsd-to-pcm', sourceSampleRate: Number(stream.sample_rate) * 8, sourceBitsPerSample: 1 } : {}),
      }
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, target)
      await fs.writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 })
      this.pruneTask = (this.pruneTask ?? Promise.resolve()).catch(() => {}).then(() => this.prune(target))
      await this.pruneTask
      return { path: target, allowedRoot: this.cacheDir, mime: 'audio/wav', ...metadata, cached: false }
    } finally { this.release(); await fs.rm(temporary, { force: true }) }
  }
  async prune(protectedFile) {
    const entries = await fs.readdir(this.cacheDir)
    const files = (await Promise.all(entries.filter((name) => /^[a-f0-9]{64}\.wav$/.test(name)).map(async (name) => { const file = path.join(this.cacheDir, name); return { file, ...await fs.stat(file) } }))).sort((a, b) => b.mtimeMs - a.mtimeMs)
    // Count pinned files first: equal timestamps must not let an unpinned file
    // consume space needed by the protected current/next PCM file.
    let total = files.filter((file) => file.file === protectedFile || this.leases.has(file.file)).reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (file.file === protectedFile || this.leases.has(file.file)) continue
      // The current and pre-scheduled next file remain leased even before Swift
      // opens them. Native keeps at most these two (each below 2 GiB).
      if (total + file.size > this.cacheLimitBytes) {
        await fs.rm(file.file, { force: true }); await fs.rm(`${file.file}.json`, { force: true })
      } else total += file.size
    }
  }
  dispose() { this.disposed = true; for (const job of this.jobs.values()) job.controller.abort() }
}

export class NativeAudioOutput {
  constructor({ dataDir, decoder, trackFile }) {
    this.dataDir = dataDir; this.decoder = decoder; this.trackFile = trackFile
    this.pending = new Map(); this.serial = 0; this.operation = 0; this.deviceId = 'default'; this.desiredVolume = 0.7; this.disposed = false
    this.transitionSettings = {}
    this.effects = {}
    this.nextOperation = 0
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      if (process.platform !== 'darwin') throw failure('CoreAudio 输出仅适用于 macOS')
      const swift = await findExecutable('swiftc')
      if (!swift) throw failure('原生输出需要 Apple Command Line Tools（swiftc）')
      const hash = createHash('sha256').update(await fs.readFile(SOURCE)).update(process.arch).digest('hex').slice(0, 16)
      const folder = path.join(this.dataDir, 'native-v040'); await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      this.binary = path.join(folder, `rhine-audio-${hash}`)
      if (!await exists(this.binary)) {
        const temporary = `${this.binary}.${randomUUID()}.tmp`
        try { await runProcess(swift, [SOURCE, '-O', '-o', temporary], { timeout: 120000 }); await fs.chmod(temporary, 0o700); await fs.rename(temporary, this.binary) }
        finally { await fs.rm(temporary, { force: true }) }
      }
    })()
    return this.ready
  }
  async start() {
    await this.init()
    if (this.disposed) throw failure('原生输出已关闭')
    if (this.process) return
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.process = child
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try { const reply = JSON.parse(line); const request = this.pending.get(reply.id); if (request) { this.pending.delete(reply.id); clearTimeout(request.timer); reply.error ? request.reject(failure(reply.error, 422)) : request.resolve(reply.result) } } catch {}
      }
    })
    child.stderr.on('data', () => {})
    const failed = () => { if (this.process === child) this.process = null; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure('CoreAudio 进程已退出，请重新选择输出')) }; this.pending.clear() }
    child.on('error', failed); child.on('exit', failed)
    child.stdin.on('error', () => {})
  }
  async send(command) {
    await this.start()
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('CoreAudio 响应超时')); this.process?.kill() }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }
  async devices() { return (await this.send({ action: 'devices' })).devices }
  observeState(state) {
    if (this.nextLease && state.boundarySerial > this.nextLease.boundarySerial && state.trackId === this.nextLease.trackId) {
      this.activeLease?.release?.(); this.activeLease = this.nextLease; this.nextLease = null
    }
    return state
  }
  invalidateNext() {
    ++this.nextOperation; this.nextPreparing?.abort(); this.nextPreparing = null
  }
  async cancelNext() {
    this.invalidateNext()
    const lease = this.nextLease
    // Reconcile an already crossed audio boundary before releasing either file.
    const state = this.observeState(await this.send({ action: 'cancelNext' }))
    if (this.nextLease === lease) { this.nextLease?.release?.(); this.nextLease = null }
    return state
  }
  async command(value) {
    const actions = new Set(['play', 'pause', 'stop', 'seek', 'volume', 'device', 'state', 'transition', 'prepareNext', 'cancelNext'])
    if (!actions.has(value.action)) throw failure('未知音频操作', 400)
    if (value.deviceId !== undefined && !/^(default|\d+)$/.test(value.deviceId)) throw failure('无效输出设备', 400)
    for (const key of ['position', 'volume']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw failure(`无效 ${key}`, 400)
    if (value.volume !== undefined && value.volume > 1) throw failure('音量超出范围', 400)
    if (value.fadeEnabled !== undefined && typeof value.fadeEnabled !== 'boolean') throw failure('无效淡入淡出设置', 400)
    if (value.transitionMode !== undefined && !TRANSITION_MODES.has(value.transitionMode)) throw failure('无效歌曲衔接方式', 400)
    for (const key of ['trackId', 'afterTrackId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value[key]))) throw failure('无效歌曲 ID', 400)
    if (value.action === 'play' && value.trackId === undefined) throw failure('无效歌曲 ID', 400)
    const transitionSettings = value.transitionMode !== undefined ? { transitionMode: value.transitionMode }
      : value.fadeEnabled !== undefined ? { fadeEnabled: value.fadeEnabled } : {}
    if (value.action === 'transition') {
      if (!Object.keys(transitionSettings).length) throw failure('缺少歌曲衔接方式', 400)
      // A setting edit never aborts preparation or restarts the playing source.
      this.transitionSettings = transitionSettings
      await this.cancelNext()
      return this.observeState(await this.send({ action: 'transition', ...this.transitionSettings }))
    }
    if (value.action === 'effects') {
      // Applied at decode: a config change fingerprints the PCM cache key, so
      // the effect set reaches the speakers on the next decode/play.
      this.effects = value.config && typeof value.config === 'object' ? value.config : {}
      await this.cancelNext().catch(() => {})
      return { ok: true }
    }
    if (value.action === 'volume') { this.desiredVolume = value.volume ?? this.desiredVolume; return this.send({ action: 'volume', volume: this.desiredVolume }) }
    if (value.action === 'state') return this.observeState(await this.send({ action: 'state' }))
    if (value.action === 'cancelNext') return this.cancelNext()
    if (value.action === 'prepareNext') {
      if (value.trackId === undefined) throw failure('缺少下一首歌曲 ID', 400)
      this.invalidateNext()
      const token = this.nextOperation, operation = this.operation
      const valid = () => token === this.nextOperation && operation === this.operation
      const current = this.observeState(await this.send({ action: 'state' }))
      if (!valid()) throw aborted()
      if (current.transitionMode !== 'gapless' || !current.playing) throw failure('当前未在无缝模式播放，无法预备下一首', 409)
      if (value.afterTrackId !== undefined && current.trackId !== value.afterTrackId) throw failure('当前歌曲已改变，已取消过期预备', 409)
      if (current.nextTrackId === value.trackId && this.nextLease?.trackId === value.trackId) return current
      this.observeState(await this.send({ action: 'cancelNext' }))
      if (!valid()) throw aborted()
      this.nextLease?.release?.(); this.nextLease = null
      const controller = new AbortController()
      this.nextPreparing = controller
      let decoded
      try {
        // The spare consumes integer frames in the engine's existing rate.
        // Explicit normalization avoids AVAudioPlayerNode's fractional SRC tail
        // varying by direction and inserting/doubling one boundary sample.
        decoded = await this.decoder.prepare(this.trackFile(value.trackId), { signal: controller.signal, retain: true, targetSampleRate: current.outputSampleRate, effects: this.effects })
        if (!valid()) throw aborted()
        const state = this.observeState(await this.send({ action: 'prepareNext', path: decoded.path, trackId: value.trackId, afterTrackId: current.trackId, afterBoundarySerial: current.boundarySerial }))
        if (!valid()) throw aborted()
        this.nextLease = { trackId: value.trackId, boundarySerial: current.boundarySerial ?? 0, release: decoded.release }
        decoded = null
        return this.observeState(state)
      } finally {
        decoded?.release?.()
        if (token === this.nextOperation) this.nextPreparing = null
      }
    }
    if (value.action === 'device') {
      await this.cancelNext()
      const previous = this.deviceId, requested = value.deviceId ?? 'default'
      this.deviceId = requested
      try { return await this.send({ action: 'device', deviceId: requested }) }
      catch (error) { if (this.deviceId === requested) this.deviceId = previous; throw error }
    }
    const operation = ++this.operation
    this.preparing?.abort(); this.preparing = null
    if (value.action === 'play') {
      // Capture the request before any await. A subsequent settings edit must
      // win even while we are waiting for cancellation/state acknowledgements.
      this.transitionSettings = transitionSettings
      if (value.deviceId !== undefined) this.deviceId = value.deviceId
      if (value.volume !== undefined) this.desiredVolume = value.volume
    }
    await this.cancelNext()
    if (operation !== this.operation) throw aborted()
    if (value.action === 'play') {
      if (typeof value.trackId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.trackId)) throw failure('无效歌曲 ID', 400)
      const controller = new AbortController(); this.preparing = controller
      // Silence the previous source before decoding or switching; no overlapping tracks.
      const current = await this.send({ action: 'state' })
      if (operation !== this.operation) throw aborted()
      if (current.trackId === value.trackId && value.position === undefined) {
        if (current.playing) return this.send({ action: 'volume', volume: this.desiredVolume, ...this.transitionSettings })
        if (current.currentTime < current.duration) return this.send({ action: 'play', volume: this.desiredVolume, ...this.transitionSettings })
      }
      const fadeOut = this.transitionSettings.transitionMode !== undefined
        ? this.transitionSettings.transitionMode !== 'gapless' : this.transitionSettings.fadeEnabled === true
      if (current.playing && fadeOut) {
        await this.send({ action: 'fadeOut' })
        await new Promise((resolve) => setTimeout(resolve, 450))
        if (operation !== this.operation) throw aborted()
      }
      await this.send({ action: 'stop' })
      this.activeLease?.release?.(); this.activeLease = null
      const decoded = await this.decoder.prepare(this.trackFile(value.trackId), { signal: controller.signal, retain: true, effects: this.effects })
      try {
        if (operation !== this.operation) throw aborted()
        this.preparing = null
        const state = await this.send({ action: 'play', path: decoded.path, trackId: value.trackId, position: value.position, deviceId: this.deviceId, volume: this.desiredVolume, ...this.transitionSettings })
        if (operation !== this.operation) throw aborted()
        this.activeLease = { trackId: value.trackId, release: decoded.release }
        return this.observeState(state)
      } catch (error) { decoded.release?.(); throw error }
    }
    const state = await this.send({ action: value.action, deviceId: value.deviceId, position: value.position })
    if (value.action === 'device') this.deviceId = state.deviceId
    if (value.action === 'stop') { this.activeLease?.release?.(); this.activeLease = null }
    return state
  }
  dispose() { this.disposed = true; ++this.operation; this.preparing?.abort(); this.invalidateNext(); this.process?.kill(); this.process = null; this.activeLease?.release?.(); this.nextLease?.release?.(); this.activeLease = this.nextLease = null }
}
