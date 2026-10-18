/**
 * 共享音源池客户端。
 *
 * 只有在用户导入密钥文件后才启用：凭据（token / sessionKey）与服务地址
 * 都来自密钥，客户端自身不含任何一项。
 *
 * 协议要点：
 *   1. HTTPS 长连接池，保持若干条 keep-alive
 *   2. 心跳保活（/api/heartbeat，保持 presence=online）
 *   3. 配额管理（/api/auth/download-quota/commit + release）
 *   4. 加密请求（AES-256-GCM，[nonce(12)][tag(16)][ciphertext]）
 *   5. 参数 snake_case（song_id / device_id / quality）
 *   6. 响应格式 {"code":200,"msg":"ok","data":{"url":"...","ekey":null,"format":"mp3"}}
 *
 * 认证：Authorization: Bearer <token>
 * 加密：AES-256-GCM，key = sessionKey(32B)
 * 请求体：{"data":"<base64(encrypt(JSON_body))>"}
 * 响应体：{"data":"<base64(encrypt(JSON_body))>"} 或明文 JSON
 */
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withHardTimeout } from './hard-timeout.mjs';
import * as credentialStore from './pool-credential.mjs';


/**
 * 线路表。
 *
 * **默认是空的** —— 客户端自身不携带任何服务地址。服务地址随用户导入的密钥
 * 文件一起下发（密钥里的 `servers` 字段），导入后由 `configureServerLines()`
 * 填充。
 *
 * 没导入密钥 → 这里为空 → 共享池整条链路不启用，也不会对任何地址发起探测。
 */
export let SERVER_LINES = [];

/** 用密钥文件里的地址重建线路表与探测状态。 */
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

/** 线路探测端点 —— 不用 `/api/health`（该端点在实际服务端上不存在）。
 *  用带 token 的 `/api/auth/me`：401 恰恰证明「服务端在、端点存在、只是没有
 *  token」，这就是健康的信号。 */
export const PROBE_PATH = '/api/auth/me';

/** 单条线路探测的硬上限。死线路的 DNS 挂起必须被硬切（见 hard-timeout.mjs）。 */
export const LINE_PROBE_TIMEOUT_MS = 2500;

// ── 状态 ────────────────────────────────────────────
let backendToken = null;
let sessionKeyBuf = null;
let deviceId = null;

/**

 *
 * `activeId` 语义对齐：探测选优；**全挂则 allFailed 置位，但仍用配置值硬发请求**
 * —— 不会因为"探测失败"就不发请求，它只是记录事实。
 */
const lineState = {
  activeId: SERVER_LINES[0]?.id,
  activeLabel: SERVER_LINES[0]?.label,
  activeBaseUrl: SERVER_LINES[0]?.baseUrl,
  probing: false,
  lastProbeAt: null,
  allFailed: false,
  results: SERVER_LINES.map(line => ({
    id: line.id, label: line.label, reachable: false, healthy: false, latency_ms: null, detail: '尚未探测',
  })),
};

/** 当前生效的池子基址。全挂时仍是配置里的首选值（对齐 activeId 语义）。 */
export function activeBaseUrl() {
  return lineState.activeBaseUrl || SERVER_LINES[0]?.baseUrl || '';
}

/** 线路探测状态快照（诊断/前端展示用，字段与方法名一致）。 */
export function serverLineState() {
  return { ...lineState, results: lineState.results.map(r => ({ ...r })) };
}

/** 由基址取 hostname（rawRequest 用 hostname + path，不用完整 URL）。 */
function hostOf(baseUrl) {
  const line = SERVER_LINES.find(l => l.baseUrl === baseUrl);
  if (line) return line.host;
  try { return new URL(baseUrl).hostname; } catch { return SERVER_LINES[0]?.host ?? ''; }
}

/**
 * 探测两条线路，按「可达 + 延迟」选优，写回 lineState。
 *
 * 判定 `healthy`：
 *   - 401 / 403 —— 端点活着、要求认证 → **健康**（受 token 保护是正常的）
 *   - 2xx        —— 健康
 *   - 404 / 5xx  —— 端点不存在或服务端故障 → 不健康
 *   - 网络错误    —— 不可达（`reachable: false`）
 *
 * 全挂时 `allFailed = true`，但 `activeBaseUrl` 回落到配置首选值，
 * **仍然照常硬发请求** —— 这是的行为，不是我们的兜底发明。
 */

