import { invoke } from '@tauri-apps/api/core';
import type { NeteaseAccount, PlatformLogin } from './netease-login';
import { fetchOnline } from './online-debug';

type Action = 'send-code' | 'sms-login' | 'logout' | 'start' | 'poll';
export class QishuiLogin implements PlatformLogin {
  private container?: HTMLElement;
  private lifetime = new AbortController();
  private requestController?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private account: NeteaseAccount = { loggedIn: false };
  private id?: string;
  private busy = false;
  private retryAt = 0;
  private retryPhone = '';
  private message = '';
  private verification?: { action: Action; automatic: boolean; purpose: 'session' | 'verification' | 'request' };
  private resend?: { id: string; phone: string; at: number };
  private hasCode = false;
  private qrImage = '';
  private qrExpiresAt = 0;
  private qrNextAt = 0;
  private qrMessage = '正在准备二维码…';
  private currentAction?: Action;
  private queuedAction?: Action;
  constructor(private onAccountChange: (account: NeteaseAccount) => void = () => {}) {}
  mount(container: HTMLElement, _startLogin = false) {
    this.dispose(); this.container = container;
    const lifetime = this.lifetime = new AbortController();
    container.innerHTML = `<div class="netease-account"><div><strong>汽水音乐</strong><small data-sms-account></small></div><button class="text-button" data-sms-action="logout" hidden>退出登录</button></div>
      <div class="qishui-login-options"><section class="qishui-qr-panel" aria-label="扫码登录"><strong>扫码登录</strong><div class="netease-qr"><img width="192" height="192" alt="汽水音乐登录二维码" hidden></div><p data-qr-status class="netease-auth-status" aria-live="polite"></p><button type="button" class="text-button" data-sms-action="start">刷新二维码</button><small>请使用抖音 App 扫码并确认登录</small></section>
      <form class="qishui-sms-form"><strong>短信验证码登录</strong><label>手机号<input name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="11" pattern="1[0-9]{10}" placeholder="中国大陆手机号" required></label>
      <div class="qishui-sms-code"><label>验证码<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6 位短信验证码" required></label><button class="text-button" type="button" data-sms-action="send-code">获取验证码</button></div>
      <button class="text-button" type="submit" data-sms-action="sms-login">验证码登录</button></form></div><p class="netease-auth-status" role="status" aria-live="polite"></p>`;
    container.addEventListener('submit', event => { event.preventDefault(); void this.run('sms-login'); }, { signal: lifetime.signal });
    container.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-sms-action]')?.dataset.smsAction as Action | undefined;
      if (action && action !== 'sms-login') void this.run(action);
    }, { signal: lifetime.signal });
    container.querySelector('input[name="phone"]')!.addEventListener('input', () => {
      if (!this.busy || this.currentAction === 'poll') { this.hasCode = false; this.resend = undefined; this.input('code')!.value = ''; this.message = ''; this.update(); }
    }, { signal: lifetime.signal });
    window.addEventListener('rhine-qishui-verification', event => {
      const detail = (event as CustomEvent<{ id: string; success: boolean; purpose: string; retryAfter?: number; error?: string }>).detail;
      if (detail?.id !== this.id || !this.verification) return;
      if (detail.purpose !== this.verification.purpose) return;
      const pending = this.verification; this.verification = undefined; this.busy = false;
      if (!detail.success) { this.cancel(); this.message = detail.error || '安全验证未完成，请重新获取验证码。'; this.update(); return; }
      if (pending.purpose === 'session' || pending.purpose === 'request') { void this.run(pending.action, pending.automatic, true); return; }
      if (pending.action === 'sms-login') {
        this.hasCode = true; this.message = '安全验证完成，正在继续本次登录…';
        void this.run('sms-login', true); return;
      }
      this.hasCode = false; this.input('code')!.value = '';
      const seconds = Math.min(3600, Math.max(0, Number(detail.retryAfter) || 0));
      const phone = this.input('phone')!.value.trim();
      this.resend = { id: this.id!, phone, at: Math.max(phone === this.retryPhone ? this.retryAt : 0, Date.now() + seconds * 1000) };
      this.message = '安全验证完成，正在重新获取验证码…'; this.update();
    }, { signal: lifetime.signal });
    this.timer = setInterval(() => this.update(), 1000);
    this.update(); void this.status();
  }
  private input(name: string) { return this.container?.querySelector<HTMLInputElement>(`input[name="${name}"]`); }
  private update() {
    const container = this.container; if (!container) return;
    const remaining = this.input('phone')?.value.trim() === this.retryPhone ? Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)) : 0;
    if (this.resend && !this.busy) {
      const pending = this.resend;
      if (pending.id !== this.id || pending.phone !== this.input('phone')?.value.trim() || document.hidden) { this.cancel(); this.message = '自动获取已取消，请重新获取验证码。'; }
      else if (Date.now() >= pending.at) { this.resend = undefined; void this.run('send-code', true); return; }
      else this.message = `安全验证完成，${Math.ceil((pending.at - Date.now()) / 1000)} 秒后自动获取新验证码…`;
    }
    container.querySelector('[data-sms-account]')!.textContent = this.account.loggedIn ? `已登录 · ${this.account.profile?.nickname || '汽水用户'}` : '未登录 · 扫码或短信验证码登录';
    container.querySelector<HTMLElement>('.qishui-login-options')!.hidden = this.account.loggedIn;
    const image = container.querySelector<HTMLImageElement>('.netease-qr img')!;
    image.hidden = !this.qrImage;
    if (this.qrImage && image.getAttribute('src') !== this.qrImage) image.src = this.qrImage;
    if (!this.qrImage) image.removeAttribute('src');
    container.querySelector('[data-qr-status]')!.textContent = this.qrMessage;
    container.querySelector<HTMLButtonElement>('[data-sms-action="start"]')!.disabled = this.busy;
    const logout = container.querySelector<HTMLButtonElement>('[data-sms-action="logout"]')!;
    logout.hidden = !this.account.loggedIn; logout.disabled = this.busy;
    const send = container.querySelector<HTMLButtonElement>('[data-sms-action="send-code"]')!;
    const blocking = this.busy && this.currentAction !== 'poll';
    send.textContent = remaining ? `${remaining} 秒后重发` : '获取验证码'; send.disabled = blocking || !!this.resend || remaining > 0;
    container.querySelector<HTMLButtonElement>('[data-sms-action="sms-login"]')!.disabled = blocking || !this.id || !this.hasCode || !!this.resend;
    for (const input of container.querySelectorAll<HTMLInputElement>('input')) input.disabled = blocking;
    container.querySelector('[role="status"]')!.textContent = this.message || this.account.warning || '';
    if (this.qrImage && !this.account.loggedIn && !this.busy && !this.resend && !document.hidden && Date.now() >= this.qrNextAt) {
      if (Date.now() >= this.qrExpiresAt) { this.qrImage = ''; this.qrMessage = '二维码已过期，请刷新。'; this.update(); }
      else { this.qrNextAt = Date.now() + 2500; void this.run('poll'); }
    }
  }
  private async request(action: string, body?: object) {
    this.requestController?.abort();
    const controller = this.requestController = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime!.signal, AbortSignal.timeout(30000)]);
    const response = await fetchOnline('qishui', action, `/api/online/qishui/auth/${action}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '汽水登录暂时不可用。'), { status: response.status, retryAfter: result.retryAfter });
    return result;
  }
  async status() {
    if (this.busy || this.id) return;
    const lifetime = this.lifetime; this.busy = true; this.update();
    try {
      const result = await this.request('status'); if (lifetime !== this.lifetime) return;
      this.account = result; this.onAccountChange(result); this.message = '';
    } catch (error) { if (lifetime === this.lifetime) this.message = (error as Error).message; }
    if (lifetime === this.lifetime) { this.busy = false; this.update(); if (!this.account.loggedIn && !this.id) void this.run('start'); }
  }
  private async run(action: Action, automatic = false, initialized = false) {
    if (!this.container) return;
    if (this.busy) { if (this.currentAction === 'poll' && (action === 'send-code' || action === 'sms-login')) this.queuedAction = action; return; }
    const phone = this.input('phone')!.value.trim(), code = this.input('code')!.value.trim();
    if ((action === 'send-code' || action === 'sms-login') && !/^1\d{10}$/.test(phone)) { this.message = '请输入正确的中国大陆手机号。'; this.update(); return; }
    if (action === 'sms-login' && !/^\d{6}$/.test(code)) { this.message = '请输入 6 位短信验证码。'; this.update(); return; }
    const lifetime = this.lifetime; this.busy = true; this.currentAction = action;
    if (action === 'start') { this.qrImage = ''; this.qrMessage = '正在获取二维码…'; }
    if (action === 'send-code' || action === 'sms-login' || action === 'logout') this.message = action === 'send-code' ? '正在发送验证码…' : action === 'sms-login' ? '正在登录…' : '正在退出登录…';
    this.update();
    try {
      const result = await this.request(action, action === 'send-code' ? { phone, id: this.id } : action === 'sms-login' ? { id: this.id, code } : { id: this.id });
      if (lifetime !== this.lifetime) return;
      if (result.id) this.id = result.id;
      if (result.state === 'verification' || result.state === 'initialization' || result.state === 'request') {
        const purpose = result.state === 'request' ? 'request' : result.state === 'initialization' ? 'session' : 'verification';
        if (purpose === 'request' && initialized) throw new Error('汽水安全请求没有完成，请重试。');
        if (purpose === 'session' ? initialized : automatic) throw new Error(purpose === 'session' ? '官方安全会话初始化未成功，请稍后重试。' : `汽水仍要求安全验证，已停止自动${action === 'sms-login' ? '登录' : '获取'}，请稍后重试。`);
        this.verification = { action, automatic, purpose };
        if (purpose === 'request' && (action === 'start' || action === 'poll')) this.qrMessage = action === 'start' ? '正在加载二维码…' : '正在确认扫码状态…';
        else this.message = purpose === 'request' ? '正在连接汽水登录服务…' : purpose === 'session' ? '正在初始化官方安全会话…' : '请在官方安全验证窗口中完成验证。';
        this.update();
        if (!('__TAURI_INTERNALS__' in window)) throw new Error('请在桌面客户端内完成官方安全验证。');
        await invoke('desktop_qishui_verify', { id: this.id, purpose });
        return;
      }
      if (action === 'start') {
        if (typeof result.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.image) || result.image.length > 131072 || !Number.isFinite(result.expiresAt)) throw new Error('二维码获取失败，请点击刷新重试。');
        this.qrImage = result.image; this.qrExpiresAt = result.expiresAt; this.qrNextAt = Date.now() + 2500; this.qrMessage = '等待扫码'; return;
      }
      if (action === 'poll' && !result.loggedIn) {
        if (result.state === 'expired') { this.qrImage = ''; this.qrMessage = '二维码已过期，请刷新。'; }
        else this.qrMessage = result.state === 'scanned' ? '已扫码，请在手机上确认。' : '等待扫码';
        this.qrNextAt = Date.now() + 2500; return;
      }
      if (action === 'send-code') {
        this.hasCode = true;
        this.retryPhone = phone; this.retryAt = Date.now() + Number(result.retryAfter || 60) * 1000; this.message = '验证码已发送，请查看手机短信。';
      } else {
        if (action === 'sms-login' && !result.loggedIn) throw new Error('本次登录已过期，请重新获取验证码。');
        const id = this.id; this.id = undefined; this.hasCode = false; this.qrImage = ''; this.account = result; this.queuedAction = undefined;
        if (id && '__TAURI_INTERNALS__' in window) void invoke('desktop_qishui_verify', { id, purpose: 'cancel' }).catch(() => {});
        this.input('code')!.value = ''; this.message = result.loggedIn ? '已登录。' : '已退出汽水音乐登录。';
        this.onAccountChange(result);
      }
    } catch (error) {
      if (lifetime === this.lifetime) {
        this.verification = undefined;
        const retryAfter = Number((error as Error & { retryAfter?: number }).retryAfter);
        if (action === 'send-code' && Number.isFinite(retryAfter) && retryAfter > 0) { this.retryPhone = phone; this.retryAt = Date.now() + Math.min(3600, retryAfter) * 1000; }
        if ((error as Error & { status?: number }).status === 409) this.cancel();
        this.message = (error as Error).message;
        if (action === 'start') this.qrMessage = '二维码暂时不可用，可刷新或使用短信登录。';
        this.qrNextAt = Date.now() + 5000;
      }
    } finally {
      if (lifetime === this.lifetime) {
        this.busy = !!this.verification;
        if (!this.busy && this.queuedAction) { const queued = this.queuedAction; this.queuedAction = undefined; void this.run(queued); }
        else { this.update(); if (!this.busy && action === 'logout') void this.run('start'); }
      }
    }
  }
  private cancel() {
    const id = this.id; this.id = undefined; this.verification = undefined; this.resend = undefined; this.hasCode = false; this.qrImage = ''; this.queuedAction = undefined;
    if (id) {
      if ('__TAURI_INTERNALS__' in window) void invoke('desktop_qishui_verify', { id, purpose: 'cancel' }).catch(() => {});
      void fetchOnline('qishui', 'cancel', '/api/online/qishui/auth/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
    }
  }
  dispose() {
    this.cancel(); this.requestController?.abort(); this.lifetime.abort(); this.lifetime = new AbortController();
    clearInterval(this.timer); this.container = undefined; this.busy = false;
  }
}
