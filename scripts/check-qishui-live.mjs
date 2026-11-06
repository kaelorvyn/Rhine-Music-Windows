// 未登录搜索矩阵自检：六个平台在**没有任何凭据**时都必须出结果。
//
// 这条是硬要求：搜索不允许因为没登录就没结果。所以要守住的不是某一个平台，
// 而是整张平台的匿名通道 —— 汽水走无签名 H5 口、JOOX 走匿名 commonCgi、
// QQ 走匿名 search_for_qq_cp、其余走各自公开口。
//
// 跑法：node scripts/check-qishui-live.mjs   （会联网；断网时逐项报错但不误判为通过）
import { QishuiCatalog } from './qishui-catalog.mjs';
import { JooxCatalog } from './joox-protocol.mjs';
import { KuwoCatalog } from './kuwo-protocol.mjs';
import { KugouCatalog } from './kugou-protocol.mjs';
import { PlatformCatalog } from './platform-catalog.mjs';
import { NeteaseOnline } from './netease-online.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUERY = '周杰伦';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-live-'));

const catalogs = {
  qishui: () => new QishuiCatalog({}),
  joox: () => new JooxCatalog(),
  kuwo: () => new KuwoCatalog(),
  kugou: () => new KugouCatalog({}),
  qq: () => new PlatformCatalog({ provider: 'qq', auth: null }),
  netease: () => new NeteaseOnline({ dataDir: scratch }),
};

let failed = 0;
for (const [provider, make] of Object.entries(catalogs)) {
  const startedAt = Date.now();
  try {
    const result = await make().search(QUERY, 0);
    const count = Array.isArray(result?.tracks) ? result.tracks.length : 0;
    const ms = Date.now() - startedAt;
    if (count > 0) {
      console.log(`✓ ${provider.padEnd(7)} ${String(count).padStart(2)} 条  ${ms}ms  ${result.tracks[0]?.title ?? ''}`);
    } else {
      failed++;
      console.log(`✗ ${provider.padEnd(7)} 匿名搜索返回 0 条（${ms}ms）`);
    }
  } catch (error) {
    failed++;
    console.log(`✗ ${provider.padEnd(7)} 匿名搜索失败：${error?.message ?? error}`);
  }
}

if (failed) {
  console.error(`\n✗ 有 ${failed} 个平台在未登录状态下搜不了。`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 六个平台在未登录状态下全部可以搜索。');
}
