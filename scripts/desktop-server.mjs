import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createMusicServer } from './music-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [name, variable] of [['ffmpeg', 'FFMPEG_PATH'], ['ffprobe', 'FFPROBE_PATH']]) {
  const bundled = path.join(root, 'bin', `${name}.exe`);
  if (!process.env[variable] && existsSync(bundled)) process.env[variable] = bundled;
}
// The desktop controls the service lifetime. Never reuse a foreign process.
const { server, decoder, output, qishuiVerification } = await createMusicServer({ distDir: path.join(root, 'dist') });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  decoder.dispose(); output.dispose();
  server.close(() => process.exit(0)); server.closeAllConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.stdin.setEncoding('utf8');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  if (line === 'shutdown') { stop(); return; }
  if (line.length > 1048576) return;
  let message;
  try {
    message = JSON.parse(line);
    if (!Number.isSafeInteger(message.id) || !['verification-context', 'verification-result', 'verification-cancel', 'verification-http', 'session-context', 'session-result', 'passport-context', 'passport-result', 'passport-ready', 'passport-retry'].includes(message.action)) return;
    const result = await qishuiVerification(message.action, message.args ?? {});
    process.stdout.write('RHINE_VERIFY ' + JSON.stringify({ id: message.id, ok: true, result }) + '\n');
  } catch {
    if (Number.isSafeInteger(message?.id)) process.stdout.write('RHINE_VERIFY ' + JSON.stringify({ id: message.id, ok: false }) + '\n');
  }
});
process.stdin.once('end', stop);
process.once('SIGTERM', stop); process.once('SIGINT', stop);
async function listen(port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}
// A stable origin keeps browser preferences across launches. Conflicting ports
// fall back to a random owned port rather than terminating another application.
try { await listen(Number(process.env.RHINE_DESKTOP_PORT || 5175)); }
catch (error) { if (error.code !== 'EADDRINUSE') throw error; await listen(0); }
server.on('error', error => { console.error(error); process.exitCode = 1; stop(); });
console.log(`RHINE_READY http://127.0.0.1:${server.address().port}/`);