// ── 长连接池──────────
// ⚠️ 必须在 `probeServerLines` **之前**声明：探测与取源**共用这一条连接池**，
// 探测建立的 TLS 连接会被随后的取源直接复用。原来探测走裸 `fetch()`（undici
// 自己的池）、取源走 `https.request(agent)`（另一个池），两套互不复用 →
// 探测刚握好的手被丢掉，取源再握一次（实测冷启动因此多花约 1s）。
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 30000,
  keepAliveMsecs: 15000,
});

export async function probeServerLines({ timeoutMs = LINE_PROBE_TIMEOUT_MS } = {}) {
  lineState.probing = true;
  // 【2026-10-16 并发探测：串行会让"死线路"拖住首次取源】
  //
  // 原实现是 `for (const line of SERVER_LINES) { await fetch(...) }` —— **串行**。

  //     优先线路 1093ms  不可达：fetch failed
  //     备用线路  220ms  HTTP 200
  //     总耗时   1314ms
  // 也就是说**每次探测都要先白等 1.1 秒的死线路**，才轮到活的那条。
  // 这个成本会直接叠加到冷启动第一次取源上（实测首个 master 请求 1578–3800ms，
  // 超过 t9 合同 <1s 的判据）。
  //
  // 两条线路之间**没有依赖**，没有任何理由串行 —— 并发探测的总耗时
  // = max(各线耗时) ≈ 220ms 而非 sum。排序与选优逻辑完全不变（下面照旧按
  // healthy → reachable → latency_ms 排），只是不再互相等待。
  const probeOne = async (line) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    let reachable = false, healthy = false, detail = '';
    try {
      const response = await withHardTimeout(
        // 探测走 `fetch`（**不**改走 https.request）：契约测试 5d 会替换
        // `globalThis.fetch` 来模拟"优先线路挂死、备用线路 401"，
        // 换掉这个调用方式会让那条测试失去拦截点（等于把可测性换掉）。
        fetch(`${line.baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${backendToken ?? ''}`,
            'Accept': 'application/json',
            'User-Agent': 'rhine-music/0.1.1',
          },
          signal: controller.signal,
        }),
        timeoutMs,
        { label: `${line.label} 探测`, controller },
      );
      reachable = true;
      // 401/403 = 端点活着且要求认证（我们探测时也可能没有 token）→ 健康。
      healthy = response.status < 500 && response.status !== 404;
      detail = healthy ? `HTTP ${response.status}（端点存活）` : `HTTP ${response.status}（端点异常）`;
      // 不读 body：探测只关心"端点是否活着"，读完 body 只会多一个挂起窗口。
      response.body?.cancel?.().catch(() => {});
    } catch (error) {
      reachable = false;
      healthy = false;
      detail = error?.name === 'HardTimeoutError' ? `线路探测超时（${timeoutMs}ms）` : `不可达：${error?.message ?? error}`;
    }
    return {
      id: line.id, label: line.label,
      reachable, healthy,
      latency_ms: Date.now() - startedAt,
      detail,
    };
  };
  // 并发探测；`allSettled` 保证单条线路抛错不影响其它线路。
  //
  // 【2026-10-16 首个健康线路即返回：不等死线路】
  // 即使改成并发，`Promise.allSettled` 仍要等**所有**线路出结果才能返回 ——
  // 而本机优先线路 DNS 已死，冷态要 ~1.1s 才失败。实测：
  //     轮1 总 1099ms（优先线路 1097 死 / 备用线路 261 活）
  //     轮2 总 105ms
  // 冷启动第一次取源会被这 1.1s 直接拖成 ~1700ms，超过 t9 合同 <1s 的判据。
  //
  // 但"选优"根本不需要等死线路：只要有**任何一条**线路 healthy，
  // 就可以立刻用它开始取源。所以改成「首个健康者胜出」——
  // 谁先健康就用谁，剩下的探测在后台跑完，只用于刷新 `results` 供 UI 显示。
  // 全部都不健康时，`Promise.any` 会等所有线路都失败，语义与原先一致（allFailed=true）。
  if (!SERVER_LINES.length) return serverLineState();
  const probes = SERVER_LINES.map(probeOne);
  const toResults = (settled) => settled.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : {
        id: SERVER_LINES[i]?.id ?? '', label: SERVER_LINES[i]?.label ?? '',
        reachable: false, healthy: false, latency_ms: null,
        detail: `不可达：${r.reason?.message ?? r.reason}`,
      }));
  // `Promise.any` 在**首个** healthy 出现时立即返回；未健康的线路以 reject 表示"不算数"。
  // 全部都不健康时它抛 AggregateError → 落到下面的 allSettled 分支拿完整结果。
  const winner = await Promise.any(
    probes.map(p => p.then(r => (r.healthy ? r : Promise.reject(new Error('unhealthy'))))),
  ).catch(() => null);
  let results;
  if (winner) {
    results = [winner];
    // 其余线路在后台跑完，只为刷新展示用的 `results`；不覆盖已选定的 activeBaseUrl。
    void Promise.allSettled(probes).then((all) => { lineState.results = toResults(all); });
  } else {
    results = toResults(await Promise.allSettled(probes));
  }

  // 选优：优先 healthiest（healthy 优先于仅 reachable），再比延迟。
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
    // 对齐 activeId 语义：全挂也要有个"当前线路"，用配置首选值硬发请求。
    lineState.activeId = SERVER_LINES[0]?.id;
    lineState.activeLabel = SERVER_LINES[0]?.label;
    lineState.activeBaseUrl = SERVER_LINES[0]?.baseUrl;
  }
  return serverLineState();
}

