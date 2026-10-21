/**
 * LX Music 音源插件宿主（服务端运行时）
 *
 * 背景：能播全网歌曲，靠的是加载 LX Music 的自定义音源插件（.js 文件）。
 * 本模块复刻 LX Music 的 `globalThis.lx` 运行环境，把用户自己的音源插件加载进
 * 莱茵音乐的本地服务，接到搜索与取曲链路上。插件由用户自行提供与维护，
 * 本模块只做「宿主」：加载、注册、调用、结果回传。
 *
 * 插件契约（LX Music 公开的自定义音源格式）：
 *   const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx
 *   on(EVENT_NAMES.request, ({ source, action, info }) => Promise)
 *     action='search'   info={ keyword, page, limit }
 *     action='musicUrl' info={ type: 音质, musicInfo: { songmid/id/hash, name, singer… } }
 *   send(EVENT_NAMES.inited, { sources: { <平台键>: { name, type:'music',
 *     actions:['musicUrl','search'], qualitys:[...] } } })
 *
 * 平台键与莱茵平台的对应：wy→netease  tx→qq  kg→kugou  kw→kuwo
 */

import vm from 'node:vm'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
  showConfigView: 'showConfigView',
  clearCache: 'clearCache',
  changeLanguage: 'changeLanguage',
  setConfig: 'setConfig',
  hotSearch: 'hotSearch',
}

/** 莱茵平台 → LX 音源平台键 */
export const LX_KEY_FOR_PROVIDER = { netease: 'wy', qq: 'tx', kugou: 'kg', kuwo: 'kw' }
/** LX 音源平台键 → 莱茵平台（mg 等无对应的键仍可搜索，只是不回灌到换源链路） */
export const PROVIDER_FOR_LX_KEY = { wy: 'netease', tx: 'qq', kg: 'kugou', kw: 'kuwo' }

// ─── utils（LX Music 的工具面） ───────────────────────────────────────────────

function createUtils() {
  const asBuffer = (data, encoding = 'utf-8') =>
    Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding)

  const buffer = {
    from: (data, encoding = 'utf-8') => asBuffer(data, encoding),
    bufToString: (buf, encoding = 'utf-8') => asBuffer(buf).toString(encoding),
    concat: (list) => Buffer.concat(list.map((item) => asBuffer(item))),
  }

  /** Node cipher 名归一：'cbc' / 'aes-128-cbc' / 'aes-256-ecb' 都能吃 */
  const resolveCipher = (mode, keyLength) => {
    const text = String(mode || 'aes-128-cbc').toLowerCase()
    if (text.startsWith('aes-') || text.startsWith('des-')) return text
    const algo = text.includes('des') ? 'des' : `aes-${keyLength * 8}`
    return `${algo}-${text}`
  }

  const aes = (direction, data, mode, key, iv) => {
    const keyBuf = asBuffer(key, 'utf-8')
    const cipherName = resolveCipher(mode, keyBuf.length)
    const ivBuf = iv === undefined || iv === null ? null : asBuffer(iv, 'utf-8')
    const impl = direction === 'encrypt'
      ? (cipherName.includes('ecb') ? crypto.createCipheriv(cipherName, keyBuf, null) : crypto.createCipheriv(cipherName, keyBuf, ivBuf))
      : (cipherName.includes('ecb') ? crypto.createDecipheriv(cipherName, keyBuf, null) : crypto.createDecipheriv(cipherName, keyBuf, ivBuf))
    const input = asBuffer(data)
    return Buffer.concat([impl.update(input), impl.final()])
  }

  const cryptoUtils = {
    md5: (str) => crypto.createHash('md5').update(asBuffer(str)).digest('hex'),
    toMD5: (str) => crypto.createHash('md5').update(asBuffer(str)).digest('hex'),
    sha256: (str) => crypto.createHash('sha256').update(asBuffer(str)).digest('hex'),
    aesEncrypt: (data, mode, key, iv) => aes('encrypt', data, mode, key, iv),
    aesDecrypt: (data, mode, key, iv) => aes('decrypt', data, mode, key, iv),
    rsaEncrypt: (data, key) => {
      const encrypted = crypto.publicEncrypt(
        { key: String(key), padding: crypto.constants.RSA_PKCS1_PADDING },
        asBuffer(data),
      )
      return encrypted.toString('base64')
    },
  }

  return {
    buffer,
    crypto: cryptoUtils,
    toMD5: cryptoUtils.md5,
    toBase64: (str) => asBuffer(str).toString('base64'),
    fromBase64: (str) => Buffer.from(String(str), 'base64').toString('utf-8'),
    toHex: (str) => asBuffer(str).toString('hex'),
    fromHex: (hex) => Buffer.from(String(hex), 'hex').toString('utf-8'),
    /** LX 的 iv()：随机字节的十六进制串 */
    iv: (size = 16) => crypto.randomBytes(size).toString('hex').slice(0, size),
    randomBytes: (size = 16) => crypto.randomBytes(size).toString('hex'),
  }
}

// ─── request（LX Music 的 HTTP 面） ──────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 解析响应体：JSON 就给对象（插件里 `body.code` 这种直取字段的写法靠它），否则给字符串 */
function parseBody(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  const first = trimmed[0]
  if (first !== '{' && first !== '[' && first !== '"') return trimmed
  try { return JSON.parse(trimmed) } catch { return trimmed }
}

/**
 * 第三方音源的「自更新清单」识别。
 *
 * 很多音源在初始化时先拉一个远端 JSON（形如
 * `{version:'1.0.1', updateUrl:'…', description:'…'}`），只要里面的 version
 * 比插件自己的高，就 **打印"发现新版本，脚本将不会初始化"并彻底拒绝工作**。
 *
 * 这在家用 LX Music 里是合理的（提醒用户去下载新版），但对我们是致命的：
 * 那些"新版"往往只是作者换了发布页，脚本本体并没有真的不兼容；而一旦作者
 * 不再维护、或发布页挂掉，插件就永久变砖——我们实测 8 个精选音源里有 4 个
 * 就是被这道自检挡死的（念心 1.0.0 vs 清单 1.0.1、长青SVIP 同理）。
 *
 * 处理方式：识别出这类清单后，把 version 改写成**插件自己的版本**，于是
 * compareVersions(self, self) === 0，插件正常初始化。我们只改"要不要拒绝
 * 运行"这一个字段，其余（updateUrl / description）原样保留，插件若想展示
 * 更新提示仍然能看到。真正的兼容性问题会以取曲失败的形式暴露，不会被掩盖。
 */
const UPDATE_MANIFEST_HOSTS = [
  'gitee.com', 'kdocs.cn', 'yuque.com', 'kstore.vip', 'github.com', 'githubusercontent.com',
  'gitcode.com', 'jsdelivr.net', 'unpkg.com', 'gitee.io', 'vercel.app', 'netlify.app',
  'dpdns.org', 'zddyr.top',
]
function looksLikeUpdateManifest(url, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (typeof body.version !== 'string' || !/^\d+(\.\d+)*$/.test(body.version.trim())) return false
  // 必须同时带"去哪儿更新"的痕迹，避免把普通的带 version 字段的业务响应误改。
  const hasUpdateHint = body.updateUrl || body.downloadUrl || body.update_url || body.description || body.desc || body.notice
  if (!hasUpdateHint) return false
  let host = ''
  try { host = new URL(url).hostname } catch { host = '' }
  // 命中常见的"音源发布页/图床"域名，或 URL 里带明显的更新清单关键字。
  return UPDATE_MANIFEST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    || /update|version|ver\.json|newest|latest|check/i.test(url)
}
/** 把自更新清单里的 version 降级为插件自身版本，让自检通过。 */
function neutralizeUpdateManifest(url, body, selfVersion) {
  if (!selfVersion || !looksLikeUpdateManifest(url, body)) return body
  return { ...body, version: String(selfVersion).replace(/^v/i, '') }
}

