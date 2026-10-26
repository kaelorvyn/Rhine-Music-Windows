import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, createReadStream } from 'node:fs'
import fsSync from 'node:fs'
import { MusicLibraryStore, safeRootList } from './music-library.mjs'
import { AudioDecoder, NativeAudioOutput } from './music-audio.mjs'
import { parseEffectsQuery } from './pcm-effects.mjs'
import { NeteaseOnline } from './netease-online.mjs'
import { PlatformAuth } from './platform-auth.mjs'
import { PlatformCatalog } from './platform-catalog.mjs'
import { BodianCatalog } from './bodian-catalog.mjs'
import { KugouCatalog } from './kugou-protocol.mjs'
import { KuwoCatalog } from './kuwo-protocol.mjs'
import { JooxCatalog } from './joox-protocol.mjs'
import { BackupSources, DEFAULT_SOURCES } from './backup-sources.mjs'
import { DownloadManager } from './downloads.mjs'
import { resolveLyrics } from './lyrics.mjs'
import { LxSourceHost } from './lx-source-host.mjs'
import { PlatformCoverStore } from './platform-media.mjs'
import { LocalPlaylists, SORT_KEYS } from './local-playlists.mjs'
import { SourceLog } from './source-log.mjs'
import { diagnoseOnlineFailure, onlineDiagnostic, onlineRouteContext } from './online-diagnostics.mjs'
import { withHardTimeout } from './hard-timeout.mjs'
import { resolveSongBest as poolResolve, loadFromImportedKey, configureServerLines, resetPoolRuntime, invalidatePoolUrlCache, credentialsReady as poolCredentialsReady, serverLineState as poolLineState, probeServerLinesShared as poolProbeLines, probeUpstreams as poolProbeUpstreams, signingHealth as poolSigningHealth, SERVER_LINES as POOL_SERVER_LINES } from './shared-pool.mjs'
import * as poolCredential from './pool-credential.mjs'
import { decryptOrFallback, cacheKeyFor, QmcError, PLAINTEXT_FALLBACK_QUALITY, isEncrypted, QMC_ERRORS } from './qmc-decrypt.mjs'
import { OnlineAudioRelay } from './online-audio-relay.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 加密音频（QMC）解密：待解密任务表 + 解密落盘缓存 ────────────────────────
// 为什么需要 pending 表：Range 请求可能先到（浏览器探测时长会先发 Range: bytes=0-），
// 而 URL/ekey 较大不适合塞进查询串，故由 POST 登记任务、GET 再取流。
// 条目短暂驻留（TTL）避免内存泄漏；同一 cacheKey 复用同一解密文件。
const qmcPending = new Map()
const QMC_PENDING_TTL_MS = 30 * 60 * 1000
const QMC_CACHE_DIR = path.join(PROJECT_DIR, '.cache', 'decoded-audio')
const qmcInFlight = new Map()
// 在线音频同源中转（音浪取数的前提）：Web Audio 对跨域媒体源会输出静音，
// 播放地址必须换成本机票据地址才能接分析旁支。见 online-audio-relay.mjs。
const audioRelay = new OnlineAudioRelay()
/** sameOrigin 请求：把 audioUrl 换成同源票据地址。平台域名校验不过就原样返回 ——
 *  宁可这一首没波形，也不能因为中转影响发声。 */
function relayedSameOrigin (prepared, provider, body) {
  if (body?.sameOrigin !== true || !prepared?.audioUrl) return prepared
  try { return { ...prepared, audioUrl: audioRelay.register(provider, prepared.audioUrl) } }
  catch { return prepared }
}

/** 用 FFmpeg showspectrumpic 画整轨频谱图（256 时间列 × 64 频带，灰度 PNG）。 */
async function renderSpectrumPng(ffmpeg, input, out) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', String(input),
      '-lavfi', 'showspectrumpic=s=256x64:legend=0:scale=log:fscale=log,format=gray',
      '-frames:v', '1', out,
    ], { windowsHide: true, shell: false });
    let err = '';
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || ('ffmpeg 退出码 ' + code))));
  });
}
function qmcPrunePending () {
  const now = Date.now()
  for (const [k, v] of qmcPending) if (now - v.at > QMC_PENDING_TTL_MS) qmcPending.delete(k)
}

/** 登记一个待解密任务，返回前端应使用的 cacheKey */
export function registerQmcTask (spec = {}) {
  qmcPrunePending()
  const key = spec.cacheKey ?? cacheKeyFor(spec)
  qmcPending.set(key, { ...spec, cacheKey: key, at: Date.now() })
  return key
}

/**
 * 确保密文已解密并落盘，返回可交给 serveFile 的描述符。
 * 同一 cacheKey 只解一次（in-flight 去重）；已解好的直接复用。
 */
async function qmcDecryptToCache (entry, response) {
  const target = path.join(QMC_CACHE_DIR, `${entry.cacheKey}.bin`)
  let inflight = qmcInFlight.get(entry.cacheKey)
  if (!inflight) {
    inflight = (async () => {
      await fs.mkdir(QMC_CACHE_DIR, { recursive: true })
      try {
        const st = await fs.stat(target)
        if (st.size > 0) return target       // 已解好，直接复用
      } catch {}
      if (!entry.audioUrl) throw new QmcError('ENCRYPTED_NO_KEY')
      const res = await fetch(entry.audioUrl, { redirect: 'follow' })
      if (!res.ok) throw new QmcError('RESULT_CHECK', `下载加密音频失败: HTTP ${res.status}`)
      const cipher = Buffer.from(await res.arrayBuffer())
      // 统一走 decryptOrFallback：解密不可用时抛带 fallbackQuality 的错误，
      // 由路由转成 503 JSON 让前端回落到明文档位 —— 绝不落盘垃圾。
      const { buf } = decryptOrFallback(cipher, {
        format: entry.format, ekey: entry.ekey, provider: entry.provider, quality: entry.quality,
      })
      const tmp = `${target}.${process.pid}.tmp`
      await fs.writeFile(tmp, buf)
      await fs.rename(tmp, target)
      return target
    })().finally(() => qmcInFlight.delete(entry.cacheKey))
    qmcInFlight.set(entry.cacheKey, inflight)
  }
  try {
    const file = await inflight
    return { path: file, allowedRoot: QMC_CACHE_DIR, mime: 'audio/flac' }
  } catch (error) {
    if (error instanceof QmcError) throw error
    throw new QmcError('RESULT_CHECK', error?.message ?? '音频解密失败', { fallbackQuality: PLAINTEXT_FALLBACK_QUALITY })
  }
}

/**
 * 加密档位的**静默降级**。
 *
 * 背景（2026-10-16 实测）：池子的 master/surround/hifi 档返回的是**加密容器**
 * （mflac/mgg，带 ekey），而 `ekey → QMC 原始密钥` 至今未解出（见 docs/qmc-spec.md
 * 的证伪清单）。所以这些档的 URL **浏览器根本放不出来** —— 直连只会得到噪音/静音。
 *
 * 自己有解密能力，我们没有。用户要的是「能听 + 音质尽可能好」，
 * 不是「必须走解密」。因此这里把加密档**静默换成 lossless 明文**：
 *   lossless == 明文 flac（实测 22.58MB / 24bit 那首 52.83MB），fLaC 魔数 + STREAMINFO
 *   合格 + 3079/3079 帧解码，到可播首块 116–287ms —— 真无损，且比母带更快。
 *
 * 不弹提示、不写 state.error（用户明确要求「换源全静默」），只如实回报
 * `actualQuality` 与 `degradedFrom`，让前端徽章显示真实档位。
 *
 * @param {object} resolved 已解析出的结果（可能含加密 audioUrl）
 * @param {(quality: string) => Promise<object|null>} refetch 用指定档位重新取源
 * @returns {Promise<object>} 可播放的结果（明文优先）
 */
/**
 * 加密档位的**静默降级** —— 取源前的档位映射。
 *
 * 背景（2026-10-16 实测）：池子的 master/surround/hifi 档返回的是**加密容器**
 * （mflac/mgg，带 ekey），而 `ekey → QMC 原始密钥`至今未解出（见 docs/qmc-spec.md
 * 的证伪清单）。所以这些档的 URL **浏览器根本放不出来** —— 直连只会得到噪音/静音。
 *
 * 【为什么要在**取源之前**就换档，而不是拿到加密结果再重取】
 * 最初实现是「先按原档取源 → 发现是 mflac → 用 lossless 重跑整条链」。
 * 实测这会把**整条串行链跑两遍**：冷启动首个 master 请求要 2000ms
 * （池子冷 1782ms + 池子热 194ms 两次请求），验收实测 1597–3787ms，
 * **超过 t9 合同 <1s 的判据**。
 * 既然解密能力是**开机就知道**的（`QMC_UNRESOLVED` 是常量，不是运行时才知道），
 * 就应当在取源前把档位**直接落到明文档** —— 整条链只跑一次。
 *
 * 语义不变：用户要的是「能听 + 音质尽可能好」，不是「必须走解密」；
 * 前端仍从 `degradedFrom` / `actualQuality` 看到真实档位。
 *
 * @param {string} quality 用户请求的档位
 * @returns {string} 实际要拿去取源的档位（解密不可用时降为明文档）
 */
function playableQuality (quality) {
  const wanted = POOL_QUALITIES.includes(quality) ? quality : 'master'
  // 明文档直接用（lossless=flac / high=mp3 / standard=mp3），不动。
  if (!ENCRYPTED_TIERS.has(wanted)) return wanted
  // 加密档：解密能力已证伪 ⇒ 直接请求明文无损档，链路只跑一次。
  return PLAINTEXT_FALLBACK_QUALITY
}

/** 【2026-10-18 修「酷狗的歌一首也放不出来」】
 *
 *  用户实测：搜「可能」「霍元甲」「天涯」等，酷狗的结果全部失败，
 *  日志里 32 次酷狗请求 **0 成功**；同期网易云 91%、酷我 64%。
 *
 *  翻日志看到酷狗的 songId 长这样：
 *
 *      baf4fc76ca09250c2713197ff3e3e029.45429610
 *      └────────── hash ──────────────┘ └albumId┘
 *
 *  这是本地用的复合 id（`hash.albumId`），酷狗自己的签名接口认这个；
 *  但共享池（的服务器）转发给酷狗官方时**只认裸 hash**，
 *  带上 `.albumId` 后缀就查不到音源，回一个空 url。
 *
 *  所以在问共享池之前把后缀剥掉。其他平台原样传：
 *   · kuwo   `MUSIC_228908` → 共享池那边由 service-pool 自己剥前缀
 *   · netease/qq 是纯数字，无需处理
 *
 *  ⚠️ 只对共享池这一跳生效。本地解析（kugou-protocol 的 songInfo）
 *  仍用完整 id，它需要 albumId 去拼播放地址。
 */
function poolSongId (provider, songId) {
  // `hash.`（albumId 为空时拼出的尾点）先削掉，剩下的交给正则。
  const text = String(songId ?? '').trim().replace(/\.$/, '')
  if (provider !== 'kugou') return text
  const match = /^([0-9a-fA-F]{16,40})(?:\.\d{1,24})?$/.exec(text)
  return match ? match[1] : text
}

/** 【2026-10-18 修「下载下来根本不是 FLAC」】
 *
 *  用户实测：酷狗《可能》原唱下载得到的是 **0.92MB** 的文件 —— 218 秒的
 *  真无损应该有 40MB 左右（酷我同曲 41MB）。ffprobe 看：
 *
 *      酷狗   codec=mp3   bit_rate=35234    size=960112    ← 名字叫 .flac
 *      酷我   codec=flac  bit_rate=1578618  size=43016351
 *
 *  酷狗把一个 128kbps 的 MP3 换个 `.flac` 后缀发出来，URL 里还带 `quflac`。
 *  我们照单全收，界面标「无损」、下载下来是 MP3 —— 名不副实。
 *
 *  判定**不看平台自报的码率**（那是档位表里的默认值，不是实际给的那份），
 *  而是**自己算**：`码率 = content-length × 8 ÷ 时长`。这个数字骗不了人 ——
 *  MP3 128kbps 的 218 秒文件必然约 3.5Mbps 以下的等效码率，而真 flac 在
 *  1000kbps 以上。
 *
 *  代价：一次 HEAD 请求（约 20~80ms）。相对于取源本身动辄几百毫秒，
 *  这个开销可以忽略，换来的是「界面标的音质是真的」。
 *
 *  @param {string} audioUrl 实际播放地址
 *  @param {string} format   平台/池子报的格式（可能是假的）
 *  @param {number} duration 时长（秒），0 表示未知
 *  @returns {Promise<{format: string, quality: string|null, downgraded: boolean, measuredKbps: number}>}
 */
const LOSSLESS_FORMATS = new Set(['flac', 'ape', 'wav', 'alac', 'dsf', 'dff'])
/** 真无损在这个等效码率之上；低于它却自称无损的就是假的（FLAC 压缩率再高也不会低于 700）。 */
const FAKE_LOSSLESS_BELOW_KBPS = 700
const FORMAT_MEASURE_TIMEOUT_MS = 2500

async function honestFormat (audioUrl, format, duration) {
  const declared = String(format ?? '').toLowerCase().replace(/^\./, '')
  // 有损格式无需测 —— 报的就是真的。
  if (!LOSSLESS_FORMATS.has(declared)) return { format: declared, quality: null, downgraded: false, measuredKbps: 0 }
  // 没有地址或时长，测不了就照原样报（宁可放过，不要冤判）。
  if (!audioUrl || !(Number(duration) > 0)) {
    return { format: declared, quality: null, downgraded: false, measuredKbps: 0 }
  }
  let bytes = 0
  try {
    const probe = await withHardTimeout(
      fetch(audioUrl, { method: 'HEAD' }).then((r) => (r.ok ? Number(r.headers.get('content-length')) || 0 : 0)),
      FORMAT_MEASURE_TIMEOUT_MS,
      { label: 'format-head' },
    )
    bytes = Number(probe) || 0
  } catch { /* HEAD 不可用就退回平台自报值，不阻断播放 */ }
  if (!bytes) return { format: declared, quality: null, downgraded: false, measuredKbps: 0 }
  const kbps = Math.round((bytes * 8) / Number(duration) / 1000)
  if (kbps >= FAKE_LOSSLESS_BELOW_KBPS) {
    return { format: declared, quality: null, downgraded: false, measuredKbps: kbps }
  }
  // 实测码率低到不可能是无损 —— 如实报 mp3，档位降到 high。
  return { format: 'mp3', quality: 'high', downgraded: true, measuredKbps: kbps }
}

/** 池子/平台会把这几档取成加密容器（mflac/mgg）。实测表见 docs/qmc-spec.md。 */
const ENCRYPTED_TIERS = new Set(['master', 'surround', 'hifi'])

/**
 * 兜底降级：万一**上游无视档位**、仍回了加密容器（例如备用源只给加密档），
 * 就在原地用 lossless 再问一次。这是安全网，不是主路径 ——
 * 主路径已由 `playableQuality()` 在取源前解决，正常不会走到这里。
 *
 * 不弹提示、不写 state.error（用户明确要求「换源全静默」），只如实回报
 * `actualQuality` 与 `degradedFrom`，让前端徽章显示真实档位。
 *
 * @param {object} resolved 已解析出的结果（可能含加密 audioUrl）
 * @param {(quality: string) => Promise<object|null>} refetch 用指定档位重新取源
 * @returns {Promise<object>} 可播放的结果（明文优先）
 */
