// Backup source fallback module — 严格对齐 service v3.6.2 src\backup_source.rs。
// 证据：二进制字符串完整扒取（tmp-dump-backup.cjs），逐字段对齐。
//
// backup_source.rs 的精确调用格式（从二进制还原）：
//
// 1) LX Music API:
//    GET https://yy.zddyr.top/lx/api/?source={source}&name={title}&songmid={songId}&quality={quality}
//    响应: {"code":200,"url":"https://..."}
//    支持 source: kg/kw/qq/migu/kuwo/netease/wy
//    quality 值: standard/lossless/hires/master/dolby/dts/320kmp3/flac/128kmp3
//
// 2) QQ Music API:
//    GET https://api.ygking.top/api/song/url?mid={songId}&source=QQ
//    响应: {"data":{"url":"..."}}  或 {"url":"..."}
//    字段: media_mid, song_id, data
//
// 3) Generic Music API:
//    GET https://music.bxa241d4.shop/api/music?type={provider}&id={songId}&quality={quality}
//    响应: {"url":"..."}
//
// UA 全部: Rhine-Tauri/2.0 backup-source
// 平台→source码（二进制原文: qqkuwokugounetease&kgkw）:
//   qq→qq, kuwo→kuwo, kugou→kg, netease→netease, qishui→netease, bodian→kw, joox→qq

import { withHardTimeout } from './hard-timeout.mjs';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });

/**
 * 单站硬上限：2.5s（不设 10s）。
 *
 * 实测（2026-10-16，真实 exe 环境）三个站各自的表现：
 *   yy.zddyr.top       命中 404~470ms / 说"没有"要 6000ms+（服务端自己慢，不是我们慢）
 *   api.ygking.top     3~141ms（DNS ENOTFOUND，快速失败）
 *   music.bxa241d4.shop 连接挂死，**不传 signal 时 10801ms** 才失败
 *
 * 2500ms 落在任务要求的 2–3s 带内：活站的正常应答（400~800ms）稳稳在窗口内，
 * 死站的挂死被硬切，慢站的"慢慢说没有"不再拖住后面的人。
 */
export const SOURCE_TIMEOUT_MS = 2500;

/**
 * 启动探测用的探针歌曲 —— 必须是一首**确定存在**的歌。
 *
 * 用假 id 会把好源判死（真实踩坑：`yy.zddyr.top` 对不存在的歌不是"说没有"，
 * 而是拖着不给答复 → 2.5s 超时 → 误判为死站，直接丢了一个可用音源）。
 * 这首《青花瓷》在酷我有完整版权，是稳定的探针目标。
 */
const PROBE_SONG_ID = '1860327';

/** 平台→source码（严格对齐二进制: qqkuwokugounetease&kgkw） */
const SOURCE_CODE = {
  qq: 'qq', kuwo: 'kuwo', kugou: 'kg', netease: 'netease',
  qishui: 'netease', bodian: 'kw', joox: 'qq',
};

/** quality 值（二进制原文: standardlosslesshiresmasterdolbydts320kmp3flac128kmp3） */
const QUALITY_MAP = {
  '标准': 'standard', '高品': '320kmp3', '无损': 'lossless',
  'flac': 'flac', 'hires': 'hires', 'master': 'master', 'dolby': 'dolby', 'dts': 'dts',
  '320k': '320kmp3', '128k': '128kmp3', '320kmp3': '320kmp3', '128kmp3': '128kmp3',
};

/** 硬编码的三个备用音源（对齐 backup_source.rs，不做配置化） */
export const DEFAULT_SOURCES = [
  {
    name: 'LX Music API',
    type: 'lx-api',
    url: 'https://yy.zddyr.top/lx/api/',
    providers: ['netease', 'qq', 'kuwo', 'kugou', 'qishui', 'bodian', 'joox'],
  },
  {
    name: 'QQ Music API',
    type: 'qq-api',
    url: 'https://api.ygking.top/api/song/url',
    providers: ['qq'],
  },
  {
    name: 'Generic Music API',
    type: 'generic-api',
    url: 'https://music.bxa241d4.shop/api/music',
    providers: ['netease', 'qq', 'kuwo', 'kugou', 'qishui', 'bodian', 'joox'],
  },
];

