import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'desktop-runtime');
// This fixed staging directory is inside the project, never a user library.
if (path.dirname(target) !== path.resolve(root)) throw new Error('Invalid runtime staging path');
await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
await fs.copyFile(process.execPath, path.join(target, 'node.exe'));

// ── 只复制运行时真正会 import 到的模块 ──────────────────────────────
//
// 旧实现是 `fs.cp(root/scripts, target/scripts)`，把整个开发目录原样搬进
// 发布包 —— 连测试脚本、调试脚本、开发期片段一起带上，包体虚增且没有必要。
// 现在按依赖图收集：从 desktop-server.mjs 出发递归跟踪
// `from './xxx.mjs'` / `import('./xxx.mjs')`，只搬真正被引用的文件。
// 新增模块只要被 import 到就会自动进包，不需要维护白名单。
const SCRIPT_ENTRIES = ['desktop-server.mjs'];

async function collectRuntimeModules(dir) {
  const seen = new Set();
  const queue = [...SCRIPT_ENTRIES];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const file = path.join(dir, name);
    if (!(await fs.stat(file).catch(() => null))) continue;
    seen.add(name);
    const src = await fs.readFile(file, 'utf8');
 // 静态 import、动态 import()、export ... from 三种形式都覆盖
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([\w.-]+\.[cm]?js)['"]/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return [...seen];
}

const runtimeModules = await collectRuntimeModules(path.join(root, 'scripts'));
await fs.mkdir(path.join(target, 'scripts'), { recursive: true });
for (const name of runtimeModules) {
  await fs.copyFile(path.join(root, 'scripts', name), path.join(target, 'scripts', name));
}
// ── 按路径字符串加载的运行时文件（不在 import 图里，必须显式列出）─────
//
// 上面按 import 图收集只能发现 `import`/`export from`。
// 有两类文件是**运行时按路径打开**的，import 图看不见，于是被漏掉，
// 导致发布包里 LX 音源整体加载失败（worker 找不到）：
//
// · lx-source-worker.mjs lx-source-host.mjs:12 用 new URL 算出路径再起 Worker
// · windows-protect-secret.ps1 netease-session.mjs:10 调 PowerShell 读 DPAPI 密钥
//
// 以后再加「按路径读的文件」时，请同步往这张表里补一行。
const RUNTIME_EXTRA_FILES = ['lx-source-worker.mjs', 'windows-protect-secret.ps1'];

console.log('运行时代码：' + runtimeModules.length + ' 个模块');

for (const name of RUNTIME_EXTRA_FILES) {
  const from = path.join(root, 'scripts', name);
  if (!(await fs.stat(from).catch(() => null))) {
    console.warn('警告：运行时依赖缺失 ' + name);
    continue;
  }
  await fs.copyFile(from, path.join(target, 'scripts', name));
}

// ── lx-sources/：随包分发的音源插件目录，必须整目录带过去 ────────────
//
//
// 上面按 import 图收集只覆盖 `.mjs` 模块；`lx-sources/*.js` 是运行时按目录
// 扫描加载的插件，不在 import 图里，于是被整批漏掉。后果很严重：
// 发布包 pluginCount=0 → 自定义音源那一跳 0ms 直接返回空 → 用户没有导入
// 密钥时，取源链三跳全空，一首歌都放不出来。
//
// 旧实现是 `fs.cp(root/scripts, target/scripts, {recursive:true})`，
// 顺带把整个目录都搬了。改成按需收集时必须在显式白名单里补回来。
const LX_SOURCES_DIR = 'lx-sources';
const lxFrom = path.join(root, 'scripts', LX_SOURCES_DIR);
if (await fs.stat(lxFrom).catch(() => null)) {
  await fs.cp(lxFrom, path.join(target, 'scripts', LX_SOURCES_DIR), { recursive: true });
  const n = (await fs.readdir(lxFrom)).filter((f) => f.endsWith('.js')).length;
  console.log('音源插件：' + n + ' 个');
} else {
  console.warn('警告：找不到 scripts/' + LX_SOURCES_DIR + '，发布包将没有自定义音源');
}

await fs.cp(path.join(root, 'dist'), path.join(target, 'dist'), { recursive: true });
// native/ 只发布**运行时真正会读的源文件**（RhineAudio.swift，macOS 的音频助手）。
//
// 原来是无条件 `cp` 整个 native/ —— 而 native/rhine-audio-win/
// 是一个 Rust 实验目录，它的 target/debug/ 编译产物有 130 MB（rlib/rmeta/pdb），
// 全被扫进了发布包却没任何代码引用。实测这让便携包从 677 MB 涨到 807 MB，
// 用户拿去别的电脑传输纯属白背。按扩展名/目录白名单复制，别再整目录搬。
const NATIVE_KEEP = ['RhineAudio.swift'];
await fs.mkdir(path.join(target, 'native'), { recursive: true });
for (const name of NATIVE_KEEP) {
  const from = path.join(root, 'native', name);
  if (await fs.stat(from).catch(() => null)) await fs.copyFile(from, path.join(target, 'native', name));
}
await fs.cp(path.join(root, 'third-party'), path.join(target, 'third-party'), { recursive: true });
// README.original.md 是上游项目原始说明，已从仓库移除；改用本项目的 PLATFORM-NOTICE.md。
for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE.md', 'PLATFORM-NOTICE.md'])
  await fs.copyFile(path.join(root, name), path.join(target, name));
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const child = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
if (child.status !== 0) throw new Error('Could not prepare locked production dependencies');
// Optional user-supplied FFmpeg binaries. Their licenses must accompany them.
const bin = path.join(root, 'desktop-binaries');
try {
  await fs.access(bin);
  for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'FFMPEG-LICENSE.txt', 'FFMPEG-README.txt']) await fs.access(path.join(bin, name));
  await fs.cp(bin, path.join(target, 'bin'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT' || await fs.stat(bin).catch(() => null)) throw error;
}
console.log('Desktop runtime prepared; end users do not need Node.js or npm.');