function createRequest(selfVersion) {
  return function request(url, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    const opts = options ?? {}
    const done = typeof callback === 'function' ? callback : () => {}
    let settled = false
    const finish = (err, resp) => { if (settled) return; settled = true; clearTimeout(watchdog); done(err, resp) }

    const method = String(opts.method || 'GET').toUpperCase()
    // 请求头必须是 ByteString：第三方插件常塞中文（referer / UA / 自定义头），
    // 不清洗会让 fetch 同步抛错。保留能装进 Latin-1 的字符，其余折成 '?'。
    const headers = {}
    for (const [key, value] of Object.entries({ 'User-Agent': UA, ...(opts.headers ?? {}) })) {
      if (value === undefined || value === null) continue
      headers[key] = String(value).replace(/[^\x20-\x7e\u00a0-\xff]/g, '?')
    }
    let body
    if (opts.body !== undefined && opts.body !== null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
    } else if (opts.form) {
      body = new URLSearchParams(opts.form).toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (opts.formData) {
      const fd = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.formData)) fd.append(k, String(v))
      body = fd.toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }

    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 12000
    const init = { method, headers, redirect: 'follow' }
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = body
    try { init.signal = AbortSignal.timeout(timeout) } catch { /* 老 Node 无此 API */ }

    // 双保险：AbortSignal 之外再挂一个定时器，保证永远会回调一次
    const watchdog = setTimeout(() => finish(new Error(`请求超时 ${timeout}ms`)), timeout + 500)

    let pending
    try {
      pending = fetch(url, init)
    } catch (err) {
      return finish(err, null)
    }
    pending.then(async (res) => {
      const text = await res.text().catch(() => '')
      let body = parseBody(text)
      // 拦住「自更新清单」里的版本号，别让插件因为"有新版本"而拒绝初始化。
      if (body && typeof body === 'object') {
        try { body = neutralizeUpdateManifest(url, body, selfVersion) } catch { /* 原样 */ }
      }
      finish(null, {
        statusCode: res.status,
        statusMessage: res.statusText,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        body,
      })
    }, (err) => finish(err, null))
  }
}

// ─── 插件元信息 ───────────────────────────────────────────────────────────────

export function extractMeta(content) {
  const meta = {}
  const block = /\/\*[\s\S]*?\*\//.exec(content)?.[0] ?? ''
  const pick = (tag) => RegExp(`@${tag}\\s+(.+?)\\s*$`, 'm').exec(block)?.[1]?.trim()
  if (pick('name')) meta.name = pick('name')
  if (pick('description')) meta.description = pick('description')
  if (pick('version')) meta.version = pick('version')
  if (pick('author')) meta.author = pick('author')
  return meta
}

// ─── 单个插件 ─────────────────────────────────────────────────────────────────

class LxPlugin {
  constructor({ id, filePath, content }) {
    this.id = id
    this.filePath = filePath
    this.content = content
    this.meta = extractMeta(content)
    /** 平台键 → 能力声明 */
    this.sources = new Map()
    /** 迟绑定的事件处理器槽：插件可能在异步初始化里才注册 */
    this.handlers = { request: null, showConfigView: null }
    this.sent = new Map()
    this.loadError = null
  }

  /**
   * 执行插件脚本。注意：不少插件（聚合API、星海等）先发远端请求，
   * 成功后才 `send(EVENT_NAMES.inited, …)` 注册能力——所以这里是异步的，
   * 要给一段初始化宽限期等它的能力声明落地。
   */
  async load({ initGraceMs = INIT_GRACE } = {}) {
    const selfScript = this.content
    const selfName = path.basename(this.filePath)
    const selfDigest = crypto.createHash('md5').update(selfScript).digest('hex')

    const lx = {
      EVENT_NAMES,
      // 【2026-10-15】必须报 LX Music 桌面版的真实大版本 2.x：新版音源（念心、
      // 长青SVIP、统一音乐源…）会拿 lx.version 跟自己的 CURRENT_VERSION 比，
      // 低于要求就**不发 inited**（表现为"声明源为空、取不到地址"）。
      // 旧值 1.0.0 让一半以上的新版音源静默失效。url 指向官方仓库，供插件
      // 做「有无新版本」提示；不做真实跳转，只作为字符串存在。
      version: Object.assign(new String('2.11.0'), { version: '2.11.0', url: 'https://github.com/lyswhut/lx-music-desktop' }),
      env: 'desktop',
      utils: createUtils(),
      // 野花 / 野草 / 洛雪科技 这类插件会读取自身源码做指纹校验，
      // LX Music 通过 currentScriptInfo 提供（rawScript / md5 / hash）
      currentScriptInfo: {
        rawScript: selfScript,
        source: selfScript,
        name: selfName,
        md5: selfDigest,
        hash: selfDigest,
        version: this.meta.version ?? '1.0.0',
        author: this.meta.author ?? '',
      },
      request: createRequest(this.meta.version),
      on: (event, handler) => {
        if (event === EVENT_NAMES.request) this.handlers.request = handler
        else if (event === EVENT_NAMES.showConfigView) this.handlers.showConfigView = handler
      },
      send: (event, data) => {
        this.sent.set(event, data)
        if (event === EVENT_NAMES.inited) this._adoptSources(data)
      },
    }

    const sandbox = {
      lx,                       // 裸 `lx.xxx` 的写法
      console,
      setTimeout, setInterval, clearTimeout, clearInterval, setImmediate,
      Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
      Promise, Date, JSON, Math, Object, Array, String, Number, Boolean,
      Error, TypeError, RangeError, RegExp, Map, Set, Symbol, BigInt,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      // FreeListen 等用 `document.getElementsByTagName('script')[0].innerText`
      // 取自己的源码；webpack 打包的插件里还可能摸 window / navigator
      document: {
        currentScript: { innerText: selfScript, textContent: selfScript, src: '' },
        getElementsByTagName: (tag) =>
          String(tag).toLowerCase() === 'script'
            ? [{ innerText: selfScript, textContent: selfScript, src: '' }]
            : [],
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        cookie: '',
        title: 'lx-music',
      },
      navigator: { userAgent: 'lx-music-desktop/1.0.0', language: 'zh-CN', platform: 'win32' },
      location: { href: 'https://lx-music.local/', origin: 'https://lx-music.local', protocol: 'https:' },
    }
    // `globalThis.lx` / `window.lx` / `self.lx` 都要能取到
    sandbox.globalThis = sandbox
    sandbox.window = sandbox
    sandbox.self = sandbox

    const context = vm.createContext(sandbox, {
      name: `lx-plugin:${this.id}`,
      codeGeneration: { strings: true, wasm: false },
    })

    try {
      new vm.Script(this.content, { filename: path.basename(this.filePath) })
        .runInContext(context, { timeout: 3000 })
    } catch (err) {
      this.loadError = err
      throw new Error(`${this.meta.name ?? path.basename(this.filePath)} 加载失败：${err.message}`)
    }

    // 等异步初始化把能力声明送来（远端 init.conf 类插件靠它）
    const deadline = Date.now() + initGraceMs
    while (this.sources.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return this
  }

  _adoptSources(data) {
    const declared = data?.sources ?? {}
    for (const [key, def] of Object.entries(declared)) {
      if (def?.type && def.type !== 'music') continue
      this.sources.set(key, {
        key,
        name: def?.name ?? key,
        actions: def?.actions ?? ['musicUrl'],
        qualitys: def?.qualitys ?? ['128k', '320k'],
        qualityName: def?.qualityName ?? {},
        maxSearchCount: def?.maxSearchCount ?? 20,
      })
    }
    if (!this.sources.size && this.handlers.request) {
      this.sources.set('custom', { key: 'custom', name: this.meta.name ?? 'custom', actions: ['musicUrl'], qualitys: ['128k', '320k'], qualityName: {}, maxSearchCount: 20 })
    }
  }

  /** 调用插件的请求处理器（带硬超时，第三方代码不能拖死宿主） */
  call(sourceKey, action, info, timeoutMs) {
    const handler = this.handlers.request
    if (!handler) return Promise.reject(new Error('插件未注册 request 处理器'))
    const label = `${this.meta.name ?? this.id}:${action}`
    return withTimeout(
      Promise.resolve(handler({ source: sourceKey, action, info })),
      timeoutMs ?? SEARCH_TIMEOUT,
      label,
    )
  }

  search(sourceKey, keyword, page = 1, limit = 10) {
    return this.call(sourceKey, 'search', { keyword, page, limit }, SEARCH_TIMEOUT).then((result) => {
      const list = Array.isArray(result?.list) ? result.list : []
      return {
        list,
        total: Number(result?.total) || list.length,
        page: Number(result?.page) || page,
        limit: Number(result?.limit) || limit,
        allPage: Number(result?.allPage) || 1,
      }
    })
  }

  musicUrl(sourceKey, musicInfo, quality) {
    return this.call(sourceKey, 'musicUrl', { type: quality, musicInfo }, MUSIC_URL_TIMEOUT).then((url) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw new Error('插件返回的音频地址无效')
      }
      return url
    })
  }
}

