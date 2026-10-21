// Qishui (汽水音乐) 扫码登录协议适配。
// 端点依据：passport web SDK 的 get_qrcode / check_qrconnect（实测 2026-10-20）。
//   GET  https://api.qishui.com/passport/web/get_qrcode/?<FIXED>
//     -> data.token / data.qrcode (data:image/png;base64,...) / data.expire_time
//     Set-Cookie: passport_csrf_token, passport_csrf_token_default, odin_tt, reg-store-region
//   POST https://api.qishui.com/passport/web/check_qrconnect/?<token>
//     form: passport_jssdk_version / passport_jssdk_type / is_from_ttaccountsdk / aid / iid / version_code
//     header 必须带回第 1 步的 cookie，否则轮询失败。
//     -> data.status（new / scanning / scanned / confirmed / expired）
//     登录成功时 Set-Cookie 出现 sessionid。
//   GET  https://api.qishui.com/luna/pc/me?aid=386088   （UA: LunaPC/3.0.0(290101097) + Cookie: sessionid=...）
//     -> profile（无 cookie 时 status_code 1000016「登录状态已失效，请重新登录」）

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '');
/** data URL 不能走 clean()：它会把 base64 截断到 200 字符，二维码就废了。
 *  上限 131072 与 platform-auth.start() 的校验保持一致，超了在那里也会被拒。 */
const imageOf = value => (typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,/.test(value)
  ? value.replace(/[\s\u0000-\u001f\u007f]/g, '').slice(0, 131072)
  : '');
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const UA_PC = 'LunaPC/3.7.0(30070100)';
const BASE = 'https://api.qishui.com';

// passport 固定参数（实测 get_qrcode 需要全部带上）。
// version_code 必须跟上当前客户端版本：旧值 30020100（≈3.2.1）会让 check_qrconnect
// 在确认那一刻返回 err=1049「当前应用版本过低或经非官方渠道下载」。
// passport_jssdk_version 低于 2.8.8 时同接口返回 err=4031「需要 2.8.8 及以上版本」。
const PASSPORT_FIXED = {
  passport_jssdk_version: '2.9.0',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  aid: '386088',
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_new_login: '1',
  is_frontier: 'true',
  iid: '4210500195088827',
  version_code: '30070100',
};

/** cookie 头拼接：从 Set-Cookie 数组取 "name=value" 部分。 */
function cookieHeader(setCookies) {
  return (setCookies ?? [])
    .map(value => String(value).split(';')[0].trim())
    .filter(Boolean)
    .slice(0, 32)
    .join('; ');
}

/**
 * 把一次响应里的 Set-Cookie 合并进已有 cookie 串。
 *
 * 扫码推进时服务端会轮换 CSRF 之类的一次性 cookie；只重放起始那套旧值，
 * 服务端会认为 cookie 与 token 不匹配，直接回 err=7「访问太频繁」。
 */
