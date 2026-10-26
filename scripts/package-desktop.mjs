import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const name = process.env.RHINE_PACKAGE_NAME || 'Rhine-Music-Windows';
if (!/^Rhine-Music-Windows(?:-[A-Za-z0-9-]+)?$/.test(name)) throw new Error('Invalid portable folder name');
const output = path.resolve('release', name);
if (path.dirname(output) !== path.resolve('release')) throw new Error('Invalid portable output path');
// Windows forbids opening a running executable for writing. Check before
// removing any files so an open preview remains a complete, usable package.
for (const executable of [path.join(output, 'Rhine Music.exe'), path.join(output, 'runtime', 'node.exe')]) {
  try { const handle = await fs.open(executable, 'r+'); await handle.close(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The target preview is running. Close it or use a separate RHINE_PACKAGE_NAME before packaging.'); }
}
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile('src-tauri/target/release/rhine-music-windows.exe', path.join(output, 'Rhine Music.exe'));
await fs.cp('desktop-runtime', path.join(output, 'runtime'), { recursive: true });
await fs.copyFile('README.md', path.join(output, 'README.txt'));
await fs.copyFile('LICENSE', path.join(output, 'LICENSE'));
await fs.copyFile('NOTICE.md', path.join(output, 'NOTICE.md'));
await fs.copyFile('PLATFORM-NOTICE.md', path.join(output, 'PLATFORM-NOTICE.md'));
// 贡献者名单随包分发：NOTICE.md / PLATFORM-NOTICE.md 都引用了它，
// 包里没有这份文件就成了死链，署名也就断了。
await fs.copyFile('CONTRIBUTORS.md', path.join(output, 'CONTRIBUTORS.md'));
await fs.copyFile('PRIVACY.md', path.join(output, 'PRIVACY.md'));
const hashes = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name !== 'SHA256SUMS.txt') hashes.push(`${createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${path.relative(output, file).replaceAll('\\', '/')}`);
  }
}
await walk(output);
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`Portable desktop: ${output}`);
