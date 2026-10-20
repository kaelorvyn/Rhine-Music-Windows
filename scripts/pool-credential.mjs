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

export const CREDENTIAL_FILE = 'pool-credential.json';
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
  if (!key) throw new Error('密钥文件里没有 sessionKey');

  // 服务地址随密钥一起走：客户端自身不含任何服务端域名。
  // 没导入密钥 → servers 为空 → 共享池整条链路不启用。
  const servers = Array.isArray(input?.servers)
    ? input.servers.map(s => String(s ?? '').trim()).filter(Boolean)
    : [];

  // 请求签名参数同样随密钥下发：规范串版本、头版本、迁移值、UA、签名器脚本。
  // 客户端源码里一个字都不写；没有这一段 → 只能发未签名请求，池子自然不工作。
  const sig = input?.sign ?? null;
  const sign = sig && typeof sig === 'object' ? {
    protocol: String(sig.protocol ?? '').trim(),
    headerVersion: String(sig.headerVersion ?? '').trim(),
    headerMigration: String(sig.headerMigration ?? '').trim(),
    userAgent: String(sig.userAgent ?? '').trim(),
    signerScript: String(sig.signerScript ?? ''),
  } : null;

 // did 缺失时补一个稳定默认值，不让它阻断导入
  return { token, key, did: did || 'desktop-local', servers, sign };
}

function credentialPath(dataDir) {
  return path.join(dataDir, CREDENTIAL_FILE);
}

/** 读取已导入的凭据。没有就返回 null（不是错误 —— 这是正常状态）。 */
export function read(dataDir) {
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(credentialPath(dataDir), 'utf8'));
    if (raw?.format !== FORMAT) return null;
    const cred = validate(raw);
    return { ...cred, importedAt: raw.importedAt ?? null };
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
    importedAt: new Date().toISOString(),
    ...cred,
  };
 // 0600：仅当前用户可读写。Windows 上 mode 被忽略，靠目录 ACL。
  fs.writeFileSync(credentialPath(dataDir), JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return payload;
}

/** 移除已导入的凭据。返回是否真的删掉了文件。 */
export function clear(dataDir) {
  if (!dataDir) return false;
  try {
    fs.rmSync(credentialPath(dataDir), { force: true });
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
      account: null,
      expiresAt: null,
      importedAt: null,
 // 明确告诉前端当前处于降级状态，好显示提示条
      note: '未导入密钥，当前只使用备用音源',
    };
  }
  const info = describe(cred.token);
  const expiresAt = info.expiresAt;
  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
  return {
    configured: !expired,
    account: info.account,
    expiresAt,
    importedAt: cred.importedAt,
    note: expired ? '密钥已过期，请重新导入' : null,
  };
}

/** 导出当前凭据为 `.rhinekey` 文件内容（供「导出密钥」按钮使用）。 */
export function exportKeyFile(dataDir) {
  const cred = read(dataDir);
  if (!cred) throw new Error('还没有导入密钥');
  return JSON.stringify({ format: FORMAT, ...cred }, null, 2);
}