function mergeCookies(current, setCookies) {
  const pairs = new Map();
  for (const item of String(current ?? '').split(';')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    if (at > 0) pairs.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  for (const raw of setCookies ?? []) {
    const first = String(raw).split(';')[0].trim();
    const at = first.indexOf('=');
    if (at <= 0) continue;
    const name = first.slice(0, at);
    const value = first.slice(at + 1);
    if (value === '' || /^(?:deleted|expired)$/i.test(value)) pairs.delete(name);
    else pairs.set(name, value);
  }
  return [...pairs].slice(0, 32).map(([name, value]) => `${name}=${value}`).join('; ');
}

export function validQishuiCredential(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.sessionid === 'string' && /^[A-Za-z0-9_.%=-]{8,2048}$/.test(value.sessionid)
    && (value.userId === undefined || (typeof value.userId === 'string' && /^[1-9]\d{0,19}$/.test(value.userId)));
}

function normalizeStatus(raw) {
  switch (String(raw ?? '').toLowerCase()) {
    case 'confirmed':
    case 'success':
    case 'verified':
      return 'authorized';
    case 'scanned':
    case 'scanning':
      return 'scanned';
    case 'expired':
    case 'cancel':
    case 'cancelled':
      return 'expired';
    default:
      return 'waiting';
  }
}

/**
 * 汽水扫码登录协议。接口形态对齐 platform-auth.mjs 的 transport 契约：
 *   start(signal, method) -> { image, token, expiresAt, cookie }
 *   poll(challenge, signal) -> { state, credential, profile }
 *   profile(credential) -> { userId, nickname }
 */
export class QishuiLoginProtocol {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.cookieByToken = new Map();
  }

  async start(signal, _method = 'qishui') {
    const query = new URLSearchParams(PASSPORT_FIXED).toString();
    const response = await this.fetcher(`${BASE}/passport/web/get_qrcode/?${query}`, {
      headers: { 'User-Agent': UA_WEB },
      signal,
      redirect: 'follow',
    });
    const text = await response.text().catch(() => '');
    let body;
    try { body = JSON.parse(text); } catch { throw failure('汽水音乐登录响应格式发生变化。'); }
    const data = body?.data ?? body;
    const token = clean(data.token);
    const image = imageOf(data.qrcode);
    if (!token || !image) {
      throw failure('汽水音乐登录二维码获取失败，请稍后重试。');
    }
    const cookie = cookieHeader(response.headers.getSetCookie?.());
    if (cookie) this.cookieByToken.set(token, cookie);
    const expiresAt = Number(data.expire_time) > 0 ? Number(data.expire_time) * 1000 : Date.now() + 120000;
    return { image, token, expiresAt };
  }

  async poll(challenge, signal) {
    const token = clean(challenge.token);
    if (!token) return { state: 'expired' };
    const query = new URLSearchParams({
      need_logo: PASSPORT_FIXED.need_logo,
      need_short_url: PASSPORT_FIXED.need_short_url,
      is_frontier: PASSPORT_FIXED.is_frontier,
      token,
      is_new_login: PASSPORT_FIXED.is_new_login,
      next: PASSPORT_FIXED.next,
    }).toString();
    const form = new URLSearchParams({
      passport_jssdk_version: PASSPORT_FIXED.passport_jssdk_version,
      passport_jssdk_type: PASSPORT_FIXED.passport_jssdk_type,
      is_from_ttaccountsdk: PASSPORT_FIXED.is_from_ttaccountsdk,
      aid: PASSPORT_FIXED.aid,
      iid: PASSPORT_FIXED.iid,
      version_code: PASSPORT_FIXED.version_code,
    }).toString();
    const response = await this.fetcher(`${BASE}/passport/web/check_qrconnect/?${query}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA_WEB,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.cookieByToken.has(token) ? { Cookie: this.cookieByToken.get(token) } : {}),
      },
      body: form,
      signal,
    });
    const text = await response.text().catch(() => '');
    let body;
    try { body = JSON.parse(text); } catch { throw failure('汽水音乐登录状态响应格式发生变化。'); }
    const data = body?.data ?? body;

    const setCookies = response.headers.getSetCookie?.() ?? [];
    const sessionid = setCookies
      .map(value => /(?:^|;\s*)sessionid=([^;]+)/.exec(String(value))?.[1])
      .find(Boolean);
    // 每次轮询都把新 cookie 合并回去，下一次请求用最新那套。
    if (setCookies.length) {
      this.cookieByToken.set(token, mergeCookies(this.cookieByToken.get(token), setCookies));
    }

    const state = normalizeStatus(data.status);
    // token 可能在中途轮换（实测扫码后服务端会下发新 token）。继续拿旧 token 轮询
    // 会被判成异常访问，直接回 err=7「访问太频繁」。发现新值就切过去，cookie 一并继承。
    const nextToken = clean(data.token);
    const rotated = nextToken && nextToken !== token ? nextToken : '';
    if (rotated && this.cookieByToken.has(token)) {
      this.cookieByToken.set(rotated, this.cookieByToken.get(token));
      this.cookieByToken.delete(token);
    }
    // 判据以「响应头是否下发 sessionid」为准，status 只作辅助。
    // 实测：确认登录那一刻返回体里 data.status 会变空（形状和轮询期不同），
    // 若只看 status 就会把已经成功的登录判成 waiting，白扫一次。
    if (state === 'authorized' || sessionid) {
      if (!sessionid) throw failure('汽水音乐登录未返回有效凭据，请重新扫码。');
      const credential = { sessionid };
      const profile = await this.profile(credential, signal).catch(() => ({ userId: '', nickname: '' }));
      if (!profile?.userId) throw failure('汽水音乐账号信息获取失败，请重新扫码。');
      this.cookieByToken.delete(token);
      return { state: 'authorized', credential, profile };
    }
    // raw/shape 只用于诊断（qishui-login-check 会打出来）；platform-auth 只读 state。
    return {
      state,
      raw: String(data.status ?? ''),
      // 确认前后返回体形状会变，把顶层键名带出来便于排查（不含任何凭据）。
      shape: Object.keys(data ?? {}).slice(0, 12).join(','),
      // 塌成 4 个键时是错误响应，description 才是真正原因。
      description: clean(data.description ?? ''),
      errorCode: Number(data.error_code ?? 0) || undefined,
      // 服务端轮换了 token 时带出去，调用方用它更新后续轮询。
      nextToken: rotated || undefined,
      // 只带条数不带值，用来诊断 cookie 是否在扫码后被轮换。
      cookieCount: String(this.cookieByToken.get(token) ?? '').split(';').filter(Boolean).length,
    };
  }
  async profile(credential, signal) {
    if (!validQishuiCredential(credential)) throw failure('请重新登录汽水音乐。', 401);
    const response = await this.fetcher(`${BASE}/luna/pc/me?aid=${PASSPORT_FIXED.aid}`, {
      headers: {
        'User-Agent': UA_PC,
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: `sessionid=${credential.sessionid}`,
      },
      signal,
    });
    const text = await response.text().catch(() => '');
    let body;
    try { body = JSON.parse(text); } catch { throw failure('汽水音乐账号信息响应格式发生变化。'); }
    if (Number(body?.status_code) === 1000016) {
      throw Object.assign(failure('登录状态已失效，请重新登录。', 401), { loginExpired: true });
    }
    // GetMyInfo（GET /luna/pc/me）的载荷是 **my_info**，不是 user：
    //   客户端源码 `userState.value.info?.my_info.id` 即取此字段作 user_id。
    const info = body?.my_info ?? body?.data?.my_info ?? {};
    return {
      userId: clean(info.id ?? info.uid ?? info.user_id ?? info.sec_uid).slice(0, 32),
      nickname: clean(info.nickname ?? info.nick_name ?? info.name).slice(0, 120),
    };
  }
}