export class BackupSources {
  constructor({ fetch: doFetch = globalThis.fetch, enabled = true } = {}) {
    this.doFetch = doFetch;
    /**
     * 单站超时。
     *
     * 【2026-10-16 对齐：改回串行 + 短超时】
     * 这里被改过两轮，都是"我们发明、没有"的东西：
     *   第 1 轮 `for...await` 串行 + 每站 15s → 最坏 45s
     *   第 2 轮 `Promise.all` → 降到"最慢的单站"，但**仍然等最慢的**
     *   第 3 轮 先成功先返回（竞速）→ 又快了一档，**但根本没有竞速**
     *
     * 的真实结构（exe 文案逐字证明）：
     *   `src\backup_source.rs` 的报错是 ` 备用 HTTP 失败: ` / ` 备用请求失败: `
     *   / ` 备用接口未返回播放地址` 这种**逐站拼接**的文案，配合 `playback.rs`
     *   的 `; 备用音源: <名字>` —— 这是"链式失败后拼错误消息"，也就是**串行**、
     *   问完一站再问下一站。exe 里搜不到「竞速」二字。
     * 所以本轮**删掉竞速**，回到串行；速度靠"每站硬超时 2.5s"来保证，
     * 而不是靠并发。串行最坏 3×2.5 = 7.5s，但只有"三个站全挂"才会走到，
     * 且第一个活着说"没有"的站通常几百毫秒就返回。
     */
    this.timeout = SOURCE_TIMEOUT_MS;
    this._enabled = enabled;
    /**
     * 站点健康记忆：连续失败到阈值后，本轮直接跳过。
     *
     * 明知某个站点是死的，就不该每首歌都白等一个 2.5 秒超时。记"连续失败"
     * 而不是"失败过一次就永久拉黑"：站点可能只是临时抖动，一次成功立刻清零
     * （见下方 _ok/_fail），这样恢复后能自动回到链路里。
     *
     * 【2026-10-16 修复：跳过过的站点永远回不来】
     * 原实现只记「连续失败次数」，达到阈值后**本轮跳过**，而 `_fail` 只有在
     * 真正发起请求后才会调用 —— 被跳过的站点永远不再发起请求，也就永远不
     * 可能成功、永远不清零。结果是：一个站点只要连续失败 3 次，就被**永久**
     * 踢出链路，哪怕它一小时后就恢复了。（注释写着"恢复后能自动回到链路里"，
     * 但代码做不到这一点。）
     *
     * 现在加冷却：跳过只维持 `_skipCooldownMs`，到点后放行一次「探路」请求。
     * 成功即清零并回到链路；再失败就把冷却重新计。这样"跳过"是**临时**的，
     * 与注释承诺的语义一致，也让下面的启动预热探测变得安全 —— 预热敢把
     * 站点标成失败，是因为它一定会被重新给机会。
     */
    this._failStreak = new Map();
    this._skipThreshold = 3;
    /** 跳过冷却：超过这个时长就重新给失败站点一次机会（默认 60s）。 */
    this._skipCooldownMs = 60_000;
    /** 每站的最近一次失败时刻，用于冷却判定（见 _isSkipped）。 */
    this._failAt = new Map();
    /** 最近一次 resolve 的逐站结果，供诊断（对齐的 results[] 结构语义）。 */
    this._lastResults = [];
  }

  get enabled() { return this._enabled && DEFAULT_SOURCES.length > 0; }
  get status() { return DEFAULT_SOURCES.map(s => ({ name: s.name, type: s.type, providers: s.providers, failStreak: this._failStreak.get(s.name) ?? 0 })); }

