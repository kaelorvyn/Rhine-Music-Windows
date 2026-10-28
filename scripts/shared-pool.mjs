import https from 'node:https';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withHardTimeout } from './hard-timeout.mjs';
import * as credentialStore from './pool-credential.mjs';

export let SERVER_LINES = [];

let signConfig = null;
let cryptoSpec = null;
let apiSpec = {};
let sourceSpec = {};
export let QUALITY_LADDER = [];
export let PROBE_PATH = '';

let signerCache = { key: null, line9: null };

/**
 * 签名健康状态。
 *
 * 【2026-10-26】原来 signedHeaders() 里 `catch { return {} }` —— 签不出签名就
 * 悄悄发一个无签名请求，服务端回 403，界面只显示「取源失败」，
 * 用户完全看不出是自己这台电脑缺设备密钥。
 *
 * 现在把最后一次失败的原因记在这里，由 pool-credential.status() 转成一句人话。
 */
export const signHealth = {
  ok: true,
  reason: '',        // 内部原因码：no_container / signer_failed / key_mismatch / ...
  detail: '',        // 补充说明（不含凭据）
  at: 0,
};

/** 记录一次签名失败。reason 用固定枚举，方便上层映射成文案。 */
function markSignFailure(reason, detail = '') {
  signHealth.ok = false;
  signHealth.reason = reason;
  signHealth.detail = String(detail ?? '').slice(0, 400);
  signHealth.at = Date.now();
}

/** 签名成功一次就把状态清干净。 */
function markSignOk() {
  if (!signHealth.ok && !signHealth.reason) return;
  signHealth.ok = true;
  signHealth.reason = '';
  signHealth.detail = '';
  signHealth.at = Date.now();
}

/** 供上层读取当前签名健康状态（只读）。 */
export function signingHealth() {
  return { ok: signHealth.ok, reason: signHealth.reason, detail: signHealth.detail, at: signHealth.at };
}

/**
 * 把签名器返回的 JSON 里的 error 字段翻译成原因码。
 * 容器不存在 = 这台电脑没登录过上游客户端，是最常见的一种。
 */
function classifySignerError(j) {
  const raw = String(j?.error ?? j?.message ?? '').trim();
  const e = raw.toUpperCase();
  if (!e) return ['signer_failed', '签名器没有返回签名'];
  if (e.includes('NO_KEY') || e.includes('NOT_FOUND') || e.includes('0X80090016')) {
    return ['no_container', '这台电脑的系统密钥容器里没有设备签名密钥（需要先在客户端里登录一次）'];
  }
  if (e.includes('0X8009002B') || e.includes('0X80090010') || e.includes('SIGN_FAIL')) {
    return ['signer_failed', '系统密钥容器拒绝了签名运算'];
  }
  return ['signer_failed', `签名失败：${raw.slice(0, 160)}`];
}

/** 从任意错误里尽量挖出结构化信息。 */
function safeParse(err) {
  const msg = String(err?.message ?? err ?? '');
  const m = msg.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 不是 JSON 就用原文 */ }
  }
  return { error: msg };
}

export function configureSigning(sign) {
  const ok = Boolean(sign
    && sign.signerScript
    && sign.emptyHash
    && Number(sign.nonceBytes) > 0
    && Array.isArray(sign.canonical) && sign.canonical.length
    && sign.headers
    && sign.headers.sign && sign.headers.signKey && sign.headers.version
    && sign.headers.migration && sign.headers.timestamp
    && sign.headers.nonce && sign.headers.device);
  signConfig = ok ? sign : null;
  signerCache = { key: null, line9: null };
}

export function configureCrypto(spec) {
  const ok = Boolean(spec && spec.cipher && Number(spec.ivBytes) > 0 && Number(spec.tagBytes) > 0);
  cryptoSpec = ok ? spec : null;
}

export function configureProtocol({ api, sources, qualities } = {}) {
  if (api && typeof api === 'object') apiSpec = { ...api };
  if (sources && typeof sources === 'object') sourceSpec = { ...sources };
  if (Array.isArray(qualities)) QUALITY_LADDER = qualities.map(String);
  if (apiSpec.probe) PROBE_PATH = apiSpec.probe;
}

