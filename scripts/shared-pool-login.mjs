/**
 * 共享音源 —— 设备登录（扫码授权）。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────
 *
 * 服务端给每个设备登记一对 (device_id, 公钥)，请求头 `x-sign` 用这把私钥签名。
 * 密钥文件里带的私钥只对「生成它的那台电脑」有效 —— 换一台电脑，
 * 服务端拿新公钥跟已登记的那些一对不上，就回 403（SIGN_KEY_MISMATCH）。
 *
 * 这套流程让**任何一台电脑**都能自己登记：
 *   1. 本机生成一对新密钥（私钥留本机）
 *   2. 调 /api/auth/qr/create 拿一个二维码
 *   3. 用户用手机上的客户端扫一下 → 服务端把这个 (device_id, 公钥) 登记到账号下
 *   4. 轮询 /api/auth/qr/status 拿到 token
 *
 * 拿到的 token + 本机私钥，就等于一份「这台电脑专属」的密钥文件。
 *
 * ── 与 shared-pool.mjs 的分工 ─────────────────────────────────
 *
 * shared-pool 用的是「密钥文件里带来的那把钥匙」；这里用的是「本机现生成的一把」。
 * 两者签名方式一致（同一套 canonical），但密钥来源不同，所以单独一个文件，
 * 不去动 shared-pool 的加载逻辑。
 */

import https from 'node:https';
import crypto from 'node:crypto';

// 【不内置任何东西】协议标识、迁移哈希、UA 全部由调用方从密钥文件的 sign 模板传入。
// 这个文件里没有任何写死的上游标识 —— 软件只认「用户导入的密钥文件说什么就是什么」。
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 生成一套设备密钥。 */
export function createDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyB64: spki.toString('base64'),
    keyHash: sha256hex(spki),
  };
}

/** 设备标识：跟客户端一样的格式。 */
export function createDeviceId() {
  return 'desktop-' + crypto.randomBytes(16).toString('hex');
}

/**
 * 组签名头。canonical 的字段顺序与服务端一致。
 *
 * spec 来自密钥文件：{ protocol, headerVersion, headerMigration, userAgent, ... }。
 * 缺哪个就报哪个的错 —— 不偷偷用兜底常量，因为兜底常量等于「内置」。
 */
function signHeaders({ method, path, body, token, deviceId, keyHash, publicKeyB64, privateKey, spec }) {
  const protocol = String(spec?.protocol ?? '').trim();
  const version = String(spec?.headerVersion ?? '').trim();
  const migration = String(spec?.headerMigration ?? '').trim();
  const userAgent = String(spec?.userAgent ?? '').trim();
  if (!protocol) throw new Error('密钥文件缺少签名协议配置');
  if (!version) throw new Error('密钥文件缺少签名版本配置');
  if (!migration) throw new Error('密钥文件缺少签名迁移配置');
  if (!userAgent) throw new Error('密钥文件缺少客户端标识配置');

  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = body && body.length ? sha256hex(body) : EMPTY_HASH;
  const canonical = [
    protocol, method, path, ts, nonce, bodyHash,
    sha256hex(token ?? ''), deviceId, keyHash,
  ].join('\n');
  const sign = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return {
    'x-sign': sign,
    'x-sign-key': publicKeyB64,
    'x-sign-version': version,
    'x-sign-migration': migration,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-device-id': deviceId,
  };
}