  /** 该站此刻是否处于"跳过"状态（连续失败达阈值且冷却未到）。 */
  _isSkipped(name) {
    const streak = this._failStreak.get(name) ?? 0;
    if (streak < this._skipThreshold) return false;
    const at = this._failAt.get(name) ?? 0;
    return Date.now() - at < this._skipCooldownMs;
  }

  /** 逐站探测结果（对齐 server_line.rs 的 results 字段语义）。 */
  get results() { return this._lastResults.map(r => ({ ...r })); }

  /**
   * 主入口：**按声明顺序串行**问每一个适用的备用音源，第一个给出可用地址的胜出。
   *
   * 【2026-10-16 对齐：竞速 → 串行】
   * 之前实现的是"谁先成功用谁"（并发发起 + 先到先得）。是串行链：
   * `yy.zddyr.top` → `api.ygking.top` → `music.bxa241d4.shop`，问完一站再问下一站。
   * 串行 + 每站 2.5s 硬超时，既保持的语义，又把最坏耗时钉在 7.5s 以内。
   *
   * 之所以不能只靠并发还有另一个原因：并发会让"优先级"变得不可预测 ——
   * 同一批微任务里谁先 settle 取决于网络抖动，而不是 `DEFAULT_SOURCES`
   * 的声明顺序。的顺序是**确定的**。
   */
  async resolve(provider, songId, { quality = '320k', title = '', artist = '' } = {}) {
    const applicable = DEFAULT_SOURCES.filter(source =>
      source.providers.includes('*') || source.providers.includes(provider));
    if (!applicable.length) return null;

    const results = [];
    let winner = null;
    for (const source of applicable) {
      // 连续失败到阈值、且冷却未到的站点直接跳过，但**记为一次失败探测**（诊断可见）。
      if (this._isSkipped(source.name)) {
        results.push({ name: source.name, ok: false, skipped: true, detail: '连续失败达阈值，冷却中本轮跳过' });
        continue;
      }
      const startedAt = Date.now();
      let value = null;
      let detail = '';
      let timedOut = false;
      try {
        const found = await this.callSource(source, provider, songId, { quality, title, artist });
        if (found?.audioUrl) value = { ...found, backupSource: source.name };
        else detail = '备用接口未返回播放地址';
      } catch (error) {
        if (error?.name === 'HardTimeoutError') {
          timedOut = true;
          detail = `备用请求超时（${this.timeout}ms）`;
        } else {
          detail = `备用请求失败：${error?.message ?? error}`;
        }
      }
      const latency = Date.now() - startedAt;
      results.push({ name: source.name, ok: !!value, latency_ms: latency, detail: value ? 'ok' : detail });
      this._lastResults = results;
      if (value) { this._failStreak.delete(source.name); winner = value; break; }
      // 【2026-10-16】两类失败的证据强度不同，不该等价对待：
      //   · **硬超时** = 这个站 2.5s 内连一个 HTTP 响应都没给。这是「站点不健康」
      //     的强证据，与启动探测里"探测不可达"同一性质 → 直接判定跳过。
      //   · **快失败/说没有** = 站点活着、明确答复"这首歌我没有"。这是**歌曲
      //     相关**的弱证据（可能只是这首歌没版权）→ 只累加一次，攒够阈值才跳过。
      // 这样死站只罚一次（用户不用连着三次白等 2.5s），而活站不会因为几首
      // 冷门歌就被误踢。两者的跳过都会在 60s 冷却后自动放行重试（见 _isSkipped）。
      if (timedOut) {
        this._failStreak.set(source.name, this._skipThreshold);
        this._failAt.set(source.name, Date.now());
      } else {
        this._fail(source.name);
      }
    }
    this._lastResults = results;
    return winner;
  }

  /** 记一次失败；到阈值后跳过该站，但冷却到点会重新给机会（一次成功即清零）。 */
  _fail(name) {
    this._failStreak.set(name, (this._failStreak.get(name) ?? 0) + 1);
    this._failAt.set(name, Date.now());
  }