export function signingReady() {
  return Boolean(signConfig && cryptoSpec && apiSpec.source);
}

function endpoint(name) {
  const value = apiSpec[name];
  if (!value) throw new Error('endpoint unavailable');
  return value;
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function rawSign(canonical) {
  const out = execFileSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', signConfig.signerScript],
    { input: canonical, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }).trim();
  const j = JSON.parse(out);
  if (j?.error) {
    // 保留原始错误内容，交给 classifySignerError 翻译成原因码 + 人话。
    const e = new Error(j.error);
    e.signerError = j;
    throw e;
  }
  return j;
}

function signedHeaders(method, path, body) {
  if (!signConfig) return {};
  try {
    if (!signerCache.key) {
      const probe = rawSign(signConfig.probeCanonical || signConfig.canonical.join('\n'));
      signerCache = { key: probe.key, line9: probe.line9 };
    }
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(signConfig.nonceBytes).toString('hex');
    const bodyHash = body && body.length ? sha256hex(body) : signConfig.emptyHash;
    const fields = {
      protocol: signConfig.protocol,
      method,
      path,
      timestamp: ts,
      nonce,
      bodyHash,
      tokenHash: sha256hex(authToken ?? ''),
      device: deviceId ?? '',
      keyHash: signerCache.line9 ?? '',
    };
    const canonical = signConfig.canonical.map((k) => fields[k] ?? '').join('\n');
    const r = rawSign(canonical);
    signerCache = { key: r.key, line9: r.line9 };
    const h = {};
    h[signConfig.headers.sign] = r.sign;
    h[signConfig.headers.signKey] = r.key;
    h[signConfig.headers.version] = signConfig.headerVersion;
    if (signConfig.headerMigration) h[signConfig.headers.migration] = signConfig.headerMigration;
    h[signConfig.headers.timestamp] = ts;
    h[signConfig.headers.nonce] = nonce;
    h[signConfig.headers.device] = deviceId;
    markSignOk();
    return h;
  } catch (err) {
    // 【2026-10-26】原来这里是 `catch { return {} }` —— 签不出签名就悄悄发
    // 一个无签名请求，服务端回 403，界面只显示「取源失败」，
    // 用户完全看不出是自己这台电脑缺设备密钥。
    // 现在把原因记下来，由 pool-credential.status() 转成一句人话。
    const [reason, detail] = classifySignerError(err?.signerError ?? safeParse(err?.message));
    markSignFailure(reason, detail);
    return {};
  }
}

export function configureServerLines(servers) {
  const list = (Array.isArray(servers) ? servers : [])
    .map((s, i) => {
      const raw = String(s ?? '').trim();
      if (!raw) return null;
      let host = '';
      try { host = new URL(raw).hostname; } catch { return null; }
      return { id: 'line_' + i, label: i === 0 ? '优先线路' : '备用线路', baseUrl: raw, host };
    })
    .filter(Boolean);

  SERVER_LINES.length = 0;
  SERVER_LINES.push(...list);

  lineState.activeId = SERVER_LINES[0]?.id ?? '';
  lineState.activeLabel = SERVER_LINES[0]?.label ?? '';
  lineState.activeBaseUrl = SERVER_LINES[0]?.baseUrl ?? '';
  lineState.allFailed = false;
  lineState.lastProbeAt = null;
  lineState.results = SERVER_LINES.map((line) => ({
    id: line.id, label: line.label, reachable: false, healthy: false, latency_ms: null, detail: '尚未探测',
  }));
}

export const LINE_PROBE_TIMEOUT_MS = 8000;

let authToken = null;
let cipherKeyBuf = null;
let deviceId = null;

const lineState = {
  activeId: SERVER_LINES[0]?.id,
  activeLabel: SERVER_LINES[0]?.label,
  activeBaseUrl: SERVER_LINES[0]?.baseUrl,
  probing: false,
  lastProbeAt: null,
  allFailed: false,
  results: [],
};

export function activeBaseUrl() {
  return lineState.activeBaseUrl || SERVER_LINES[0]?.baseUrl || '';
}