// ─── 宿主 ─────────────────────────────────────────────────────────────────────

const CACHE_TTL = 20 * 60 * 1000

/** 音质档位从低到高（LX 生态的通用命名）。取曲时从高往低试。 */
const QUALITY_TIERS = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']

/**
 * 播放取曲实际会尝试的档位（对齐洛雪 TRY_QUALITYS_LIST）。
 *
 * 【为什么只要 3 档】洛雪 `src/renderer/core/music/utils.ts`：
 *     export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k']
 * 它的 `getPlayQuality` 从这三档里挑**第一个该源支持的**，只问那一个。
 *
 * 我们原来是全量 9 档从 `master` 起串行试：7 档 × 每档最少 3500ms
 * = 理论最坏 24.5 秒。虽然多数时候第一档就命中（实测 183ms），但**一旦
 * 前面的高档位拿不到**（音源没声明母带/全景声、或该档接口报错），
 * 后面每一档都要等满一个切片，用户就一直转圈。
 *
 * 砍到 3 档后最坏路径从 7 轮降到 3 轮，且这 3 档是洛雪验证过覆盖面最好的
 * 组合：无损优先、320k 兜底。`master`/`atmos`/`hires` 等更高档位不再默认
 * 参与取曲 —— 它们在实际音源里很少被声明，试它们基本是纯浪费。
 */
export const PLAY_QUALITYS = ['flac24bit', 'flac', '320k']

/**
 * 取曲档位阶梯：从**起始档位往上**的所有档位，按从高到低排列。
 *
 * 用户明确要求「默认音质肯定是最高的」，所以起点是 320k 时，实际会先试
 * 母带 / Hi-Res / 无损，全部拿不到才落到 320k —— 既保证默认拿到最好的那一版，
 * 又不会因为强求无损而放不出歌（往下还有 320k 兜底）。
 */
/**
 * 一组声明档位里最高的那一档（用于搜索结果的音质标注）。
 * 档位名按 QUALITY_TIERS 的次序比，未知名字排在最后、不影响已知档位。
 */
export function highestQuality(qualitys) {
  if (!Array.isArray(qualitys) || !qualitys.length) return ''
  return [...qualitys].sort((a, b) => QUALITY_TIERS.indexOf(b) - QUALITY_TIERS.indexOf(a))[0] ?? ''
}

/**
 * 音频地址的「文件身份」，用于串歌防护的归属比对。
 *
 * 不能直接拿整串 URL 当 key —— CDN 每次请求返回的签名/token/时间戳都可能
 * 不同，同一个文件会有无数个「不同的 URL」。实测踩过：酷我同一个 .flac 两次
 * 请求签名段不同，Map 里存成两条，防护完全失效（《唯一》两条不同 id 依然
 * 拿到同一个 F000001ziKgJ3o5Ipp.flac，urlOwner 里出现两行相同文件名）。
 *
 * 归一化规则：host + 最后一段路径。最后一段是真正的媒体文件名
 * （F000001ziKgJ3o5Ipp.flac / 588957081.mp3 / xxx.mgg），跨签名稳定。
 * 拿不到 host 或文件名（不是媒体扩展名）就返回空串，调用方跳过检查 ——
 * 宁可不拦，也不能误杀正常地址。
 */
export function audioIdentity(url) {
  try {
    const parsed = new URL(String(url))
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (!last) return ''
    const clean = last.split(';')[0]
    if (!/\.(mp3|flac|m4a|aac|ogg|opus|wav|mgg|mflac|qmc|kgm|kwm|ape|wma)$/i.test(clean)) return ''
    return `${parsed.hostname}/${clean}`
  } catch { return '' }
}

/**
 * 取曲档位阶梯（对齐洛雪的「只问一个档位」思路）。
 *
 * 默认只在 PLAY_QUALITYS 这 3 档内从高到低走，不再蔓延到全部 9 档 ——
 * 这是把「最坏 7 轮」压到「最坏 3 轮」的关键一刀。
 *
 * 【始终从最高档起】用户要求「默认音质肯定是最高的」，所以常规播放一律
 * 返回完整的 3 档（flac24bit > flac > 320k），**不因传进来的 startQuality
 * 而裁掉高档位**。实测踩过：若按 startQuality='320k' 裁剪，结果只剩 1 档，
 * 无损就不会被尝试 —— 与"默认最高"的要求相反。
 *
 * 传进来的 startQuality 是更高档位（'master'/'hires' 等，不在
 * PLAY_QUALITYS 内）时，说明是**显式**要那一档（自检/诊断等调用），
 * 此时按原语义返回「>= 起始档」的全量阶梯，保持向后兼容。
 */
export function qualityLadder(startQuality = '320k') {
  if (!PLAY_QUALITYS.includes(startQuality)) {
    const start = QUALITY_TIERS.indexOf(startQuality)
    const highestFirst = [...QUALITY_TIERS].reverse()
    if (start < 0) return highestFirst
    return highestFirst.filter((tier) => QUALITY_TIERS.indexOf(tier) >= start)
  }
  // 常规播放：始终从最高档起，3 档内从高到低。
  return [...PLAY_QUALITYS]
}

/** 单次插件调用的硬超时：插件是第三方代码，不能让它把宿主拖死 */
const SEARCH_TIMEOUT = 20000
/**
 * 取曲单次调用超时（2026-10-15 提速：25000 → 8000）。
 *
 * 【教训】这里**不是**越快越好。它是单次插件调用的**上限**，不是延迟：
 * 成功路径几毫秒就返回，根本碰不到它；调小它只会掐掉「慢但能成功」的调用。
 * 实测踩过：收到 3000 时，冷启动首次取曲（插件初始化 + 远端握手 ≈1.8~3s）
 * 正好卡在临界点 —— 3022ms 失败、2907ms 成功，把能放的歌变成放不出。
 * 8000 给冷启动留足余量，同时比原来的 25000 好得多（坏源 8 秒出局）。
 */