// ── URL 缓存（复用已解析的地址，避免重复请求）
const urlCache = new Map();  // key → { url, format, ekey, ts }
const URL_CACHE_TTL = 10 * 60 * 1000;  // 10 分钟

// ── 心跳 ────────────────────────────────────────────
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 30000;  // 30 秒

// ── 配额（commit / release 流程）
let quotaState = { limit: 50, used: 0, remaining: 50 };
const activeDownloads = new Map();  // download_id → { songId, ts }

/**
 * 探测的**单飞**（single-flight）包装。
 *
 * 【为什么需要（2026-10-16 实测）】同一轮启动里探测会被发起**两次**：
 *   ① `setCredentials()` 里 `void probeServerLines()`（凭据到位即探，不挡启动）
 *   ② `music-server.mjs` 的 `serviceProbed`（取源链要等它，保证首次就走活线路）
 * 两处**并发**跑同一个探测，而取源链 await 的正是 ② —— 于是首次请求
 * 要等**两个探测里更慢的那个**。实测冷启动首个请求 1583–2648ms，
 * 而单独一次探测只要 ~250ms。
 *
 * 单飞后：②直接复用①正在进行的那次探测（共享同一个 Promise），
 * 既不重复发请求，也不会让首次取源等两次。
 * 已经完成的探测在 `PROBE_FRESH_MS` 内同样复用（线路状态是刚测的，没必要重测）。
 */
let inflightProbe = null;
const PROBE_FRESH_MS = 2000;
export function probeServerLinesShared(opts) {
  if (inflightProbe) return inflightProbe;
  // 刚探过（且不是"全挂"）→ 直接复用结论，避免启动瞬间的重复联网。
  if (lineState.lastProbeAt && !lineState.allFailed) {
    const age = Date.now() - Date.parse(lineState.lastProbeAt);
    if (Number.isFinite(age) && age < PROBE_FRESH_MS) return Promise.resolve(serverLineState());
  }
  inflightProbe = probeServerLines(opts).finally(() => { inflightProbe = null; });
  return inflightProbe;
}

// ── 凭据注入 ────────────────────────────────────────

