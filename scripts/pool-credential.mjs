/**
 * 共享音源凭据存储。
 *
 * ── 设计原则 ────────────────────────────────────────────
 *
 * 客户端本身不携带任何凭据。用户在设置里导入一份密钥文件，
 * 落盘到 <dataDir>/pool-credential.json，之后共享池才会启用。
 *
 * · 未导入 → 共享池停用，只走备用音源，功能降级但完整可听
 * · 已导入 → 凭据只存在于本机内存与数据目录，不写日志、不回报前端
 *
 * ── 为什么 UI 不显示 token ──────────────────────────────
 *
 * UI 只回报「是否已启用」「属于哪个账号」「什么时候导入的」。
 * 账号与到期时间从 JWT payload 解出，不含签名部分，
 * 因此截图分享也不会带出可用凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { decode, encode } from './keyfile-envelope.mjs';

export const CREDENTIAL_FILE = 'pool-credential.dat';
const LEGACY_FILE = 'pool-credential.json';
const FORMAT = 1;

/** 密钥文件的扩展名（用户导入时用这个）。 */
export const KEY_FILE_EXT = '.rhinekey';

/** 解出 token 的 JWT payload（不含签名，不可用于伪造请求）。 */
function tokenPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 给 UI 看的摘要：账号名 + 到期时间。**不含 token 本体。** */
export function describe(token) {
  const p = tokenPayload(token);
  if (!p) return { account: null, expiresAt: null };
  return {
    account: typeof p.uname === 'string' ? p.uname : (p.uid != null ? 'uid ' + p.uid : null),
    expiresAt: Number.isFinite(p.exp) ? new Date(p.exp * 1000).toISOString() : null,
  };
}

/** 规范化一份凭据。
 *
 * 这里只做「明显不完整就报错」的最低限度检查，
 * **不校验凭据是否真的有效** —— 有效性由服务端判定：导入错的 token
 * 池子自然拿不到数据，取源链会自己降级到其它音源。
 *
 * 在客户端做严格格式校验反而有害：服务端哪天改了 token 结构，
 * 我们会把一份其实能用的凭据拒之门外。 */
export function validate(input) {
  const token = String(input?.token ?? '').trim();
  const key = String(input?.key ?? '').trim();
  const did = String(input?.did ?? '').trim();

  if (!token) throw new Error('密钥文件里没有 token');
  if (!key) throw new Error('密钥文件里没有加密密钥');

  // 服务地址随密钥一起走：客户端自身不含任何服务端域名。
  // 没导入密钥 → servers 为空 → 共享池整条链路不启用。
  const servers = Array.isArray(input?.servers)
    ? input.servers.map(s => String(s ?? '').trim()).filter(Boolean)
    : [];

  const sig = input?.sign ?? null;
  const sign = sig && typeof sig === 'object' ? {
    protocol: String(sig.protocol ?? '').trim(),
    headerVersion: String(sig.headerVersion ?? '').trim(),
    headerMigration: String(sig.headerMigration ?? '').trim(),
    userAgent: String(sig.userAgent ?? '').trim(),
    signerScript: String(sig.signerScript ?? ''),
    emptyHash: String(sig.emptyHash ?? '').trim(),
    nonceBytes: Number(sig.nonceBytes) > 0 ? Number(sig.nonceBytes) : 0,
    canonical: Array.isArray(sig.canonical) ? sig.canonical.map(x => String(x)) : [],
    headers: sig.headers && typeof sig.headers === 'object' ? { ...sig.headers } : null,
    probeCanonical: String(sig.probeCanonical ?? ''),
    // 内嵌设备私钥（可选）。有它 → 密钥文件在任意电脑都能用；
    // 没有 → 退回本机系统密钥容器签名（只在这台生成过密钥的电脑上有效）。
    privateKeyPem: String(sig.privateKeyPem ?? '').trim(),
    publicKeyB64: String(sig.publicKeyB64 ?? '').trim(),
    keyHash: String(sig.keyHash ?? '').trim(),
  } : null;

  const cryptoIn = input?.crypto ?? null;
  const cryptoSpec = cryptoIn && typeof cryptoIn === 'object' ? {
    cipher: String(cryptoIn.cipher ?? '').trim(),
    ivBytes: Number(cryptoIn.ivBytes) || 0,
    tagBytes: Number(cryptoIn.tagBytes) || 0,
    envelope: String(cryptoIn.envelope ?? '').trim(),
  } : null;

  const apiIn = input?.api ?? null;
  const api = apiIn && typeof apiIn === 'object'
    ? Object.fromEntries(Object.entries(apiIn).map(([k, v]) => [k, String(v ?? '')]))
    : null;

  const sourcesIn = input?.sources ?? null;
  const sources = sourcesIn && typeof sourcesIn === 'object' ? { ...sourcesIn } : null;

  const qualities = Array.isArray(input?.qualities) ? input.qualities.map(String) : [];

 // did 缺失时补一个稳定默认值，不让它阻断导入
  return { token, key, did: did || 'desktop-local', servers, sign, crypto: cryptoSpec, api, sources, qualities };
}