async function degradeEncrypted (resolved, refetch) {
  if (!resolved?.audioUrl || !isEncrypted(resolved.format)) return resolved
  const requested = resolved.actualQuality ?? resolved.quality ?? null
  // 已是明文回落档（lossless 返回 flac）时不会进这里；只有加密容器才降级。
  try {
    const plain = await refetch(PLAINTEXT_FALLBACK_QUALITY)
    if (plain?.audioUrl && !isEncrypted(plain.format)) {
      return {
        ...plain,
        requestedQuality: requested,
        degradedFrom: resolved.format,
        degradedReason: QMC_ERRORS.EKEY_UNRESOLVED,
      }
    }
  } catch { /* 回落取源失败 → 保持原结果，让前端拿到 503 语义 */ }
  return resolved
}

// 共享池：启动时尝试从 DB 加载凭据（失败则跳过，不影响其他源）
let poolReady = false

// 共享池接受的 7 级音质枚举（低→高），与 exe 内的枚举一致。
const POOL_QUALITIES = ['standard', 'high', 'lossless', 'hires', 'hifi', 'surround', 'master']

// 池子的 7 档 → 各下游音源自己的档位词。
//
// 【对齐：单次请求，不发明降级阶梯】
//  exe 的音质是**单一枚举字符串**（`standard|high|lossless|hires|hifi|
// surround|master`），只有**一次**请求；档位回落由**服务端**做（池子/平台返回
// `actualQuality` 告诉客户端实际给了哪档）。客户端**没有**那一串降级阶梯 ——
// `shared-pool.mjs` 里那个 7 档 for 循环是历史遗留的自造逻辑，这里不用。
//
// 各下游的档位词汇（都在本仓库内有据）：
//   · 池子      `POST /api/proxy/music`，quality 就是这 7 个枚举名（shared-pool.mjs）
//   · 备用音源  standard|320kmp3|lossless|hires|master|dolby|dts|flac|128kmp3
//               （backup-sources.mjs 的 QUALITY_MAP，来自二进制原文）
//   · LX       128k|192k|320k|flac|flac24bit|hires|atmos|atmos_plus|master
//               （lx-source-loader.mjs 的 QUALITY_TIERS）
const LX_QUALITY_OF_TIER = {
  standard: '128k', high: '320k', lossless: 'flac',
  hires: 'flac24bit', hifi: 'flac24bit', surround: 'atmos', master: 'master',
}
const BACKUP_QUALITY_OF_TIER = {
  standard: 'standard', high: '320kmp3', lossless: 'lossless',
  hires: 'hires', hifi: 'flac', surround: 'dts', master: 'master',
}

// LX 插件**实际**给出的档位名 → 我们的 7 档枚举。
// 取曲时 LX 会把真正命中那一档写进返回值的 `quality` 字段（lx-source-loader.mjs
// `resolveUrl`：`return { ...attempt, quality: tier }`），这正是"服务端自回落"
// 的 LX 版本 —— 我们对齐的语义，把它作为 actualQuality 如实回报。
// 词表 = lx-source-loader.mjs 的 QUALITY_TIERS（低→高）：
//   128k 192k 320k flac flac24bit hires atmos atmos_plus master
const TIER_OF_LX_QUALITY = {
  '128k': 'standard', '192k': 'high', '320k': 'high',
  flac: 'lossless', flac24bit: 'hires', hires: 'hires',
  atmos: 'surround', atmos_plus: 'surround', master: 'master',
}
// ── 共享池凭据：只认「用户导入的密钥文件」 ────────────────────────────
//
// 【2026-10-18 重构】以前这里读的是构建期内嵌的凭据，等于把一份 token
// 明发给所有用户。现在客户端**不带任何凭据**：
//   · 用户导入 `pool-credential.json` → 共享池启用
//   · 没导入 → 共享池跳过，只走备用音源（功能降级，但完整可听）
// 源码因此可以公开，不需要混淆 —— 细节见 pool-credential.mjs 顶部说明。
//
// 实际的加载放在 createMusicServer 里（那里才知道 dataDir）。
// 【2026-10-16 修：池子双线路必须开机探测，否则第一次播放必然失败】
//
// 真实行为（`server_line.rs`）：**开机先探线路、之后按结果选路**。
// 我们此前只 `serviceLoad()`（读凭据），**从未探测** —— 于是池子一直用
// `SERVER_LINES` 里的默认第一条 首选线路（实测**已失效**），
// 冷启动第一次取源必然「未命中 63ms」，用户白等一整条串行链
// （实测 7.6–8.6s）才失败。
//
// 关键：探测**不 await 在 createMusicServer 里**（它要联网，会重新把启动
// 拖慢到 16 秒，见下方 `lxPluginsLoaded` 的同类修复）。
//
// 【为什么探测结果**不再**挡在取源链前面（2026-10-16 二次修正）】
// 最初把探测记成 `serviceProbed` 并让池子那一跳 `await` 它，是因为当时
// `rawRequest` 只会打 `activeBaseUrl()` 一条线路 —— 探测没跑完时它还是死线路。
// 现在 `rawRequest` 已自带式**换线容错**（打不通自动换另一条），
// 首个请求不依赖探测也能找到活线路。所以去掉这一跳：
// 冷启动首请求不必再付探测的网络时间（实测 1524–1569ms → 291–908ms）。
// 探测照旧在启动时并行发起；下面这行只负责**发起 + 打日志**，不被 await。
if (poolReady) {
  poolProbeLines().then(
    () => {},
    (err) => { console.warn('[shared-pool] 线路探测失败（不影响其它音源）：', err?.message ?? err) },
  )
}

// FFmpeg 自动发现：打包版把它放在 runtime/bin（由 desktop-server 注入），
// 开发机上常在 PATH 之外（winget 安装）。这里补齐，免得原生 DSP 音效因为
// 一个环境变量没设就整体 503。
for (const [name, variable] of [['ffmpeg', 'FFMPEG_PATH'], ['ffprobe', 'FFPROBE_PATH']]) {
  if (process.env[variable]) continue
  const candidates = [
    path.join(PROJECT_DIR, 'runtime', 'bin', `${name}.exe`),
    path.join(PROJECT_DIR, 'bin', `${name}.exe`),
  ]
  if (process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const entry of fsSync.readdirSync(winget)) {
        if (!entry.startsWith('Gyan.FFmpeg')) continue
        const base = path.join(winget, entry)
        for (const version of fsSync.readdirSync(base)) {
          candidates.push(path.join(base, version, 'bin', `${name}.exe`))
        }
      }
    } catch { /* winget 目录不存在就跳过 */ }
  }
  const found = candidates.find(candidate => fsSync.existsSync(candidate))
  if (found) process.env[variable] = found
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请使用 application/json 请求体'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 请求体必须是对象')
  return value
}

/** Returns null for no Range; false for invalid or unsatisfiable single ranges. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  const headers = {
    'Content-Type': descriptor.mime ?? MIME[path.extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
  }
  if (range === false) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 })
    response.end()
    return
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = range.end - range.start + 1
  } else headers['Content-Length'] = stat.size
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

/** LX 音源插件的用户配置：只记「停用了哪些」，落在数据目录里。
 *  有源即启用 —— 用户要求删掉那个总开关。 */
const LX_CONFIG_FILE = 'lx-config.json'
/** 用户自己添加的音源落在这里；内置目录在项目里，只读。 */
const LX_USER_SOURCES_DIR = 'lx-sources-user'
/** 自检单个音源的硬上限：10 秒内不出歌就算超时（用户要求）。 */
const LX_SELFCHECK_CALL_TIMEOUT_MS = 10000
async function readLxConfig(dataDir) {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, LX_CONFIG_FILE), 'utf-8')) }
  catch { return {} }
}
async function writeLxConfig(dataDir, value) {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, LX_CONFIG_FILE), JSON.stringify(value, null, 2), 'utf-8')
}

/** 备用音源的用户配置：接口列表 + 总开关，落在数据目录里 */
const BACKUP_CONFIG_FILE = 'backup-sources-config.json'
async function readBackupConfig(dataDir) {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, BACKUP_CONFIG_FILE), 'utf-8')) }
  catch { return {} }
}
async function writeBackupConfig(dataDir, value) {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, BACKUP_CONFIG_FILE), JSON.stringify(value, null, 2), 'utf-8')
}

/** 音源自检结果缓存：一天内有效，避免每次开机都重跑 1~3 分钟的自检。 */
const LX_HEALTH_FILE = 'lx-health.json'
const LX_HEALTH_TTL = 24 * 60 * 60 * 1000
/** 插件集合的指纹（数量 + id 校验和）。
 *
 * 缓存只按时间判断新鲜度是不够的：往音源目录里加/删/换插件之后，旧自检结果
 * 里根本没有新插件的条目，`_rankSources` 会给「未自检」打 0 分（居中），于是
 * 新装的源要等 24 小时过期才会被真正评级 —— 用户会以为"加了没用"。带上指纹
 * 后，插件集合一变就立即重测。 */
const lxPluginFingerprint = (sources) => {
 // 源对象是 `{ name, filePath, ok }`，**没有 id 字段** —— 早先按 `s.id` 取值
 // 会拿到 undefined，随后 `id.length` 直接抛 TypeError 把自检整条链路打断。
 // 用文件名做身份：换目录不算变，换文件才算变。
  const ids = [...new Set((sources ?? []).map((s) => path.basename(String(s?.filePath ?? s?.name ?? ''))))].sort()
  let hash = 0
  for (const id of ids) for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return `${ids.length}:${hash}`
}

/**
 * 取曲地址缓存（对齐洛雪的 SQLite music_url 表）。
 *
 * 洛雪把「歌 → 播放地址」持久化，所以重启后再放同一首歌是 ~0ms。我们原来
 * 只有内存 Map，一退就没。这个文件补上"第二次不用取源"。
 * TTL 与 loader 里的 CACHE_TTL 一致（20 分钟）—— CDN 签名会过期，
 * 存太久只会拿到打不开的地址。
 */
const LX_URL_CACHE_FILE = 'lx-url-cache.json'

/**
 * 【2026-10-16 对齐：删掉总预算与竞速】
 *
 * 这里原来有一个 `FALLBACK_BUDGET_MS = 10000`（换源总预算）和一个
 * `POOL_PRIORITY_MS = 4000`（池子独占窗口），外加 `poolFirst()` 并发竞速。
 * 三者都是**我们自己发明的，没有**：
 *
 *   - 的失败链是 `播放地址解析失败:` → `获取播放地址超时` → `; 备用音源: <名>`
 *     （服务端返回的原样字符串，2026-10-16 实测确认）。
 *     这种"链式失败后拼接错误消息"的文案形态证明它是**串行**：问完一站报一站。
 *     exe 里搜不到「竞速」二字，也没有任何"总预算"概念的痕迹。
 *   - 实测代价：池子未命中的五首歌耗时 9033/10056/10203/10440/10453ms ——
 *     **全部被这个 10s 预算钉住**。删掉它、改成"每问一次都有短硬超时"之后，
 *     失败路径由"等到预算用完"变成"逐个快速失败"。
 *
 * 现在没有任何跨阶段的超时常量：唯一的时限是**每一次请求自己的**硬超时
 * （备用源 2500ms 见 backup-sources.mjs，池子 3000ms 见 shared-pool.mjs）。
 *
 * 下面这个 LX 常量不是"总预算"：它只约束**串行链末端那一次** LX 调用
 * 自己的内部预算（LX 默认 9000ms），因为 LX 排在最后、它超时就直接决定
 * 用户等多久。与已删的 FALLBACK_BUDGET_MS 的区别：那个是"所有阶段共享
 * 一个总池"，这个是"这一站自己的超时"，各站互不占用。
 */
const BACKUP_LEGACY_TIMEOUT_MS = 1200 // 三个第三方车站的内层封顶（实测全死，只是兜底）

/**
 * 备用音源这一跳向本地源要的起始档位。
 *
 * 实测（2026-10-23，同一首 VIP《夜曲》）：
 *   · 起点 `master`     → 阶梯里只有 master 一档，极少数源才支持，2500ms 0 命中；
 *   · 起点 `flac24bit`  → 5 秒还空手（高档位插件要么超时要么空回）；
 *   · 起点 `flac`       → **944ms 命中**（VIP 整首 FLAC）。
 * 兜底场景的首要目标是「能出声」，所以统一从 flac 起步；实际拿到哪一档由返回值的
 * quality 字段如实回报（前端音质徽章用它，不靠猜）。
 */
function lxFallbackTier(quality) {
  const mapped = LX_QUALITY_OF_TIER[quality] ?? 'flac'
  return ['master', 'atmos', 'atmos_plus', 'hires', 'flac24bit'].includes(mapped) ? 'flac' : mapped
}

const LX_FALLBACK_BUDGET_MS = 2500

// 串行链每一步的外层硬超时（兜住组件内部预算失灵）。各步互不占用 —— 这是
// 「每一步都有自己的上限」，不是已删的那种「全链共享一个总预算」。
//
// LX 为什么是 2500ms 而不是"它自己的 3000ms 预算 + 余量"：实测
// `lxHost.resolveForProvider(..., { budgetMs })` **不遵守 budgetMs**
// （传 1500/3000 都跑 7000ms+；插件目录冷加载本身要 22s）。也就是说
// LX 这一跳的 `budgetMs` 是装饰品，唯一真正生效的是这里的外层硬超时。
// 它在串行链末端，超时多久用户就多等多久 —— 所以取 2500ms（与备用源
// 同档），而不是 6000ms。
const POOL_STEP_TIMEOUT_MS = 3500   // 池子单次请求自带 3000ms，留 500ms 余量
const BACKUP_STEP_TIMEOUT_MS = 8500 // 三站串行 × 2500ms + 余量
const LX_STEP_TIMEOUT_MS = 2500     // LX 不遵守 budgetMs，只能靠外层硬切

/** 【2026-10-17 实测：这两跳在真实曲库上零命中，不该再让用户为它们等待】
 *
 *  取源日志（80 条真实播放样本，`/api/source-log`）：
 *
 *    · 共享池     80 次尝试 / **55 次命中** / 平均 976ms   ← 唯一主力
 *    · 备用音源   25 次尝试 / **0 次命中** / 平均 953ms    ← 全废，却排在链中
 *    · 自定义音源 25 次出现 / **0 次命中** / 真实请求皆吃满 2500ms
 *
 *  再看最慢几首的构成（总耗时 5.5~10.5s，全部失败）：
 *
 *    共享池 3020ms 未返回 → 备用音源 5008ms 未返回 → 自定义音源 2511ms 超时
 *
 *  也就是说**失败路径上，有 7.5s 花在从来没命中过的两跳上**。
 *
 *  为什么会这样（都有独立证据，不是猜）：
 *    · 备用源三站：`yy.zddyr.top` 现在回 `code:500「歌曲不存在」`，响应里
 *      `auth.trusted:false / auth_type:"none"` —— 它要授权，而那套凭据
 *      不适用于第三方直连。`api.ygking.top` DNS 已无记录，`music.bxa241d4.shop`
 *      连接挂死。本仓库 music-server.mjs 更早的注释（2026-10-15）就记过
 *      「三个全部失效」，之后才引入 LX 音源来替代它们。
 *    · 自定义音源：18 个插件里没有一个能在预算内出地址，实测直接调
 *      `/api/lx/resolve` 要 9.5~11s 才失败（v2.1 闻音「暂不支持此音源」、
 *      ikun「fetch failed」…）。原版**根本没有这一跳**（见下方决策树注释
 *      ③「我们的扩展层，没有但保留」）。
 *
 *  处理原则 —— 不删除能力，只不阻塞主链路：
 *    1. 这两跳改成**链尾兜底**：共享池成功就直接返回，不再问它们。
 *    2. 兜底时给它们**很短的超时**：既然历史命中率 0%，就不值得再等 2.5s。
 *    3. 真正的收益在**失败路径**：原来 7.5s 的两跳现在压到 1.2s 内。
 *
 *  这与「对齐」并不冲突：的决策树是 ①平台 prepare → ②共享池；
 *  备用三站在它那里是**已失效的历史分支**，LX 则是我们后加的扩展。让主链路
 *  对齐（池子优先、命中即止），把无效分支降级到链尾，才是的真实行为。
 */
