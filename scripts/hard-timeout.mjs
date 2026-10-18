/**
 * 硬超时原语 —— 取源链路上每一个「问一次」都必须能在固定时间内收口。
 *
 * 为什么不能只靠 `AbortSignal.timeout`：
 *
 * 1. `AbortSignal.timeout(ms)` 只对**认这个 signal 的 fetch** 生效。
 * `BackupSources` / `servicePool` 都允许注入自定义 fetch（自检用假 fetch，
 * 有的实现根本不理 signal）。这种情况下 signal 形同虚设。
 *
 * 2. 更常见的是「压根没传 signal」：实测死主机 `music.bxa241d4.shop`
 * 在不传 signal 时 **10801ms** 才失败（`UND_ERR_CONNECT_TIMEOUT`
 * —— undici 自己的连接超时是 10 秒），而不是立刻报错。
 * 旧代码把它当成"网络慢"，其实是没人给它设上限。
 *
 * 3. 就算 fetch 认了 signal，**读 body 阶段**也可能再挂一次。
 *
 * `Promise.race` 与上面三点都无关：到点必定 settle。所以这里是**兜底**，
 * 不是替代 —— 同时仍然 abort 传入的 controller，让底层连接尽快真正释放。
 */

/** 硬超时错误：带 `timeoutMs`，调用方据此区分「超时」与「接口说没有」。 */
export class HardTimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} 超时 ${ms}ms`);
    this.name = 'HardTimeoutError';
    this.timeoutMs = ms;
  }
}

/**
 * 给一个 promise 套上硬上限。
 *
 * @param {Promise<unknown>} promise 被保护的任务
 * @param {number} ms 硬上限（毫秒）；非正数表示不限
 * @param {object} [options]
 * @param {string} [options.label='hard-timeout'] 出错文案里的名字
 * @param {AbortController} [options.controller] 到点后一并 abort，释放底层连接
 * @returns {Promise<unknown>}
 */
export function withHardTimeout(promise, ms, { label = 'hard-timeout', controller } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
 // 竞速落败的那一侧仍可能稍后 reject（真实 fetch 在 abort 后就会）——
 // 挂一个空的 catch，避免它变成 unhandled rejection 把进程打挂。
  Promise.resolve(promise).catch(() => {});
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const failure = new HardTimeoutError(label, ms);
      try { controller?.abort(failure); } catch { /* 已经结束 */ }
      reject(failure);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 带硬超时的 fetch：注入一个 AbortController 交给 fetch，同时用
 * `withHardTimeout` 兜住"fetch 不理 signal"和"读 body 挂住"两种情况。
 *
 * @param {string|URL} url
 * @param {RequestInit} [options] 可含外层 `signal`，会转发给内部 controller
 * @param {number} ms 硬上限（毫秒）
 * @param {string} [label] 出错文案里的名字
 * @returns {Promise<Response>}
 */
export function fetchWithHardTimeout(url, options = {}, ms, label = 'fetch') {
  const controller = new AbortController();
  const outer = options.signal;
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  }
  const { signal: _signal, ...rest } = options;
  return withHardTimeout(
    fetch(url, { ...rest, signal: controller.signal }),
    ms,
    { label, controller },
  );
}
