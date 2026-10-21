import https from 'node:https';
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
  if (j?.error) throw new Error('signer error');
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
    return h;
  } catch {
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

export const LINE_PROBE_TIMEOUT_MS = 2500;

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
      id: line.id, label: line.label,
      reachable, healthy,
      latency_ms: Date.now() - startedAt,
      detail,
    };
  };
  if (!SERVER_LINES.length || !PROBE_PATH) { lineState.probing = false; return serverLineState(); }
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
const URL_CACHE_TTL = 10 * 60 * 1000;

let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 30000;

let quotaState = { limit: 50, used: 0, remaining: 50 };
const activeDownloads = new Map();

let inflightProbe = null;
const PROBE_FRESH_MS = 2000;

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

export const POOL_REQUEST_TIMEOUT_MS = 3000;

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

export async function resolveSong({ source = '', songId, quality, name, artist, album, mid }) {
  const tier = quality ?? QUALITY_LADDER[0] ?? '';
  const normalizedId = normalizeId(source, songId);
  const cacheKey = `${source}:${normalizedId}:${tier}`;
  const cached = urlCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < URL_CACHE_TTL) {
    return { audioUrl: cached.url, format: cached.format, ekey: cached.ekey, actualQuality: cached.actualQuality, bitrate: cached.bitrate, cached: true };
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
      urlCache.set(cacheKey, { url: result.audioUrl, format: result.format, ekey: result.ekey, actualQuality: result.actualQuality, bitrate: result.bitrate, ts: Date.now() });
      return result;
    }

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