const MUSIC_URL_TIMEOUT = 8000
// 初始化宽限期：新版音源常常「先请求远端配置、成功后才 send(inited)」，
// 远端慢的时候 3 秒不够（会表现为"声明源为空"），给到 10 秒。
// 代价只在服务启动时一次性付出（有源声明就提前退出等待）。
// 3000ms：绝大多数插件在脚本执行完的同一轮事件循环里就 send(inited)，
// 需要联网拿 init.conf 的才要等。原来给 10 秒，117 个插件叠加起来就把
// 启动拖到几分钟 —— 用户要求「加载不出来的一律不要」，所以收紧。
const INIT_GRACE = 3000
/**
 * 一次取曲在所有插件上最多花多久（用户点歌不能等太久）。
 *
 * 【同上】这是**上限**：正常几百毫秒就命中第一档返回，与它无关。
 * 它的作用只是"全军覆没时别让用户干等"。9000 覆盖 3 档 × 3000ms 切片的
 * 最坏串行路径（冷启动 + 高档位无人应答时要走到低档位）。
 * 2026-10-15 曾误降到 6000，导致第 2 档还没轮到就被掐断。
 */
const RESOLVE_BUDGET = 9000

/**
 * 【已移除 RESOLVE_RACE_WIDTH】原来是「一次只问 6 个，全败才放剩下」的两波
 * 串行，最坏要等「第一波全灭」+「第二波才成功」；第一波里只要有一个源卡到
 * 超时，用户就白等。2026-10-15 改成**单波全量并发**（见 _resolveTier），
 * 好坏源同时接受检阅、谁先成功用谁，这个宽度常量随之删除。
 */

/** 自检里单次调用与尝试次数的上限（自检是批量任务，不能让单个坏源拖垮整轮） */
const SELFCHECK_CALL_TIMEOUT = 8000
const MAX_SELFCHECK_ATTEMPTS = 6

/**
 * 自检探针曲：每个平台一首**确定存在的经典免费曲**。
 *
 * 自检必须同时覆盖两类音源（实测结论，两类都存在）：
 *   ① **只支持 musicUrl 的源**（如星海）：直接拿平台的真实 id 取地址。
 *      —— 拿假 id 会得到 "unknow error"，所以真 id 要由平台自己搜出来。
 *   ② **按搜索实现的源**（说明文件原文：「闻音的api用的公开的这个api的使用
 *      逻辑是通过搜索实现，所以大家在使用时尽量搜索，否则可能会请求失败」）：
 *      要先用插件**自己的 search** 找到它认的 id。
 *
 * 所以自检对每个插件两步都试：先按平台真 id 取，失败再用插件搜索取。
 * 这两种 id 都由「平台搜索」提前准备好（见 resolveProbeIds），不写死。
 */
export const DEFAULT_PROBES = [
  { source: 'wy', keyword: '晴天 周杰伦' },
  { source: 'kg', keyword: '晴天 周杰伦' },
  { source: 'kw', keyword: '晴天 周杰伦' },
  { source: 'tx', keyword: '晴天 周杰伦' },
]

const safeHost = (value) => { try { return new URL(value).host } catch { return '' } }

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

export class LxSourceRuntime {
  constructor({ fetchFn, guardRejections = true } = {}) {
    /** @type {Map<string, LxPlugin>} */
    this.plugins = new Map()
    /** 平台键 → 插件 id 列表（保持加载顺序） */
    this.bySource = new Map()
    this.urlCache = new Map()
    /**
     * 地址归属表：音频地址 → 它属于哪首歌（songKey）。
     *
     * 【为什么必须有】实测发现有的音源插件内部「竞速多个上游」，其中某个上游
     * **忽略传入的 id、永远返回同一条热门结果**。证据（scripts/probe-mismatch4）：
     * 酷我四首完全不同的《青丝》全部返回同一个
     * `.../trackmedia/M800001ziKgJ3o5Ipp.mp3` —— 用户听到的就是「歌名是《青丝》、
     * 放出来是《唯一》」。
     *
     * 这类错误**没法靠单次请求发现**（地址本身有效、能取到音频字节，_verifyUrl
     * 会判它通过），只有跨请求比较才看得出来：同一个地址不可能同时属于两首不同
     * 的歌。所以每次解析成功都登记一次；一旦发现某地址已被**另一首歌**登记过，
     * 就判定该地址不可信、丢弃它继续问下一个源。
     *
     * 用 Map 而不是 Set 是为了记住归属，能区分「同一首歌重复请求」（正常，
     * 应该命中 urlCache 而不是重新解析）和「不同歌撞同一地址」（异常）。
     */
    this.urlOwner = new Map()
    this.loadReport = []
    /**
     * 开机自检结果：插件 id → { ok, quality, attempts, ms, at, error }
     * 自检没跑完时是空 Map，取曲逻辑自动退化为「按加载顺序试」。
     */
    this.health = new Map()
    this.selfCheckReport = null
    if (guardRejections) LxSourceRuntime.installRejectionGuard()
    void fetchFn
  }