  /**
   * 启动期健康探测 —— 对齐 `server_line.rs` 的 `probeServerLines` 语义。
   *
   * 用**一首确定存在的歌**挨个站点问一次，把结果写进 `_failStreak`，让第一条
   * 播放请求就不必再等死站。返回结构对齐的 `results[]`：
   * `{ id, name, label, reachable, healthy, latency_ms, detail }`。
   *
   * 【为什么必须用"真歌"，不能用假 id 或裸 URL】
   * 探针形状错了会把**好源判死**，那比慢更糟 —— 慢只是等，判死是丢音源。
   * 我先后踩了两个坑，都实测过：
   *   · 裸 `GET source.url`：只证明"服务器在跑"。`yy.zddyr.top` 裸 URL 411ms
   *     回 200，可靠它解析一首冷门歌要 2570ms 超时 —— 判不准。
   *   · 假 songmid（`__service_probe__`）：`yy.zddyr.top` 这个**能用**的站
   *     对不存在的歌不是"说没有"，而是**拖着不给答复**（实测 2570ms 超时）。
   *     于是它被误判为死站 —— 直接丢了一个可用音源。
   * 换成一首真实存在的歌，语义就清楚了：
   *   · 答出地址或在预算内答复"没有" → 活（`healthy`）
   *   · 连答复都给不出（硬超时 / DNS 挂）→ 死
   * 这也正是 service 线路探测的做法：探已知可达的目标，用延迟与可达性判优，
   * 而不是拿一个无意义的目标去试。
   *
   * 判错也不会永久丢源：失败只维持 `_skipCooldownMs`（60s）就自动放行重试。
   *
   * @param {{ timeoutMs?: number, probeId?: string, probe?: (source: object) => Promise<unknown> }} [options]
   * @returns {Promise<Array<{id:string,name:string,label:string,reachable:boolean,healthy:boolean,latency_ms:number,detail:string}>>}
   */
  async probeHealth({ timeoutMs = this.timeout, probeId = PROBE_SONG_ID, probe } = {}) {
    const results = [];
    for (const source of DEFAULT_SOURCES) {
      const startedAt = Date.now();
      let healthy = false;
      let detail = '';
      try {
        const attempt = Promise.resolve().then(() => (probe
          // 自定义探针（测试注入）优先；否则走该站真实协议，用一首真实存在的歌。
          ? probe(source)
          : this.callSource(source, 'kuwo', probeId, { quality: '320k', title: '青花瓷', artist: '周杰伦' })));
        await withHardTimeout(attempt, timeoutMs, { label: `探测 ${source.name}` });
        // 没抛错 = 这个站在预算内给出了答复（"有地址"或"没这首歌"都算健康）。
        healthy = true;
        detail = '答复正常';
      } catch (error) {
        detail = error?.name === 'HardTimeoutError'
          ? `不可达：超时（${error.timeoutMs}ms）`
          : `不可达：${error?.message ?? error}`;
      }
      const latency_ms = Date.now() - startedAt;
      if (healthy) {
        this._failStreak.delete(source.name);
        this._failAt.delete(source.name);
      } else {
        // 探测是**专门为"这个站还活着吗"发的一次请求**，证据强度高于
        // "解析某首歌失败"（后者可能只是那首歌没有版权）。所以一次探测失败
        // 就直接判定为"本轮跳过"，不必再让用户等两次 2.5s 白等。
        // 不会永久拉黑：`_failAt` 一并写入，60s 冷却到点后它会重新被放行
        // （见 _isSkipped），恢复的站点 1 分钟内自动回到链路。
        this._failStreak.set(source.name, this._skipThreshold);
        this._failAt.set(source.name, Date.now());
      }
      results.push({ id: source.type, name: source.name, label: source.name, url: source.url, reachable: healthy, healthy, latency_ms, detail });
    }
    return results;
  }

