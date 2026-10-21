// 汽水音乐（Luna）请求签名：X-Helios / X-Medusa。
//
// 为什么需要它：luna 的业务接口（/luna/pc/media-player 等）在缺签名时返回
// 200 + **空响应体**；带上签名后才会返回真实数据，且带登录态时给的是整首
// （实测 VIP 曲 218.143s / 全曲 218.133s，hi_res 318kbps）。
//
// 签名算法在字节的 MetaSec 原生库里（metasecml.dll），不在 JS 层。客户端自己
// 也只是调 bdms.generateHttpSignatureHeaders(url, 头部文本)，所以这里直接复用
// 同一个原生模块，而不是重写算法。
//
// 原生文件放 scripts/vendor/qishui/（bdms.node + metasecml.dll，约 8.8MB），
// 可用环境变量 RHINE_QISHUI_NATIVE 指向别处。缺文件时签名退化为「不加签名」，
// 调用方自然回落到匿名通道，不会抛错。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const NATIVE_FILES = ['bdms.node', 'metasecml.dll'];
/** bdms 需要一个设备号，实测与账号无关（换随机值签名同样有效），固定即可。 */
const DEFAULT_DEVICE_ID = '199447014549364';

export function signerDir() {
  return process.env.RHINE_QISHUI_NATIVE || path.resolve(process.cwd(), 'scripts', 'vendor', 'qishui');
}

let native;
let attempted = false;
let initedFor = '';

function load() {
  if (attempted) return native;
  attempted = true;
  try {
    const dir = signerDir();
    if (!NATIVE_FILES.every(name => fs.existsSync(path.join(dir, name)))) return (native = null);
    // metasecml.dll 靠 Windows 的 DLL 搜索路径找，加载前把它加进 PATH。
    process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
    const module = require(path.join(dir, 'bdms.node'));
    if (typeof module?.generateHttpSignatureHeaders !== 'function') return (native = null);
    return (native = module);
  } catch {
    return (native = null);
  }
}

/** 签名组件是否可用（原生文件在位且能加载）。 */
export function signerReady() {
  return load() !== null;
}

/**
 * 给一组请求头签名，返回新对象（含 X-Helios / X-Medusa）。
 * 签名不可用或失败时原样返回入参，调用方按匿名请求处理即可。
 */
export function signHeaders(url, headers, deviceId = DEFAULT_DEVICE_ID) {
  const module = load();
  if (!module) return headers;
  try {
    if (deviceId !== initedFor) {
      module.init({ deviceId });
      initedFor = deviceId;
    }
    // 客户端做法：每个头拼成 "key\r\nvalue"，全部用 \r\n 串起来喂给签名器。
    const lines = [];
    for (const [key, value] of Object.entries(headers)) lines.push(`${key}\r\n${value}`);
    const parts = String(module.generateHttpSignatureHeaders(url, lines.join('\r\n'))).split('\r\n').filter(part => part.trim());
    const signed = { ...headers };
    for (let index = 0; index < parts.length / 2; index += 1) signed[parts[index * 2]] = parts[index * 2 + 1];
    return signed;
  } catch {
    return headers;
  }
}