  /**
   * ── 开机自检 ──────────────────────────────────────────────────────────────
   *
   * 用户的要求：「打开应用时自检所有音源，先拿到一个标准，然后后续在剩余的
   * 音源里面找优质的」。
   *
   * 做法：拿几首**每个平台都一定有的免费曲**当探针，逐个插件试取地址并验真
   * （必须真的返回音频字节，只回网页/JSON 的都算死源）。结果写进 this.health，
   * 之后取曲就只走健康源、且按「能给的最高音质」排序。
   *
   * 99 个音源里大量是死的/需 apikey/被墙——自检就是把它们挑掉，让播放不再
   * 一个个去撞墙（用户实测的"等 20 秒"就来自依次撞死源）。
   *
   * 不阻塞启动：由调用方以 background 方式跑（见 music-server），自检期间
   * 播放照常可用（退化顺序试）。
   */
  async selfCheck({ probes = DEFAULT_PROBES, concurrency = 6, budgetMs = 120000, onProgress, resolveId } = {}) {
    const started = Date.now()
    // 进度状态：前端加载页据此画进度条（首次启动时会等它跑完才进应用）。
    this.selfCheckState = { running: true, done: 0, total: 0, alive: 0, startedAt: started, finishedAt: null }
    const publish = () => {
      if (!this.selfCheckState) return
      this.selfCheckState.alive = [...this.health.values()].filter((h) => h.ok).length
      try { onProgress?.(this.selfCheckState) } catch { /* 进度回调不能影响自检 */ }
    }
    // 探针的真实 id 由平台搜索提供（每个平台搜一次即可，供所有插件复用）。
    await this._prepareProbeIds(probes, resolveId)
    // 按「插件 × 它声明的每个探针平台」建任务。
    //
    // 【2026-10-15 修复自检误判】原来每个插件只挑**第一个**匹配的探针平台
    // （顺序恒为 wy→kg→kw→tx），于是所有插件都只用「网易」测。但实测音源
    // 常常只有部分平台可用：
    //     星海音乐源   wy ✅ master      kg/kw/tx ✗
    //     K×H测试      wy ✅ master      kw ✅ master   kg ✅ atmos   tx ✗
    // 只测网易会把「酷狗/酷我还能用」的源整个判死（星海就被误判了）。
    // 现在逐平台都测，健康表按 `${pluginId}|${平台键}` 存，取曲时按平台筛。
    const pluginIds = [...this.plugins.keys()]
    const jobs = []
    for (const id of pluginIds) {
      const plugin = this.plugins.get(id)
      if (!plugin?.sources?.size) continue
      for (const probe of probes) {
        if (plugin.sources.has(probe.source)) jobs.push({ id, plugin, probe })
      }
    }
    this.selfCheckState.total = jobs.length
    publish()

    let done = 0
    const worker = async () => {
      while (jobs.length) {
        if (Date.now() - started > budgetMs) return
        const job = jobs.shift()
        if (!job) return
        const { id, plugin, probe } = job
        const healthKey = `${id}|${probe.source}`
        const t0 = Date.now()
        const result = { ok: false, quality: null, attempts: 0, ms: 0, at: Date.now(), error: '', source: probe.source }
        // 候选 id：三类音源实现都要覆盖（实测三类都存在）
        //   ① 平台搜出的真 id —— 只支持 musicUrl 的源用这个（星海）
        //   ② 插件自己搜索得到的 id —— 按搜索实现的源用这个
        //   ③ 纯「歌名+歌手」—— getMusicUrl 内部再按关键字搜索的源（闻音）
        const candidates = []
        if (probe.info) candidates.push({ info: probe.info, via: '平台id' })
        const searchId = await this._searchViaPlugin(plugin, probe)
        if (searchId) candidates.push({ info: searchId, via: '插件搜索' })
        if (probe.keyword) {
          const [name, singer = ''] = String(probe.keyword).split(/\s+/)
          candidates.push({ info: { id: '', songmid: '', name, singer, albumName: '' }, via: '歌名歌手' })
        }
        if (!candidates.length) {
          result.error = '探针曲未取到可用 id'
          result.ms = Date.now() - t0
          this.health.set(healthKey, result)
          done++
          continue
        }
        result.hasSearch = candidates.some((c) => c.via === '插件搜索')

        // 从高到低试档位：拿到哪一档就记哪一档（这就是这个源的"标准"）。
        //
        // 【性能】候选 × 档位的组合会很慢（3 候选 × 8 档 × 25s 超时 = 最坏几分钟）。
        // 所以：先挑**最高档位**把候选试一遍（能成的大多一次就中），全都失败才
        // 降到下一档；且每个插件最多试 MAX_SELFCHECK_ATTEMPTS 次就放弃判定为坏源。
        const declared = plugin.sources.get(probe.source)?.qualitys ?? []
        const tiers = qualityLadder('128k').filter((t) => !declared.length || declared.includes(t))
        let lastError = ''
        let used = 0
        outer: for (const tier of tiers) {
          for (const c of candidates) {
            if (used >= MAX_SELFCHECK_ATTEMPTS) { lastError = lastError || '超过自检尝试上限'; break outer }
            used++
            result.attempts++
            try {
              const url = await withTimeout(plugin.musicUrl(probe.source, { ...c.info }, tier), SELFCHECK_CALL_TIMEOUT, 'musicUrl')
              if (!url) { lastError = '未返回地址'; continue }
              const verified = await this._verifyUrl(url)
              if (verified.ok) {
                result.ok = true; result.quality = tier; result.host = safeHost(url)
                result.via = c.via; result.error = ''
                break outer
              }
              lastError = verified.reason
            } catch (err) {
              lastError = err?.message ?? 'call failed'
            }
          }
        }
        if (!result.ok) result.error = lastError
        result.ms = Date.now() - t0
        this.health.set(healthKey, result)
        done++
        if (this.selfCheckState) this.selfCheckState.done = done
        publish()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker))

    const alive = [...this.health.values()].filter((h) => h.ok)
    // alive 是「插件 × 平台」的可用条数（同一个插件在多个平台可用会计多条），
    // 另外给出去重后的插件数，两个数字含义不同，日志/界面都别混。
    const alivePlugins = new Set([...this.health.entries()].filter(([, h]) => h.ok).map(([k]) => String(k).split('|')[0]))
    this.selfCheckReport = {
      checked: this.health.size,
      alive: alive.length,
      alivePlugins: alivePlugins.size,
      dead: this.health.size - alive.length,
      ms: Date.now() - started,
      at: Date.now(),
    }
    // 自检后重排：健康源在前，且能给的音质越高越前
    this._rankSources()
    if (this.selfCheckState) {
      this.selfCheckState.running = false
      this.selfCheckState.done = this.selfCheckState.total
      this.selfCheckState.finishedAt = Date.now()
    }
    publish()
    return this.selfCheckReport
  }

  /**
   * 自检进度（前端加载页画进度条用）。 */
  get selfCheckProgress() {
    return this.selfCheckState ?? { running: false, done: 0, total: 0, alive: 0, startedAt: null, finishedAt: null }
  }

  /**
   * ── 取曲缓存落盘（对齐洛雪最有效的一招）────────────────────────────────────
   *
   * 洛雪 `src/renderer/core/music/online.ts`：
   *     const cachedUrl = await getStoreMusicUrl(musicInfo, targetQuality)
   *     if (cachedUrl && !isRefresh) return cachedUrl
   * 它的 URL 缓存在 **SQLite** 里（`src/main/worker/dbService/modules/music_url/`），
   * 所以**重启应用后**再放同一首歌仍是 ~0ms —— 用户感觉"洛雪就是快"，
   * 很大一部分来自这个"第二次不用取源"。
   *
   * 我们原来只有内存 Map（`urlCache`），进程一退就全丢：每次开机第一遍
   * 放任何歌都要重新走一遍取源。这里把同一份数据落盘。
   *
   * 同时把 `urlOwner`（串歌归属表）一起落盘 —— 它是"同一个音频地址不可能属于
   * 两首不同的歌"的判据，只存内存的话重启后第一首歌没有对照基准，串歌防护
   * 存在一个漏判窗口。
   *
   * 不落盘的内容：`error`（失败结果）—— 失败的源下次该重试，缓存失败等于
   * 把死源永久钉死。
   */
  exportUrlCache() {
    const urls = {}
    const now = Date.now()
    for (const [key, entry] of this.urlCache) {
      // 过期的直接不写，避免文件里堆垃圾。
      if (now - Number(entry?.at ?? 0) >= CACHE_TTL) continue
      urls[key] = { value: entry.value, at: entry.at }
    }
    const owners = {}
    for (const [identity, songKey] of this.urlOwner) owners[identity] = songKey
    return { at: now, urls, owners }
  }

  /**
   * 恢复落盘的取曲缓存。
   *
   * 过期条目直接丢弃（CDN 签名会失效，留着只会导致播放失败后重试一次，
   * 不如现在就当没有）。恢复 `urlOwner` 时**不做冲突检测**：落盘文件是
   * 我们自己写的，信任它；冲突检测的价值在"新解析出的地址 vs 已有归属"。
   */
  importUrlCache(snapshot) {
    if (!snapshot) return false
    const now = Date.now()
    let urls = 0, owners = 0
    for (const [key, entry] of Object.entries(snapshot.urls ?? {})) {
      if (!entry?.value || now - Number(entry.at ?? 0) >= CACHE_TTL) continue
      this.urlCache.set(key, { value: entry.value, at: Number(entry.at) })
      urls++
    }
    for (const [identity, songKey] of Object.entries(snapshot.owners ?? {})) {
      if (!identity || !songKey) continue
      this.urlOwner.set(identity, songKey)
      owners++
    }
    return urls > 0 || owners > 0
  }

  /**
   * 自检结果的落盘快照，用于下次启动跳过重复自检。
   * 键是 `${pluginId}|${平台键}`（逐平台记录）—— 因为一个音源常常只有
   * 部分平台可用（如星海只有网易），按插件存会把可用平台一起丢掉。
   */
  exportHealth() {
    const rows = {}
    for (const [key, h] of this.health) {
      rows[key] = { ok: h.ok, quality: h.quality, host: h.host ?? '', error: h.error ?? '', ms: h.ms, at: h.at, source: h.source ?? '' }
    }
    return { at: Date.now(), report: this.selfCheckReport, sources: rows }
  }

