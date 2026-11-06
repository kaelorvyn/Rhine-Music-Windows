import { createHash, randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PlatformAuth } from './platform-auth.mjs';
import { QishuiLoginProtocol, validQishuiCredential } from './qishui-protocol.mjs';
import { PASSPORT_UA, passportSignature } from './qishui-passport-signature.mjs';
import QRCode from 'qrcode';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const BASE = 'https://api.qishui.com';
const mix = value => [...value].map(character => (character.charCodeAt(0) ^ 5).toString(16).padStart(2, '0')).join('');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_=/+-]{16,8192}$/.test(value);
const newIdentity = () => ({ deviceId: String(1000000000000000n + randomBytes(8).readBigUInt64LE() % 9000000000000000n), installId: String(1000000000000000n + randomBytes(8).readBigUInt64LE() % 9000000000000000n) });
async function clientIdentity(dataDir) {
  if (!dataDir) return newIdentity();
  const file = path.join(dataDir, 'qishui-client.json');
  const read = async () => {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!/^\d{16}$/.test(value?.deviceId || '') || !/^\d{16}$/.test(value?.installId || '')) throw failure('汽水本机登录配置无效，请检查 qishui-client.json，原文件未修改。', 500);
    return value;
  };
  try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = newIdentity(); await fs.mkdir(dataDir, { recursive: true });
  try { await fs.writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return value; }
  catch (error) { if (error.code === 'EEXIST') return read(); throw error; }
}
export function qishuiVerificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return undefined;
    if (!['qishui.com', 'snssdk.com', 'zijieapi.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return undefined;
    if (/\.(?:js|mjs|css|json|png|jpe?g|webp|gif|svg|wasm|map)(?:\/|$)/i.test(url.pathname) || /\/(?:passport\/web|captcha\/(?:get|verify|refresh))(?:\/|$)/i.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function qishuiSecondaryScriptUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !/\.js$/i.test(url.pathname)) return undefined;
    if (!['yhgfb-cn-static.com', 'bytescm.com', 'douyinstatic.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return undefined;
    return url.href;
  } catch { return undefined; }
}
function secondaryDecisionOf(value, code, portrait) {
  if (code !== 2046) return;
  const { data, ...outer } = value || {};
  let decision = { ...outer, ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) };
  if (typeof decision.captcha === 'string' && decision.captcha.length <= 32768) {
    try {
      const parsed = JSON.parse(decision.captcha);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) decision = { ...decision, ...parsed };
    } catch {}
  }
  if (decision.verify_from !== 'verify_center' && !qishuiSecondaryScriptUrl(decision.url) && !(decision.verify_ticket && Array.isArray(decision.verify_ways))) return;
  if (JSON.stringify(decision).length > 65536) throw failure('官方二次验证信息过大，请稍后重试。', 502);
  if (!decision.verify_portrait_id) decision.verify_portrait_id = portrait;
  return decision;
}
export function qishuiVerificationRequestUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 32768) return undefined;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return undefined;
    if (url.hostname === 'mssdk.bytedance.com' && url.pathname === '/web/common') return url.href;
    if (url.hostname === 'vcs.zijieapi.com' && url.pathname.startsWith('/vc/')) return url.href;
    if (['verify.snssdk.com', 'verify.zijieapi.com'].includes(url.hostname) && url.pathname.startsWith('/captcha/')) return url.href;
    if (['verify.zijieapi.com', 'auth.zijieapi.com'].includes(url.hostname) && url.pathname.startsWith('/passport/')) return url.href;
    if (['mcs.zijieapi.com', 'mon.zijieapi.com'].includes(url.hostname) && /^\/(?:list|webid|v1\/|monitor_browser\/)/.test(url.pathname)) return url.href;
  } catch {}
}
function mergeCookies(challenge, headers) {
  const token = headers.get('x-ms-token');
  if (validToken(token)) challenge.msToken = token;
  const cookies = new Map(String(challenge.cookie || '').split(';').flatMap(pair => {
    const index = pair.indexOf('='); return index > 0 ? [[pair.slice(0, index).trim(), pair.slice(index + 1).trim()]] : [];
  }));
  for (const raw of headers.getSetCookie?.() || []) {
    const match = /^([\w-]{1,64})=([^;\r\n]{0,4096})/.exec(raw);
    if (!match) continue;
    if (match[1] === 'msToken' && validToken(match[2])) challenge.msToken = match[2];
    if (match[2]) cookies.set(match[1], match[2]); else cookies.delete(match[1]);
  }
  challenge.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}
