// Live health check for the online sources: search -> prepare -> probe the
// audio URL -> playlists. Diagnostic evidence script (like assets/reference
// probe-*.mjs), not a synthetic test suite. Usage: node scripts/health-check-sources.mjs [关键词]
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { KugouCatalog } from './kugou-protocol.mjs';
import { KuwoCatalog } from './kuwo-protocol.mjs';
import { JooxCatalog } from './joox-protocol.mjs';
import { BodianCatalog } from './bodian-catalog.mjs';
import { PlatformCatalog } from './platform-catalog.mjs';
import { NeteaseOnline } from './netease-online.mjs';

const query = process.argv[2] || '青花瓷';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-health-'));
// Stub platform auth (never logged in): catalogs must answer anonymously or
// with an honest 401, not crash on missing auth plumbing.
const anonymousAuth = { ready: Promise.resolve(), epoch: 0, credential: null };

const sources = {
  netease: () => new NeteaseOnline({ dataDir }),
  qq: () => new PlatformCatalog({ provider: 'qq', auth: anonymousAuth }),
  bodian: () => new BodianCatalog({ auth: anonymousAuth }),
  kugou: () => new KugouCatalog({}),
  kuwo: () => new KuwoCatalog({}),
  joox: () => new JooxCatalog({}),
};

async function probeUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-255', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok || response.status === 206, status: response.status, type: response.headers.get('content-type'), bytes: buffer.length };
  } catch (error) { return { ok: false, status: 0, error: error.message }; }
}

for (const [name, make] of Object.entries(sources)) {
  const row = { source: name, search: '❌', play: '❌', playlists: '⏭', notes: [] };
  try {
    const catalog = make();
    const result = await catalog.search(query, 0);
    const tracks = result?.tracks ?? [];
    row.search = tracks.length ? `✅ ${tracks.length} 首` : `❌ 0 首${result?.error ? ' / ' + result.error : ''}`;
    const first = tracks[0];
    if (first) row.sample = { id: first.id, providerId: first.onlineSource?.id, title: first.title, artist: first.artist, fee: first.onlineSource?.fee, quality: first.onlineSource?.qualityLabel };
    if (first) {
      for (const value of [first.id, first.onlineSource?.id]) {
        if (!value) continue;
        try {
          const prepared = await catalog.prepare(value);
          const url = prepared?.audioUrl;
          if (!url) { row.notes.push(`prepare(${value}) 无 audioUrl`); continue; }
          const probe = await probeUrl(url);
          row.play = probe.ok ? `✅ ${probe.status} ${probe.type ?? '?'} ${probe.bytes}B` : `❌ ${probe.status || probe.error}`;
          row.playVia = value;
          if (prepared.trial) row.trial = prepared.trial;
          break;
        } catch (error) { row.notes.push(`prepare(${value}): ${error.status ?? ''} ${error.message}`); }
      }
    }
    try {
      const lists = await catalog.playlists();
      row.playlists = `✅ ${(lists?.playlists ?? []).length} 个`;
    } catch (error) {
      row.playlists = error.status === 401 || /登录|login|credential|token|账号/i.test(error.message) ? '⏭ 需登录' : `❌ ${error.status ?? ''} ${error.message}`;
    }
  } catch (error) { row.notes.push(`FATAL: ${error.message}`); }
  console.log(JSON.stringify(row, null, 1));
}