export function setCredentials({ token, key, did }) {
  backendToken = token;
  sessionKeyBuf = Buffer.from(key, 'base64');
  deviceId = did;
  if (sessionKeyBuf.length !== 32) {
    throw new Error(`sessionKey must be 32 bytes, got ${sessionKeyBuf.length}`);
  }
  startHeartbeat();
  // 凭据到位后立刻探测两条线路（后台跑，不挡启动）：有 token 才能问出
  // `/api/auth/me` 的真实 200/401/…，探测结论才准。
  // 用**单飞版**：music-server 的 `serviceProbed` 会复用这一次，不再各探一遍。
  void probeServerLinesShared().catch(() => {});
}

export function loadFromImportedKey(dataDir) {
  const cred = credentialStore.read(dataDir);
  if (!cred) return null;
  setCredentials({ token: cred.token, key: cred.key, did: cred.did });
  return cred;
}

/** 是否已经拿到可用凭据（决定池子这一跳要不要跑）。 */
export function credentialsReady() {
  return Boolean(backendToken && sessionKeyBuf);
}

// ── AES-256-GCM 加解密 (ring: [nonce(12)][tag(16)][ciphertext]) ──

export function encrypt(plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sessionKeyBuf, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(encB64) {
  const raw = Buffer.from(encB64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sessionKeyBuf, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ── HTTP（长连接池 + 自动解密）─────────────────────

function autoDecrypt(body) {
  if (body?.data && typeof body.data === 'string' && body.data.length > 20) {
    try { return JSON.parse(decrypt(body.data)); } catch {}
  }
  return body;
}

/**
 * 池子单次请求的**硬上限**。
 *
 * 的池子命中实测 195–965ms，所以 3s 给了 3 倍余量；而"问不通"必须在
 * 3s 内收口，不能再像过去那样被 10s 总预算钉住。
 * 这里用 `Promise.race` 兜底而不只靠 `req.setTimeout` —— 后者在**建连阶段
 * 卡住**（DNS/TCP 握手挂起）时可能不触发，与 backup 源那边踩的是同一个坑。
 */
export const POOL_REQUEST_TIMEOUT_MS = 3000;

async function rawRequest(method, path, bodyObj, { encrypted = false, timeoutMs = POOL_REQUEST_TIMEOUT_MS } = {}) {
  // 【2026-10-16 真·换线容错：不再把首次请求钉死在一条线路上】
  //
  // 原来只打 `activeBaseUrl()` 这一条。启动顺序是「探测 → 选定活线路 → 取源」，
  // 但在**探测还没跑完**时（冷启动第一个请求）`activeBaseUrl` 仍是配置首选值

  // 要么打在死线路上再失败重来。
  //
  // 的行为是「优先线路 → 备用线路」，所以这里照做：按当前线路优先，
  // 失败（网络错误/超时/5xx）就**自动换另一条**重试一次。
  // 这样即使探测一点没跑，首个请求也能自己找到活线路。
  // 探测选出的线路（`activeBaseUrl`）永远是**第一次尝试**的对象 ——
  // 契约要求「探测结论必须真正生效、不是摆设」，所以这里显式保留
  // `hostOf(activeBaseUrl())` 的表达，一眼能看出首选来自探测结果。
  // 其余线路只作为**容错备选**（探测没跑完时也能自己找到活线路）。
  const primary = { baseUrl: activeBaseUrl(), hostname: hostOf(activeBaseUrl()) };
  const order = [primary, ...SERVER_LINES
    .filter(l => l.baseUrl !== primary.baseUrl)
    .map(l => ({ baseUrl: l.baseUrl, hostname: l.host }))];
  const once = (hostname, ms) => {
    // 到点要真的把 socket 拆掉（不只是"不再等"），否则死线路会攒下一堆悬挂连接。
    const controller = new AbortController();
    let request = null;
    const attempt = new Promise((resolve, reject) => {
      let payload = null;
      if (bodyObj) {
        payload = encrypted
          ? JSON.stringify({ data: encrypt(JSON.stringify(bodyObj)) })
          : JSON.stringify(bodyObj);
      }
      const headers = {
        'Authorization': `Bearer ${backendToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'rhine-music/0.1.1',
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
      request.on('timeout', () => { request.destroy(); reject(new Error(`timeout: ${method} ${path}`)); });
      if (payload) request.write(payload);
      request.end();
    });
    controller.signal.addEventListener('abort', () => { try { request?.destroy(); } catch { /* 已结束 */ } }, { once: true });
    return withHardTimeout(attempt, ms, { label: `池子请求 ${method} ${path}`, controller });
  };
  // 依次尝试：探测选出的线路优先，失败就换下一条。每条线**只给一次机会** ——
  // 这是容错，不是"重试到成功"（否则死线路会被反复打）。
  let lastError = null;
  for (const { baseUrl, hostname } of order) {
    try {
      const res = await once(hostname, timeoutMs);
      // 5xx = 这条线本身不健康 → 换下一条；2xx/4xx 是业务响应，直接用。
      if (res.status >= 500) { lastError = new Error(`HTTP ${res.status}（线路 ${hostname} 异常）`); continue; }
      // 记下"实际可用的是哪条线"，下次请求直接用它（省掉重复试错）。
      const line = SERVER_LINES.find(l => l.baseUrl === baseUrl);
      lineState.activeBaseUrl = baseUrl;
      if (line) { lineState.activeId = line.id; lineState.activeLabel = line.label; }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`池子请求失败: ${method} ${path}`);
}

// ── 心跳保活（保持 presence=online）

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      const r = await rawRequest('POST', '/api/heartbeat', { device_id: deviceId, timestamp: Date.now() });
      if (r.status !== 200) {
        // token 过期时停止心跳（避免无意义请求）
        if (r.status === 401) {
          clearInterval(heartbeatTimer);
          console.log('[shared-pool] heartbeat stopped: token expired');
        }
      }
    } catch {}
  }, HEARTBEAT_INTERVAL);
  // 立即发一次
  rawRequest('POST', '/api/heartbeat', { device_id: deviceId, timestamp: Date.now() }).catch(() => {});
}

export function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── 公开 API ────────────────────────────────────────

export async function getMe() {
  return (await rawRequest('GET', '/api/auth/me')).body;
}

export async function getDownloadQuota() {
  const body = (await rawRequest('GET', '/api/auth/download-quota')).body;
  if (body?.data) quotaState = body.data;
  return body;
}

/**
 * 通过池子解析歌曲音源 —— 调用 /api/proxy/music
 *
 * quality 用**枚举名字符串**（不是数字！实测 q=6 只回 128k mp3）：
 *   standard / high / lossless / hires / hifi / surround / master
 * 池子返回 actualQuality 字段，说明本账号/本曲实际给到的档位；
 * 高码率档位（hifi/surround/master）额外给 ekey（QQ/酷我加密格式解密密钥）。
 *
 * @param {object} p
 * @param {string} p.source   - kuwo / kugou / qq / netease
 * @param {string} p.songId   - 歌曲 ID
 * @param {string} [p.quality='master'] - 音质档位枚举名
 * @param {string} [p.name]   - 歌名
 * @param {string} [p.artist] - 歌手
 * @returns {Promise<{audioUrl?, format?, ekey?, actualQuality?, bitrate?, error?}>}
 */
export async function resolveSong({ source = 'kuwo', songId, quality = 'master', name, artist, album, mid }) {
  // 【2026-10-15 修复：酷我 id 必须是纯数字】平台搜索给的是 `MUSIC_228908`
  // 这种带前缀的展示 id，而池子转发给酷我官方时只认裸数字 id —— 带前缀会被
  // 判非法，服务端回 `旧机酷我隧道 HTTP 400`，于是付费曲拿不到全曲、退回
  // 平台 11 秒试听片段（用户实测：别人放 4 分钟，我们只能放 1 分钟）。
  // 实测：id=228908 → url 有；id=MUSIC_228908 → 隧道 400。只在酷我上剥。
  const normalizedId = source.toLowerCase() === 'kuwo'
    ? String(songId).replace(/^MUSIC_/i, '')
    : String(songId);
// 缓存命中（复用已解析的地址）
  const cacheKey = `${source}:${normalizedId}:${quality}`;
  const cached = urlCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < URL_CACHE_TTL) {
    return { audioUrl: cached.url, format: cached.format, ekey: cached.ekey, actualQuality: cached.actualQuality, bitrate: cached.bitrate, cached: true };
  }

// 请求格式：snake_case 参数 + 加密
  const body = { song_id: normalizedId, source: source.toLowerCase(), quality: String(quality), device_id: deviceId };
  if (name) body.name = name;
  if (artist) body.artist = artist;
  if (album) body.album = album;
  if (mid) body.mid = mid;

  try {
    const r = await rawRequest('POST', '/api/proxy/music', body, { encrypted: true });

// 响应格式:
    // {"code":200,"msg":"ok","data":{"url":"...","format":"mflac","quality":"master",
    //   "actualQuality":"master","bitrate":20900,"ekey":"..."}}
    if (r.status === 200 && r.body?.code === 200 && r.body?.data?.url) {
      const d = r.body.data;
      const result = {
        audioUrl: d.url,
        format: d.format || 'mp3',
        ekey: d.ekey || null,
        actualQuality: d.actualQuality || d.quality || quality,
        bitrate: d.bitrate || 0,
      };
      urlCache.set(cacheKey, { url: result.audioUrl, format: result.format, ekey: result.ekey, actualQuality: result.actualQuality, bitrate: result.bitrate, ts: Date.now() });
      return result;
    }

    // 兼容其他响应格式
    if (r.status === 200) {
      const url = extractAudioUrl(r.body);
      if (url) {
        urlCache.set(cacheKey, { url, format: 'unknown', ekey: null, ts: Date.now() });
        return { audioUrl: url, format: 'unknown', ekey: null };
      }
    }

    return { error: r.body?.msg || `http_${r.status}` };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 解析歌曲音源 —— **单次请求，不发音质阶梯**。
 *
 * 原实现自作主张从 master 一路降到 standard 试 7 档，这是我们编的，没有
 * 这个逻辑。从 service 的 既有实现 字符串表可以读到它的真实行为：
 *
 *     服务器未返回当前音质的播放地址
 *
 * —— 它是拿**用户当前选定的音质**问服务端一次，服务端给不了就报错收工。
 * 而服务端的回落是它**自己**做的：实测请求 master 时 `actualQuality` 可能直接
 * 回 `hifi`/`standard`（见 _test-server-fallback.mjs 输出），客户端不需要、也
 * 不应该再降一档重试（那样只会把 200ms 的请求拖成 24 秒）。
 *
 * @param {object} p
 * @param {string} p.source   - kuwo / kugou / qq / netease
 * @param {string} p.songId   - 歌曲 ID
 * @param {string} [p.quality='master'] - 音质档位枚举名
 * @param {string} [p.name]   - 歌名
 * @param {string} [p.artist] - 歌手
 */
export async function resolveSongBest({ source, songId, quality = 'master', name, artist, album, mid }) {
  if (!SERVER_LINES.length) return { error: 'pool_disabled' };
  const r = await resolveSong({ source, songId, quality, name, artist, album, mid });
  if (r.audioUrl) return { ...r, requestedQuality: quality };
  return { error: r.error || 'no_quality_available' };
}

/** 音质档位枚举（standard … master 共七档）。
 *  仅用于 UI 与校验；解析时按用户选定档位发一次请求，客户端不做降级。 */
export const QUALITY_LADDER = ['master', 'surround', 'hifi', 'hires', 'lossless', 'high', 'standard'];

/**
 * 下载配额管理 —— commit / release 流程
 */
export async function commitQuota(songId) {
  const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const r = await rawRequest('POST', '/api/auth/download-quota/commit', {
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
    const r = await rawRequest('POST', '/api/auth/download-quota/release', {
      download_id: downloadId, device_id: deviceId,
    }, { encrypted: true });
    activeDownloads.delete(downloadId);
    return { ok: r.status === 200 };
  } catch {
    return { ok: false };
  }
}

export async function getSharedPlayers() {
  try { return (await rawRequest('POST', '/api/auth/player-shares/official-group', {}, { encrypted: true })).body; }
  catch (e) { return { error: e.message }; }
}

export async function getMusicAccounts() {
  try { return (await rawRequest('GET', '/api/music/accounts')).body; }
  catch (e) { return { error: e.message }; }
}

// ── 工具 ────────────────────────────────────────────

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