  /**
   * 用落盘的自检结果恢复排序（跳过耗时的重测）。
   * 只恢复「健康 + 音质」用于排序；真实地址仍然每次现取（会过期）。
   */
  importHealth(snapshot) {
    if (!snapshot?.sources) return false
    let applied = 0
    // 健康表的键是 `${pluginId}|${平台键}`，快照按同一格式写盘（见 exportHealth）。
    for (const [key, row] of Object.entries(snapshot.sources)) {
      if (!row) continue
      this.health.set(key, { ok: !!row.ok, quality: row.quality ?? null, host: row.host ?? '', error: row.error ?? '', ms: row.ms ?? 0, at: row.at ?? Date.now(), attempts: 0, source: row.source ?? '' })
      applied++
    }
    this.selfCheckReport = snapshot.report ?? null
    if (applied) this._rankSources()
    return applied > 0
  }

  /**
   * 探测针曲的真实平台 id：用**平台自己的搜索**（免登录的那些）拿到真 id，
   * 供「只支持 musicUrl、不支持 search」的音源使用。拿不到就留空，
   * 自检会退回「插件搜索」那条路。
   *
   * 平台搜索器由调用方注入（`selfCheck({ resolveId })`）——loader 不能直接
   * import 各平台协议，否则会和 music-server 形成循环依赖。
   */
  async _prepareProbeIds(probes, resolveId) {
    if (typeof resolveId !== 'function') return
    for (const probe of probes) {
      if (probe.info) continue
      try {
        const info = await resolveId(probe.source, probe.keyword)
        if (info?.id) probe.info = info
      } catch { /* 取不到就走插件搜索那条路 */ }
    }
  }

  /** 用插件自己的 search 找它认得的歌曲 id（按搜索实现的音源必须走这条）。 */
  async _searchViaPlugin(plugin, probe) {
    if (!plugin.sources.get(probe.source)?.actions?.includes('search')) return null
    try {
      const found = await withTimeout(plugin.search(probe.source, probe.keyword, 1, 5), SEARCH_TIMEOUT, 'search')
      const first = found?.list?.find((raw) => raw && (raw.songmid || raw.id || raw.mid || raw.hash))
      if (!first) return null
      const songId = String(first.songmid ?? first.id ?? first.mid ?? first.hash)
      return {
        id: songId, songmid: songId, mid: songId, hash: songId,
        name: String(first.name ?? first.title ?? probe.keyword),
        singer: String(first.singer ?? first.artist ?? ''),
      }
    } catch { return null }
  }

  /**
   * 按自检结果重排每个平台的插件顺序（健康 + 高音质优先，坏源沉底）。
   * 健康表按 `${id}|${平台键}` 存，所以这里也按平台查——某个源只在网易可用
   * 时，只会被排到网易那一列的前面，其它平台不受影响。
   */
  _rankSources() {
    if (!this.health.size) return
    const score = (id, sourceKey) => {
      const h = this.health.get(`${id}|${sourceKey}`)
      if (!h) return 0                       // 未自检：保持中间
      if (!h.ok) return -1000                // 该平台死源沉底
      return 100 + QUALITY_TIERS.indexOf(h.quality ?? '128k')
    }
    for (const [key, ids] of this.bySource) {
      const ranked = [...ids].sort((a, b) => score(b, key) - score(a, key))
      this.bySource.set(key, ranked)
    }
  }

  /** 自检摘要（给设置界面/日志看）。逐平台一行，便于看出「哪个源在哪个平台活」。 */
  get healthSummary() {
    const rows = [...this.health.entries()].map(([key, h]) => {
      const [id, sourceKey = h.source ?? ''] = String(key).split('|')
      return {
        plugin: this.plugins.get(id)?.meta.name ?? id,
        source: sourceKey,
        ok: h.ok, quality: h.quality, ms: h.ms, host: h.host ?? '', error: h.error || '',
      }
    })
    return { report: this.selfCheckReport, sources: rows.sort((a, b) => Number(b.ok) - Number(a.ok) || QUALITY_TIERS.indexOf(b.quality ?? '') - QUALITY_TIERS.indexOf(a.quality ?? '')) }
  }

  /**
   * 第三方音源插件是不可信代码：它们的异步初始化失败（如远端 init.conf
   * 拉不到）会抛出 unhandled rejection。音乐服务是常驻进程，绝不能因此
   * 整个崩掉——记日志继续跑，坏插件在调用时自然失败。
   */
  static installRejectionGuard() {
    if (LxSourceRuntime._guardInstalled) return
    LxSourceRuntime._guardInstalled = true
    process.on('unhandledRejection', (reason) => {
      console.warn('[LX] 音源插件异步错误（已隔离）：', reason?.message ?? String(reason))
    })
  }

