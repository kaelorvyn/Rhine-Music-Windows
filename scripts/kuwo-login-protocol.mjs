import { randomUUID } from 'node:crypto';
import { PlatformLoginProtocols, validPlatformCredential } from './platform-login-protocols.mjs';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
const callbackUrl = 'https://www.kuwo.cn/callback';
const wechatCallback = 'http://i.kuwo.cn/US/platform/WeixinCallback.jsp?f=web&callbackUrl=' + encodeURIComponent(callbackUrl);
const cookieValue = value => {
  try { return decodeURIComponent(value.replace(/%u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))); }
  catch { return value; }
};

/** Official website WeChat authorization. OAuth codes and Kuwo sessions stay in Node. */
export class KuwoLoginProtocol extends PlatformLoginProtocols {
  constructor(fetcher = fetch) { super('kuwo', fetcher); }
  async start(signal) {
    const state = randomUUID();
    const query = new URLSearchParams({ appid: 'wx41c1275bb3e28427', response_type: 'code', scope: 'snsapi_login', redirect_uri: wechatCallback, state });
    const html = await this.request(`https://open.weixin.qq.com/connect/qrconnect?${query}`, { signal });
    const key = /(?:uuid=|\/connect\/qrcode\/)([A-Za-z0-9_-]{8,128})/.exec(html)?.[1];
    if (!key) throw failure('酷我微信登录二维码暂时无法生成，请重试。');
    return { key, state, image: await this.request(`https://open.weixin.qq.com/connect/qrcode/${key}`, { signal, image: true }) };
  }
  async poll(challenge, signal) {
    if (!challenge.authorization) {
      const raw = await this.request(`https://lp.open.weixin.qq.com/connect/l/qrconnect?${new URLSearchParams({ uuid: challenge.key, _: String(Date.now()) })}`, { signal, timeoutMs: 30000 });
      const code = /wx_errcode\s*=\s*(\d+)/.exec(raw)?.[1];
      if (code === '402' || code === '403') return { state: 'expired' };
      if (code === '404') return { state: 'scanned' };
      if (code === '408') return { state: 'waiting' };
      const authorization = /wx_code\s*=\s*['"]([A-Za-z0-9_-]{1,256})['"]/.exec(raw)?.[1];
      if (code !== '405' || !authorization) throw failure('暂时无法确认酷我微信扫码状态，请稍后重试。');
      challenge.authorization = authorization;
    }
    let next = challenge.callback || `https://i.kuwo.cn/US/platform/WeixinCallback.jsp?${new URLSearchParams({ f: 'web', code: challenge.authorization, state: challenge.state, callbackUrl })}`;
    const cookies = challenge.kuwoCookies ||= {};
    for (let hop = 0; hop < 4; hop++) {
      const url = new URL(next);
      // Follow only the documented authorization exchange, never an arbitrary callback.
      if (!((url.hostname === 'i.kuwo.cn' && ['/US/platform/WeixinCallback.jsp', '/US_NEW/kuwo/login_by_weixin_web'].includes(url.pathname))
        || (url.hostname === 'www.kuwo.cn' && url.pathname === '/callback'))
        || !['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password)
        throw failure('酷我授权跳转地址发生变化，请重新扫码。');
      url.protocol = 'https:';
      const result = await this.request(url.href, { signal, manual: true, withHeaders: true, headers: { Referer: 'https://www.kuwo.cn/' } });
      for (const raw of result.headers.getSetCookie()) {
        const match = /^(userid|sid|websid|username|uname3)=([^;\r\n]{0,4096})/.exec(raw);
        if (match) cookies[match[1]] = cookieValue(match[2]);
      }
      const location = result.headers.get('location');
      if (location && [301, 302, 303, 307, 308].includes(result.status)) { next = new URL(location, url).href; challenge.callback = next; continue; }
      const credential = { uid: cookies.userid, sid: cookies.websid || cookies.sid };
      if (!validPlatformCredential('kuwo', credential)) throw Object.assign(failure('微信授权未返回有效的酷我登录信息，请刷新二维码重试。'), { loginExpired: true });
      const profile = await this.profile(credential, signal);
      return { state: 'authorized', credential, profile };
    }
    throw failure('酷我授权跳转次数过多，请重新扫码。');
  }
  async profile(credential, signal) {
    if (!validPlatformCredential('kuwo', credential)) throw failure('请重新登录酷我音乐。', 401);
    const query = new URLSearchParams({ op: 'gui', uid: credential.uid, sid: credential.sid });
    const raw = await this.request(`https://vip1.kuwo.cn/vip/v2/sysinfo?${query}`, { signal });
    let body; try { body = JSON.parse(raw); } catch { throw failure('酷我账号响应格式发生变化。'); }
    if (Number(body?.meta?.code) !== 200 || !body.data) throw failure('酷我登录信息已失效，请重新扫码。', 401);
    return { userId: credential.uid, nickname: clean(body.data.NICKNAME || body.data.NAME) || '酷我用户' };
  }
}