  async callSource(source, provider, songId, vars) {
    switch (source.type) {
      case 'lx-api': return this.callLxApi(source, provider, songId, vars);
      case 'qq-api': return this.callQqApi(source, provider, songId, vars);
      case 'generic-api': return this.callGenericApi(source, provider, songId, vars);
      default: throw failure(`未知的备用音源类型: ${source.type}`);
    }
  }

  /**
   * LX Music API（对齐 backup_source.rs）:
   * GET https://yy.zddyr.top/lx/api/?source={source}&name={title}&songmid={songId}&quality={quality}
   * 响应: {"code":200,"url":"..."}
   */
  async callLxApi(source, provider, songId, { quality, title }) {
    const sourceCode = SOURCE_CODE[provider] || provider;
    const qualityCode = QUALITY_MAP[quality] || quality || '320kmp3';
    const params = new URLSearchParams({ source: sourceCode, name: title || sourceCode, songmid: songId, quality: qualityCode });
    const response = await this._fetch(`${source.url}?${params}`, source.name);
    const body = await this._json(response, source.name);
    if (body?.code !== 200 || !body?.url) return null;
    return { audioUrl: body.url };
  }

  /**
   * QQ Music API（对齐 backup_source.rs）:
   * GET https://api.ygking.top/api/song/url?mid={songId}&source=QQ
   * 响应: {"data":{"url":"..."}}  或 {"url":"..."}
   */
  async callQqApi(source, provider, songId) {
    const params = new URLSearchParams({ mid: songId, source: 'QQ' });
    const response = await this._fetch(`${source.url}?${params}`, source.name);
    const body = await this._json(response, source.name);
    const url = body?.data?.url ?? body?.url ?? body?.data?.audio_url ?? body?.audio_url;
    return url ? { audioUrl: url } : null;
  }

  /**
   * Generic Music API（对齐 backup_source.rs）:
   * GET https://music.bxa241d4.shop/api/music?type={provider}&id={songId}&quality={quality}
   * 响应: {"url":"..."}
   */
  async callGenericApi(source, provider, songId, { quality }) {
    const qualityCode = QUALITY_MAP[quality] || quality || '320kmp3';
    const params = new URLSearchParams({ type: SOURCE_CODE[provider] || provider, id: songId, quality: qualityCode });
    const response = await this._fetch(`${source.url}?${params}`, source.name);
    const body = await this._json(response, source.name);
    const url = body?.url ?? body?.data?.url ?? body?.audio_url ?? body?.data?.audio_url;
    return url ? { audioUrl: url } : null;
  }

  /**
   * 带**硬超时**的一跳。
   *
   * 两层保护缺一不可：
   *   ① `AbortSignal.timeout` —— 让 fetch 自己放弃（实测对死主机有效：
   *      2.5s 上限 → 2.5s 收口，而**不传 signal** 是 10801ms）。
   *   ② `withHardTimeout` 的 `Promise.race` —— 兜住"自定义 fetch 不理 signal"
   *      与"读 body 再挂一次"这两种 signal 治不了的情况。
   * `_timeoutCheck` 实测：只靠 ① 时死主机按上限收口；只靠 ② 时 2504ms 收口。
   * 两者都在，任何一跳都不会超过 `this.timeout`。
   */
  _fetch(url, label) {
    const controller = new AbortController();
    const attempt = this.doFetch(url, {
      headers: { 'User-Agent': 'Rhine-Tauri/2.0 backup-source' },
      signal: controller.signal,
    }).then(async (response) => {
      // body 也纳入保护范围：响应头回来了但 body 迟迟不结束同样要切。
      return { response, text: await response.text() };
    });
    return withHardTimeout(attempt, this.timeout, { label, controller });
  }

  /** 上面的 `_fetch` 已把 body 读完，这里只做解析（不再有额外的挂起窗口）。 */
  async _json({ text }) {
    try { return JSON.parse(text); } catch { return null; }
  }
}