/** 一次 HTTPS 请求。 */
function request(host, method, path, bodyObj, { token = null, deviceId, keyHash, publicKeyB64, privateKey, spec, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      'Accept': 'application/json',
      'User-Agent': String(spec?.userAgent ?? '').trim(),
      ...signHeaders({ method, path, body, token, deviceId, keyHash, publicKeyB64, privateKey, spec }),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const req = https.request({
      hostname: host, port: 443, path, method, headers, rejectUnauthorized: false, timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { j = { raw: d.slice(0, 500) }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 发起一次扫码登录。
 *
 * 返回 { sessionId, pollToken, qrContent, expiresAt, deviceId, deviceKey }
 * 其中 deviceKey.privateKeyPem 要自己保存 —— 服务端只存公钥。
 *
 * host 与 spec 全部由调用方给（spec 来自密钥文件的 sign 模板）：
 * 这个模块不内置任何上游标识。
 */
export async function createQrLogin({ host, spec, deviceId, deviceKey } = {}) {
  if (!host) throw new Error('没有可用线路：先导入密钥文件');
  if (!spec) throw new Error('密钥文件缺少签名配置');
  const did = deviceId || createDeviceId();
  const key = deviceKey || createDeviceKey();
  const res = await request(host, 'POST', '/api/auth/qr/create',
    { device_id: did, public_key: key.publicKeyB64 },
    { deviceId: did, keyHash: key.keyHash, publicKeyB64: key.publicKeyB64, privateKey: key.privateKey, spec });
  if (res.status !== 200) {
    const msg = res.body?.error || `HTTP ${res.status}`;
    throw new Error(msg === 'Missing request signature' ? '设备签名被拒，请重试' : msg);
  }
  return {
    sessionId: res.body.session_id,
    pollToken: res.body.poll_token,
    qrContent: res.body.qr_content,
    expiresAt: res.body.expires_at,
    pollInterval: res.body.poll_interval,
    deviceId: did,
    deviceKey: key,
  };
}

/**
 * 查一次扫码状态。
 *
 * 授权成功时返回 { status: 'approved', token, sessionKey }。
 * 未授权时返回 { status: 'waiting' }。
 */
export async function pollQrLogin(session, { host, spec } = {}) {
  if (!host) throw new Error('没有可用线路：先导入密钥文件');
  if (!spec) throw new Error('密钥文件缺少签名配置');
  const res = await request(host, 'POST', '/api/auth/qr/status', {
    session_id: session.sessionId,
    poll_token: session.pollToken,
    device_id: session.deviceId,
    public_key: session.deviceKey.publicKeyB64,
  }, {
    deviceId: session.deviceId,
    keyHash: session.deviceKey.keyHash,
    publicKeyB64: session.deviceKey.publicKeyB64,
    privateKey: session.deviceKey.privateKey,
    spec,
  });
  if (res.status === 429) {
    // 服务端对轮询有速率限制（实测每 2 秒一次会触发 "Too many requests"）。
    // 这不是失败，交给调用方隔久一点再问。
    return { status: 'rate_limited', raw: res.body };
  }
  if (res.status !== 200) {
    return { status: 'error', error: res.body?.error || `HTTP ${res.status}` };
  }
  const j = res.body || {};
  const token = j.token || j.access_token || null;
  const sessionKey = j.session_key || j.sessionKey || null;
  if (token) return { status: 'approved', token, sessionKey, raw: j };
  return { status: j.status || 'waiting', raw: j };
}

/**
 * 把扫码登录的产物整理成一份可直接写盘的凭据。
 * 结构与密钥文件（format 1）一致，所以导入/导出那条路能直接复用。
 */
export function toCredential({ session, token, sessionKey, api, sign, crypto: cryptoSpec, servers }) {
  if (!token) throw new Error('没有拿到访问令牌');
  if (!sessionKey) throw new Error('没有拿到会话密钥');
  return {
    // format 必须与 pool-credential.mjs 的 FORMAT 一致，否则读不出来。
    format: 1,
    importedAt: new Date().toISOString(),
    token,
    key: sessionKey,
    did: session.deviceId,
    servers: servers ?? [],
    sign: {
      ...(sign ?? {}),
      // 内嵌本机私钥 —— 这份凭据就只属于这台电脑了。
      privateKeyPem: session.deviceKey.privateKeyPem,
      publicKeyB64: session.deviceKey.publicKeyB64,
      keyHash: session.deviceKey.keyHash,
    },
    crypto: cryptoSpec,
    api,
  };
}