const BACKUP_TAIL_TIMEOUT_MS = 3000   // 备用音源一站总预算（本地源 + 第三方三站并跑）
/** 启动预热时等 LX 自检就绪的上限；到点还没就绪就跳过预热（宁慢不误判）。 */
const LX_WARMUP_WAIT_MS = 60_000

export async function createMusicServer({
  dataDir = process.env.MUSIC_DATA_DIR ?? path.join(PROJECT_DIR, '..', 'music-data-v3'),
  distDir = path.join(PROJECT_DIR, 'dist'),
  defaultRoots = process.env.MUSIC_ROOTS ? process.env.MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : [],
  store: providedStore,
  autoScan = true,
  online: providedOnline,
  platformAuth: providedPlatformAuth,
  catalogs: providedCatalogs,
  downloads: providedDownloads,
  localPlaylists: providedLocalPlaylists,
  sourceLog: providedSourceLog,
} = {}) {
  const store = providedStore ?? await new MusicLibraryStore({ dataDir, defaultRoots }).init()
  const decoder = new AudioDecoder({ dataDir: store.dataDir ?? dataDir })

  // ── 共享池凭据：只认用户导入的密钥文件 ──────────────────────────
  //
  // 没导入 = 正常降级，不是错误：共享池那一跳会被跳过，取源链自动落到
  // 备用源与 LX。用户随时可以在设置里导入/移除，见 /api/pool/credential。
  poolReady = false
  try {
    const imported = loadFromImportedKey(store.dataDir ?? dataDir)
    if (imported && Array.isArray(imported.servers) && imported.servers.length) {
      // SERVER_LINES 只由 configureServerLines() 填充：密钥可用时必须同步一次线路表，
      // 否则取源会落到「未启用」分支。
      configureServerLines(imported.servers)
      poolReady = true
      console.log('[shared-pool] 已启用导入的密钥，共享池可用', imported.servers.join(' / '))
    } else if (imported) {
      poolReady = false
      console.log('[shared-pool] 密钥缺少服务地址 — 共享池停用，当前只使用备用音源')
    } else {
      console.log('[shared-pool] 未导入密钥 — 共享池停用，当前只使用备用音源')
    }
  } catch (e) {
    console.log('[shared-pool] 导入的密钥不可用:', e.message)
  }
  const output = new NativeAudioOutput({ dataDir: store.dataDir ?? dataDir, decoder, trackFile: (id) => store.trackFile(id) })
  const online = providedOnline ?? new NeteaseOnline({ dataDir })
  const platformAuth = providedPlatformAuth ?? { qq: new PlatformAuth({ provider: 'qq', dataDir }), bodian: new PlatformAuth({ provider: 'bodian', dataDir }), kugou: new PlatformAuth({ provider: 'kugou', dataDir }) }
  const catalogs = providedCatalogs ?? { qq: new PlatformCatalog({ provider: 'qq', auth: platformAuth.qq }), ...(platformAuth.bodian ? { bodian: new BodianCatalog({ auth: platformAuth.bodian }) } : {}), ...(platformAuth.kugou ? { kugou: new KugouCatalog({ auth: platformAuth.kugou }) } : {}), kuwo: new KuwoCatalog(), joox: new JooxCatalog() }
  const platformCovers = new PlatformCoverStore()
  const downloads = providedDownloads ?? new DownloadManager({ dataDir: store.dataDir ?? dataDir })
  // 本地歌单（自建歌单能力）：只存本机，不参与云同步。
  const localPlaylists = providedLocalPlaylists ?? await new LocalPlaylists({ dataDir: store.dataDir ?? dataDir }).init()
  // 取源日志：每首歌经过哪些音源、每一跳耗时/失败原因。落盘 `<dataDir>/source-log.jsonl`。
  // 用于排查「某些歌播放很慢」—— 事后能回看到底卡在哪一跳。
  const sourceLog = providedSourceLog ?? await new SourceLog({ dataDir: store.dataDir ?? dataDir }).init()

  // LX 音源宿主：**默认加载随应用打包的音源目录**（scripts/lx-sources，94 个），
  // 用户在设置里指定的目录会覆盖它。这些音源取代了那三个已失效的
  // backup-source 接口（2026-10-15 实测三个全部失效：yy.zddyr.top 回
  // code:500 要授权、api.ygking.top SSL 握手失败、music.bxa241d4.shop 超时）。
  // 插件跑在 worker 线程里，坏插件不能拖死曲库服务主线程。
  const lxHost = new LxSourceHost()
  // 【2026-10-23 自检隔离】`selfCheck` 会把 worker 占满几分钟：期间同一个 worker 上的
  // `resolveForProvider` 根本回不来（实测备用音源整站干等到硬超时，用户前 3 分钟点播放
  // 拿不到地址）。所以自检单独开一个宿主/worker，结果用 importHealth 同步给播放宿主。
  const lxCheckHost = new LxSourceHost()
  const ensureCheckHost = async () => {
    await lxCheckHost.loadDirectories(sortedSourceDirs)
    if (disabledPlugins.length) await lxCheckHost.setDisabled(disabledPlugins).catch(() => {})
  }
  const lxConfig = await readLxConfig(store.dataDir ?? dataDir)
  // 音源自检是否已就绪：front-end 的加载页据此决定「能不能进应用」。
  // 首次运行会一直是 false，直到自检跑完（用户要求：首次要卡在加载页等它）。
  let lxReady = false
  // 内置音源目录：随 desktop-runtime 一起发布，缺失时（例如在源码仓库里直接
  // 跑）回退到仓库内的 scripts/lx-sources。
  const bundledSources = [path.join(PROJECT_DIR, 'lx-sources'), path.join(PROJECT_DIR, 'scripts', 'lx-sources')]
    .find(dir => { try { return fsSync.statSync(dir).isDirectory() } catch { return false } })
  const userSourcesDir = path.join(store.dataDir ?? dataDir, LX_USER_SOURCES_DIR)
  // 顺序即优先级：内置在最前，用户目录在最后（同名文件以用户那份为准）。
  const sortedSourceDirs = [bundledSources, lxConfig.dir, userSourcesDir].filter(Boolean)
  const sourceDirs = sortedSourceDirs
  const disabledPlugins = Array.isArray(lxConfig.disabled) ? lxConfig.disabled : []
  // 【2026-10-16 启动提速：插件加载不再挡在服务监听之前】
  //
  // 实测 `lxHost.loadDirectory()`（worker 里加载 18 个插件）独占约 **15.9s**
  // （loadDirectory 调用 12.6s + snapshot 2.7s）。它原先被 `await` 在这里，
  // 于是 `createMusicServer()` 要 16s 才返回、端口 16s 才能服务 ——
  // 桌面端 main.rs 只等 25s，这段时间窗口连不上服务只能干等。
  //
  // 为什么之前没人动它：**不能简单地不 await** —— 下面的 `startLxSelfCheck`
  // 用 `lxHost.enabled` 判断"要不要跑自检"，插件没加载时 `enabled === false`
  // 会直接 `lxReady = true`，把用户明确要求的首次自检**整个跳过**。
  //
  // 所以这里保留依赖链、只移除阻塞：把加载过程记成一个 promise，
  // 由 `startLxSelfCheck` 在自检前 await 它。顺序与语义完全不变
  // （插件就绪 → 自检 → 放行进主界面），但服务可以立刻监听。
  const lxPluginsLoaded = (async () => {
    try {
      // 配置里明确停用就别加载：hermetic 测试与"我自己有音源"的用户都不该付这份网络代价。
      if (lxConfig.enabled === false) {
        console.log('[LX] 配置里已停用音源插件，跳过加载')
        return
      }
      // 一次性加载所有根目录：内置先、用户目录后，同名以用户目录为准。
      await lxHost.loadDirectories(sortedSourceDirs)
      if (disabledPlugins.length) await lxHost.setDisabled(disabledPlugins)
      console.log(`[LX] 音源插件就绪：${lxHost.pluginCount} 个（内置 ${bundledSources ?? '无'}）`)
    } catch (err) {
      console.warn('[LX] 音源目录加载失败：', err.message)
    }
  })()
  // 开机自检（用户要求）：应用打开后，在**转圈的加载页**上逐个音源试取地址，
  // 挑出活的、记录各自能给的最高音质，并据此重排优先级——之后播放只在健康源里
  // 找最好的音质，不再挨个撞死源（用户实测的"等 20 秒"来自依次撞死源）。
  //
  // 关键（用户纠正）：自检**绝不能挡在服务监听之前** —— 那样窗口连不上服务，
  // 应用连界面都打不开（"连应用都点不开"）。正确顺序是：
  //   ① 服务立刻监听 → ② 窗口打开、显示转圈加载页 → ③ 人在加载页上看到进度条
  //   → ④ 自检跑完 → ⑤ 前端放行进入主界面。
  // 所以这里把自检挂到 listening 之后**后台**跑，只把「进度」与「是否就绪」
  // 通过 /api/health + /api/lx/progress 报给前端；前端加载页据此等待。
  // 结果落盘（lx-health.json）：下次开机读缓存，瞬间就绪、加载页一闪而过。
  const startLxSelfCheck = () => {
    void (async () => {
      // 先等插件目录加载完（它已不再挡服务启动，见上方 lxPluginsLoaded 的注释）。
      // 必须等 —— 否则 `lxHost.enabled` 还是 false，会被误判成"LX 不可用"
      // 而直接放行，跳过用户明确要求的首次自检。
      await lxPluginsLoaded
      if (!lxHost.enabled) { lxReady = true; return }
      const healthFile = path.join(store.dataDir ?? dataDir, LX_HEALTH_FILE)
      let cached = null
      try { cached = JSON.parse(await fs.readFile(healthFile, 'utf-8')) } catch { /* 首次运行 */ }
      // 插件集合变了（加了/删了音源）就当作缓存失效，立即重测；
      // 否则新插件拿不到自检评级，会一直居中排在健康源后面（见 lxPluginFingerprint 注释）。
      const pluginPrint = lxPluginFingerprint(lxHost.sources)
      const samePlugins = cached && cached.plugins === pluginPrint
      const fresh = samePlugins && Date.now() - Number(cached.at ?? 0) < LX_HEALTH_TTL
      if (fresh) {
        await lxHost.importHealth(cached)
        console.log(`[LX] 用缓存的自检结果排序（${Object.values(cached.sources ?? {}).filter(s => s.ok).length} 个可用），跳过自检`)
      } else {
        if (cached && !samePlugins) console.log('[LX] 音源插件集合有变化，重新自检')
        try {
          await ensureCheckHost()
          const report = await lxCheckHost.selfCheck({ concurrency: 10, budgetMs: 300000, resolveId: lxResolveProbeId })
          console.log(`[LX] 首次自检完成：可用 ${report.alive}/${report.checked}，用时 ${Math.round(report.ms / 1000)}s`)
          try {
            const snapshot = await lxCheckHost.exportHealth()
            // 把自检评级同步给播放宿主：排序/健康标记都在它身上生效。
            await lxHost.importHealth(snapshot)
            snapshot.plugins = pluginPrint
            await fs.writeFile(healthFile, JSON.stringify(snapshot, null, 2), 'utf-8')
          }
          catch (err) { console.warn('[LX] 自检结果写入缓存失败：', err.message) }
        } catch (err) {
          // 自检失败不能挡住应用：标记完成，播放退化为按加载顺序试。
          console.warn('[LX] 自检失败（不影响播放）：', err.message)
        }
      }
      // 只有到这里前端才被放行进入主界面。
      lxReady = true
    })()
  }

  // 备用音源（backup_source.rs 等价物）：平台协议 + LX 都拿不到时，
  // 问可配置的第三方解析接口要完整地址。配置在 backup-sources-config.json。
  const backupConfig = await readBackupConfig(store.dataDir ?? dataDir)
  const backupSources = new BackupSources({ sources: backupConfig.sources ?? DEFAULT_SOURCES, enabled: backupConfig.enabled !== false })

  /**
   * 取曲缓存落盘（对齐洛雪的 SQLite music_url）。
   *
   * 启动时读回上次的「歌 → 地址」，命中即 0ms；播放成功后再节流写回。
   * 与 lx-health.json 用同一个数据目录、同样的容错策略（读不到当首次运行）。
   */
  const urlCacheFile = path.join(store.dataDir ?? dataDir, LX_URL_CACHE_FILE)
  try {
    const snapshot = JSON.parse(await fs.readFile(urlCacheFile, 'utf-8'))
    // lxHost 是 worker 的代理，方法都是异步的 —— 必须 await，否则拿到的是
    // Promise（恒为真值）而不是真正的恢复结果。
    const restored = await lxHost.importUrlCache(snapshot)
    if (restored) {
      console.log(`[LX] 取曲缓存已恢复（${Object.keys(snapshot.urls ?? {}).length} 条地址、${Object.keys(snapshot.owners ?? {}).length} 条归属）`)
    }
  } catch { /* 首次运行或文件损坏：当作没有缓存 */ }

  // 写盘节流：取曲是高频操作，不能每成功一次就写一次磁盘。攒 3 秒落盘一次。
  let urlCacheTimer = null
  const flushUrlCache = () => {
    urlCacheTimer = null
    void lxHost.exportUrlCache()
      .then(snapshot => fs.writeFile(urlCacheFile, JSON.stringify(snapshot, null, 2), 'utf-8'))
      .catch(err => console.warn('[LX] 取曲缓存写入失败：', err.message))
  }
  const scheduleUrlCacheFlush = () => {
    if (urlCacheTimer) return
    urlCacheTimer = setTimeout(flushUrlCache, 3000)
    urlCacheTimer.unref?.()
  }

  /**
   * LX 自定义音源兜底（网易与其它平台共用）：平台只肯给试听片段、或根本不给
   * 地址时，问用户自己加载的 lx-music 音源插件要一个完整地址。插件由用户
   * 自行提供，本服务只做「宿主」——加载、调用、结果回传。
   *
   * 拿到完整地址后必须把付费/试听证据一并清掉（fee=0、trial=undefined）：
   * fee 留着会让播放器以为还是付费曲，再去换源；换到的那边同样带 fee，
   * 于是两个音源之间无限乒乓（用户实测：一直放不出来）。
   */
const PLATFORM_NAMES = { netease: '网易云音乐', qq: 'QQ 音乐', bodian: '波点音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', joox: 'JOOX' }

  /**
   * 自检用的「探针曲真实 id」解析器：LX 平台键（wy/kg/kw/tx）→ 该平台的真 id。
   *
   * 为什么需要：只支持 musicUrl 的音源（如星海）必须拿平台真 id 才能取曲；
   * 拿假 id 会报 unknow error，把好源误判成死源（实测踩过 17 个源全判死）。
   * 这里只用**免登录**的平台搜索，所以自检不需要用户登录任何账号。
   */
async function lxResolveProbeId(lxKey, keyword) {
  const provider = { wy: 'netease', kg: 'kugou', kw: 'kuwo', tx: 'qq' }[lxKey]
  if (!provider) return null
  try {
    const catalog = catalogs[provider]
    if (!catalog?.search) return null
    const found = await catalog.search(keyword, 1)
    const first = (found?.tracks ?? [])[0]
    const raw = String(first?.onlineSource?.id ?? '')
    if (!raw) return null
    const album = String(first?.onlineSource?.albumId ?? '')
    const base = { name: first.title ?? '', singer: first.artist ?? '', albumName: first.onlineSource?.albumTitle ?? '' }
    // 【2026-10-23 修自检误判】库里的 id 是「展示用」形态，插件要的是平台原生字段：
    //   酷我   MUSIC_228908      → rid 228908（纯数字），另给 albumId
    //   酷狗   <hash>.<albumId>  → hash 与 albumId 拆开
    //   QQ     songmid 本身即可   → 另给 albumMid
    //   网易   纯数字 id           → 另给 albumId
    // 之前四种都塞同一个字符串，插件一律报「缺少 songId/songmid/hash」，
    // 20 个源里 14 个被误判成坏源。
    if (provider === 'kuwo') {
      const rid = raw.replace(/^MUSIC_/i, '')
      return { ...base, id: rid, rid, songmid: rid, mid: rid, hash: rid, albumId: album || undefined }
    }
    if (provider === 'kugou') {
      const [hash, albumId] = raw.split('.')
      return { ...base, id: hash, hash, songmid: hash, mid: hash, albumId: albumId || album || undefined }
    }
    if (provider === 'qq') {
      return { ...base, id: raw, songmid: raw, mid: raw, hash: raw, albumId: album || undefined, albumMid: album || undefined }
    }
    return { ...base, id: raw, songmid: raw, mid: raw, hash: raw, albumId: album || undefined }
  } catch { return null }
}


  /**
   * 启动预热：把"备用源探测"和"末端 LX 一跳是否可用"提前跑掉。
   *
   * 对齐 `server_line.rs` 的启动探测思路（开机先探，之后按结果选路），
   * 但复用**已有的判据**，不新增协议：
   *   · 备用三站 → `backupSources.probeHealth()`（内部走 `_failStreak`）
   *   · 末端 LX   → 用同一首歌问一次，超时即记入 `stepHealth`
   *
   * 为什么值得做：不预热时**头两次播放**每次白等 2.5s（备用源死站 + LX 超时
   * 各一次），实测首次 5600ms、第二次 2974ms 才降到稳态 330ms。预热把这段
   * 成本挪到开机阶段（与 LX 自检、曲库扫描并行），用户第一次点击就是稳态。
   *
   * 必须**不 await** 且**吞掉所有错误**：预热失败只是慢一点，绝不能挡住服务
   * 启动或让第一次播放报错。等 `lxReady` 再预热 LX —— LX worker 没加载好时
   * 去问它，会得到一个"假超时"，把好音源误标成跳过。
   */
  async function startFallbackWarmUp() {
    // 两件事**并发**做，别串行 —— 串行要 7.5s(备用三站) + 2.5s(LX) ≈ 10s，
    // 并发只要 ~7.5s。窗口打开后到预热完成这段时间里用户点击还是慢的，
    // 所以能缩短就缩短。
    const backupWarmUp = (async () => {
      if (!backupSources.enabled) return
      try {
        const report = await backupSources.probeHealth()
        const dead = report.filter(r => !r.healthy).map(r => r.name)
        console.log(`[备用源] 启动探测完成：${report.length - dead.length}/${report.length} 可用${dead.length ? `，已标记 ${dead.join('、')}` : ''}`)
      } catch (err) {
        console.warn('[备用源] 启动探测失败（不影响播放）：', err?.message ?? err)
      }
    })()

    const lxWarmUp = (async () => {
      // 等 LX **插件加载完成**再预热 —— 注意门槛是 `lxHost.enabled`（插件目录
      // 已加载、18 个插件就绪），**不是** `lxReady`。
      //
      // 踩过的坑：一开始等 `lxReady`，实测它 50s 内都不会变真（`lxReady` 还
      // 要求跑完整个 LX 自检，自检要 3 分钟）。结果预热一直没跑，冷启动那
      // 5.5s 原样留着。插件加载完成后就足够调 `resolveForProvider` 了。
      // 上限 `LX_WARMUP_WAIT_MS` 兜住"worker 一直起不来"的情况。
      const deadline = Date.now() + LX_WARMUP_WAIT_MS
      while (!lxHost.enabled && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
      if (!lxHost.enabled) return

      // 用一个**确定存在**的歌去问，才能区分"LX 不可用"与"这首没有"。
      // 拿不到探针歌曲就不预热 —— 宁可慢，也不要把好音源误判成死的。
      const probe = await lxResolveProbeId('kw', '青花瓷').catch(() => null)
      if (!probe?.id) return
      const startedAt = Date.now()
      try {
        const found = await withHardTimeout(
          Promise.resolve().then(() => lxHost.resolveForProvider('kuwo', probe.id, {
            quality: '320k', name: probe.name, singer: probe.singer, budgetMs: LX_FALLBACK_BUDGET_MS,
          })),
          LX_STEP_TIMEOUT_MS,
          { label: '自定义音源' },
        )
        if (found?.audioUrl) stepSucceeded('自定义音源')
        else stepTimedOut('自定义音源')
        console.log(`[自定义音源] 启动预热完成：${found?.audioUrl ? '可用' : '未命中'}（${Date.now() - startedAt}ms）`)
      } catch (err) {
        // 只有硬超时才记"不健康"；其它错误（例如该插件明确报错）不算。
        if (err?.name === 'HardTimeoutError') stepTimedOut('自定义音源')
        console.log(`[自定义音源] 启动预热未通过（${Date.now() - startedAt}ms）：${err?.message ?? err}`)
      }
    })()

    await Promise.allSettled([backupWarmUp, lxWarmUp])
  }

  /**
   * 串行问链 —— 对齐的 `backup_source.rs` + `playback.rs` 决策树。
   *
   * 逐个 await 每个"问一次"的任务，第一个给出可用结果的立刻返回；全都说没有
   * 就把**每个的名字与失败原因**一并带回，供调用方拼出风格的文案
   * `; 备用音源: <名字>`。
   *
   * 【2026-10-16 对齐：并发竞速 → 串行快速失败】
   * 这里原来是 `firstSuccessful(tasks, budgetMs)`：并发发起 + 先到先得 +
   * 总预算封顶。没有这套东西 —— 它的错误文案是逐站拼接的，即串行。
   * 串行会不会变慢？不会，前提是**每一次问都有自己的硬超时**：死站被短超时
   * 快速切掉（backup 2.5s / 池子 3s），而不是靠一个全局预算来兜。
   *
   * 每个任务自己吞掉异常并返回 `{ ok: false, detail }`，所以串行不会因为
   * 中间某一跳抛错而中断 —— 也是"这一站失败了就换下一站"。
   *
   * 每一步都可以带自己的 `timeoutMs`：串行链要快，靠的是"每一步都有上限"，
   * 而不是"整条链共享一个总预算"。`timeoutMs` 用 `withHardTimeout` 兜底，
   * 连"组件内部自有预算失灵"（例如 LX 的 worker 没回消息）也能切断。
   *
   * @param {Array<{name: string, run: () => Promise<unknown>, timeoutMs?: number}>} steps 按优先次序
   * @returns {Promise<{winner: unknown, attempts: Array<{name: string, ok: boolean, detail: string, latency_ms: number}>}>}
   */
  async function resolveSerial(steps) {
    const attempts = []
    for (const step of steps) {
      // 冷静期内直接跳过（理由见 STEP_SKIP_* 注释）。仍然记一条 attempt，
      // 这样失败文案里照样列出这一站的名字 —— 与"逐站拼名字"的形态一致。
      if (stepSkipped(step.name)) {
        const skipped = { name: step.name, ok: false, skipped: true, detail: '连续超时，冷却中本轮跳过', latency_ms: 0 }
        attempts.push(skipped)
        if (process.env.MUSIC_DEBUG_RESOLVE) console.log(`[取源] ${step.name} 跳过 ${skipped.detail}`)
        continue
      }
      const startedAt = Date.now()
      let winner = null
      let detail = ''
      let timedOut = false
      try {
        const value = step.timeoutMs
          ? await withHardTimeout(Promise.resolve().then(step.run), step.timeoutMs, { label: step.name })
          : await step.run()
        if (value) winner = value
        else detail = '未返回播放地址'
      } catch (error) {
        if (error?.name === 'HardTimeoutError') {
          timedOut = true
          detail = `超时（${error.timeoutMs}ms）`
        } else {
          detail = String(error?.message ?? error)
        }
      }
      if (winner) stepSucceeded(step.name)
      else if (timedOut) stepTimedOut(step.name)
      attempts.push({ name: step.name, ok: !!winner, detail, latency_ms: Date.now() - startedAt })
      // 取源慢时要能一眼看出卡在哪一跳。默认关闭，`MUSIC_DEBUG_RESOLVE=1` 打开。
      if (process.env.MUSIC_DEBUG_RESOLVE) {
        const last = attempts[attempts.length - 1]
        console.log(`[取源] ${step.name} ${last.ok ? '命中' : '未命中'} ${last.latency_ms}ms ${last.detail}`)
      }
      if (winner) return { winner, attempts }
    }
    return { winner: null, attempts }
  }

  /**
   * 串行链每一跳的临时健康记忆 —— 对齐 `backup-sources.mjs` 的 failStreak 语义。
   *
   * 为什么需要：`自定义音源`（lxHost）这一跳在真实环境里**每次都吃满硬超时**
   * 却什么都解析不出来（实测 6 首歌、热态、给足 9s，0 命中，全 13–15s 超时）。
   * 它在链尾，超时多久用户就白等多久 —— 稳态那 2.5s 里有一整个 2.5s 是它。
   *
   * 判据与备用源一致：**只把「硬超时」当作不健康的强证据**（连响应都拿不到），
   * 「快速说没有」只算弱证据。门槛取 1 而不是 3 —— 因为启动预热已经先给过
   * 它一次机会（`startFallbackWarmUp` 会用真歌探一次），到用户第一次点击时
   * 我们手上已经有样本了。`STEP_SKIP_COOLDOWN_MS` 到点一定放行重试，
   * 所以不会有"永久拉黑"（那个 bug 我在 backup-sources.mjs 里修过一个）。
   *
   * 注意：这一跳**不是**的组成部分（`server_line.rs` 只探两条线路），
   * 所以这里只是"别让它拖慢语义的主链路"，判据复用同一套，
   * 不发明新协议。
   */
  const STEP_SKIP_AFTER = 1
  const STEP_SKIP_COOLDOWN_MS = 120_000
  const stepHealth = new Map() // name -> { timeouts, lastTimeoutAt }

  function stepSkipped(name) {
    const h = stepHealth.get(name)
    if (!h || h.timeouts < STEP_SKIP_AFTER) return false
    return Date.now() - h.lastTimeoutAt < STEP_SKIP_COOLDOWN_MS
  }
  function stepSucceeded(name) { stepHealth.delete(name) }
  function stepTimedOut(name) {
    const h = stepHealth.get(name) ?? { timeouts: 0, lastTimeoutAt: 0 }
    h.timeouts += 1
    h.lastTimeoutAt = Date.now()
    stepHealth.set(name, h)
  }

  /** 【2026-10-17 取源失败结果短期缓存 —— 修「同一首歌反复重走失败链」】
   *
   *  取源日志实测（25 首唯一歌曲 / 94 次请求）：
   *
   *      《酒醉的蝴蝶》     10 次请求，跨度 115s，累计白等 26.5s
   *      《酒醉的蝴蝶 Remix》 7 次请求，跨度  63s，累计白等 24.1s
   *      《天涯》            7 次请求，跨度  35s，累计白等 22.7s
   *
   *      **重复请求浪费 102.8s / 总耗时 134.7s = 76%**
   *
   *  这些歌为什么反复失败：它们是**付费歌**——平台 prepare 返回
   *  `fee:1, trial:{start:0,end:60}`（只给 60 秒试听），于是按决策树
   *  要去兜底链找全曲；而共享池对它们回「音质/资源不可用」，备用源/LX 也
   *  给不出地址。每次重试都要把「池子 ~2.4s + 备用 1.2s + LX 0.8s」重走一遍。
   *
   *  前端 `ONLINE_RETRY_DELAYS=[600,1400,2800]` 只重试 3 次，10 次是**用户
   *  反复点播放 / 切走又切回**造成的 —— 每次点击都是一次全新的 2.4s 等待。
   *
   *  所以在**服务端**按「provider+songId+quality」记住失败结论，短期内重复
   *  请求直接返回同一个失败，不再重走整条链。TTL 取 90s：足够覆盖用户
   *  「这首歌放不出来」的反复尝试窗口，又不至于让刚上架的歌一直被判死。
   *
   *  只缓存**确定性失败**（全链都没给出地址），命中成功的路径完全不受影响
   *  —— 成功本来就会走缓存地址（scheduleUrlCacheFlush），不需要这里再插一手。
   */
  const RESOLVE_FAILURE_TTL_MS = 90_000
  const resolveFailures = new Map() // `${provider}:${songId}:${quality}` -> { at, attempts, error }
  function resolveFailureOf(key) {
    const hit = resolveFailures.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > RESOLVE_FAILURE_TTL_MS) { resolveFailures.delete(key); return null }
    return hit
  }
  function rememberResolveFailure(key, attempts, error) {
    // 上限防止长时间运行累积（只需覆盖用户手头的重试窗口）。
    if (resolveFailures.size > 500) {
      const oldest = [...resolveFailures.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) resolveFailures.delete(oldest[0])
    }
    resolveFailures.set(key, { at: Date.now(), attempts, error })
  }
  function forgetResolveFailure(key) { resolveFailures.delete(key) }
  /** 供 /api/pool/lines 之类的诊断接口查看（不新增协议，只是把状态暴露出来）。 */
  function stepHealthState() {
    return [...stepHealth.entries()].map(([name, h]) => ({
      name, timeouts: h.timeouts, lastTimeoutAt: h.lastTimeoutAt, skipped: stepSkipped(name),
    }))
  }

  /**
   * 对齐的失败文案：`; 备用音源: <名字>`。
   *
   * 真实 exe 里这三个片段是**连续**排列的：
   *     `播放地址解析失败: ` / `获取播放地址超时` / `; 备用音源: `
   * 说明它是"主源失败 → 逐站追加备用源名 → 拼成一条错误消息"。
   * 这里对齐这个形态：主错误 + 每个问过的备用源名字。
   */
  function backupSourceSuffix(attempts) {
    const tried = attempts.filter(a => !a.ok).map(a => a.name)
    return tried.length ? `; 备用音源: ${tried.join(' → ')}` : ''
  }

  /** 把一次取源的结果写成一条日志（成功/失败都写）。
   *
   *  用户要求：「看我放的每一首歌，它都经历了哪些音源」。
   *  所以这里记录的是**整条链**：每一跳的名字、耗时、是否跳过、失败原因，
   *  以及最后到底是哪一跳给出的地址。落盘后可通过 /api/source-log 回看。
   *  日志永远不该影响播放：任何异常都在 SourceLog 内部吞掉。 */
  function logResolve({ provider, songId, title, artist, quality, attempts, winner, startedAt, error }) {
    try {
      const kind = winner?.kind ?? ''
      sourceLog.record({
        provider, songId, title, artist, quality,
        // 命中的跳名（对应 resolveSerial 里的 step.name），空 = 全链未命中
        source: kind === 'pool' ? '共享池' : kind === 'backup' ? (winner?.found?.backupSource || '备用音源') : kind === 'lx' ? '备用音源' : '',
        ok: Boolean(winner),
        totalMs: Date.now() - (startedAt || Date.now()),
        attempts: attempts.map(a => ({
          name: a.name, ok: a.ok, skipped: a.skipped,
          latencyMs: a.latency_ms, detail: a.detail,
          sourceName: a.sourceName ?? a.backupSource,
        })),
        error,
      })
    } catch { /* 日志失败不影响取源 */ }
  }

  async function applyLxFallback(result, provider, songId, meta = null, quality = 'master') {
    // 对齐的播放决策树（backup_source.rs）：只要这首歌带付费/试听证据
    // （trial 非空，或 fee 非 0），或平台干脆没给地址，就去备用音源拿全曲。
    // 旧实现只看 trial —— 而酷我/QQ/JOOX 的 prepare 不报 trial，只报 fee，
    // 于是备用音源从不触发，试听片段被当全曲播放（用户实测：只能听十几秒）。
    const paidEvidence = !!result?.trial || Number(result?.fee ?? 0) !== 0
    if (result?.audioUrl && !paidEvidence) return result
    // backup 源按「歌名+歌手」匹配，所以必须把曲目元数据一起带上：
    // platform 路由的 prepare 只回音源，没有 title/artist，第三方解析就匹配不到歌。
    if (meta && (meta.title || meta.artist) && !result?.title && !result?.artist) result = { ...result, ...meta }
    const title = meta?.title || result?.title || ''
    const artist = meta?.artist || result?.artist || ''
    // 取源计时起点：用于日志里的 totalMs（整条串行链耗时）。
    const resolveStartedAt = Date.now()

    // 【失败结论复用】这首歌刚在 90s 内失败过，就别再让用户等第二遍。
    // 详见 RESOLVE_FAILURE_TTL_MS 的注释：实测重复请求浪费了 76% 的总耗时。
    const failureKey = `${provider}:${songId}:${quality}`
    const knownFailure = resolveFailureOf(failureKey)
    if (knownFailure) {
      logResolve({
        provider, songId, title, artist, quality,
        attempts: knownFailure.attempts.map((a) => ({
          name: a.name, ok: false, skipped: true, latencyMs: 0,
          detail: `复用 ${Math.round((Date.now() - knownFailure.at) / 1000)}s 前的失败结论`,
        })),
        winner: null, startedAt: resolveStartedAt,
        error: knownFailure.error,
      })
      const carrier = result ?? {}
      Object.defineProperty(carrier, 'fallbackAttempts', {
        value: knownFailure.attempts, enumerable: false, configurable: true,
      })
      return carrier
    }

    // 的播放决策树（对齐 backup_source.rs + platform\*.rs）：
    //   ① 平台 prepare（已在调用方完成）
    //   ② 备用源三站（yy.zddyr.top → api.ygking.top → music.bxa241d4.shop）
    //   ③ 自定义音源（我们的扩展层，没有但保留）
    //   ④ 池子（的服务器代理：酷我播放**必须**经服务端）
    //
    // 【2026-10-16 对齐：串行，不竞速、不设总预算】
    // 顺序对齐，逐个 await；谁先给出可用地址就用谁，全都没有才报错。
    // 的顺序证据：backup_source.rs 的逐站错误文案 + playback.rs 的
    // `; 备用音源: <名>`，是链式拼接 —— 串行。
    //
    // **池子排第一**（保持既有契约，理由是可验证的两条）：
    //   1. 池子是唯一能拿到母带/加密档（mflac/master + ekey）的来源。
    //      实测 kuwo/1860327：池子给 `mflac` + actualQuality=master（638ms），
    //      而备用源0 给的是低档明文档（410ms）。若备用源抢先，音质徽章与
    //      ekey 解密链路都会退化 —— 那是 t8/t10/t15 的前提。
    //   2. 命中必须在 1s 内（本任务的定量目标），只有池子先手才能做到。
    // 注意这**不是**旧的 `POOL_PRIORITY_MS` 独占窗口（那个已经删掉）：旧的
    // 是"让池子与第三方**并发**赛跑、并给它 4s 优先窗口"；现在是纯串行，
    // 池子问完（成功即结束，失败立刻继续）才轮到下一站，没有任何窗口。
    //
    // name/singer 必须传给 LX：部分音源（如「闻音」）的 getMusicUrl 是拿
    // 「歌名+歌手」在内部重新搜索的，只给平台 id 它匹配不到歌。
    const { winner, attempts } = await resolveSerial([
      {
        // 共享池：用池子里别人的票调官方源（酷我/酷狗/QQ 全通，网易无直链）
        name: '共享池',
        // 池子单次请求自带 3000ms 硬超时（shared-pool.mjs），这里再套一层
        // 兜住"组件内部预算失灵"的情况；留一点余量避免两层同时掐断。
        timeoutMs: POOL_STEP_TIMEOUT_MS,
        // 【2026-10-16 不再等探测：探测结论只是"抄近路"，不是"能不能用"】
        //
        // 这里原来写成 `serviceProbed.then(() => …)` —— **取源必须等线路探测跑完**。
        // 起因是当时 `rawRequest` 只会打 `activeBaseUrl()` 一条线路，探测没跑完时
        // 它还是配置首选（本机首选线路）→ 首次请求必然
        // 「未命中」，白等一整条链（实测 7.6–8.6s）。
        //
        // 但现在 `rawRequest` 自己已经对齐了的「优先线路 → 备用线路」**换线容错**：
        // 打不通就自动换另一条。所以**首个请求即使探测一点没跑，也能自己找到活线路**，
        // 不需要再等探测。
        //
        // 去掉这一跳的直接收益：冷启动首请求不必再付探测的网络时间
        // （实测 1524–1569ms → 300–520ms）。探测仍在启动时并行发起，
        // 跑完后 `activeBaseUrl` 被选优，后续请求走最短路径。
        //
        // 【2026-10-18 加重试：共享池偶发失败导致「串歌」】
        //
        // 用户实测 09:31:15 点《可能》原唱，共享池跑了 3033ms 后
        // 「未返回播放地址」——**刚好卡在 3000ms 超时边缘**。同一首歌
        // 09:32:10 再点只用 447ms 就成功（服务端连续 5 次实测 5/5 成功）。
        //
        // 单次失败本身不可怕，可怕的是失败后的行为：整条链失败 → 前端报错
        // → 用户再点，很容易点到列表里相邻的「(DJ翊轩版)」——听起来就是
        // 「串歌了」。所以这里对同一个 songId 重试一次，把偶发抖动吃掉。
        //
        // 只重试一次、只在**第一次确实没拿到地址**时重试（缓存命中直接返回，
        // 不会重复打网络）。最坏多花 3.5s，但能把「偶发失败」变成「偶发慢」。
        run: () => {
          if (!poolReady) return Promise.resolve(null)
          const ask = () => poolResolve({
            source: provider, songId: poolSongId(provider, songId), quality, name: title, artist,
          })
          return ask()
            .then(found => (found?.audioUrl ? found : ask()))
            .then(found => (found?.audioUrl ? { kind: 'pool', found } : null))
            .catch(() => ask().then(found => (found?.audioUrl ? { kind: 'pool', found } : null)))
        },
      },
      {
        // 【2026-10-23 合并】原来是两站：『备用音源』= 三个第三方接口，实测全死
        // （api.ygking.top DNS 失效 / music.bxa241d4.shop 443 不通 / yy.zddyr.top 2.5s 超时，
        // 25 次真实请求 0 命中）；『自定义音源』= 本地音源插件，实测 122–294ms 就取到
        // VIP 整首 25.45MB FLAC。现在合并成**一站『备用音源』**：两组来源并发，
        // 谁先出地址用谁，对外只有一个名字，内部仍按 kind 记真实来源。
        name: '备用音源',
        timeoutMs: BACKUP_TAIL_TIMEOUT_MS,
        run: () => firstHit([
          // 第三方三站两死一挂（2026-10-23 实测），给 1200ms 内层封顶，不拖死整站预算。
          backupSources.enabled
            ? withHardTimeout(backupSources.resolve(provider, songId, { quality: BACKUP_QUALITY_OF_TIER[quality] ?? quality, title, artist }), BACKUP_LEGACY_TIMEOUT_MS)
              .then(found => (found?.audioUrl ? { kind: 'backup', found } : null))
              .catch(() => null)
            : Promise.resolve(null),
          // ⚠️ 不能无条件 await lxPluginsLoaded：插件目录加载实测 ~15.9s，硬等它会让
          // 前 16 秒的每次播放都把这一站预算耗光。有界等待 700ms，没就绪就快速放弃。
          Promise.race([lxPluginsLoaded, new Promise(r => setTimeout(r, 700))])
            .then(() => (lxHost.enabled
              ? lxHost.resolveForProvider(provider, songId, { quality: lxFallbackTier(quality), name: title, singer: artist, budgetMs: LX_FALLBACK_BUDGET_MS })
                .then(found => (found?.audioUrl ? { kind: 'lx', found } : null))
              : null))
            .catch(() => null),
        ]),
      },
    ])
    if (winner?.kind === 'pool') {
      const { found } = winner
      scheduleUrlCacheFlush()
      forgetResolveFailure(failureKey)
      logResolve({ provider, songId, title, artist, quality, attempts, winner, startedAt: resolveStartedAt })
      // 母带/环绕等加密格式（mflac/mgg）带 ekey，播放器据此解密；actualQuality
      // 是池子报告的真实档位，UI 音质徽章直接用它，不靠文件名猜。
      // 注意：platform prepare 的 result 没有 onlineSource（只回音源），所以
      // 档位/密钥必须放在**顶层**，由前端回填到曲目上。
      //
      // 【2026-10-18】再过一道 honestFormat：池子偶尔把 128kbps MP3 标成
      // `.flac`（酷狗《可能》实测 0.92MB vs 应有的 40MB），对齐会让界面
      // 标「无损」而下载到 MP3。用 HEAD 实测 content-length 折算码率，
      // 低于无损底线就如实降回 mp3（详见 honestFormat 注释）。
      const realDuration = Number(result?.duration) || Number(meta?.duration) || 0
      const honest = await honestFormat(found.audioUrl, found.format || result?.format, realDuration)
      return {
        ...result,
        audioUrl: found.audioUrl,
        trial: undefined,
        fee: 0,
        format: honest.format,
        actualQuality: honest.quality ?? found.actualQuality,
        ekey: found.ekey || null,
        poolSource: found.format,
        ...(honest.downgraded ? { degradedFrom: found.actualQuality ?? quality } : {}),
      }
    }
    if (winner?.kind === 'backup' || winner?.kind === 'lx') {
      const { found } = winner
      // 合并后两类来源对外统一叫「备用音源」；backupSource 记真实命中者（第三方站名或插件名）。
      scheduleUrlCacheFlush()
      forgetResolveFailure(failureKey)
      logResolve({ provider, songId, title, artist, quality, attempts, winner, startedAt: resolveStartedAt })
      // 本地源命中的 quality 是它实际那一档（自回落后），翻译成 7 档枚举交给音质徽章。
      const actualQuality = winner.kind === 'lx'
        ? TIER_OF_LX_QUALITY[String(found.quality ?? '').toLowerCase()]
        : undefined
      return {
        ...result,
        audioUrl: found.audioUrl,
        trial: undefined,
        fee: 0,
        backupSource: found.backupSource ?? found.plugin ?? found.source,
        ...(actualQuality ? { actualQuality } : {}),
      }
    }

    // 全都没给出地址：把"问过哪些备用源"按的文案形态附在错误上，
    // 调用方（platform prepare 路由）据此拼出 `播放地址解析失败: ; 备用音源: …`。
    // 用非枚举属性挂载，避免污染 HTTP 响应 JSON 的既有字段。
    // 注意 `result` 可能是 null（平台 prepare 直接失败）—— 那种情况也要能带上
    // 尝试记录，否则错误文案会丢掉 `; 备用音源: <名>`（的形态特征）。
    // 全链失败同样要落日志：这是排查「为什么这首歌放不出来」最要紧的一条。
    const failureError = `播放地址解析失败${backupSourceSuffix(attempts)}`
    logResolve({
      provider, songId, title, artist, quality, attempts, winner: null, startedAt: resolveStartedAt,
      error: failureError,
    })
    // 记住这次失败结论：90s 内同一首歌再来，直接复用，不再重走整条链。
    // 实测这是最大的一笔浪费（重复请求占总耗时 76%）。
    rememberResolveFailure(failureKey, attempts, failureError)
    const carrier = result ?? {}
    Object.defineProperty(carrier, 'fallbackAttempts', { value: attempts, enumerable: false, configurable: true })
    return carrier
  }

  const server = http.createServer(async (request, response) => {    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`)
      if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
      const url = new URL(request.url, host)
      if (request.headers.origin && request.headers.origin !== host.origin) return json(response, 403, { error: '不接受跨站点访问本地曲库' })
      const route = decodeURIComponent(url.pathname)
      if (route.includes('\0') || route.includes('\\')) return json(response, 400, { error: '无效路径' })
      const get = request.method === 'GET' || request.method === 'HEAD'
      // 同源音源票据流（音浪）：/api/online/audio/<token>，token 只由 prepare 签发。
      const relayedAudio = /^\/api\/online\/audio\/([a-f0-9]{48})$/.exec(route)
      if (relayedAudio && (request.method === 'GET' || request.method === 'HEAD')) {
        try { return await audioRelay.serve(relayedAudio[1], request, response) }
        catch (error) {
      // 上游说这条直链不能用了（403/404/410）：立刻把该平台的直链缓存作废，
      // 下一次播放会重新取源，而不是继续发同一条死链（用户要求：坏条目不许留在缓存里）。
      const code = error?.status ?? 502
      if ([403, 404, 410, 502].includes(code)) {
        const provider = audioRelay.providerOf?.(relayedAudio[1]) ?? ''
        if (provider) invalidatePoolUrlCache(provider)
      }
      return json(response, code, { error: error?.message || '音频转发失败' })
    }
      }
      if (route === '/api/health' && get) return json(response, 200, { service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid, lxReady })
      const platformLogin = /^\/api\/online\/(qq|bodian|kugou)\/auth\/(status|start|poll|cancel|logout)$/.exec(route)
      if (platformLogin) {
        const auth = platformAuth[platformLogin[1]], action = platformLogin[2]
        if (!auth) return json(response, 503, { error: '当前平台未配置。' })
        if (action === 'status' && request.method === 'GET') return json(response, 200, await auth.status())
        if (action !== 'status' && request.method === 'POST') {
          const body = await bodyJson(request)
          return json(response, 200, await auth[action](action === 'start' ? body.method : body.id))
        }
        return json(response, 405, { error: '请求方法不支持' })
      }
      // ─── LX 音源插件：状态 / 搜索 / 取曲 / 配置 ──────────────────────────
      if (route === '/api/lx/status' && get) {
        const plugins = await lxHost.listPlugins()
        return json(response, 200, {
          enabled: lxHost.enabled,
          pluginCount: lxHost.pluginCount,
          plugins,
          counts: {
            total: plugins.length,
            loaded: plugins.filter((plugin) => plugin.enabled).length,
          },
          sources: lxHost.sources,
          report: lxHost.report,
        })
      }
      if (route === '/api/lx/sources' && get) return json(response, 200, { sources: lxHost.sources })
      // 音源自检明细：哪些源是活的、各自能给的最高音质（设置界面/诊断用）。
      if (route === '/api/lx/health' && get) return json(response, 200, await lxHost.health())
      // 自检进度：前端加载页据此画进度条（首次启动会等它跑完才放行）。
      if (route === '/api/lx/progress' && get) return json(response, 200, await lxHost.progress())
      if (route === '/api/lx/search' && get) {
        const q = url.searchParams.get('q') ?? ''
        const source = url.searchParams.get('source') ?? 'all'
        const offset = Number(url.searchParams.get('offset') || 0)
        const result = await lxHost.search(q, { source, page: Math.floor(offset / 20) + 1, limit: 20 })
        return json(response, 200, {
          provider: 'lx', query: q, offset, limit: 20,
          total: result?.total ?? 0, hasMore: result?.hasMore ?? false,
          tracks: result?.tracks ?? [], failures: result?.failures ?? [],
        })
      }
      if (route === '/api/lx/resolve' && request.method === 'POST') {
        const body = await bodyJson(request)
        const trackId = String(body.trackId ?? body.id ?? '')
        const quality = String(body.quality ?? '320k')
        const options = { quality, name: String(body.name ?? ''), singer: String(body.singer ?? '') }
        const result = trackId
          ? await lxHost.resolveTrackId(trackId, options)
          : await lxHost.resolveForProvider(String(body.provider ?? ''), String(body.songId ?? ''), options)
        if (!result?.audioUrl) return json(response, 404, { error: result?.error ?? '没有可用的备用音源能解析这首歌。' })
        return json(response, 200, result)
      }
      // ─── 自定义音源管理：添加 / 移除 / 停用 / 重新自检 ─────────────────
      //
      // 「有源即启用」：没有总开关，也没有目录输入框。用户点「添加音源」选文件，
      // 这里写进用户音源目录再加载；内置源可以被停用，但不能移除。
      if (route === '/api/lx/sources/add' && request.method === 'POST') {
        const body = await bodyJson(request)
        const files = Array.isArray(body.files) ? body.files : []
        if (!files.length) return json(response, 400, { error: '没有收到音源文件' })
        await fs.mkdir(userSourcesDir, { recursive: true })
        const added = []
        for (const file of files) {
          const name = path.basename(String(file?.name ?? '')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
          if (!/\.js$/i.test(name)) continue
          const text = String(file?.text ?? '')
          if (!text.trim()) continue
          await fs.writeFile(path.join(userSourcesDir, name), text, 'utf-8')
          added.push(name)
        }
        if (!added.length) return json(response, 400, { error: '这些文件不是 .js 音源插件' })
        try { await lxHost.loadDirectories(sourceDirs) } catch (err) { return json(response, 400, { error: `音源加载失败：${err.message}` }) }
        await lxHost.setDisabled(disabledPlugins)
        const plugins = await lxHost.listPlugins()
        return json(response, 200, { added, plugins, counts: { total: plugins.length, loaded: plugins.filter((plugin) => plugin.enabled).length } })
      }
      if (route === '/api/lx/sources/remove' && request.method === 'POST') {
        const body = await bodyJson(request)
        const id = String(body.id ?? '')
        const target = (await lxHost.listPlugins()).find((plugin) => plugin.id === id)
        if (!target) return json(response, 404, { error: '没有这个音源' })
        if (target.builtin) return json(response, 403, { error: '内置音源不能移除，只能停用' })
        await fs.rm(path.join(userSourcesDir, target.file), { force: true })
        try { await lxHost.loadDirectories(sourceDirs) } catch { /* 单个坏文件不影响其它源 */ }
        await lxHost.setDisabled(disabledPlugins.filter((item) => item !== id))
        const plugins = await lxHost.listPlugins()
        return json(response, 200, { plugins, counts: { total: plugins.length, loaded: plugins.filter((plugin) => plugin.enabled).length } })
      }
      if (route === '/api/lx/sources/toggle' && request.method === 'POST') {
        const body = await bodyJson(request)
        const id = String(body.id ?? '')
        const enabled = body.enabled !== false
        const plugins = await lxHost.listPlugins()
        if (!plugins.some((plugin) => plugin.id === id)) return json(response, 404, { error: '没有这个音源' })
        const next = new Set(disabledPlugins)
        if (enabled) next.delete(id); else next.add(id)
        lxConfig.disabled = [...next]
        await writeLxConfig(store.dataDir ?? dataDir, lxConfig)
        await lxHost.setDisabled(lxConfig.disabled)
        const after = await lxHost.listPlugins()
        return json(response, 200, { plugins: after, counts: { total: after.length, loaded: after.filter((plugin) => plugin.enabled).length } })
      }
      if (route === '/api/lx/selfcheck' && request.method === 'POST') {
        if (!lxHost.enabled) return json(response, 409, { error: '还没有加载任何音源' })
        // 和开机自检同一条链路：先按平台搜索解析出真实 id 再测。
        // 少了 resolveId 时，只认平台 id 的音源（HHYW/Hei/TuneFlow 一大批）
        // 会统一报「缺少歌曲ID」，界面再把任意失败显示成「超时」——用户实测
        // 「明明有些能用，一直显示超时」就是这条。
    try {
      await ensureCheckHost()
      await lxCheckHost.selfCheck({ concurrency: 10, budgetMs: 300000, resolveId: lxResolveProbeId })
      // 【2026-10-23】手动重测原来只跑 checkHost：既不 import 给播放宿主、也不落盘，
      // 界面点「测试连通性」后列表纹丝不动（等于按钮白按）。补齐与开机自检一致的三步。
      const snapshot = await lxCheckHost.exportHealth()
      await lxHost.importHealth(snapshot)
      snapshot.plugins = lxPluginFingerprint(lxHost.sources)
      await fs.writeFile(path.join(store.dataDir ?? dataDir, LX_HEALTH_FILE), JSON.stringify(snapshot, null, 2), 'utf-8')
    }
        catch (err) { return json(response, 500, { error: `自检失败：${err.message}` }) }
        const plugins = await lxHost.listPlugins()
        return json(response, 200, { plugins, counts: { total: plugins.length, loaded: plugins.filter((plugin) => plugin.enabled).length } })
      }

      // 备用音源 API（backup_source.rs 等价物）
      if (route === '/api/backup/status' && get) {
        return json(response, 200, {
          enabled: backupSources.enabled,
          sources: backupSources.status,
          // 逐站探测结果（对齐 server_line.rs 的 results 字段语义）
          results: backupSources.results,
          config: backupConfig,
        })
      }
      // 池子双线路状态（对齐 src\server_line.rs 的字段与语义）
      if (route === '/api/pool/lines' && get) {
        return json(response, 200, {
          configured: POOL_SERVER_LINES.map(l => ({ id: l.id, label: l.label, baseUrl: l.baseUrl, host: l.host })),
          ...poolLineState(),
        })
      }
      // 连通性检测：scope=all（默认）| lines | upstreams。
      // 线路用签名探测，平台上游各发一次最小取源；两边互不影响。
      if (route === '/api/pool/lines/probe' && request.method === 'POST') {
      if (!poolReady) return json(response, 200, { results: [], upstreams: [], note: '未导入密钥，没有可检测的线路' })
        const scope = url.searchParams.get('scope') || 'all'
        const wantLines = scope === 'all' || scope === 'lines'
        const wantUpstreams = scope === 'all' || scope === 'upstreams'
        const [lineState, upstream] = await Promise.all([
          wantLines ? poolProbeLines() : Promise.resolve(poolLineState()),
          wantUpstreams ? poolProbeUpstreams().catch(() => ({ upstreams: [] })) : Promise.resolve(null),
        ])
        return json(response, 200, { ...lineState, upstreams: upstream?.upstreams ?? [] })
      }

      // ── 共享池密钥：用户自己导入，客户端不内置任何凭据 ──────────────
      //
      // 【为什么不内置】客户端要调池子就必须持有 token，而持有就能被实测
      // 拿到。把凭据塞进安装包 + 混淆，挡不住愿意花几分钟的人。改成
      // 「用户导入自己的密钥」后，客户端不含任何秘密，源码可以公开。
      //
      //   GET    /api/pool/credential            状态（不含 token）
      //   POST   /api/pool/credential/import     { payload } 导入密钥文件
      //   GET    /api/pool/credential/export     导出当前密钥文件
      //   DELETE /api/pool/credential            移除
      const credDir = store.dataDir ?? dataDir

      /** 导入/移除后重新装填一次，并回报最新状态。 */
      const applyPoolCredential = () => {
        poolReady = false
        try {
          const imported = loadFromImportedKey(credDir)
          if (imported && Array.isArray(imported.servers) && imported.servers.length) {
            // 与启动时同理：光有 token 不够，线路表也得按这份密钥重建，
            // 否则 resolveSongBest 永远返回 pool_disabled（导入完不重启就不生效）。
            configureServerLines(imported.servers)
            poolReady = true
          } else {
            // 没有密钥 = 这个功能整块下线：令牌、线路表、上次探测结果全部作废。
            // （2026-10-23：原来只删磁盘文件，内存里的 token 与线路表还在，
            //   于是「移除密钥」之后照样能点亮延迟、照样能取源。）
            resetPoolRuntime()
            poolReady = false
          }
        } catch (error) {
          console.log('[shared-pool] 密钥应用失败:', error.message)
        }
        return { ...poolCredential.status(credDir), poolEnabled: poolReady, signNote: poolCredential.signNote(poolSigningHealth()) }
      }

      if (route === '/api/pool/credential' && get) {
        return json(response, 200, { ...poolCredential.status(credDir), poolEnabled: poolReady, signNote: poolCredential.signNote(poolSigningHealth()) })
      }

      if (route === '/api/pool/credential/import' && request.method === 'POST') {
        const body = await bodyJson(request)
        try {
          // data 是密钥文件的原始字节（base64）。加密信封与老明文都由
          // keyfile-envelope 自己识别，这里不再假设文件是 JSON。
          if (typeof body.data === 'string' && body.data) {
            poolCredential.importKeyFile(credDir, Buffer.from(body.data, 'base64'))
          } else if (typeof body.payload === 'string') {
            // 兼容旧前端：直接传文件原文
            poolCredential.importKeyFile(credDir, Buffer.from(body.payload, 'utf8'))
          } else if (body.payload && typeof body.payload === 'object') {
            poolCredential.write(credDir, body.payload)
          } else {
            return json(response, 400, { error: '没有收到密钥文件' })
          }
        } catch (error) {
          return json(response, 400, { error: error.message })
        }
        return json(response, 200, applyPoolCredential())
      }

      if (route === '/api/pool/credential/export' && get) {        try {
          const buffer = poolCredential.exportKeyFile(credDir)
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': buffer.length,
            'content-disposition': 'attachment; filename="Rhine-Music.rhinekey"',
          })
          return response.end(buffer)
        } catch (error) {
          return json(response, 404, { error: error.message })
        }
      }

      if (route === '/api/pool/credential' && request.method === 'DELETE') {
        poolCredential.clear(credDir)
        return json(response, 200, applyPoolCredential())
      }
      if (route === '/api/backup/resolve' && request.method === 'POST') {
        const body = await bodyJson(request)
        const result = await backupSources.resolve(
          String(body.provider ?? ''), String(body.songId ?? ''),
          { quality: String(body.quality ?? '320k'), title: String(body.title ?? ''), artist: String(body.artist ?? '') }
        )
        if (!result?.audioUrl) return json(response, 404, { error: '备用音源没有找到这首歌的播放地址。' })
        return json(response, 200, result)
      }
      if (route === '/api/backup/config' && request.method === 'POST') {
        const body = await bodyJson(request)
        backupConfig.sources = Array.isArray(body.sources) ? body.sources : backupConfig.sources ?? DEFAULT_SOURCES
        await writeBackupConfig(store.dataDir ?? dataDir, backupConfig)
        return json(response, 200, { enabled: backupSources.enabled, sources: backupSources.status })
      }

      const platformRoute = /^\/api\/online\/(qq|bodian|kugou|kuwo|joox)\/(search|playlists|cover|playlists\/([A-Za-z0-9_-]{1,64})\/tracks|songs\/([A-Za-z0-9_.-]{1,96})\/info|prepare\/([A-Za-z0-9_.-]{1,96}))$/.exec(route)
      if (platformRoute) {
        const provider = platformRoute[1], action = platformRoute[2], catalog = catalogs[provider]
        if (!catalog) return json(response, 503, { error: '当前平台未配置。' })
        if (action.startsWith('prepare/') && request.method === 'POST') {
          const prepareBody = await bodyJson(request)
          const songId = platformRoute[5]
          // 下载可指定音质档位（standard…master）；不传则播放默认取最高档。
          const wantedQuality = POOL_QUALITIES.includes(prepareBody?.quality) ? prepareBody.quality : 'master'
          // ★ 解密能力开机即知（QMC_UNRESOLVED），所以加密档**在取源前**就落到明文档，
          //   整条链只跑一次 —— 而不是取回 mflac 再重跑一遍（那会让冷启动首个请求翻倍，
          //   实测 1597–3787ms，超过 t9 合同 <1s）。`wantedQuality` 仍保留用于回报真实档位。
          // 下载链显式带 allowEncrypted：允许直接取加密容器 + ekey（下载器落盘前
          // 解密成真母带）。播放链不带该标记，仍按明文档位取源（浏览器放不了 mflac）。
          const allowEncrypted = prepareBody?.allowEncrypted === true && provider === 'kuwo'
          const fetchQuality = allowEncrypted ? wantedQuality : playableQuality(wantedQuality)
          // 平台 prepare 失败时（版权拒绝、接口异常）不能直接把错误抛给前端：
          // 的做法是照样去备用音源问一次，拿到全曲就播它。
          const info = await catalog.songInfo(songId).catch(() => null)

          // duration 用于 honestFormat 实测码率（缺它就无法判断真假无损）。
          const meta = { title: info?.track?.title ?? '', artist: info?.track?.artist ?? '', duration: Number(info?.track?.duration) || 0 }
          // 档位必须**真正透传**给平台取流：以前只把 wantedQuality 写进任务记录，
          // prepare 根本不知道用户选了哪档，于是「下载选 standard、播放按 master
          // 取源」两边不一致，档位等于没生效。对齐：**单次**请求带上档位，
          // 拿不到就由服务端自回落，客户端如实回报 actualQuality（不发明降级阶梯）。
          let result = await catalog.prepare(songId, { quality: fetchQuality }).catch(() => null)
          if (result && result.fee === undefined) {
            result.fee = Number(info?.track?.onlineSource?.fee ?? 0)
            if (meta.title) { result.title = result.title || meta.title; result.artist = result.artist || meta.artist }
          }
          const resolved = await applyLxFallback(result, provider, songId, meta, fetchQuality)
          if (!resolved?.audioUrl) {
            // 失败文案对齐（真实 exe 字符串，逐字）：
            //     `播放地址解析失败: ` … `; 备用音源: <名字>`
            // 是把"主源失败原因"和"逐个试过的备用源名"拼成一条消息。
            return json(response, 503, {
              error: `播放地址解析失败: ${PLATFORM_NAMES[provider] ?? provider}没有返回可播放的音源${backupSourceSuffix(resolved?.fallbackAttempts ?? [])}`,
            })
          }
          // 兜底：万一上游无视档位仍回了加密容器（主路径已由 playableQuality 挡掉），
          // 就地用 lossless 再问一次。**回落必须复用同一条取源链**（applyLxFallback）
          // —— 加密结果本就是池子给的（直连 kuwo 协议对这首歌取不到），
          // 只重跑池子那层才拿得到它的明文版本；单独调 catalog.prepare 会报
          // 「无效的酷我歌曲标识」。
          const playable = allowEncrypted
            ? resolved
            : await degradeEncrypted(resolved, q =>
            applyLxFallback(result, provider, songId, meta, q).catch(() => null))
          // 用户要的是加密档（如 master）但实际给的是明文档 → 如实回报，前端徽章照此显示。
          const prepared = {
            ...playable,
            ...(fetchQuality !== wantedQuality && !playable.degradedFrom
              ? { requestedQuality: wantedQuality, degradedFrom: 'mflac', degradedReason: QMC_ERRORS.EKEY_UNRESOLVED }
              : {}),
          }
          // sameOrigin：换成本机票据地址，前端才能安全接 Web Audio 分析旁支（音浪）。
          return json(response, 200, relayedSameOrigin(prepared, provider, prepareBody))
        }
        if (request.method !== 'GET') return json(response, 405, { error: '请求方法不支持' })
        if (action === 'search') return json(response, 200, await catalog.search(url.searchParams.get('q'), Number(url.searchParams.get('offset') || 0)))
        if (action === 'playlists') return json(response, 200, await catalog.playlists(Number(url.searchParams.get('offset') || 0)))
        if (platformRoute[3]) return json(response, 200, await catalog.playlistTracks(platformRoute[3], Number(url.searchParams.get('offset') || 0)))
        if (platformRoute[4]) return json(response, 200, await catalog.songInfo(platformRoute[4]))
        if (action === 'cover') {
          const source = url.searchParams.get('url') || ''
          if (source.length > 4096) return json(response, 400, { error: '封面地址过长' })
          const image = await platformCovers.get(provider, source)
          response.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=300' }); return response.end(image.bytes)
        }
      }
      if (route === '/api/online/netease/search' && request.method === 'GET') {
        return json(response, 200, await online.search(url.searchParams.get('q'), Number(url.searchParams.get('offset') || 0)))
      }
      if (route === '/api/online/netease/auth/status' && request.method === 'GET') return json(response, 200, await online.auth.status())
      if (route === '/api/online/netease/playlists' && request.method === 'GET') return json(response, 200, await online.playlists(Number(url.searchParams.get('offset') || 0)))
      const playlistTracks = /^\/api\/online\/netease\/playlists\/([1-9]\d{0,15})\/tracks$/.exec(route)
      if (playlistTracks && request.method === 'GET') return json(response, 200, await online.playlistTracks(playlistTracks[1], Number(url.searchParams.get('offset') || 0)))
      const songInfo = /^\/api\/online\/netease\/songs\/([1-9]\d{0,15})\/info$/.exec(route)
      if (songInfo && request.method === 'GET') return json(response, 200, await online.songInfo(songInfo[1]))
      const mvRoute = /^\/api\/online\/netease\/mv\/([1-9]\d{0,15})$/.exec(route)
      if (mvRoute && request.method === 'GET') {
        if (typeof online.mv !== 'function') return json(response, 404, { error: '当前音源暂不支持在线观看 MV。' })
        return json(response, 200, await online.mv(mvRoute[1]))
      }
      const authAction = /^\/api\/online\/netease\/auth\/(start|poll|cancel|logout)$/.exec(route)
      if (authAction && request.method === 'POST') {
        const body = await bodyJson(request)
        return json(response, 200, await online.auth[authAction[1]](body.id))
      }
      const onlinePrepare = /^\/api\/online\/netease\/prepare\/([1-9]\d{0,15})$/.exec(route)
      if (onlinePrepare && request.method === 'POST') {
        const prepareBody = await bodyJson(request)
        // 档位透传（与平台路由同一契约）：网易档位词见 netease-online.mjs 的
        // NETEASE_LEVELS；实测服务端会**自回落**（要 jymaster 时回 exhigh/320k），
        // 客户端如实回报 actualQuality，不做降级阶梯。
        const wantedQuality = POOL_QUALITIES.includes(prepareBody?.quality) ? prepareBody.quality : 'master'
        // 同平台路由：加密档在取源前落到明文档，链路只跑一次（见 playableQuality 注释）。
        const fetchQuality = playableQuality(wantedQuality)
        // 平台 prepare 失败（版权拒绝 403 / 需要会员 / 地区限制）时**不能直接
        // 抛给前端** —— 的决策树是照样去备用音源问一次，拿到全曲就播它。
        // 这里原来漏了 .catch()，于是 online.prepare() 抛错直接中断，
        // applyLxFallback 根本没机会执行，用户看到「网易云未提供播放地址」。
        // （同文件 platform 路由那条已经正确写成 .catch(() => null)。）
        const result = await online.prepare(onlinePrepare[1], { quality: fetchQuality }).catch(() => null)
        // 同平台路由：补上 fee 证据，付费曲才会走备用音源拿全曲。
        if (result && result.fee === undefined) {
          result.fee = await online.songInfo(onlinePrepare[1])
            .then(info => Number(info?.track?.onlineSource?.fee ?? 0))
            .catch(() => 0)
        }
        // 备用音源按「歌名+歌手」匹配，必须把曲目元数据一起带上，否则匹配不到歌。
        const info = await online.songInfo(onlinePrepare[1]).catch(() => null)
        const meta = { title: info?.track?.title ?? '', artist: info?.track?.artist ?? '' }
        const rescued = await applyLxFallback(result, 'netease', onlinePrepare[1], meta, fetchQuality)
        if (!rescued?.audioUrl) {
          return json(response, 503, {
            error: `播放地址解析失败: ${PLATFORM_NAMES.netease ?? '网易云'}没有返回可播放的音源${backupSourceSuffix(rescued?.fallbackAttempts ?? [])}`,
          })
        }
        // 同平台路由：兜底降级 + 如实回报真实档位。
        const playable = await degradeEncrypted(rescued, q => online.prepare(onlinePrepare[1], { quality: q }).catch(() => null))
        const prepared = {
          ...playable,
          ...(fetchQuality !== wantedQuality && !playable.degradedFrom
            ? { requestedQuality: wantedQuality, degradedFrom: 'mflac', degradedReason: QMC_ERRORS.EKEY_UNRESOLVED }
            : {}),
        }
        return json(response, 200, relayedSameOrigin(prepared, 'netease', prepareBody))
      }
      // 歌词统一入口：本源优先，缺歌词时跨源按 歌名+歌手+时长 匹配（scripts/lyrics.mjs）
      if (route === '/api/lyrics' && get) {
        const title = url.searchParams.get('title') || ''
        if (!title) return json(response, 400, { error: '缺少歌曲名' })
        const lyrics = await resolveLyrics({
          title,
          artist: url.searchParams.get('artist') || '',
          duration: Number(url.searchParams.get('duration') || 0),
          provider: url.searchParams.get('provider') || undefined,
          id: url.searchParams.get('id') || undefined,
        }, { catalogs: { netease: online, ...catalogs } })
        return json(response, 200, lyrics)
      }
      // ── 音频缓存管理：设置里的「缓存上限 / 缓存位置 / 清理缓存」──
      //
      // 这三项原先只是设置面板里的空壳：前端把数字存进 localStorage，
      // 后端从来不看，上限写死 4GB、目录写死 music-data/、清理按钮没有处理器。
      // 现在改成前后端同一条契约：
      //   GET  /api/audio/cache            → { bytes, files, limitBytes, cacheDir }
      //   POST /api/audio/cache/configure  → { limitMb?, location? } 应用到 decoder
      //   POST /api/audio/cache/clear      → 真删文件，返回释放量与剩余量
      if (route === '/api/audio/cache' && get) {
        await decoder.init()
        return json(response, 200, await decoder.usage())
      }
      if (route === '/api/audio/cache/configure' && request.method === 'POST') {
        const body = await bodyJson(request)
        const applied = decoder.configure({ limitMb: Number(body?.limitMb), location: body?.location })
        await decoder.init()
        return json(response, 200, { ...applied, ...(await decoder.usage()) })
      }
      if (route === '/api/audio/cache/clear' && request.method === 'POST') {
        // 顺序很重要：先 clear 拿「释放了多少」，再 usage 拿「现在还剩多少」。
        // 两个对象都有 files/bytes，直接 {...a, ...b} 会让 b 覆盖 a —— 清理完
        // usage() 自然是 0，于是「释放量」被抹成 0，界面上就永远显示
        // 「删除 0 个文件」。所以把释放量放在独立的 freed 字段里，不跟剩余量抢名字。
        const freed = await decoder.clear()
        const after = await decoder.usage()
        return json(response, 200, {
          freed: { files: freed.files, bytes: freed.bytes },
          files: after.files, bytes: after.bytes, limitBytes: after.limitBytes, cacheDir: after.cacheDir,
        })
      }
      if (route === '/api/audio/capabilities' && get) {
        await decoder.init()
        let devices = [], nativeError = null
        if (decoder.ffmpeg && process.platform === 'darwin') {
          try { devices = await output.devices() } catch (error) { nativeError = error.message }
        }
        return json(response, 200, { decoderAvailable: !!decoder.ffmpeg, decoder: decoder.version ?? null, decoderError: decoder.error ?? null, nativeAvailable: !!decoder.ffmpeg && process.platform === 'darwin' && !nativeError, nativeError, devices: [{ id: 'default', name: '系统默认输出' }, ...devices], mode: 'shared', formats: ['APE', 'WAV', 'FLAC', 'ALAC', 'AIFF', 'MP3', 'AAC', 'OGG', 'OPUS', 'WV', 'DSF', 'DFF'], dsdPlayback: 'pcm' })
      }
      // ── 加密音频（QMC）解密流：监听行为对齐「酷我母带(mflac)也要能整曲播完」──
      // 前端静默换源后拿到 mflac/mgg 时，改播本路由；本路由负责
      //   [下载密文] → [qmc-decrypt 解密] → [落盘缓存] → 走 serveFile 的 206/Range
      // 复用 parseRange/serveFile，所以 Range/断点/拖动进度条与本地文件完全一致。
      const decodedEncrypted = /^\/api\/decoded-audio\/([a-zA-Z0-9-]+)$/.exec(route)
      if (decodedEncrypted && get && url.searchParams.get('enc') === '1') {
        const key = decodedEncrypted[1]
        const entry = qmcPending.get(key)
        if (!entry) return json(response, 404, { error: '解密任务不存在或已过期' })
        let cached
        try { cached = await qmcDecryptToCache(entry, response) } catch (error) {
          if (response.writableEnded) return
          // 解密不可用时给前端明确语义 + 回落档位（明文无损），绝不发垃圾字节
          return json(response, 503, {
            error: error?.message ?? '音频解密失败',
            code: error?.code ?? 'RESULT_CHECK',
            fallbackQuality: error?.fallbackQuality ?? 'lossless',
          })
        }
        if (!cached) return
        return await serveFile(request, response, { ...cached, allowedRoot: cached.allowedRoot }, { cache: 'private, max-age=3600' })
      }

      const prepare = /^\/api\/audio\/prepare\/([a-zA-Z0-9-]+)$/.exec(route)
      const decodedAudio = /^\/api\/decoded-audio\/([a-zA-Z0-9-]+)$/.exec(route)
      if ((prepare && request.method === 'POST') || (decodedAudio && get)) {
        if (prepare) await bodyJson(request)
        const id = (prepare ?? decodedAudio)[1]
        const controller = new AbortController()
        const cancel = () => { if (!response.writableEnded) controller.abort() }
        response.once('close', cancel)
        try {
          const decoded = await decoder.prepare(store.trackFile(id), { signal: controller.signal, effects: parseEffectsQuery(url.searchParams) })
          if (prepare) {
            const { path: _path, allowedRoot: _root, ...metadata } = decoded
            return json(response, 200, { ...metadata, audioUrl: `/api/decoded-audio/${id}` })
          }
          return await serveFile(request, response, decoded, { cache: 'private, no-cache' })
        } finally { response.removeListener('close', cancel) }
      }
      // 原生 DSP 音效（service 语义）：效果在服务端 FFmpeg 解码期烘焙
      // （scripts/pcm-effects.mjs），浏览器只直放处理后的文件——不依赖 WebAudio。
      const processed = /^\/api\/audio\/processed\/([a-zA-Z0-9-]+)$/.exec(route)
      // qishui（汽水音乐）在 catalogs 里已注册，音效应路由必须覆盖它，
      // 否则开音效时汽水的歌直接 503。
      const processedOnline = /^\/api\/audio\/processed-online\/(netease|qq|bodian|kugou|kuwo|joox)\/([A-Za-z0-9_.-]{1,96})$/.exec(route)
      if ((processed || processedOnline) && get) {
        const controller = new AbortController()
        const cancel = () => { if (!response.writableEnded) controller.abort() }
        response.once('close', cancel)
        try {
          const effects = parseEffectsQuery(url.searchParams)
          let decoded
          if (processed) {
            decoded = await decoder.prepare(store.trackFile(processed[1]), { signal: controller.signal, effects })
          } else {
            const provider = processedOnline[1], id = processedOnline[2]
            const source = provider === 'netease' ? online : catalogs[provider]
            if (!source?.prepare) throw Object.assign(new Error('当前平台未配置。'), { status: 503 })
            // 音效路由是 GET，档位从查询串取（前端把当前档位一起带上）。
            //
            // 【2026-10-18 修「开了音效就放不出声」】
            //
            // 原来缺省档位是 **master**（最高档）。酷我对 master 回的是
            // **mflac 加密容器**，FFmpeg 读不了，于是整条音效路由 422：
            //
            //     音频处理失败：…AIM0001RsvMC0VovJA….mflac?bitrate$20900&format$mflac
            //     → Invalid data found when processing input
            //
            // 用户看到的现象是「应用里放不了」：应用开着 EQ（`eqEnabled:true`），
            // 所有播放都走这条路由；浏览器那份没开音效，直接放明文 flac，所以正常。
            // 同一个后端、同一份前端，差异全在这个默认档位上。
            //
            // 修法：默认档位改成 **lossless**。音效路由必须交给 FFmpeg 解码，
            // 而母带/环绕几档是加密容器（QMC 密钥未解出，见 docs/qmc-spec.md），
            // 天然解不了；无损是明文 flac，真无损且能处理。
            //
            // 用户显式带 quality 就尊重，但**仍挡掉加密档** —— 传上来只会 422，
            // 不如当场降到能解的档位。
            const requestedQuality = url.searchParams.get('quality')
            const wantedQuality = POOL_QUALITIES.includes(requestedQuality)
              ? (ENCRYPTED_TIERS.has(requestedQuality) ? 'lossless' : requestedQuality)
              : 'lossless'
            // 必须走 applyLxFallback：平台 prepare 只给试听/拒绝时，
            // 由它去备用音源（backup_source.rs 等价物）要全曲。
            // 少了这一步，开音效时「只能听十几秒」的歌依然放不出全曲。
            let prepared = await source.prepare(id, { quality: wantedQuality }).catch(() => null)
            prepared = await applyLxFallback(prepared, provider, id, null, wantedQuality).catch(() => prepared)
            if (!prepared?.audioUrl) throw Object.assign(new Error('未取到可播放地址'), { status: 422 })
            decoded = await decoder.prepareUrl(prepared.audioUrl, { signal: controller.signal, effects, identity: `${provider}/${id}` })
          }
          return await serveFile(request, response, decoded, { cache: 'private, no-cache' })
        } finally { response.removeListener('close', cancel) }
      }
      // ── 音浪频谱图：整轨一张 PNG（服务端 FFmpeg showspectrumpic，按身份缓存）──
      // 前端按播放位置取列驱动音浪。真数据来自音频本身，与 WebView2 的
      // Web Audio / captureStream 通路完全无关，任何播放路径都能对上。
      const spectrumLocal = /^\/api\/audio\/spectrum\/([a-zA-Z0-9-]+)$/.exec(route);
      const spectrumOnline = /^\/api\/audio\/spectrum-online\/(netease|qq|bodian|kugou|kuwo|joox|qishui)\/([A-Za-z0-9_.-]{1,96})$/.exec(route);
      if ((spectrumLocal || spectrumOnline) && get) {
        const identity = spectrumLocal
          ? 'local-' + spectrumLocal[1]
          : 'online-' + spectrumOnline[1] + '-' + spectrumOnline[2];
        const png = path.join(decoder.cacheDir, 'spectrum-' + crypto.createHash('sha1').update(identity).digest('hex') + '.png');
        try {
          if (!fsSync.existsSync(png)) {
            let input;
            const srcParam = url.searchParams.get('src');
            if (srcParam && /^https?:\/\//i.test(srcParam)) {
              // 前端把播放器手里解析成功的直链递过来：不重新走取源链
              //（共享池/备用源失败缓存期间重新解析必然失败，波形就永远没数据）。
              input = srcParam;
            } else if (spectrumLocal) {
              input = store.trackFile(spectrumLocal[1]);
            } else {
              const provider = spectrumOnline[1], id = spectrumOnline[2];
              const source = provider === 'netease' ? online : catalogs[provider];
              if (!source?.prepare) throw Object.assign(new Error('当前平台未配置。'), { status: 503 });
              const requestedQuality = url.searchParams.get('quality');
              const wantedQuality = POOL_QUALITIES.includes(requestedQuality)
                ? (ENCRYPTED_TIERS.has(requestedQuality) ? 'lossless' : requestedQuality)
                : 'lossless';
              let prepared = await source.prepare(id, { quality: wantedQuality }).catch(() => null);
              prepared = await applyLxFallback(prepared, provider, id, null, wantedQuality).catch(() => prepared);
              if (!prepared?.audioUrl) throw Object.assign(new Error('未取到可播放地址'), { status: 422 });
              input = prepared.audioUrl;
            }
            await decoder.init();
            if (!decoder.ffmpeg) throw Object.assign(new Error('未找到 FFmpeg，无法生成频谱图'), { status: 503 });
            await renderSpectrumPng(decoder.ffmpeg, input, png);
          }
          return await serveFile(request, response, { path: png, allowedRoot: decoder.cacheDir, mime: 'image/png' },
            { cache: 'private, max-age=86400' });
        } catch (error) {
          return json(response, 500, { error: '频谱图生成失败：' + error.message });
        }
      }
      if (route === '/api/output/state' && get) return json(response, 200, await output.command({ action: 'state' }))
      if (route === '/api/output/command' && request.method === 'POST') return json(response, 200, await output.command(await bodyJson(request)))
      if (route === '/api/downloads' && get) { await downloads.ready; return json(response, 200, downloads.snapshot()) }
      if (route === '/api/downloads' && request.method === 'POST') return json(response, 200, await downloads.add(await bodyJson(request)))
      if (route === '/api/downloads/settings' && request.method === 'POST') return json(response, 200, await downloads.configure(await bodyJson(request)))
      const downloadAction = /^\/api\/downloads\/([A-Za-z0-9-]{1,64})\/(retry|remove)$/.exec(route)
      if (downloadAction && request.method === 'POST') return json(response, 200, await downloads[downloadAction[2]](downloadAction[1]))
      // ---- 本地歌单（自建歌单）------------------------------------------
      // 收藏（我喜欢的音乐）用固定 id 'favorites' 走同一套路由，前端一个视图两种歌单。
      // ── 取源日志：每首歌经过哪些音源、每一跳耗时/失败原因 ────────────────
      // 排查「某些歌播放很慢 / 放不出来」时先看这里，不用再靠猜。
      if (route === '/api/source-log' && get) {
        return json(response, 200, {
          entries: sourceLog.recent({
            limit: Number(url.searchParams.get('limit')) || 200,
            provider: url.searchParams.get('provider') || '',
            query: url.searchParams.get('q') || '',
            onlyFailed: url.searchParams.get('failed') === '1',
          }),
          stats: sourceLog.stats(),
        })
      }
      if (route === '/api/source-log' && request.method === 'DELETE') {
        await sourceLog.clear()
        return json(response, 200, { cleared: true })
      }
      if (route === '/api/playlists/local' && get) return json(response, 200, { playlists: localPlaylists.summary() })
      if (route === '/api/playlists/local' && request.method === 'POST') {
        const value = await bodyJson(request)
        const playlist = localPlaylists.create(value.name)
        await localPlaylists.save()
        return json(response, 200, { playlist })
      }
      const localSongs = /^\/api\/playlists\/local\/([A-Za-z0-9-]{1,80})\/songs$/.exec(route)
      if (localSongs && request.method === 'POST') {
        const value = await bodyJson(request)
        const result = localPlaylists.addSongs(localSongs[1], value.songs)
        await localPlaylists.save()
        return json(response, 200, result)
      }
      if (localSongs && request.method === 'DELETE') {
        const value = await bodyJson(request)
        const result = localPlaylists.removeSongs(localSongs[1], value.ids)
        await localPlaylists.save()
        return json(response, 200, result)
      }
      const localOrder = /^\/api\/playlists\/local\/([A-Za-z0-9-]{1,80})\/order$/.exec(route)
      if (localOrder && request.method === 'POST') {
        const value = await bodyJson(request)
        const result = localPlaylists.reorder(localOrder[1], value.ids)
        await localPlaylists.save()
        return json(response, 200, result)
      }
      const localPlays = /^\/api\/playlists\/local\/([A-Za-z0-9-]{1,80})\/play$/.exec(route)
      if (localPlays && request.method === 'POST') {
        const value = await bodyJson(request)
        const result = localPlaylists.countPlay(localPlays[1], String(value.songId ?? ''))
        await localPlaylists.save()
        return json(response, 200, result)
      }
      // 收藏：POST /api/playlists/favorites 收藏一首，DELETE 取消收藏。
      if (route === '/api/playlists/favorites' && request.method === 'POST') {
        const value = await bodyJson(request)
        const result = localPlaylists.favorite(value.song)
        await localPlaylists.save()
        return json(response, 200, result)
      }
      const favoriteSong = /^\/api\/playlists\/favorites\/(.{1,300})$/.exec(route)
      if (favoriteSong && request.method === 'DELETE') {
        const result = localPlaylists.unfavorite(decodeURIComponent(favoriteSong[1]))
        await localPlaylists.save()
        return json(response, 200, result)
      }
      // 单个本地歌单：GET 取曲目（支持排序），PATCH 更名，DELETE 删除。
      const localOne = /^\/api\/playlists\/local\/([A-Za-z0-9-]{1,80})$/.exec(route)
      if (localOne && get) {
        const sort = url.searchParams.get('sort') ?? 'default'
        if (sort !== 'default' && !SORT_KEYS.includes(sort)) return json(response, 400, { error: '不支持的排序规则。' })
        return json(response, 200, localPlaylists.songs(localOne[1], {
          offset: Number(url.searchParams.get('offset') || 0),
          // 默认给足：原来是 100，于是不带 limit 的调用只能看到前 100 首，
          // 看起来就像「歌单只能存 100 个」。真正的上限在 MAX_SONGS_PER_PLAYLIST。
          limit: Number(url.searchParams.get('limit') || 1000),
          sort,
          direction: url.searchParams.get('direction') === 'descending' ? 'descending' : 'ascending',
        }))
      }
      if (localOne && request.method === 'PATCH') {
        const value = await bodyJson(request)
        const playlist = localPlaylists.rename(localOne[1], value.name)
        await localPlaylists.save()
        return json(response, 200, { playlist })
      }
      if (localOne && request.method === 'DELETE') {
        const playlist = localPlaylists.remove(localOne[1])
        await localPlaylists.save()
        return json(response, 200, { playlist })
      }
      if (route === '/api/library' && get) {
        // 播放过程中 genre-rules.json 可能被外部改动，这里重新读一次。
        await store.reloadRules()
        return json(response, 200, store.snapshot())
      }
      if (route === '/api/library/scan' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (store.scanPromise) return json(response, 202, store.snapshot())
        const roots = value.roots === undefined ? undefined : safeRootList(value.roots)
        void store.scan({ roots }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/genre-rules' && get) {
        await store.reloadRules()
        return json(response, 200, store.rules)
      }
      if (route === '/api/genre-rules' && request.method === 'POST') return json(response, 200, await store.updateRules(await bodyJson(request)))
      if (['/api/config', '/api/library/config'].includes(route)) {
        if (get) return json(response, 200, { ...store.config, musicBrainzConfigured: !!store.musicBrainzContact })
        if (request.method === 'POST') {
          const value = await bodyJson(request)
          if (value.roots !== undefined && store.scanPromise) return json(response, 409, { error: '正在扫描，请完成后再更改根目录' })
          return json(response, 200, { ...await store.updateConfig(value), musicBrainzConfigured: !!store.musicBrainzContact })
        }
      }
      if (route === '/api/library/enrich' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (!store.musicBrainzContact) return json(response, 400, { error: '在线资料库尚未配置：请在资料库设置填写自己的联系邮箱或项目网址。音乐仍可本地播放。' })
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        void store.enrich({ albumIds: value.albumIds, force: true }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/library/introductions' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        void store.updateIntroductions({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/library/credits' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        void store.updateCredits({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      const audio = /^\/api\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
      const artwork = /^\/api\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
      if ((audio || artwork) && get) {
        const file = audio ? store.trackFile(audio[1]) : store.artworkFile(artwork[1])
        if (!file) return json(response, 404, { error: '索引中没有此文件' })
        return await serveFile(request, response, file, { cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
      }
      if (route === '/api/foobar/status' && get) return json(response, 200, { configured: !!store.config.foobarBaseUrl, baseUrl: store.config.foobarBaseUrl, connected: false, note: 'configured 仅代表已保存地址；连接状态需读取 /api/foobar/player 实际响应。' })
      if (route.startsWith('/api/foobar/')) {
        if (!store.config.foobarBaseUrl) return json(response, 503, { error: 'foobar2000 / Beefweb 尚未配置连接' })
        const suffix = route.slice('/api/foobar/'.length)
        if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(suffix) || !['GET', 'POST'].includes(request.method)) return json(response, 400, { error: '不支持的 Beefweb 请求' })
        const target = new URL(`/api/${suffix}`, store.config.foobarBaseUrl)
        target.search = url.search
        const payload = request.method === 'POST' ? JSON.stringify(await bodyJson(request)) : undefined
        const upstream = await fetch(target, { method: request.method, body: payload, headers: payload ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' })
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      // ── 更新查询（渲染进程不能直连 GitHub：无 CORS 头的 403 会直接抛 Failed to fetch）
      // 三条通道逐级降级，全部不依赖匿名 API 配额：
      //   1. api.github.com（信息最全，但有 60 次/小时的匿名限流）
      //   2. github.com/<repo>/releases/latest 的 302 跳转（无配额，只需读 location）
      //   3. releases.atom（无配额，最稳）
      if (route === '/api/update/check' && get) {
        const repo = 'kaelorvyn/Rhine-Music-Windows';
        const portable = (version) =>
          `https://github.com/${repo}/releases/download/v${version}/Rhine-Music-${version}-Portable.zip`;
        const answer = (tag, extra = {}) => {
          const version = String(tag || '').replace(/^v/i, '');
          if (!version) return null;
          return {
            version,
            tag: 'v' + version,
            htmlUrl: `https://github.com/${repo}/releases/tag/v${version}`,
            assetUrl: portable(version),
            ...extra,
          };
        };
        const tryFetch = async (url, init = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          try {
            return await fetch(url, { ...init, signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
        };
        // 1) API
        try {
          const reply = await tryFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rhine-music-windows' },
          });
          if (reply.ok) {
            const value = await reply.json();
            const asset = (value.assets || []).find((item) => /-portable\.zip$/i.test(item.name));
            const payload = answer(value.tag_name, {
              notes: String(value.body || '').slice(0, 400),
              htmlUrl: value.html_url || undefined,
              assetUrl: asset?.browser_download_url,
              assetSize: asset?.size,
              source: 'api',
            });
            if (payload) return json(response, 200, payload);
          }
        } catch {}
        // 2) 302 跳转
        try {
          const reply = await tryFetch(`https://github.com/${repo}/releases/latest`, {
            redirect: 'manual',
            headers: { 'User-Agent': 'rhine-music-windows' },
          });
          const location = reply.headers.get('location') || '';
          const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
          const payload = answer(tag, { notes: '', source: 'redirect' });
          if (payload) return json(response, 200, payload);
        } catch {}
        // 3) atom
        try {
          const reply = await tryFetch(`https://github.com/${repo}/releases.atom`, {
            headers: { 'User-Agent': 'rhine-music-windows' },
          });
          if (reply.ok) {
            const text = await reply.text();
            const tag = /\/releases\/tag\/([^"?#]+)/.exec(text)?.[1];
            const payload = answer(tag, { notes: '', source: 'atom' });
            if (payload) return json(response, 200, payload);
          }
        } catch {}
        return json(response, 502, { error: '更新通道都不可用' });
      }

      if (route.startsWith('/api/')) return json(response, 404, { error: 'API 不存在或请求方法不支持' })
      if (!get) return json(response, 405, { error: '只接受 GET/HEAD' })

const asset = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
      return await serveFile(request, response, { path: asset, allowedRoot: distDir }, { cache: route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    } catch (error) {
      const context = onlineRouteContext(request.url)
      if (context) diagnoseOnlineFailure(error, context.provider, context.operation)
      if (!response.headersSent) json(response, error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400), { error: error.message, ...(context ? { diagnostic: onlineDiagnostic(error) } : {}) })
      else response.destroy()
    }
  })
  server.once('close', () => { audioRelay.dispose(); decoder.dispose(); output.dispose() })
  server.requestTimeout = 30_000
  if (autoScan) server.once('listening', () => { void store.scan().catch(() => {}) })
  // 自检挂在 listening 之后：服务一监听就立刻上报就绪（桌面端 main.rs 只等
  // 25s），窗口马上打开并显示转圈加载页；自检在后台跑，前端加载页看进度条等它。
  // 这样「先能打开应用」和「首次等音源加载完」两件事同时成立。
  server.once('listening', startLxSelfCheck)
  server.once('listening', () => { void startFallbackWarmUp() })
  return { server, store, decoder, output, lxHost, backupSources, sourceLog, lxReadyNow: () => lxReady }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 5173)
  const { server, store } = await createMusicServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Rhine Local Music  http://127.0.0.1:${port}/`)
    console.log(`音乐索引：${store.dataDir}`)
    console.log(`音乐目录：${store.config.roots.join('、') || '尚未配置，在界面添加目录'}`)
  })
  const close = () => { server.close(() => process.exit()); server.closeAllConnections() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