function credentialPath(dataDir, name = CREDENTIAL_FILE) {
  return path.join(dataDir, name);
}

/** 解密一份凭据信封；老明文 JSON 也认，读出来由调用方决定是否迁移。 */
function readCredentialFile(file) {
  const raw = fs.readFileSync(file);
  const { value, plaintext } = decode(raw);
  if (value?.format !== FORMAT) return null;
  return { raw: value, plaintext };
}

/** 读取已导入的凭据。没有就返回 null（不是错误 —— 这是正常状态）。 */
export function read(dataDir) {
  if (!dataDir) return null;
  const current = credentialPath(dataDir);
  try {
    const parsed = readCredentialFile(current);
    if (!parsed) return null;
    // 读到的是老明文（.dat 里却是明文：只会在迁移失败时出现），顺手补一次加密。
    if (parsed.plaintext) {
      try { write(dataDir, { ...parsed.raw }); } catch { /* 迁移失败不影响这次读取 */ }
    }
    const cred = validate(parsed.raw);
    return { ...cred, importedAt: parsed.raw.importedAt ?? null };
  } catch { /* 当前文件坏了再看老文件 */ }

  try {
    const legacy = credentialPath(dataDir, LEGACY_FILE);
    if (!fs.existsSync(legacy)) return null;
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (raw?.format !== FORMAT) return null;
    const cred = validate(raw);
    const migrated = { ...cred, importedAt: raw.importedAt ?? null };
    try {
      write(dataDir, migrated);
      fs.rmSync(legacy, { force: true });
    } catch { /* 迁移失败就下次再说 */ }
    return migrated;
  } catch {
    return null;
  }
}

/** 写入凭据。会先校验，避免把坏数据存进去。 */
export function write(dataDir, input) {
  const cred = validate(input);
  fs.mkdirSync(dataDir, { recursive: true });
  const payload = {
    format: FORMAT,
    importedAt: input?.importedAt ?? new Date().toISOString(),
    ...cred,
  };
  // 0600：仅当前用户可读写。Windows 上 mode 被忽略，靠目录 ACL。
  // 内容走 AES-256-GCM 信封，落盘不是可读 JSON —— 记事本打开是乱码。
  const buffer = encode(payload);
  const target = credentialPath(dataDir);
  const staging = `${target}.tmp`;
  fs.writeFileSync(staging, buffer, { mode: 0o600 });
  fs.renameSync(staging, target);
  fs.rmSync(credentialPath(dataDir, LEGACY_FILE), { force: true });
  return payload;
}

/** 移除已导入的凭据。返回是否真的删掉了文件。 */
export function clear(dataDir) {
  if (!dataDir) return false;
  try {
    fs.rmSync(credentialPath(dataDir), { force: true });
    fs.rmSync(credentialPath(dataDir, LEGACY_FILE), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** UI 用的状态。**永远不返回 token 与 key。** */
export function status(dataDir) {
  const cred = read(dataDir);
  if (!cred) {
    return {
      configured: false,
      expiresAt: null,
      importedAt: null,
 // 明确告诉前端当前处于降级状态，好显示提示条
      note: '未导入密钥，当前只使用备用音源',
    };
  }
  // 只透露到期时间。账号名不进 UI —— 截图分享不会带出任何身份信息。
  const info = describe(cred.token);
  const expiresAt = info.expiresAt;
  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
  return {
    configured: !expired,
    expiresAt,
    importedAt: cred.importedAt,
    note: expired ? '密钥已过期，请重新导入' : null,
  };
}

/**
 * 签名健康状态 → 给用户看的一句话。
 *
 * 【2026-10-26】以前签名失败只表现为「取源失败」，用户看不出是自己这台
 * 电脑缺设备密钥。现在把原因翻译成明确的话，让用户知道该做什么。
 */
export function signNote(health) {
  if (!health || health.ok) return null;
  switch (health.reason) {
    case 'no_container':
      return '这份密钥绑定了生成它的那台电脑，这台电脑上还没有对应的设备密钥，无法访问共享音源';
    case 'bad_embedded_key':
      return '密钥文件里的设备密钥无法读取，请重新导出这份密钥';
    case 'export_blocked':
      return '系统密钥容器不允许导出私钥，无法在这台电脑上使用这份密钥';
    case 'signer_failed':
      return '设备签名失败：' + (health.detail || '未知原因');
    default:
      return '设备签名失败：' + (health.detail || '未知原因');
  }
}

/** 导出当前凭据为 `.rhinekey` 文件内容（供「导出密钥」按钮使用）。 */
export function exportKeyFile(dataDir) {
  const cred = read(dataDir);
  if (!cred) throw new Error('还没有导入密钥');
  return encode({ format: FORMAT, ...cred });
}

/** 从一份密钥文件的原始字节导入（自动识别加密信封与老明文）。 */
export function importKeyFile(dataDir, buffer) {
  const { value } = decode(buffer);
  if (!value || typeof value !== 'object') throw new Error('这不是有效的密钥文件');
  return write(dataDir, value);
}