export function serverLineState() {
  return { ...lineState, results: lineState.results.map(r => ({ ...r })) };
}

function hostOf(baseUrl) {
  const line = SERVER_LINES.find(l => l.baseUrl === baseUrl);
  if (line) return line.host;
  try { return new URL(baseUrl).hostname; } catch { return SERVER_LINES[0]?.host ?? ''; }
}

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 30000,
  keepAliveMsecs: 15000,
});

export async function probeServerLines({ timeoutMs = LINE_PROBE_TIMEOUT_MS } = {}) {
  lineState.probing = true;
  const probeOne = async (line) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    let reachable = false, healthy = false, detail = '';
    try {
      const response = await withHardTimeout(
        fetch(`${line.baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authToken ?? ''}`,
            'Accept': 'application/json',
            'User-Agent': signConfig?.userAgent || 'rhine-music/0.1.1',
            ...signedHeaders('GET', PROBE_PATH, null),
          },
          signal: controller.signal,
        }),
        timeoutMs,
        { label: `${line.label} 探测`, controller },
      );
      reachable = true;
      healthy = response.status < 500 && response.status !== 404;
      detail = healthy ? `HTTP ${response.status}` : `HTTP ${response.status}`;
      response.body?.cancel?.().catch(() => {});
    } catch (error) {
      reachable = false;
      healthy = false;
      detail = error?.name === 'HardTimeoutError' ? `timeout ${timeoutMs}ms` : `${error?.message ?? error}`;
    }
    return {
      id: line.id, label: line.label, host: line.host,
      reachable, healthy,
      latency_ms: Date.now() - startedAt,
      detail,
    };
  };
  if (!SERVER_LINES.length || !PROBE_PATH) { lineState.probing = false; return serverLineState(); }

  // 只保留域名能解析的线路。解析不通就是不通用 —— 不显示、不探测、不参与排序。
  const resolved = await Promise.all(SERVER_LINES.map(async (line) => {
    try {
      await withHardTimeout(dns.lookup(line.host), timeoutMs, { label: line.label + ' DNS' });
      return line;
    } catch {
      return null;
    }
  }));
  if (resolved.some((line) => !line)) {
    const keep = resolved.filter(Boolean);
    SERVER_LINES.length = 0;
    SERVER_LINES.push(...keep);
    if (!keep.length) {
      lineState.probing = false;
      lineState.allFailed = true;
      lineState.results = [];
      lineState.lastProbeAt = new Date().toISOString();
      return serverLineState();
    }
    if (!keep.some((line) => line.baseUrl === lineState.activeBaseUrl)) {
      lineState.activeBaseUrl = keep[0].baseUrl;
      lineState.activeId = keep[0].id;
      lineState.activeLabel = keep[0].label;
    }
  }

  const probes = SERVER_LINES.map(probeOne);
  const toResults = (settled) => settled.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : {
        id: SERVER_LINES[i]?.id ?? '', label: SERVER_LINES[i]?.label ?? '',
        reachable: false, healthy: false, latency_ms: null,
        detail: `${r.reason?.message ?? r.reason}`,
      }));
  const winner = await Promise.any(
    probes.map(p => p.then(r => (r.healthy ? r : Promise.reject(new Error('unhealthy'))))),
  ).catch(() => null);
  let results;
  if (winner) {
    results = [winner];
    void Promise.allSettled(probes).then((all) => { lineState.results = toResults(all); });
  } else {
    results = toResults(await Promise.allSettled(probes));
  }

  const ranked = [...results].sort((a, b) => {
    if (a.healthy !== b.healthy) return Number(b.healthy) - Number(a.healthy);
    if (a.reachable !== b.reachable) return Number(b.reachable) - Number(a.reachable);
    return (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity);
  });
  const best = ranked[0];
  const allFailed = !ranked.some(r => r.healthy || r.reachable);

  lineState.probing = false;
  lineState.lastProbeAt = new Date().toISOString();
  lineState.allFailed = allFailed;
  lineState.results = results;
  if (!allFailed && best) {
    lineState.activeId = best.id;
    lineState.activeLabel = best.label;
    lineState.activeBaseUrl = SERVER_LINES.find(l => l.id === best.id)?.baseUrl ?? SERVER_LINES[0]?.baseUrl;
  } else {
    lineState.activeId = SERVER_LINES[0]?.id;
    lineState.activeLabel = SERVER_LINES[0]?.label;
    lineState.activeBaseUrl = SERVER_LINES[0]?.baseUrl;
  }
  return serverLineState();
}