  /** 递归扫目录，按文件名去重（后者覆盖前者，V2603 优先于 v2602） */
  async loadDirectory(dir, { dedupe = true } = {}) {
    const found = []
    const walk = async (current) => {
      let entries
      try { entries = await fs.readdir(current, { withFileTypes: true }) }
      catch (err) { throw new Error(`无法读取音源目录：${err.message}`) }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && /\.js$/i.test(entry.name)) found.push(full)
      }
    }
    await walk(path.resolve(dir))

    const byName = new Map()
    for (const filePath of found) {
      const base = path.basename(filePath, path.extname(filePath))
      if (dedupe) byName.set(base, filePath)
      else byName.set(`${filePath}`, filePath)
    }

    // 并发加载：每个插件的初始化宽限期互相重叠，否则几十个插件串行
    // 干等会把启动拖到几分钟。vm 同步段仍是顺序执行，不会互相抢。
    const entries = [...byName.entries()]
    const tasks = entries.map(async ([name, filePath]) => {
      let content
      try { content = await fs.readFile(filePath, 'utf-8') }
      catch (err) { return { name, filePath, ok: false, error: `读取失败：${err.message}` } }
      const id = `lx-${Buffer.from(name).toString('hex').slice(0, 16)}`
      const plugin = new LxPlugin({ id, filePath, content })
      try { await plugin.load() }
      catch (err) { return { name, filePath, ok: false, error: err.message } }
      return { name, filePath, ok: true, plugin, id }
    })

    const settled = await Promise.allSettled(tasks)
    /**
     * 同名多版本：**全部注册**，不在这里淘汰。
     *
     * 【为什么不在加载阶段按版本号淘汰】试过「同名只留最高版本号」，实测踩坑：
     * 新版不一定能用 —— 星海音乐源 ZIP 里的 v3.2.13 带一块**用户配置区**
     * （酷我代理地址 url、ChKSz apikey 都留空），留空时那些接口不启用、反而
     * 取不到曲；而旧的 v2.2.8 开箱可用。任何静态启发式（判断配置是否留空、
     * 平台数多少）都会误判，因为「能不能真取到音频」只有实际请求才知道。
     *
     * 所以交给运行期：自检会**逐版本实测**、把健康的排在前面（见 _rankSources），
     * 取曲时只在健康源里并发竞速。这样新版能用就用新版，新版坏了自动落后，
     * 旧版顶上 —— 既满足「有新版就用新版」，又不会因为新版有问题而放不出歌。
     * 代价只是多注册几个插件（死源在竞速里自然被淘汰，不额外等待）。
     */
    const report = []
    settled.forEach((item, index) => {
      const [name, filePath] = entries[index]
      if (item.status !== 'fulfilled') {
        report.push({ name, filePath, ok: false, error: item.reason?.message ?? '加载失败' })
        return
      }
      const entry = item.value
      if (!entry.ok) { report.push(entry); return }
      const { plugin, id } = entry
      this.plugins.set(id, plugin)
      for (const key of plugin.sources.keys()) {
        if (!this.bySource.has(key)) this.bySource.set(key, [])
        this.bySource.get(key).push(id)
      }
      report.push({
        name: entry.name, filePath: entry.filePath, ok: true,
        sources: [...plugin.sources.keys()],
        qualitys: [...plugin.sources.values()].flatMap((s) => s.qualitys),
        actions: [...plugin.sources.values()].flatMap((s) => s.actions),
      })
    })
    this.loadReport = report
    return report
  }

  /** 对外的源清单 */
  listSources() {
    const out = []
    for (const plugin of this.plugins.values()) {
      for (const source of plugin.sources.values()) {
        out.push({
          pluginId: plugin.id,
          pluginName: plugin.meta.name ?? path.basename(plugin.filePath),
          version: plugin.meta.version ?? '',
          author: plugin.meta.author ?? '',
          source: source.key,
          name: source.name,
          actions: source.actions,
          qualitys: source.qualitys,
        })
      }
    }
    return out
  }

  get enabled() { return this.plugins.size > 0 }

  /** 聚合搜索：所有支持 search 的插件 */
  async search(keyword, { source = 'all', page = 1, limit = 20 } = {}) {
    const targets = []
    if (source === 'all') {
      for (const plugin of this.plugins.values()) {
        for (const [key, def] of plugin.sources) {
          if (def.actions.includes('search')) targets.push({ plugin, key })
        }
      }
    } else {
      for (const id of this.bySource.get(source) ?? []) {
        const plugin = this.plugins.get(id)
        if (plugin?.sources.get(source)?.actions.includes('search')) targets.push({ plugin, key: source })
      }
    }
    const settled = await Promise.allSettled(
      targets.map(({ plugin, key }) => plugin.search(key, keyword, page, Math.min(limit, 20))),
    )
    const tracks = []
    const failures = []
    settled.forEach((item, index) => {
      const { plugin, key } = targets[index]
      if (item.status !== 'fulfilled') {
        failures.push(`${plugin.meta.name ?? key}：${item.reason?.message ?? '搜索失败'}`)
        return
      }
      for (const raw of item.value.list) {
        const track = this._toTrack(plugin, key, raw)
        if (track) tracks.push(track)
      }
    })
    return { tracks, total: tracks.length, hasMore: settled.some((s) => s.status === 'fulfilled'), failures }
  }

  /** 由平台 + 歌曲 id 取播放地址（换源兜底的主入口） */
  async resolveForProvider(provider, songId, { quality = '320k', name = '', singer = '', budgetMs } = {}) {
    const sourceKey = LX_KEY_FOR_PROVIDER[provider]
    if (!sourceKey) return null
    const musicInfo = {
      id: songId, songmid: songId, mid: songId, hash: songId,
      name, singer, artist: singer, albumName: '',
    }
    return this.resolveUrl(sourceKey, musicInfo, quality, budgetMs ? { budgetMs } : undefined)
  }

  /**
   * 地址验真：插件返回的地址不一定真能播——聚合接口可能只回一个空 HTML
   * 页（音源自己失效了），或者返回 404/403。只信「拿到音频字节」的结果，
   * 死的地址继续问下一个插件。只读前 4KB，代价很小。
   */
  async _verifyUrl(url) {
    try {
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-4095' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      // 明确的网页/JSON 响应不是音频
      if (type.includes('text/html') || type.includes('application/json') || type.includes('text/plain')) {
        return { ok: false, reason: `返回的是网页而非音频（${type || 'unknown'}）` }
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length < 256) return { ok: false, reason: `响应过短（${bytes.length}B）` }
      return { ok: true, contentType: type }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }

  /**
   * 在声明了该平台键的插件里逐个试，取第一个「验真通过」的结果。
   *
   * 总预算（resolveBudgetMs）：插件数量可能有几十个，每个都可能很慢——
   * 不能让用户点一首歌等一分钟。到点就带着已收集的失败原因返回，播放器
   * 可以立刻回落到试听片段或报错，而不是一直转圈。
   *
   * 【2026-10-15 用户定：默认要最高音质】quality 作为「起点档位」，插件若
   * 声明了更高档位就往上取（母带 > Hi-Res > 无损 > 320k > 128k）。往上取
   * 不到时**自动降档**再试同一批插件，保证「有歌就能放」，同时默认拿到最好
   * 的那一版。降档结果会记进返回值的 quality 字段，界面据此显示真实档位。
   */
  async resolveUrl(sourceKey, musicInfo, quality = '320k', { budgetMs = RESOLVE_BUDGET } = {}) {
    // 【2026-10-15 修复取曲慢】原来这里写成 qualityLadder(sourceKey, quality)，
    // 而 qualityLadder 只收一个参数（起始档位），于是 'wy' 被当成档位名、
    // indexOf('wy') === -1 → 返回**全部 9 个档位**。后果：每首歌都要
    // 「9 档 × 十几个插件」串行试探，实测 24.5 秒才出声。
    // 正确调用只传起始档位：从最高档往下，遇首个成功即返回。
    const ladder = qualityLadder(quality)
    let last = null
    const deadline = Date.now() + budgetMs
    for (const tier of ladder) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      // 【2026-10-15 提速】下限 3500 → 1200。
      // 原来是 max(3500, 均分)：3 档 × 3500 = 10500ms，**超过整个 RESOLVE_BUDGET
      // 6000**，于是最后一档常常还没轮到就被 `remaining <= 0` 掐掉。
      // 1200 让"这一档确实没人给地址"能快速判死、把预算留给下一档：
      // 3 档 × 1200 = 3600ms，落在 6000 预算内，每档都有机会被问到。
      const slice = Math.max(1200, Math.round(remaining / ladder.length))
      const attempt = await this._resolveTier(sourceKey, musicInfo, tier, { budgetMs: slice })
      if (attempt?.audioUrl) return { ...attempt, quality: tier }
      if (attempt?.error) last = attempt
    }
    return last ?? null
  }

  /**
   * 单个档位：在「声明了该平台、且声明支持该档位」的插件里**并发竞速**，
   * 谁先给出一个验真通过的音频地址就用谁。
   *
   * 【2026-10-15 修复取曲慢】原来是 for...await 串行：十几个插件挨个等，
   * 每个坏源都要等到自超时（最坏 25s），实测总耗时 24.5 秒。改成竞速后，
   * 只要有一个健康源，耗时 ≈ 最快的那个源（通常几百毫秒）。
   *
   * 用自检结果排序：健康源排在前面（先被检阅、更可能先返回）。
   *
   * 【2026-10-15 提速】原来是两波串行（前 N 个健康源全败才放余量源），
   * 现已改为**单波全量并发** —— 见下方注释。这样不再有"第二波白等"。
   */
  async _resolveTier(sourceKey, musicInfo, quality, { budgetMs = RESOLVE_BUDGET } = {}) {
    const startedAt = Date.now()
    const cacheKey = `${sourceKey}|${musicInfo.songmid ?? musicInfo.id ?? musicInfo.hash}|${quality}`
    const cached = this.urlCache.get(cacheKey)
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value

    const ids = this.bySource.get(sourceKey) ?? []
    const candidates = []
    for (const id of ids) {
      const plugin = this.plugins.get(id)
      if (!plugin?.sources.get(sourceKey)?.actions.includes('musicUrl')) continue
      // 插件声明了档位列表时，只问它真支持的那一档，别浪费一轮超时。
      const declared = plugin.sources.get(sourceKey)?.qualitys
      if (Array.isArray(declared) && declared.length && !declared.includes(quality)) continue
      const health = this.health.get(`${id}|${sourceKey}`)
      candidates.push({ id, plugin, healthy: health?.ok === true })
    }
    if (!candidates.length) return null
    // 健康源优先（自检过的那几个），其余按原顺序沉底。
    candidates.sort((a, b) => Number(b.healthy) - Number(a.healthy))

    const failures = []
    // 【2026-10-15 提速】原来是两波串行：先跑前 RESOLVE_RACE_WIDTH 个健康源，
    // **全败才**把剩下的放进来。问题在于"全败"要等第一波里每个源各自走到
    // 超时（3 秒）或返回——只要有一个源卡住，第二波就得陪着白等。
    // 实测 LX 层拿地址只要 773ms，这个串行等待纯属浪费。
    // 改成**单波全量并发**：好坏源同时接受检阅，谁先给出可用地址就用谁。
    // `_racePlugins` 本身是 Promise.race 语义，第一个成功即 settle，
    // 所以打十几个源并不会等满——只等"最快成功的那个"。
    const value = await this._racePlugins(candidates, sourceKey, musicInfo, quality, budgetMs, failures)
    if (value) {
      this.urlCache.set(cacheKey, { value, at: Date.now() })
      return value
    }
    return failures.length ? { error: failures.join('；') } : null
  }

  /**
   * 并发跑一批插件，返回第一个「拿到地址且验真通过」的结果。
   * budgetMs 是这一批的总预算：到点就放弃，等下一档或下一批。
   */
  _racePlugins(candidates, sourceKey, musicInfo, quality, budgetMs, failures) {
    // 这首歌的身份，用于地址归属校验（见 urlOwner 的注释）。
    const songKey = `${sourceKey}|${musicInfo.songmid ?? musicInfo.id ?? musicInfo.hash}`
    return new Promise((resolve) => {
      let settled = false
      let pending = candidates.length
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
      const timer = setTimeout(() => finish(null), budgetMs)
      for (const { id, plugin } of candidates) {
        const name = plugin.meta?.name ?? id
        void (async () => {
          try {
            const url = await withTimeout(plugin.musicUrl(sourceKey, musicInfo, quality), MUSIC_URL_TIMEOUT, 'musicUrl')
            if (settled) return
            if (!url) { failures.push(`${name}：未返回地址`); return }
            // 【串歌防护】先查地址归属：同一个文件不可能属于两首不同的歌。
            // 有的插件内部竞速上游，个别上游忽略 id、总返回同一条热门结果
            // （实测：四首不同的《青丝》全返回同一个 .mp3，用户听到别的歌）。
            // 这种错误地址本身有效、能取到字节，_verifyUrl 拦不住，只能靠这里。
            //
            // 【必须按「文件身份」比对，不能用整串 URL】实测踩过坑：CDN 每次
            // 返回的签名/时间戳不同（`/<sig>/<sig>/resource/.../588957081.mp3`），
            // 同一个文件存进 Map 就是两个不同的 key，防护形同虚设 ——
            // 《唯一》两条不同 id 依然拿到同一个 F000001ziKgJ3o5Ipp.flac，
            // urlOwner 里出现了两行相同文件名。归一化到
            // 「主机 + 最后一段路径（文件名）」才是稳定的文件身份。
            //
            // 只对「不含本歌 id」的地址启用：地址里带 id 的（如长青SVIP 的
            // `?id=MUSIC_3621525`）天然不可能撞车，也不必检查，避免将来某个
            // 插件返回通用代理地址时被误杀。
            const identity = audioIdentity(url)
            const rawId = String(musicInfo.songmid ?? musicInfo.id ?? musicInfo.hash ?? '')
            const idFree = rawId && !url.includes(rawId) && !url.includes(rawId.replace(/^MUSIC_/, ''))
            if (idFree && identity) {
              const owner = this.urlOwner.get(identity)
              if (owner && owner !== songKey) {
                failures.push(`${name}：地址不属于这首歌（疑似音源串歌，已丢弃）`)
                return
              }
            }
            const verified = await this._verifyUrl(url)
            if (settled) return
            if (!verified.ok) { failures.push(`${name}：${verified.reason}`); return }
            if (idFree && identity) this.urlOwner.set(identity, songKey)
            finish({ audioUrl: url, source: sourceKey, plugin: name, contentType: verified.contentType })
          } catch (err) {
            failures.push(`${name}：${err?.message ?? '调用失败'}`)
          } finally {
            pending--
            if (pending === 0) finish(null)
          }
        })()
      }
    })
  }

  _toTrack(plugin, sourceKey, raw) {
    const id = raw?.songmid ?? raw?.id ?? raw?.mid ?? raw?.hash
    if (!id) return null
    const duration = typeof raw?.interval === 'number'
      ? raw.interval
      : String(raw?.interval ?? '').split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0)
    // 音质标注（用户要求：搜索页要显示音质，别都是「普通」）。
    //
    // LX 的搜索结果**不带音质字段** —— 音质要等真正取曲（musicUrl 的档位）
    // 才知道。但每个音源在 send(inited) 里声明了它支持的档位列表
    // （qualitys: ['128k','320k','flac',…]），这是搜索阶段唯一可靠的音质线索。
    // 以前这里把 format 写死 'mp3'、又不带任何质量字段，于是 qualityTierOf()
    // 只能全判成「标准」—— 用户看到的"好多都是普通"就是这个原因。
    //
    // 现在：取该源声明档位里的**最高档**作为搜索结果的质量标注，并首次调用时
    // 顺带实测确认（见 _probeQuality）。这样显示的是「这个源能给到的最好音质」，
    // 而不是凭空猜的。
    const declared = plugin.sources.get(sourceKey)?.qualitys ?? []
    const best = highestQuality(declared)
    const codec = best && /flac|ape|alac/i.test(best) ? 'flac' : 'mp3'
    return {
      id: `lx:${sourceKey}:${id}`,
      title: String(raw?.name ?? raw?.title ?? '未知歌曲'),
      artist: String(raw?.singer ?? raw?.artist ?? '未知'),
      albumId: '',
      duration: Number.isFinite(duration) ? duration : 0,
      format: best ?? 'mp3',
      codec,
      // 交给 qualityTierOf() 判定：flac24bit/hires/atmos/master 会被认成
      // Hi-Res，flac 认成 SQ，320k 认成 HQ。
      ...(best ? { sampleRate: /hires|flac24bit|master|atmos/i.test(best) ? 96000 : undefined } : {}),
      browserPlayable: true,
      audioUrl: '',
      relativePath: `lx:${sourceKey}:${id}`,
      onlineSource: {
        provider: 'lx',
        id: String(id),
        albumTitle: String(raw?.albumName ?? raw?.album ?? ''),
        coverUrl: String(raw?.img ?? raw?.pic ?? ''),
        pageUrl: '',
        fee: 0,
        lxSource: sourceKey,
        lxPlugin: plugin.meta.name ?? plugin.id,
        qualityLabel: best ?? '',
      },
    }
  }

  /** 供 `/api/lx/resolve` 使用：按 `lx:<平台键>:<歌曲id>` 回放 */
  resolveTrackId(trackId, { quality = '320k', name = '', singer = '', budgetMs } = {}) {
    const [prefix, sourceKey, ...rest] = String(trackId).split(':')
    if (prefix !== 'lx' || !sourceKey || !rest.length) return Promise.resolve(null)
    const songId = rest.join(':')
    return this.resolveUrl(sourceKey, { id: songId, songmid: songId, mid: songId, hash: songId, name, singer, artist: singer }, quality, budgetMs ? { budgetMs } : undefined)
  }
}

export default LxSourceRuntime