function verificationOf(value) {
  const pending = [{ value, depth: 0 }]; let visited = 0;
  while (pending.length && visited++ < 32) {
    const entry = pending.shift(); let current = entry.value;
    if (typeof current === 'string' && current.length <= 16384) { try { current = JSON.parse(current); } catch { continue; } }
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    for (const field of ['securityURL', 'security_url', 'captcha_url', 'verify_url']) {
      const address = qishuiVerificationUrl(current[field]); if (address) return address;
    }
    if (entry.depth < 4) for (const field of ['data', 'captcha', 'verification', 'verify_info']) {
      const address = qishuiVerificationUrl(current[field]); if (address) return address;
      if (current[field]) pending.push({ value: current[field], depth: entry.depth + 1 });
    }
  }
}
function verificationDataOf(value) {
  const pending = [{ value, depth: 0 }]; let visited = 0;
  while (pending.length && visited++ < 32) {
    const entry = pending.shift(); let current = entry.value;
    if (typeof current === 'string' && current.length <= 16384) { try { current = JSON.parse(current); } catch { continue; } }
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    for (const field of ['verify_center_decision_conf', 'verify_center_secondary_decision_conf']) {
      let data = current?.[field];
      if (typeof data === 'string' && data.length <= 16384) { try { data = JSON.parse(data); } catch { continue; } }
      if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length && JSON.stringify(data).length <= 16384) return data;
    }
    if (entry.depth < 4) for (const field of ['data', 'captcha', 'verification', 'verify_info']) if (current[field]) pending.push({ value: current[field], depth: entry.depth + 1 });
  }
}
function officialMessage(data, value) {
  const message = [data?.description, data?.error_msg, data?.msg, value?.description, value?.error_msg, value?.msg].find(message => typeof message === 'string' && message.trim());
  return message?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/g, '（链接已省略）').replace(/\b1\d{10}\b/g, '（手机号已隐藏）').replace(/[A-Za-z0-9_=/+-]{24,}/g, '（标识已省略）').trim().slice(0, 240);
}
export class QishuiSmsProtocol extends QishuiLoginProtocol {
  constructor(fetcher = fetch, { dataDir, browserRequests = false } = {}) {
    super(fetcher); this.dataDir = dataDir; this.browserRequests = browserRequests;
  }
  async session(challenge) {
    if (!this.identity) this.identity = await clientIdentity(this.dataDir);
    if (!challenge.sdkReady || !validToken(challenge.msToken)) { challenge.sessionPending = true; return false; }
    challenge.sdkReady = false;
    return true;
  }
  async passport(action, fields, challenge) {
    challenge.verifyPortraitId ||= randomUUID() + '.login';
    if (!this.identity) this.identity = await clientIdentity(this.dataDir);
    if (!this.browserRequests && !await this.session(challenge)) return { initialization: true };
    const query = new URLSearchParams({ passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', aid: '386088',
      language: 'zh', account_sdk_source: 'web', p_js_v: '2.4.13', p_js_t: 'normal', p_zt: '3.3.5', request_host: 'app://resources', p_bd: '1.0.0.41',
      biz_trace_id: randomBytes(4).toString('hex'), is_new_login: '1', is_from_iesaccountsaas: '1', device_id: this.identity.deviceId, install_id: this.identity.installId,
      did: this.identity.deviceId, iid: this.identity.installId, device_platform: 'PC', version_code: '3.8.0', msToken: challenge.msToken }).toString();
    const body = new URLSearchParams(fields).toString();
    const target = new URL(`${BASE}/passport/web/${action}/?${query}`);
    if (this.browserRequests) {
      target.searchParams.set('p_js_t', 'pro'); target.searchParams.set('p_ver', '1.0.29');
      if (action === 'get_qrcode') for (const [key, value] of Object.entries({ next: BASE, need_logo: 'false', need_short_url: 'false' })) target.searchParams.set(key, value);
    } else target.searchParams.set('a_bogus', passportSignature(query, body));
    const headers = { 'user-agent': PASSPORT_UA, Accept: 'application/json, text/javascript',
      'content-type': 'application/x-www-form-urlencoded', 'sec-ch-ua': '"Not.A/Brand";v="99", "Chromium";v="136"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      'x-tt-trace-id': `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`, 'x-tt-passport-trace-id': randomBytes(16).toString('hex'),
      'x-ss-stub': createHash('md5').update(body).digest('hex').toUpperCase(), 'x-tt-passport-verify-portrait': challenge.verifyPortraitId, ...(challenge.cookie ? { Cookie: challenge.cookie } : {}) };
    let response;
    if (this.browserRequests) {
      const fingerprint = createHash('sha256').update(action + '\n' + body).digest('hex');
      if (challenge.passportReply) {
        if (challenge.passportRequest?.fingerprint !== fingerprint) throw failure('登录参数已变化，请重新开始。', 409);
        const reply = challenge.passportReply; challenge.passportReply = undefined; challenge.passportRequest = undefined;
        response = new Response(reply.body, { status: reply.status });
      } else {
        if (challenge.passportRequest && challenge.passportRequest.fingerprint !== fingerprint) throw failure('上一项登录操作尚未结束。', 409);
        challenge.passportRequest ||= { operationId: randomUUID(), fingerprint, action, url: target.href,
          method: action === 'get_qrcode' ? 'GET' : 'POST', body: action === 'get_qrcode' ? '' : body,
          headers: Object.fromEntries(Object.entries(headers).filter(([name]) => /^(accept|content-type|x-ss-stub|x-tt-trace-id|x-tt-passport-trace-id|x-tt-passport-verify-portrait)$/i.test(name))) };
        return { browserRequest: true };
      }
    } else response = await this.fetcher(target.href, { method: 'POST', headers, body, redirect: 'error',
      signal: AbortSignal.any([challenge.controller.signal, AbortSignal.timeout(15000)]) });
    mergeCookies(challenge, response.headers);
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) { size += chunk.length; if (size > 1048576) throw failure('汽水登录响应过大。', 502); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('汽水登录响应格式发生变化，请稍后重试。', 502); }
    const data = value?.data ?? value;
    const code = Number(data?.error_code ?? value?.error_code ?? 0);
    if (code || !response.ok || value?.message === 'error') {
      const verification = verificationOf(value);
      const verificationData = verificationDataOf(value);
      const secondaryDecision = secondaryDecisionOf(value, code, challenge.verifyPortraitId);
      if (this.dataDir) {
        const allowed = new Set(['data','error_code','captcha','securityURL','security_url','captcha_url','verify_url','verification','verify_info','verify_center_decision_conf','verify_center_secondary_decision_conf','description','error_msg','msg','message','url','verify_from','verify_ticket','verify_ways','verify_portrait_id','event_params','biz_params']);
        const fields = object => object && typeof object === 'object' ? Object.keys(object).filter(key => allowed.has(key)) : [];
        await fs.writeFile(path.join(this.dataDir, 'qishui-login-diagnostic.json'), JSON.stringify({ at: new Date().toISOString(), action, httpStatus: response.status,
          errorCode: Number.isSafeInteger(code) ? code : null, rootFields: fields(value), dataFields: fields(data), captchaType: typeof data?.captcha,
          trustedVerificationUrl: !!verification, structuredVerification: !!verificationData, secondaryVerification: !!secondaryDecision, hasVerificationHeader: response.headers.has('bdturing-verify') || response.headers.has('x-vc-bdturing-parameters') })).catch(() => {});
      }
      if (this.browserRequests && code === 2046) throw failure('官方二次验证后仍未完成登录（错误码 2046），请重新尝试。', 502);
      if (verification || verificationData || secondaryDecision) { challenge.verificationUrl = verification; challenge.verificationData = verificationData; challenge.secondaryDecision = secondaryDecision; return { verification: true }; }
      const description = officialMessage(data, value);
      if (code === 20028) throw failure(`汽水要求附加验证（错误码 20028），但当前响应没有可安全打开的验证入口。${description ? `官方提示：${description}。` : ''}请暂不要重复发送短信。`, 502);
      if (code === 7 || response.status === 429) {
        const retryAfter = Math.min(3600, Math.max(60, Number(response.headers.get('retry-after')) || 60));
        throw Object.assign(failure(code === 7 ? '汽水拒绝了本次请求（错误码 7：安全校验或频率限制），请稍后再试。' : '汽水返回了频率限制，请稍后再试。', 429), { retryAfter });
      }
      if (description) throw failure(`汽水${action === 'send_code' ? '发送验证码' : '登录'}未成功${Number.isSafeInteger(code) && code ? `（错误码 ${code}）` : ''}：${description}`, 502);
      if ([1102, 1103, 1105, 1107].includes(code)) throw failure(`短信验证码校验未通过（错误码 ${code}），请检查后重试。`);
      throw failure(`汽水${action === 'send_code' ? '发送验证码' : '登录'}未成功${Number.isSafeInteger(code) && code ? `（错误码 ${code}）` : ''}，请稍后重试。`, 502);
    }
    return data;
  }
  async sendSms(challenge) {
    const data = await this.passport('send_code', { is6Digits: '1', mix_mode: '1', mobile: mix('+86 ' + challenge.phone), type: mix('24'), fixed_mix_mode: '1' }, challenge);
    if (data.verification || data.initialization || data.browserRequest) return data;
    return { sent: true };
  }
  async loginSms(challenge, code) {
    const data = await this.passport('sms_login', { mobile: mix('+86 ' + challenge.phone), code: mix(code), login_only: 'false', mix_mode: '1', fixed_mix_mode: '1' }, challenge);
    if (data.verification || data.initialization || data.browserRequest) return data;
    const sessionid = /(?:^|;\s*)sessionid=([^;]+)/.exec(challenge.cookie || '')?.[1];
    const credential = { sessionid };
    if (!validQishuiCredential(credential)) throw failure('汽水未返回有效登录凭据，请重试。', 502);
    const profile = await this.profile(credential, challenge.controller.signal);
    if (!profile?.userId) throw failure('汽水账号资料读取失败，请重试。', 502);
    return { credential, profile };
  }
}
export class QishuiSmsAuth extends PlatformAuth {
  constructor(options = {}) { super({ ...options, provider: 'qishui', transport: options.transport ?? new QishuiSmsProtocol(undefined, { dataDir: options.dataDir, browserRequests: true }) }); this.lastSms = new Map(); }
  async start(_method, id) {
    await this.ready;
    if (!this.transport.browserRequests) throw failure('当前认证环境不支持扫码登录。');
    let challenge;
    if (id) challenge = this.context(id);
    else {
      this.discardChallenge();
      challenge = this.challenge = { id: randomUUID(), controller: new AbortController(), epoch: ++this.epoch, expiresAt: this.now() + 300000 };
    }
    if (challenge.busy) throw failure('扫码操作正在处理。', 429);
    challenge.busy = true;
    try {
      const data = await this.transport.passport('get_qrcode', {}, challenge); this.context(challenge.id);
      if (data.browserRequest) return { id: challenge.id, state: 'request' };
      if (typeof data.token !== 'string' || !/^[^\u0000-\u0020\u007f]{1,2048}$/.test(data.token)) throw failure('官方未返回有效二维码。', 502);
      const index = new URL(data.qrcode_index_url);
      if (index.protocol !== 'https:' || index.port || index.username || index.password) throw failure('官方二维码地址无效。', 502);
      const token = index.searchParams.get('token'); if (!token || token.length > 2048) throw failure('官方二维码缺少令牌。', 502);
      const scan = new URL('https://bff-pc.qishui.com/light/invoke/scan_login'); scan.searchParams.set('token', token); scan.searchParams.set('os', 'Windows'); scan.searchParams.set('computer_name', 'Rhine Music');
      const image = await QRCode.toDataURL(scan.href, { width: 240, margin: 2 }); this.context(challenge.id);
      challenge.token = data.token;
      const lifetime = Number(data.expire_time) * 1000;
      challenge.qrExpiresAt = Number.isFinite(lifetime) && lifetime > this.now() ? Math.min(lifetime, this.now() + 300000) : this.now() + 120000;
      return { id: challenge.id, state: 'waiting', image, expiresAt: challenge.qrExpiresAt };
    } finally { challenge.busy = false; }
  }
  async poll(id) {
    const challenge = this.context(id);
    if (!challenge.token) return { state: 'expired' };
    if (this.now() >= challenge.qrExpiresAt) { challenge.token = undefined; return { state: 'expired' }; }
    if (challenge.busy || (!challenge.passportReply && this.now() < (challenge.nextPoll || 0))) throw failure('请稍候再检查扫码状态。', 429);
    challenge.busy = true;
    try {
      const data = await this.transport.passport('check_qrconnect', { need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token: challenge.token, is_new_login: '1', next: BASE }, challenge); this.context(id);
      if (data.browserRequest) return { id, state: 'request' };
      challenge.nextPoll = this.now() + 2000;
      const state = String(data.status).toLowerCase();
      if (['expired', 'cancelled', 'cancel', '4', '5'].includes(state)) { challenge.token = undefined; return { state: 'expired' }; }
      if (!['confirmed', '3'].includes(state)) {
        if (typeof data.token === 'string' && /^[^\u0000-\u0020\u007f]{1,2048}$/.test(data.token)) challenge.token = data.token;
        return { state: ['scanned', 'scanning', '2'].includes(state) ? 'scanned' : 'waiting' };
      }
      if (typeof data.session_cookie === 'string' && data.session_cookie.length <= 32768) {
        const headers = new Headers();
        for (const pair of data.session_cookie.split(';').slice(0, 64)) if (/^[\w-]{1,64}=[^;\r\n]{1,4096}$/.test(pair.trim())) headers.append('set-cookie', pair.trim());
        mergeCookies(challenge, headers);
      }
      const credential = { sessionid: /(?:^|;\s*)sessionid=([^;]+)/.exec(challenge.cookie || '')?.[1] };
      if (!validQishuiCredential(credential)) throw failure('扫码已确认，但尚未取得有效会话。', 502);
      const profile = await this.transport.profile(credential, challenge.controller.signal); this.context(id);
      await this.commit(challenge, { credential, profile }); return { state: 'authorized', ...this.snapshot() };
    } finally { challenge.busy = false; }
  }
  context(id) {
    const challenge = this.challenge;
    if (!challenge || challenge.id !== id || challenge.epoch !== this.epoch || this.now() >= challenge.expiresAt) throw failure('本次登录已过期，请重新获取验证码。', 409);
    return challenge;
  }
  async sendCode({ phone, countryCode = '86', id } = {}) {
    await this.ready;
    if (countryCode !== '86' || !/^1\d{10}$/.test(phone || '')) throw failure('请输入正确的中国大陆手机号。');
    if (this.challenge?.busy) throw failure('正在处理本次登录，请稍候。', 429);
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    const remaining = (this.lastSms.get(phoneHash) || 0) - this.now();
    if (remaining > 0) throw Object.assign(failure(`请在 ${Math.ceil(remaining / 1000)} 秒后重新获取验证码。`, 429), { retryAfter: Math.ceil(remaining / 1000) });
    let challenge;
    if (id) {
      challenge = this.context(id);
      if (challenge.phone !== phone) { challenge.phone = phone; challenge.phoneHash = phoneHash; challenge.sent = false; }
    }
    else if (this.challenge?.phone === phone && this.now() < this.challenge.expiresAt) challenge = this.context(this.challenge.id);
    else { this.discardChallenge(); challenge = this.challenge = { id: randomUUID(), phone, phoneHash, controller: new AbortController(), epoch: ++this.epoch, expiresAt: this.now() + 300000 }; }
    if (challenge.busy) throw failure('正在处理本次登录，请稍候。', 429);
    challenge.busy = true;
    try {
      const result = await this.transport.sendSms(challenge); this.context(challenge.id);
      if (result.browserRequest) return { state: 'request', id: challenge.id };
      if (result.initialization) return { state: 'initialization', id: challenge.id };
      if (result.verification) return { state: 'verification', id: challenge.id };
      challenge.sent = true; challenge.verificationUrl = undefined; challenge.verificationData = undefined; challenge.secondaryDecision = undefined; challenge.expiresAt = this.now() + 300000; this.lastSms.set(phoneHash, this.now() + 60000);
      for (const [key, expires] of this.lastSms) if (expires < this.now()) this.lastSms.delete(key);
      return { state: 'sent', id: challenge.id, retryAfter: 60, expiresAt: challenge.expiresAt };
    } catch (error) {
      if (error.status === 429) {
        error.retryAfter = Math.min(3600, Math.max(60, Number(error.retryAfter) || 60));
        this.lastSms.set(phoneHash, this.now() + error.retryAfter * 1000);
      }
      throw error;
    } finally { challenge.busy = false; }
  }
  async smsLogin({ id, code } = {}) {
    const challenge = this.context(id);
    if (!challenge.sent || !/^\d{6}$/.test(code || '')) throw failure('请先获取短信并输入 6 位验证码。');
    if (challenge.busy) throw failure('正在处理本次登录，请稍候。', 429);
    challenge.busy = true;
    try {
      const result = await this.transport.loginSms(challenge, code); this.context(id);
      if (result.browserRequest) return { state: 'request', id };
      if (result.initialization) return { state: 'initialization', id };
      if (result.verification) return { state: 'verification', id };
      await this.commit(challenge, result);
      return this.snapshot();
    } finally { challenge.busy = false; }
  }
  async commit(challenge, result) {
      const id = challenge.id;
      if (!validQishuiCredential(result.credential) || !result.profile?.userId) throw failure('汽水未返回有效账号。', 502);
      await this.write(async () => {
        this.context(id);
        this.warning = undefined;
        try { await this.store.save({ credential: result.credential }); }
        catch { this.warning = '已登录，但本机无法保存登录信息，关闭后需要重新登录。'; }
        if (this.challenge !== challenge || challenge.epoch !== this.epoch) {
          await (this.credential ? this.store.save({ credential: this.credential }) : this.store.clear()).catch(() => {}); return;
        }
        this.credential = result.credential; this.profile = { userId: String(result.profile.userId).slice(0, 32), nickname: String(result.profile.nickname || '').slice(0, 120) }; this.discardChallenge(); this.epoch++; this.statusPending = undefined;
      });
  }
  passportContext(id) {
    const challenge = this.context(id);
    if (!challenge.passportRequest || challenge.passportReply) throw failure('当前没有待执行的登录请求。', 409);
    challenge.runtimeNonce ||= randomUUID();
    return { id, nonce: challenge.runtimeNonce, kind: 'passport', origin: BASE, userAgent: PASSPORT_UA, ...this.transport.identity,
      msToken: challenge.msToken, verifyPortraitId: challenge.verifyPortraitId, request: challenge.passportRequest };
  }
  completePassport(id, nonce, result, cookies) {
    const challenge = this.context(id), pending = challenge.passportRequest;
    if (!pending || challenge.passportReply || nonce !== challenge.runtimeNonce || result?.operationId !== pending.operationId) throw failure('登录请求已失效。', 409);
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string' || Buffer.byteLength(result.body) > 1048576) throw failure('官方登录响应无效。', 502);
    const actual = new URL(result.url), expected = new URL(pending.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password || actual.port || !/^[A-Za-z0-9/=_+-]{44}$/.test(actual.searchParams.get('a_bogus') || '') || !validToken(actual.searchParams.get('msToken'))) throw failure('官方安全签名未正确执行。', 502);
    challenge.nativeNonce = nonce; challenge.nativeKind = 'passport';
    this.acceptNativeResult(challenge, cookies, nonce, 'passport');
    challenge.passportReply = { status: result.status, body: result.body, operationId: result.operationId };
    return { accepted: true };
  }
  passportReady(id, nonce, operationId) {
    const challenge = this.context(id);
    if (nonce !== challenge.runtimeNonce || operationId !== challenge.passportReply?.operationId) throw failure('登录请求未完成。', 409);
    return { ready: true };
  }
  passportRetry(id, nonce, operationId, params) {
    const challenge = this.context(id), request = challenge.passportRequest;
    if (!request || request.action !== 'check_qrconnect' || request.operationId !== operationId || nonce !== challenge.runtimeNonce || challenge.passportReply) throw failure('扫码续接请求已失效。', 409);
    if (!params || typeof params !== 'object' || Array.isArray(params) || JSON.stringify(params).length > 16384) throw failure('扫码续接参数无效。');
    const fields = new URLSearchParams(request.body);
    for (const [key, value] of Object.entries(params)) if (value != null) fields.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const body = fields.toString(), url = new URL(request.url); url.searchParams.set('isResend', 'true');
    return { ...request, body, url: url.href, headers: { ...request.headers, 'x-ss-stub': createHash('md5').update(body).digest('hex').toUpperCase() } };
  }
  verificationContext(id) {
    const challenge = this.context(id);
    if (!qishuiVerificationUrl(challenge.verificationUrl) && !challenge.verificationData && !challenge.secondaryDecision) throw failure('当前没有需要完成的安全验证。', 409);
    return { ...this.nativeContext(challenge, 'verification'), kind: challenge.secondaryDecision ? 'secondary' : challenge.verificationData ? 'sdk' : 'page', url: challenge.verificationUrl, verifyData: challenge.verificationData, decision: challenge.secondaryDecision };
  }
  nativeContext(challenge, kind) {
    challenge.nativeNonce = randomUUID(); challenge.nativeKind = kind;
    return { id: challenge.id, nonce: challenge.nativeNonce, msToken: challenge.msToken, userAgent: PASSPORT_UA, ...this.transport.identity, cookies: String(challenge.cookie || '').split(';').flatMap(pair => {
      const index = pair.indexOf('='); return index > 0 ? [{ name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: '.qishui.com', path: '/' }] : [];
    }) };
  }
  sessionContext(id) {
    const challenge = this.context(id);
    if (!challenge.sessionPending) throw failure('当前没有待初始化的安全会话。', 409);
    return { ...this.nativeContext(challenge, 'session'), kind: 'session' };
  }
  completeSession(id, cookies, nonce, token) {
    const challenge = this.context(id);
    if (!challenge.sessionPending || !validToken(token)) throw failure('官方安全会话未初始化成功。', 409);
    this.acceptNativeResult(challenge, cookies, nonce, 'session');
    challenge.msToken = token; challenge.sdkReady = true; challenge.sessionPending = false;
    return { id, sessionReady: true };
  }
  acceptNativeResult(challenge, cookies, nonce, kind) {
    if (!nonce || challenge.nativeNonce !== nonce || challenge.nativeKind !== kind || !Array.isArray(cookies) || cookies.length > 64) throw failure('安全验证上下文无效。', 409);
    const headers = new Headers();
    for (const cookie of cookies) {
      if (!cookie || typeof cookie.name !== 'string' || !/^[\w-]{1,64}$/.test(cookie.name) || typeof cookie.value !== 'string' || !/^[^;\r\n]{1,4096}$/.test(cookie.value)) continue;
      if (!['qishui.com', '.qishui.com', 'api.qishui.com'].includes(cookie.domain)) continue;
      headers.append('set-cookie', `${cookie.name}=${cookie.value}`);
    }
    mergeCookies(challenge, headers); challenge.nativeNonce = undefined; challenge.nativeKind = undefined;
  }
  async verificationHttp(id, nonce, request) {
    const challenge = this.context(id);
    const validContext = () => nonce && ((challenge.runtimeNonce === nonce && challenge.passportRequest && !challenge.passportReply) || (challenge.nativeNonce === nonce && challenge.nativeKind === 'verification' && challenge.secondaryDecision));
    if (!validContext()) throw failure('验证请求已失效。', 409);
    const url = qishuiVerificationRequestUrl(request?.url);
    if (!url || !['GET', 'POST'].includes(request?.method) || typeof request.body !== 'string' || Buffer.byteLength(request.body) > 65536) throw failure('不支持的验证请求。', 400);
    if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers) || Object.keys(request.headers).length > 48) throw failure('无效的验证请求头。');
    const headers = { 'user-agent': PASSPORT_UA };
    for (const [name, value] of Object.entries(request.headers)) {
      if (!/^(?:accept|content-type|x-tt-passport-verify-portrait|x-ss-stub|bdturing-verify|x-vc-bdturing-parameters|x-tt-trace-id|x-tt-passport-trace-id)$/i.test(name)) continue;
      if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw failure('无效的验证请求头。');
      headers[name.toLowerCase()] = value;
    }
    if ((challenge.verificationRequests || 0) >= 8) throw failure('安全组件请求繁忙。', 429);
    challenge.verificationRequests = (challenge.verificationRequests || 0) + 1;
    try {
      const response = await this.transport.fetcher(url, { method: request.method, headers, ...(request.method === 'POST' ? { body: request.body } : {}), redirect: 'error', signal: AbortSignal.any([challenge.controller.signal, AbortSignal.timeout(20000)]) });
      if (response.status >= 300 && response.status < 400) throw failure('验证接口发生了不支持的跳转。', 502);
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) { size += chunk.length; if (size > 2097152) throw failure('验证响应过大。', 502); chunks.push(chunk); }
      this.context(id);
      if (!validContext()) throw failure('验证请求已失效。', 409);
      return { status: response.status, headers: Object.fromEntries(['content-type','x-ms-token','x-ms-resp','bdturing-verify','x-vc-bdturing-parameters'].flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])), bodyBase64: Buffer.concat(chunks).toString('base64') };
    } finally { challenge.verificationRequests--; }
  }
  completeVerification(id, cookies, nonce, token) {
    const challenge = this.context(id);
    if (!challenge.verificationUrl && !challenge.verificationData && !challenge.secondaryDecision) throw failure('当前没有需要完成的安全验证。', 409);
    this.acceptNativeResult(challenge, cookies, nonce, 'verification');
    if (validToken(token)) { challenge.msToken = token; challenge.sdkReady = true; }
    challenge.verificationUrl = undefined; challenge.verificationData = undefined; challenge.secondaryDecision = undefined;
    return { id, readyToResume: true, retryAfter: Math.max(0, Math.ceil(((this.lastSms.get(challenge.phoneHash) || 0) - this.now()) / 1000)) };
  }
}