const urlCache = new Map();

// 【2026-10-24 修「同一首歌怎么点都放不了」】
// 缓存没过期 ≠ 地址还活着：网易云/酷我的直链都是带签名、约几分钟到二十分钟就失效的临时地址。
// 缓存 10 分钟 + 命中直接返回 ⇒ 用户重试十次拿到的都是同一条死链，界面上就是「一直加载失败」。
// 所以命中缓存时先用 HEAD 验一下（老于 60s 的条目才验，新写入的不浪费这一次往返），
// 验不过就地删除，走真取源。
async function cachedUrlUsable(url, timeoutMs = 1800) {

  const probe = async (init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try { return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' }) }
    finally { clearTimeout(timer) }
  }
  try {
    const head = await probe({ method: 'HEAD' })
    // 有的 CDN 不吃 HEAD（405/501）：退一步用 1 字节 GET 探，别把可用地址误判成死的。
    if (head.status === 405 || head.status === 501) {
      const tiny = await probe({ headers: { Range: 'bytes=0-0' } })
      await tiny.body?.cancel().catch(() => {})
      return tiny.status === 200 || tiny.status === 206 || tiny.status === 416
    }
    return head.status === 200 || head.status === 206 || head.status === 416
  } catch { return false }
}

/**
 * 只把「真的能取到歌」的地址写进缓存。
 *
 * 用户要求（2026-10-24）：缓存里不该出现取不到歌的条目 —— 那等于把有害数据留下来，
 * 下次、下下次都拿同一条死链。所以写入前先 HEAD 验一次，验不过就不写。
 */
async function rememberUsableUrl(cacheKey, entry) {
  if (await cachedUrlUsable(entry.url)) { urlCache.set(cacheKey, entry); return true }
  urlCache.delete(cacheKey)
  return false
}

/** 播放端发现某平台的直链被拒（403/404/410）时，把该平台的缓存整片作废。 */
export function invalidatePoolUrlCache(provider) {
  const prefix = `${provider}:`
  for (const key of [...urlCache.keys()]) if (String(key).startsWith(prefix)) urlCache.delete(key)
}
const URL_CACHE_TTL = 10 * 60 * 1000;

let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 30000;

let quotaState = { limit: 50, used: 0, remaining: 50 };
const activeDownloads = new Map();

let inflightProbe = null;
const PROBE_FRESH_MS = 2000;

/**
 * 各平台的固定探针曲：检测「这个平台的上游能不能出货」用。
 * id 取自各平台自己的搜索（不是池子的 id），quality 用最低档 —— 这一跳只验证
 * 通路和延迟，不关心音质，省额度也省时间。
 */
export const POOL_PROBES = {
  kuwo: { songId: 'MUSIC_118980', name: '夜曲', artist: '周杰伦' },
  kugou: { songId: '16c8ab298231370293d16bcf9e5ff9b6', name: '夜曲', artist: '周杰伦' },
  qq: { songId: '001zMQr71F1Qo8', name: '夜曲', artist: '周杰伦' },
  netease: { songId: '2725685941', name: '夜曲', artist: '周杰伦' },
};

export const UPSTREAM_PROBE_TIMEOUT_MS = 10000;

/**
 * 逐平台探测上游：每个平台发一次最小的取源请求，量延迟。
 * 与线路探测相互独立 —— 线路挂了平台全红，线路正常也可能某个平台单独不通。
 */
export async function probeUpstreams({ timeoutMs = UPSTREAM_PROBE_TIMEOUT_MS } = {}) {
  const platforms = Object.keys(sourceSpec.alias ?? {});
  const targets = platforms.length ? platforms : Object.keys(POOL_PROBES);
  const runOne = async (platform) => {
    const probe = POOL_PROBES[platform];
    if (!probe) return { platform, ok: false, latency_ms: null, detail: '没有探针曲' };
    const startedAt = Date.now();
    try {
      const result = await withHardTimeout(
        resolveSong({ source: platform, songId: probe.songId, quality: 'standard', name: probe.name, artist: probe.artist, fresh: true }),
        timeoutMs,
        { label: platform + ' 上游' },
      );
      const latency = Date.now() - startedAt;
      if (result?.audioUrl) {
        return { platform, ok: true, latency_ms: latency, quality: result.actualQuality ?? 'standard', detail: result.format ?? '' };
      }
      return { platform, ok: false, latency_ms: latency, detail: result?.error ?? '未返回地址' };
    } catch (error) {
      const latency = Date.now() - startedAt;
      const timeout = error?.name === 'HardTimeoutError';
      return { platform, ok: false, latency_ms: timeout ? null : latency, detail: timeout ? '超时' : String(error?.message ?? error) };
    }
  };
  if (!SERVER_LINES.length || !credentialsReady()) return { upstreams: [] };
  const upstreams = await Promise.all(targets.map(runOne));
  return { upstreams };
}

export function probeServerLinesShared(opts) {
  if (inflightProbe) return inflightProbe;
  if (lineState.lastProbeAt && !lineState.allFailed) {
    const age = Date.now() - Date.parse(lineState.lastProbeAt);
    if (Number.isFinite(age) && age < PROBE_FRESH_MS) return Promise.resolve(serverLineState());
  }
  inflightProbe = probeServerLines(opts).finally(() => { inflightProbe = null; });
  return inflightProbe;
}

export function setCredentials({ token, key, did, sign, crypto: cryptoIn, api, sources, qualities }) {
  authToken = token;
  cipherKeyBuf = Buffer.from(key, 'base64');
  deviceId = did;
  if (sign) configureSigning(sign);
  if (cryptoIn) configureCrypto(cryptoIn);
  if (api || sources || qualities) configureProtocol({ api, sources, qualities });
  if (cipherKeyBuf.length !== 32) {
    throw new Error('session key invalid');
  }
  startHeartbeat();
  void probeServerLinesShared().catch(() => {});
}

export function loadFromImportedKey(dataDir) {
  const cred = credentialStore.read(dataDir);
  if (!cred) return null;
  setCredentials({
    token: cred.token,
    key: cred.key,
    did: cred.did,
    sign: cred.sign,
    crypto: cred.crypto,
    api: cred.api,
    sources: cred.sources,
    qualities: cred.qualities,
  });
  return cred;
}

/**
 * 移除密钥后把运行时状态清干净。
 *
 * 【2026-10-23 修「移除密钥还能测延迟」】
 * 原来 clear() 只删磁盘文件，内存里三样东西一样没动：
 *   · authToken / cipherKeyBuf —— credentialsReady() 仍为 true，池子还能被调用
 *   · SERVER_LINES            —— 线路表还在，/api/pool/lines/probe 照样探测
 *   · lineState.results       —— 上次的 598ms 还在，界面照旧显示
 * 于是「移除」之后照样能点亮延迟，等于没移除。
 */
export function resetPoolRuntime() {
  authToken = null;
  cipherKeyBuf = null;
  deviceId = null;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  configureServerLines([]);
  lineState.probing = false;
  lineState.lastProbeAt = null;
  lineState.allFailed = false;
  lineState.results = [];
}

export function credentialsReady() {
  return Boolean(authToken && cipherKeyBuf);
}

export function encrypt(plaintext) {
  if (!cryptoSpec) throw new Error('crypto spec unavailable');
  const nonce = crypto.randomBytes(cryptoSpec.ivBytes);
  const c = crypto.createCipheriv(cryptoSpec.cipher, cipherKeyBuf, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(encB64) {
  if (!cryptoSpec) throw new Error('crypto spec unavailable');
  const raw = Buffer.from(encB64, 'base64');
  const ivEnd = cryptoSpec.ivBytes;
  const tagEnd = ivEnd + cryptoSpec.tagBytes;
  const d = crypto.createDecipheriv(cryptoSpec.cipher, cipherKeyBuf, raw.subarray(0, ivEnd));
  d.setAuthTag(raw.subarray(ivEnd, tagEnd));
  return Buffer.concat([d.update(raw.subarray(tagEnd)), d.final()]).toString('utf8');
}

function autoDecrypt(body) {
  const field = cryptoSpec?.envelope || 'data';
  const value = body?.[field];
  if (value && typeof value === 'string' && value.length > 20) {
    try { return JSON.parse(decrypt(value)); } catch {}
  }
  return body;
}

export const POOL_REQUEST_TIMEOUT_MS = 9000;

async function rawRequest(method, path, bodyObj, { encrypted = false, timeoutMs = POOL_REQUEST_TIMEOUT_MS } = {}) {
  const primary = { baseUrl: activeBaseUrl(), hostname: hostOf(activeBaseUrl()) };
  const order = [primary, ...SERVER_LINES
    .filter(l => l.baseUrl !== primary.baseUrl)
    .map(l => ({ baseUrl: l.baseUrl, hostname: l.host }))];
  const once = (hostname, ms) => {
    const controller = new AbortController();
    let request = null;
    const attempt = new Promise((resolve, reject) => {
      let payload = null;
      if (bodyObj) {
        payload = encrypted
          ? JSON.stringify({ [cryptoSpec?.envelope || 'data']: encrypt(JSON.stringify(bodyObj)) })
          : JSON.stringify(bodyObj);
      }
      const headers = {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'User-Agent': signConfig?.userAgent || 'rhine-music/0.1.1',
        ...signedHeaders(method, path, payload),
      };
      request = https.request({
        hostname, port: 443, path, method,
        headers, agent, rejectUnauthorized: false, timeout: ms,
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          let j = null; try { j = JSON.parse(d); } catch { j = { raw: d.slice(0, 2000) }; }
          resolve({ status: res.statusCode, body: autoDecrypt(j) });
        });
      });
      request.on('error', reject);
      request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
      if (payload) request.write(payload);
      request.end();
    });
    controller.signal.addEventListener('abort', () => { try { request?.destroy(); } catch {} }, { once: true });
    return withHardTimeout(attempt, ms, { label: `${method} ${path}`, controller });
  };
  let lastError = null;
  for (const { baseUrl, hostname } of order) {
    try {
      const res = await once(hostname, timeoutMs);
      if (res.status >= 500) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const line = SERVER_LINES.find(l => l.baseUrl === baseUrl);
      lineState.activeBaseUrl = baseUrl;
      if (line) { lineState.activeId = line.id; lineState.activeLabel = line.label; }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('request failed');
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = () => {
    if (!apiSpec.heartbeat) return Promise.resolve();
    return rawRequest('POST', apiSpec.heartbeat, { device_id: deviceId, timestamp: Date.now() }).then((r) => {
      if (r.status === 401) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }).catch(() => {});
  };
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL);
  void beat();
}

export function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

export async function getMe() {
  return (await rawRequest('GET', endpoint('probe'))).body;
}

export async function getDownloadQuota() {
  const body = (await rawRequest('GET', endpoint('quota'))).body;
  if (body?.data) quotaState = body.data;
  return body;
}

function normalizeId(source, songId) {
  const key = String(source).toLowerCase();
  const prefix = sourceSpec.stripPrefix?.[key];
  const id = String(songId);
  if (!prefix) return id;
  return id.replace(new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
}

function sourceName(source) {
  const key = String(source).toLowerCase();
  const alias = sourceSpec.alias?.[key];
  if (alias) return String(alias);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export async function resolveSong({ source = '', songId, quality, name, artist, album, mid, fresh = false }) {
  const tier = quality ?? QUALITY_LADDER[0] ?? '';
  const normalizedId = normalizeId(source, songId);
  const cacheKey = `${source}:${normalizedId}:${tier}`;
  const cached = fresh ? undefined : urlCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < URL_CACHE_TTL) {
      const age = Date.now() - cached.ts
      if (age < 60_000 || await cachedUrlUsable(cached.url)) {
        return { audioUrl: cached.url, format: cached.format, ekey: cached.ekey, actualQuality: cached.actualQuality, bitrate: cached.bitrate, cached: true };
      }
      // 死链：删掉再走一次真取源，别把过期地址继续发给播放器。
      urlCache.delete(cacheKey)
    }

  const body = { song_id: normalizedId, source: sourceName(source), quality: String(tier), device_id: deviceId };
  if (name) body.name = name;
  if (artist) body.artist = artist;
  if (album) body.album = album;
  if (mid) body.mid = mid;

  try {
    const r = await rawRequest('POST', endpoint('source'), body, { encrypted: true });

    if (r.status === 200 && r.body?.code === 200 && r.body?.data?.url) {
      const d = r.body.data;
      const result = {
        audioUrl: d.url,
        format: d.format || 'mp3',
        ekey: d.ekey || null,
        actualQuality: d.actualQuality || d.quality || tier,
        bitrate: d.bitrate || 0,
      };
    await rememberUsableUrl(cacheKey, { url: result.audioUrl, format: result.format, ekey: result.ekey, actualQuality: result.actualQuality, bitrate: result.bitrate, ts: Date.now() })
      return result;
    }

    if (r.status === 200) {
      const url = extractAudioUrl(r.body);
      if (url) {
      await rememberUsableUrl(cacheKey, { url, format: 'unknown', ekey: null, ts: Date.now() })
        return { audioUrl: url, format: 'unknown', ekey: null };
      }
    }

    return { error: r.body?.msg || `http_${r.status}` };
  } catch (e) {
    return { error: e.message };
  }
}

export async function resolveSongBest({ source, songId, quality, name, artist, album, mid }) {
  if (!SERVER_LINES.length) return { error: 'pool_disabled' };
  const tier = quality ?? QUALITY_LADDER[0] ?? '';
  const r = await resolveSong({ source, songId, quality: tier, name, artist, album, mid });
  if (r.audioUrl) return { ...r, requestedQuality: tier };
  return { error: r.error || 'no_quality_available' };
}

export async function commitQuota(songId) {
  const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const r = await rawRequest('POST', endpoint('quotaCommit'), {
      download_id: downloadId, song_id: String(songId), device_id: deviceId,
    }, { encrypted: true });
    if (r.status === 200) {
      activeDownloads.set(downloadId, { songId, ts: Date.now() });
      return { downloadId, ok: true };
    }
    return { downloadId, ok: false, error: r.body?.msg };
  } catch (e) {
    return { downloadId, ok: false, error: e.message };
  }
}

export async function releaseQuota(downloadId) {
  try {
    const r = await rawRequest('POST', endpoint('quotaRelease'), {
      download_id: downloadId, device_id: deviceId,
    }, { encrypted: true });
    activeDownloads.delete(downloadId);
    return { ok: r.status === 200 };
  } catch {
    return { ok: false };
  }
}

export async function getSharedPlayers() {
  try { return (await rawRequest('POST', endpoint('group'), {}, { encrypted: true })).body; }
  catch (e) { return { error: e.message }; }
}

export async function getMusicAccounts() {
  try { return (await rawRequest('GET', endpoint('accounts'))).body; }
  catch (e) { return { error: e.message }; }
}

function extractAudioUrl(body) {
  if (!body) return null;
  if (typeof body === 'string' && /^https?:\/\//.test(body)) return body;
  for (const key of ['audioUrl', 'url', 'downloadUrl', 'playUrl', 'filePath', 'src', 'audio_url', 'play_url', 'download_url']) {
    const v = body[key] || body.data?.[key] || body.result?.[key];
    if (v && /^https?:\/\//.test(String(v))) return String(v);
  }
  const jsonStr = JSON.stringify(body);
  const m = jsonStr.match(/https?:\/\/[^"'\s<>]{30,300}\.(?:mp3|flac|m4a|aac|ogg|wav|mgg)/i);
  if (m) return m[0];
  const m2 = jsonStr.match(/https?:\/\/[^"'\s<>]{30,300}/);
  return m2 ? m2[0] : null;
}
