// 汽水音乐登录 + 歌单 + 整首播放的**人工验证**脚本（不进 CI：会联网、要扫码）。
//
// 用法：node scripts/qishui-login-check.mjs
// 生成 outputs/qishui-qr-<时间>.png，用汽水音乐 App 扫，扫完在手机上点确认。
// 脚本等 4.5 分钟（二维码有效期 5 分钟，留点余量）。
//
// 依次验证四件事：
//   1. 登录态有效（能拿到账号 id / 昵称）
//   2. 账号歌单能拉下来（歌单同步的基础）
//   3. 歌单曲目能拉下来（含封面与时长）
//   4. 受限曲能拿到整首（签名通道 /luna/pc/media-player）
//
// 注意：sessionid 是实时凭据，只留在内存里，不落盘、不打印。
// 轮询是**按需**的：脚本自己不轮询，只在 outputs/poll-request 出现时拉一次。
// 因为单个 token 的轮询次数有硬上限，超过就回 err=7 并且该 token 直接作废。
import fs from 'node:fs';
import path from 'node:path';
import { QishuiLoginProtocol } from './qishui-protocol.mjs';
import { QishuiCatalog } from './qishui-catalog.mjs';
import { signerReady } from './qishui-signer.mjs';

const VIP_TRACK = '6732580534901278722'; // 《Hora》全曲 218133ms
const OUT_DIR = path.resolve(process.cwd(), 'outputs');

/** 从 mp4/m4a 的 mvhd 读真实时长（秒）。 */
function mp4Seconds(buffer) {
  let pos = -1;
  while ((pos = buffer.indexOf('mvhd', pos + 1)) >= 0) {
    const version = buffer[pos + 4];
    const timescale = version === 1 ? buffer.readUInt32BE(pos + 24) : buffer.readUInt32BE(pos + 16);
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(pos + 28)) : buffer.readUInt32BE(pos + 20);
    if (timescale > 0 && duration > 0 && duration / timescale < 7200) return duration / timescale;
  }
  return 0;
}

console.log('签名组件:', signerReady() ? '可用（可播整首）' : '不可用（受限曲会走换源兜底）');

const protocol = new QishuiLoginProtocol();
const controller = new AbortController();
const started = await protocol.start(controller.signal, 'qishui');
const challenge = { token: started.token, expiresAt: started.expiresAt, controller };

const base64 = String(started.image).split(',')[1] ?? '';
fs.mkdirSync(OUT_DIR, { recursive: true });
// 文件名带时间戳：同名文件会被聊天界面/浏览器缓存，扫到的是过期旧图。
const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const qrPath = path.join(OUT_DIR, `qishui-qr-${stamp}.png`);
fs.writeFileSync(qrPath, Buffer.from(base64, 'base64'));
console.log('二维码:', qrPath, `(${Math.round(base64.length * 0.75)} 字节)`);
console.log('过期:', new Date(started.expiresAt).toLocaleTimeString(), '— 扫完记得在手机上点确认');
console.log('扫完并确认后，写 outputs/poll-request 触发一次拉取');

// 单个 token 的轮询次数有硬上限（实测 15 次左右），超了就回 err=7 并且该 token 作废。
// 所以不自动轮询：只在收到信号文件时才拉一次，整个流程 2~3 次请求。
const SIGNAL = path.join(OUT_DIR, 'poll-request');
if (fs.existsSync(SIGNAL)) fs.unlinkSync(SIGNAL);

let credential = null;
let polls = 0;
const deadline = Date.now() + 270000;
while (Date.now() < deadline && !credential) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!fs.existsSync(SIGNAL)) continue;
  fs.unlinkSync(SIGNAL);
  polls += 1;
  try {
    const result = await protocol.poll(challenge, controller.signal);
    if (result.nextToken) {
      // 服务端在扫码推进后会轮换 token，不跟着换就会被判成异常访问。
      challenge.token = result.nextToken;
      console.log(`· 第 ${polls} 次：token 已轮换，切到新 token`);
    }
    const mark = `${result.state}/${result.raw || '?'}${result.errorCode ? ` err=${result.errorCode}` : ''}${result.description ? ` "${result.description}"` : ''}${Number.isFinite(result.cookieCount) ? ` cookies=${result.cookieCount}` : ''}`;
    console.log(`· 第 ${polls} 次：${mark}`);
    if (result.state === 'authorized') { credential = result.credential; console.log('\n登录成功:', result.profile); }
    else if (result.state === 'expired') { console.log('\n二维码已过期。'); process.exit(1); }
  } catch (error) {
    if (error.loginExpired) { console.log('\n登录态失效。'); process.exit(1); }
    console.log('\n轮询错误:', error.message);
  }
}
if (!credential) { console.log('\n4.5 分钟内没有完成扫码。'); process.exit(1); }

const profile = await protocol.profile(credential).catch(error => ({ error: error.message }));
console.log(`\n[1] 账号: ${profile.error ? `失败 — ${profile.error}` : `OK userId=${profile.userId} nickname=${profile.nickname || '(空)'}`}`);
if (profile.error) process.exit(1);

const catalog = new QishuiCatalog({ auth: { credential } });

let firstPlaylist = '';
try {
  const list = await catalog.playlists(0);
  console.log(`[2] 账号歌单: ${list.playlists.length} 个${list.hasMore ? '（还有更多）' : ''}`);
  for (const item of list.playlists.slice(0, 8)) {
    console.log(`      · ${item.name}  ${item.trackCount} 首${item.coverUrl ? '  [有封面]' : ''}`);
  }
  if (list.playlists[0]) firstPlaylist = list.playlists[0].id;
} catch (error) {
  console.log(`[2] 账号歌单: 失败 — ${error.message}`);
}

if (firstPlaylist) {
  try {
    const page = await catalog.playlistTracks(firstPlaylist, 0);
    console.log(`[3] 歌单曲目: ${page.tracks.length}/${page.total} 首，hasMore=${page.hasMore}`);
    for (const track of page.tracks.slice(0, 5)) {
      console.log(`      · ${track.title} — ${track.artist} (${track.duration}s)${track.onlineSource.fee ? '  [受限]' : ''}`);
    }
  } catch (error) {
    console.log(`[3] 歌单曲目: 失败 — ${error.message}`);
  }
}

// 4) 受限曲：走 catalog.prepare（内部先试签名通道）
try {
  const started4 = Date.now();
  const resolved = await catalog.prepare(`qishui-${VIP_TRACK}`);
  console.log(`\n[4] 受限曲《Hora》 — ${((Date.now() - started4) / 1000).toFixed(1)}s 解析完成，格式 ${resolved.format}`);
  const media = await fetch(resolved.audioUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(90000) });
  const bytes = Buffer.from(await media.arrayBuffer());
  const seconds = mp4Seconds(bytes);
  console.log(`      实际音频 ${bytes.length} 字节 | ${seconds ? seconds.toFixed(1) + ' 秒' : '未解析'}`);
  console.log(seconds > 120 ? '\n>>> 整首 ✅ 受限曲可直接播' : '\n>>> 仍是片段 ❌');
} catch (error) {
  console.log(`\n[4] 受限曲《Hora》: 失败 — ${error.message}`);
  console.log('      说明签名通道未生效，会落到换源兜底。');
}
