(() => {
  let context = __RHINE_QISHUI_CONTEXT__;
  if (window.top !== window) return;
  let finished = false;
  let latestToken = context.msToken || '';
  let stage = 'prepare';
  let networkInstalled = false;
  let runtimeReady = false;
  let running = false;
  const complete = (action, token = '') => {
    if (finished) return;
    finished = true;
    location.href = `rhine-qishui://${action}?nonce=${encodeURIComponent(context.nonce)}&stage=${stage}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  };
  const tokenOf = (url, status, token) => {
    try {
      if (new URL(url).origin === 'https://mssdk.bytedance.com' && status >= 200 && status < 300 && /^[A-Za-z0-9_=/+-]{16,8192}$/.test(token || '')) {
        latestToken = token;
        if (context.kind === 'session') complete('session-ready', token);
      }
    } catch {}
  };
  const load = url => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(Error('组件加载超时')), 20000);
    script.src = url; script.onload = () => { clearTimeout(timer); resolve(); }; script.onerror = () => { clearTimeout(timer); reject(Error('组件加载失败')); }; document.head.append(script);
  });
  const loading = message => {
    document.documentElement.lang = 'zh-CN';
    document.documentElement.innerHTML = '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>汽水音乐安全验证</title></head><body></body>';
    document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#fafaf8;color:#666;font:14px system-ui,sans-serif';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = message; document.body.append(status);
    document.documentElement.style.visibility = 'visible';
  };
  const proxyUrl = value => {
    const url = new URL(value, location.href);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) throw Error('验证请求地址无效');
    const proxied = (url.hostname === 'mssdk.bytedance.com' && url.pathname === '/web/common')
      || (url.hostname === 'vcs.zijieapi.com' && url.pathname.startsWith('/vc/'))
      || (['verify.snssdk.com', 'verify.zijieapi.com'].includes(url.hostname) && url.pathname.startsWith('/captcha/'))
      || (['verify.zijieapi.com', 'auth.zijieapi.com'].includes(url.hostname) && url.pathname.startsWith('/passport/'))
      || (['mcs.zijieapi.com', 'mon.zijieapi.com'].includes(url.hostname) && /^\/(?:list|webid|v1\/|monitor_browser\/)/.test(url.pathname));
    if (!proxied) return url.href;
    return `https://rhine-qishui-http.localhost/request?${new URLSearchParams({ id: context.id, nonce: context.nonce, url: url.href })}`;
  };
  const installSecondaryNetwork = () => {
    if (networkInstalled) return;
    networkInstalled = true;
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function (method, url, async = true, ...rest) {
      requests.set(this, { method, url: String(url), async, headers: [] });
      return open.call(this, method, url, async, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      requests.get(this)?.headers.push([name, value]);
      return setHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const request = requests.get(this);
      if (request) {
        const target = proxyUrl(request.url);
        if (target.startsWith('https://rhine-qishui-http.localhost/')) {
          if (body != null && typeof body !== 'string') throw Error('不支持的验证请求内容');
          const { timeout, responseType, withCredentials } = this;
          open.call(this, request.method, target, request.async);
          this.timeout = timeout; this.responseType = responseType; this.withCredentials = withCredentials;
          for (const [name, value] of request.headers) setHeader.call(this, name, value);
        }
        this.addEventListener('loadend', () => tokenOf(request.url, this.status, this.getResponseHeader('x-ms-token')), { once: true });
      }
      return send.call(this, body);
    };
    const fetch = window.fetch;
    window.fetch = async function (input, init) {
      const request = new Request(input instanceof Request ? input : new URL(input, location.href), init);
      const target = proxyUrl(request.url);
      const response = target.startsWith('https://rhine-qishui-http.localhost/')
        ? await fetch.call(this, target, { method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(), credentials: 'omit', signal: request.signal, redirect: 'error' })
        : await fetch.call(this, request);
      tokenOf(request.url, response.status, response.headers.get('x-ms-token')); return response;
    };
  };
  const secondary = async () => {
    installSecondaryNetwork();
    if (/^[A-Za-z0-9_=/+-]{16,8192}$/.test(latestToken)) {
      localStorage.setItem('xmst', latestToken); localStorage.setItem('xmsty', latestToken);
    }
    const firstLoad = async sources => {
      for (const url of sources) { try { await load(url); return; } catch {} }
      throw Error('官方组件依赖加载失败');
    };
    stage = 'react';
    await firstLoad(['https://unpkg.com/react@17.0.2/umd/react.production.min.js', 'https://cdn.jsdelivr.net/npm/react@17.0.2/umd/react.production.min.js']);
    window.ucSecondVerifyReact = window.React;
    stage = 'react-dom';
    await firstLoad(['https://unpkg.com/react-dom@17.0.2/umd/react-dom.production.min.js', 'https://cdn.jsdelivr.net/npm/react-dom@17.0.2/umd/react-dom.production.min.js']);
    window.ucSecondVerifyReactDom = window.ReactDOM;
    stage = 'glue';
    if (!runtimeReady) {
      await load('https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js');
      if (typeof window._SdkGlueInit !== 'function') throw Error('安全组件缺失');
      window._SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } });
    }
    stage = 'session';
    const deadline = Date.now() + 20000;
    while (!window.bdms || !window._sdkGlueVersionMap?.bdmsVersion) {
      if (finished || Date.now() > deadline) throw Error('安全组件尚未就绪');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const generalParams = { device_id: context.deviceId, install_id: context.installId, did: context.deviceId, iid: context.installId, device_platform: 'PC', version_code: '3.8.0' };
    let decision = { ...context.decision };
    stage = 'decision';
    if (decision.verify_from === 'verify_center') {
      const payload = { aid: 386088, ...decision, ...generalParams }; delete payload.is_login;
      const body = Object.entries(payload).filter(([, value]) => value != null).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value))}`).join('&');
      const envelope = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open('POST', 'https://api.qishui.com/passport/safe/pack_verify_ways_data/?aid=386088');
        request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); request.setRequestHeader('x-tt-passport-verify-portrait', decision.verify_portrait_id || '');
        request.timeout = 30000; request.onerror = request.ontimeout = () => reject(Error('验证决策加载失败'));
        request.onload = () => {
          try {
            const result = JSON.parse(request.responseText), data = result.data || result;
            if (request.status < 200 || request.status >= 300 || result.message === 'error' || Number(data.error_code || result.error_code || 0) || !data || typeof data !== 'object' || Array.isArray(data)) throw Error();
            resolve(data);
          } catch { reject(Error('验证决策不可用')); }
        }; request.send(body);
      });
      decision = { ...decision, ...envelope };
    }
    stage = 'component';
    const resource = new URL(decision.url);
    if (resource.protocol !== 'https:' || resource.port || resource.username || resource.password || !/\.js$/i.test(resource.pathname)
      || !['yhgfb-cn-static.com', 'bytescm.com', 'douyinstatic.com'].some(domain => resource.hostname === domain || resource.hostname.endsWith('.' + domain))) throw Error('验证组件地址无效');
    let eventParams = decision.event_params;
    if (typeof eventParams === 'string') { try { eventParams = JSON.parse(eventParams); } catch { eventParams = {}; } }
    if (!eventParams || typeof eventParams !== 'object' || Array.isArray(eventParams)) eventParams = {};
    resource.searchParams.set('aid', '386088'); resource.searchParams.set('verify_reason', String(eventParams.verify_reason || '')); resource.searchParams.set('verify_scene', String(eventParams.verify_scene || ''));
    window['$$account_verify_portrait_id'] = decision.verify_portrait_id || '';
    await load(resource.href);
    if (finished || typeof window.ucWebSecondVerify !== 'function') throw Error('验证组件不可用');
    document.body.style.display = 'block';
    const status = document.querySelector('[role="status"]');
    if (status) { status.textContent = '请在窗口内完成官方安全验证'; status.style.cssText = 'margin:0;padding:8px 14px;font:13px system-ui;color:#666;background:#fafaf8'; }
    stage = 'verification';
    return new Promise(resolve => window.ucWebSecondVerify({ ...decision, aid: 386088, isNewVerifyUI: true, generalParams, event_params: eventParams,
      newSecondVerifyWebOptions: { host: 'https://api.qishui.com', verifyAppName: '汽水音乐移动端' },
      newSecondVerificationCall: { reportAppLog() {} },
      monitorTime: { startTime: Date.now(), fetchEndTime: Date.now(), scriptLoadStartTime: 0, scriptLoadEndTime: Date.now(), renderStartTime: Date.now() },
      fun: decision.verify_from === 'verify_center' ? 'verify_center' : 'verify', uc_account_verify_version: '1.0.29',
      verifyFinishCallback: result => {
        if (context.kind === 'passport') resolve(result?.status === true);
        else complete(result?.status === true ? 'verified' : 'failed', latestToken);
      } }));
  };
  const browserInfo = () => {
    const info = { hardwareConcurrency: navigator.hardwareConcurrency, webdriver: Boolean(navigator.webdriver),
      plugins: navigator.plugins?.length || 0, innerHeight: innerHeight, innerWidth: innerWidth, outerHeight: outerHeight, outerWidth: outerWidth,
      notificationPermission: window.Notification?.permission || 'unsupported', request_host: location.host, request_pathname: location.pathname,
      performance: { timeOrigin: performance.timeOrigin, usedJSHeapSize: performance.memory?.usedJSHeapSize || 'unsupported' } };
    return Array.from(new TextEncoder().encode(JSON.stringify(info)), byte => (byte ^ 5).toString(16).padStart(2, '0')).join('');
  };
  const passportRequest = request => new Promise((resolve, reject) => {
    const url = new URL(request.url);
    if (url.origin !== 'https://api.qishui.com' || !/^\/passport\/web\/(?:send_code|sms_login|get_qrcode|check_qrconnect)\/$/.test(url.pathname) || !['GET', 'POST'].includes(request.method)) { reject(Error('不支持的账号请求')); return; }
    url.searchParams.set('msToken', latestToken); url.searchParams.set('account_sdk_source_info', browserInfo());
    const xhr = new XMLHttpRequest(); xhr.open(request.method, url.href);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.timeout = 30000; xhr.onerror = xhr.ontimeout = () => reject(Error('官方账号接口请求失败'));
    xhr.onload = () => {
      if (xhr.responseText.length > 1048576) { reject(Error('官方账号响应过大')); return; }
      resolve({ status: xhr.status, body: xhr.responseText, url: xhr.responseURL });
    };
    xhr.send(request.method === 'GET' ? null : request.body);
  });
  const runPassport = async next => {
    if (running || !next || next.id !== context.id || next.nonce !== context.nonce || next.kind !== 'passport') return;
    running = true; context = next; finished = false;
    const timeout = setTimeout(() => complete('timeout'), 240000);
    try {
      if (!runtimeReady) {
        loading('正在准备汽水登录安全环境…'); installSecondaryNetwork();
        await load('https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js');
        if (typeof window._SdkGlueInit !== 'function') throw Error();
        window._SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } });
        const deadline = Date.now() + 30000;
        while (!window.bdms || !window._sdkGlueVersionMap?.bdmsVersion || !/^[A-Za-z0-9_=/+-]{16,8192}$/.test(latestToken)) {
          if (Date.now() > deadline) throw Error('安全会话未就绪');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        runtimeReady = true;
      }
      let result = await passportRequest(context.request);
      let envelope = JSON.parse(result.body), data = envelope.data || envelope;
      if (Number(data.error_code || envelope.error_code) === 2046) {
        context.decision = { ...envelope, ...data }; delete context.decision.data;
        if (typeof context.decision.captcha === 'string') { try { context.decision = { ...context.decision, ...JSON.parse(context.decision.captcha) }; } catch {} }
        context.decision.verify_portrait_id ||= context.verifyPortraitId;
        location.href = `rhine-qishui://show?nonce=${encodeURIComponent(context.nonce)}`;
        const accepted = await secondary();
        if (!accepted) throw Error('官方二次验证未完成');
        if (accepted) {
          let retry = context.request;
          if (retry.action === 'check_qrconnect') {
            let params = context.decision.biz_params;
            if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = Object.fromEntries(new URLSearchParams(params)); } }
            const response = await fetch(`https://rhine-qishui-result.localhost/retry?${new URLSearchParams({ id: context.id, nonce: context.nonce })}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: retry.operationId, params: params || {} }) });
            if (!response.ok) throw Error('扫码续接失败');
            retry = await response.json();
          }
          result = await passportRequest(retry);
        }
      }
      if (finished) return;
      const response = await fetch(`https://rhine-qishui-result.localhost/result?${new URLSearchParams({ id: context.id, nonce: context.nonce })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, operationId: context.request.operationId }) });
      if (!response.ok) throw Error('账号响应交接失败');
      finished = true;
      location.href = `rhine-qishui://request-ready?nonce=${encodeURIComponent(context.nonce)}&operationId=${encodeURIComponent(context.request.operationId)}`;
    } catch { complete('failed'); }
    finally { clearTimeout(timeout); running = false; }
  };
  const wrapVerification = sdk => {
    if (!sdk || typeof sdk.initVerifyOptions !== 'function') return sdk;
    const initialize = sdk.initVerifyOptions;
    sdk.initVerifyOptions = function (options, ...rest) {
      const previous = options?.captchaOptions?.successCb;
      const next = { ...options, captchaOptions: { ...options?.captchaOptions, successCb(...args) {
        const result = typeof previous === 'function' ? previous.apply(this, args) : undefined;
        complete('verified'); return result;
      } }, secondVerifyWebOptions: { ...options?.secondVerifyWebOptions, callBack(...args) {
        const callback = options?.secondVerifyWebOptions?.callBack;
        const result = typeof callback === 'function' ? callback.apply(this, args) : undefined;
        complete('verified'); return result;
      } } };
      return initialize.call(this, next, ...rest);
    };
    return sdk;
  };
  let sdkValue;
  if (context.kind === 'page' && location.origin === context.origin) {
    try {
      Object.defineProperty(window, 'verifySDK', { configurable: true, get: () => sdkValue, set: value => { sdkValue = wrapVerification(value); } });
    } catch { complete('failed'); return; }
  }
  const start = async () => {
    if (location.href === 'about:blank') { loading('正在准备官方安全组件…'); return; }
    if (location.origin !== context.origin) { complete('failed'); return; }
    if (context.kind === 'passport') {
      Object.defineProperty(window, '__rhineQishuiPassport', { value: runPassport });
      await runPassport(context); return;
    }
    setTimeout(() => complete('timeout'), context.kind === 'session' ? 45000 : 240000);
    try {
      if (context.kind === 'page') {
        if (document.contentType !== 'text/html') { loading('官方验证入口没有返回网页，请关闭窗口后重试。'); complete('invalid-page'); return; }
        document.documentElement.style.visibility = 'visible';
        location.href = `rhine-qishui://page-ready?nonce=${encodeURIComponent(context.nonce)}`; return;
      }
      loading(context.kind === 'session' ? '正在初始化官方安全会话…' : '正在加载官方安全验证…');
      if (context.kind === 'secondary') {
        await secondary();
      } else if (context.kind === 'session') {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
          this.addEventListener('loadend', () => {
            if (this.responseURL.startsWith('https://mssdk.bytedance.com/')) tokenOf(this.responseURL, this.status, this.getResponseHeader('x-ms-token'));
          }, { once: true });
          return originalOpen.call(this, method, url, ...args);
        };
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
          const response = await originalFetch.apply(this, args);
          tokenOf(response.url, response.status, response.headers.get('x-ms-token')); return response;
        };
        await load('https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js');
        if (typeof window._SdkGlueInit !== 'function') throw Error();
        window._SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } });
      } else {
        await load('https://lf-rc1.yhgfb-cn-static.com/obj/rc-client-security/secsdk-captcha/@latest/captcha.js');
        if (typeof window.verifySDK?.initVerifyOptions !== 'function' || typeof window.verifySDK?.autoRender !== 'function') throw Error();
        window.verifySDK.initVerifyOptions({ commonOptions: { aid: 386088, iid: context.installId, did: context.deviceId },
          captchaOptions: { fp: context.deviceId, successCb: () => complete('verified'), feedbackSubmitCb: () => complete('failed') },
          secondVerifyWebOptions: { callBack: () => complete('verified'), closeCallBack: () => complete('failed') } });
        window.verifySDK.autoRender({ verify_data: context.verifyData });
      }
    } catch { complete('failed'); }
  };
  if (document.documentElement) document.documentElement.style.visibility = 'hidden';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else void start();
})();
