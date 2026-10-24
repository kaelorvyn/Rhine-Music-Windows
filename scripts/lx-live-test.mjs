import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 实时音源测试台的数据源：逐条输出 JSONL 事件，供 PowerShell 画实时表格。 */
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const out = (ev) => { try { process.stdout.write(JSON.stringify(ev) + '\n'); } catch {} };
const repo = process.cwd();
const srcDir = path.join(repo, 'scripts', 'lx-sources');
const mod = await import(pathToFileURL(path.join(repo, 'scripts', 'lx-source-loader.mjs')).href);
const { LxSourceRuntime } = mod;

const runtime = new LxSourceRuntime({ guardRejections: true });
const report = await runtime.loadDirectories([srcDir]);
const failed = report.filter((r) => !r.ok);
out({ ev: 'load', total: report.length, ok: report.length - failed.length, failed: failed.length });
for (const f of failed) out({ ev: 'loadfail', file: f.name, error: String(f.error).slice(0, 80) });

// 逐源登记元信息 + 挂接开始/结束事件
for (const [id, plugin] of runtime.plugins) {
  const file = path.basename(plugin.filePath);
  const name = plugin.meta?.name || file;
  for (const source of plugin.sources.keys()) out({ ev: 'meta', key: `${id}|${source}`, id, file, name, source });
  const orig = plugin.musicUrl.bind(plugin);
  plugin.musicUrl = async (source, info, quality) => {
    const key = `${id}|${source}`;
    const t0 = Date.now();
    out({ ev: 'start', key, file, name, source, tier: quality });
    try {
      const url = await orig(source, info, quality);
      out({ ev: 'end', key, file, name, source, ms: Date.now() - t0, ok: Boolean(url), tier: quality, error: url ? '' : '未返回地址' });
      return url;
    } catch (error) {
      out({ ev: 'end', key, file, name, source, ms: Date.now() - t0, ok: false, tier: quality, error: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 70) });
      throw error;
    }
  };
}

const probes = [
  { source: 'kw', keyword: '夜曲 周杰伦', info: { id: '118980', songmid: '118980', name: '夜曲', singer: '周杰伦', albumName: '' } },
  { source: 'wy', keyword: '夜曲 周杰伦', info: { id: '2725685941', songmid: '2725685941', name: '夜曲', singer: '周杰伦', albumName: '' } },
  { source: 'tx', keyword: '夜曲 周杰伦', info: { id: '001zMQr71F1Qo8', songmid: '001zMQr71F1Qo8', name: '夜曲', singer: '周杰伦', albumName: '' } },
  { source: 'kg', keyword: '夜曲 周杰伦', info: { id: '16c8ab298231370293d16bcf9e5ff9b6', hash: '16c8ab298231370293d16bcf9e5ff9b6', songmid: '16c8ab298231370293d16bcf9e5ff9b6', name: '夜曲', singer: '周杰伦', albumName: '' } },
  { source: 'mg', keyword: '夜曲 周杰伦' },
];
const started = Date.now();
await runtime.selfCheck({ probes, concurrency: 6, budgetMs: 900000, callTimeoutMs: 12000 });

// 权威结论：以 health 为准
const rows = [];
for (const [id, plugin] of runtime.plugins) {
  const file = path.basename(plugin.filePath);
  const name = plugin.meta?.name || file;
  const sources = {};
  for (const source of plugin.sources.keys()) {
    const h = runtime.health.get(`${id}|${source}`);
    if (!h) continue;
    sources[source] = { ok: Boolean(h.ok), ms: h.ms ?? null, quality: h.quality ?? null, error: String(h.error ?? '').slice(0, 80) };
  }
  rows.push({ id, file, name, version: plugin.meta?.version ?? '', platforms: [...plugin.sources.keys()], alive: Object.values(sources).filter((s) => s.ok).length, total: Object.keys(sources).length, sources });
}
for (const r of rows) out({ ev: 'final', file: r.file, name: r.name, alive: r.alive, total: r.total, sources: r.sources });
const reportPath = path.join(process.env.TEMP, 'lx-full-report.json');
const keep = rows.filter((r) => r.alive > 0).length;
fs.writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, failed: failed.map((f) => ({ name: f.name, error: String(f.error).slice(0, 120) })), rows: rows.sort((a, b) => b.alive - a.alive) }, null, 2));
out({ ev: 'done', alive: keep, dead: rows.length - keep, total: rows.length, failed: failed.length, report: reportPath, seconds: Math.round((Date.now() - started) / 1000) });
