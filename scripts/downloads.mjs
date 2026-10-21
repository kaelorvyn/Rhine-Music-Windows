// Download task manager: queued downloads to a user-chosen folder with
// atomic writes, per-task retry and download_tasks.json persistence
// Downloads only what the platform
// serves to the signed-in account's own playback URLs.
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_BYTES = 512 * 1024 * 1024;
/** 用户没指定下载目录时的落点：系统「音乐」文件夹。
 *
 * 原来默认是空字符串，于是没配置时点下载只会报「请先在设置里选择下载目录」，
 * 而界面上那个框还是「例如 D:\\Music\\Downloads」的灰字。现在默认就落到
 * %USERPROFILE%\\Music，用户什么都不填也能下载。 */
export const defaultDownloadDirectory = () => {
  try { return path.join(os.homedir(), 'Music'); } catch { return ''; }
};
export const namingPatterns = ['{artist} - {title}', '{title} - {artist}', '{title}'];
// 下载音质档位 —— 7 级枚举（Standard→High→Lossless→HiRes→HiFi→Surround→Master）。
// 这个值会原样透传给共享池的 /api/proxy/music 作为 quality 参数。
export const qualityLevels = ['standard', 'high', 'lossless', 'hires', 'hifi', 'surround', 'master'];
const cleanName = value => String(value ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
/**
 * 池子/平台回的格式码 → 落盘扩展名。
 *
 * ⚠️ 加密格式**不再映射成 `.flac`**：那会让一个 172.94MB 的
 * 加密 mflac 看起来像无损 FLAC，用户下载后根本打不开。加密格式保留自己的
 * 后缀（`.mflac`/`.mgg`），配合上面的魔数校验 —— 未解密的一律拒绝落盘。
 * `mmp4` 同理：ISO-BMFF 需 `ftyp` 魔数，加密态不会有，故不再假装 `.mp4`。
 */
const FORMAT_EXTENSIONS = {
  mp3: 'mp3', m4a: 'm4a', aac: 'aac', ogg: 'ogg', wav: 'wav', wma: 'wma', ape: 'ape',
  flac: 'flac', mflac: 'mflac', mgg: 'mgg', mgg1: 'mgg1', mmp4: 'mmp4',
  // 视频（MV）：m4a 与 mp4 同为 ISO-BMFF，只能靠声明区分。不列这里的话，
  // 245MB 的 MV 会被命名成 .m4a —— 播放器当纯音频处理，画面就没了。
  mp4: 'mp4',
};
export function extensionFor(format) {
  return FORMAT_EXTENSIONS[String(format ?? '').toLowerCase()] || 'mp3';
}
/**
 * 落盘前的**魔数校验** —— 保证永不落盘垃圾文件。
 *
 * 为什么必须有：
 * 前端默认下载档位是 `master`，池子对 masterpiece 档返回的是**加密的 `mflac`**。
 * `FORMAT_EXTENSIONS` 把 `mflac` 命名为 `.flac`，于是用户拿到一个
 * **172.94MB、香农熵 8.0000 bits/byte、没有 `fLaC` 魔数的加密废文件** ——
 * 任何播放器都打不开，却看起来像无损。用户的抱怨（"下载总是 MP3"）实为更糟：
 * 下载了加密内容还伪装成无损。
 *
 * 这里的规则是：**文件内容不认识就拒绝落盘**，宁可报错也不给用户废文件。
 * 加密格式必须由调用方先解密再提交；未解密的一律拒绝。
 */
const MAGIC_RULES = [
  { name: 'flac', ext: 'flac', offset: 0, magic: Buffer.from('fLaC', 'latin1'),
    note: 'FLAC 明文（无损）' },
  { name: 'ogg', ext: 'ogg', offset: 0, magic: Buffer.from('OggS', 'latin1'),
    note: 'Ogg 容器（含 ogg/opus）' },
  { name: 'wav', ext: 'wav', offset: 0, magic: Buffer.from('RIFF', 'latin1'),
    note: 'RIFF/WAV' },
  { name: 'mp3-id3', ext: 'mp3', offset: 0, magic: Buffer.from('ID3', 'latin1'),
    note: 'MP3（带 ID3 标签头）' },
  { name: 'mp4', ext: 'm4a', offset: 4, magic: Buffer.from('ftyp', 'latin1'),
    note: 'ISO-BMFF（m4a/mp4）' },
];
/** MP3 无 ID3 时以帧同步开头：`ff fb`/`ff f3`/`ff f2`/`ff fa`。 */
const isMp3FrameSync = b => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;

/**
 * 判断一段数据是否是**可识别的明文音频**。
 * @param {Buffer} head 文件开头（至少 16 字节）
 * @returns {{ok: boolean, kind?: string, ext?: string, note?: string, reason?: string}}
 */
export function sniffAudio(head) {
  if (!head || head.length < 8) return { ok: false, reason: '文件过短，无法识别格式。' };
  for (const rule of MAGIC_RULES) {
    if (head.length >= rule.offset + rule.magic.length &&
        head.subarray(rule.offset, rule.offset + rule.magic.length).equals(rule.magic)) {
      return { ok: true, kind: rule.name, ext: rule.ext, note: rule.note };
    }
  }
  if (isMp3FrameSync(head)) return { ok: true, kind: 'mp3', ext: 'mp3', note: 'MP3（帧同步）' };
 // 已知的加密容器 —— 明确告诉用户"这是加密的，还没有解密"
  const ENCRYPTED_HINTS = [
    { magic: Buffer.from([0x2a, 0x15, 0x50, 0x73]), name: 'mflac（酷我加密 FLAC）' },
  ];
  for (const hint of ENCRYPTED_HINTS) {
    if (head.subarray(0, hint.magic.length).equals(hint.magic)) {
      return { ok: false, reason: `文件是加密的 ${hint.name}，尚未解密，拒绝落盘（避免伪装成无损）。` };
    }
  }
 // 高熵兜底：明文音乐头不会是均匀随机
  const freq = new Array(256).fill(0);
  for (const byte of head) freq[byte]++;
  let entropy = 0;
  for (const count of freq) if (count) { const p = count / head.length; entropy -= p * Math.log2(p); }
  if (entropy > 7.9) {
    return { ok: false, reason: `文件头不可识别且熵值 ${entropy.toFixed(2)} 接近随机，疑似加密内容，拒绝落盘。` };
  }
  return { ok: false, reason: '文件头不是已知的音频格式（FLAC/MP3/OGG/WAV/M4A），拒绝落盘。' };
}

export function renderFileName(pattern, track) {
  const template = namingPatterns.includes(pattern) ? pattern : namingPatterns[0];
  const rendered = template.replace('{artist}', cleanName(track.artist) || '未知歌手').replace('{title}', cleanName(track.title) || '未知歌曲');
  return `${cleanName(rendered).slice(0, 160) || '歌曲'}.${extensionFor(track.format)}`;
}
const validDirectory = value => {
  if (typeof value !== 'string' || !value || value.length > 320 || value.includes('\0')) return false;
  return path.isAbsolute(value);
};

export class DownloadManager {
  constructor({ dataDir, directory, fetch: doFetch = globalThis.fetch, concurrency = 2, now = Date.now } = {}) {
    this.file = dataDir ? path.join(dataDir, 'download_tasks.json') : undefined;
    this.doFetch = doFetch; this.concurrency = concurrency; this.now = now;
    this.tasks = []; this.active = 0;
    // `directoryConfigured` 区分「用户自己设过」与「走默认」：设置面板据此决定
    // 把路径填进输入框（用户设过）还是只当灰字提示显示（走默认）。
    this.directoryConfigured = validDirectory(directory ?? '');
    this.settings = { directory: this.directoryConfigured ? directory : defaultDownloadDirectory(), quality: 'master', naming: namingPatterns[0] };
    this.ready = this.load();
  }
  async load() {
    if (!this.file) return;
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(value.tasks)) {
        this.tasks = value.tasks.slice(0, 200).map(task => ({
          ...task, status: task.status === 'downloading' || task.status === 'queued' ? 'failed' : task.status,
          error: task.status === 'downloading' || task.status === 'queued' ? '程序退出，任务未完成，请重试。' : task.error,
        }));
      }
      if (value.settings && typeof value.settings === 'object') {
        if (validDirectory(value.settings.directory)) { this.settings.directory = value.settings.directory; this.directoryConfigured = true; }
        if (qualityLevels.includes(value.settings.quality)) this.settings.quality = value.settings.quality;
        if (namingPatterns.includes(value.settings.naming)) this.settings.naming = value.settings.naming;
      }
    } catch { /* first run or unreadable task file */ }
  }
  async save() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ settings: this.settings, tasks: this.tasks.slice(0, 200) }, null, 2), 'utf8');
    await fs.rename(temporary, this.file);
  }
  snapshot() {
    return {
      // 前端要显示「真正的落盘位置」：directory 永远是生效路径，
      // directoryIsDefault 告诉界面该不该把它填进输入框（false = 只做灰字默认值）。
      settings: { ...this.settings, directoryIsDefault: !this.directoryConfigured },
      tasks: this.tasks.map(({ id, title, artist, quality, status, error, bytes, target, createdAt }) =>
        ({ id, title, artist, quality, status, error, bytes, target, createdAt })),
    };
  }
  async configure({ directory, quality, naming } = {}) {
    await this.ready;
    if (directory !== undefined) {
      // 传空 = 回到默认目录，而不是报「需要是绝对路径」：用户清空输入框的
      // 语义就是「别再问我放哪，你决定」。
      const target = String(directory ?? '').trim() || defaultDownloadDirectory();
      if (!validDirectory(target)) throw failure('下载目录需要是绝对路径。');
      try { await fs.mkdir(target, { recursive: true }); } catch { throw failure('无法创建下载目录，请检查路径与权限。'); }
      this.settings.directory = target;
      this.directoryConfigured = String(directory ?? '').trim().length > 0;
    }
    if (quality !== undefined) {
      if (!qualityLevels.includes(quality)) throw failure('无效的下载音质。');
      this.settings.quality = quality;
    }
    if (naming !== undefined) {
      if (!namingPatterns.includes(naming)) throw failure('无效的命名方式。');
      this.settings.naming = naming;
    }
    await this.save();
    return this.snapshot();
  }
  async add({ url, title, artist, quality, fileName, format } = {}) {
    await this.ready;
    if (!this.settings.directory) throw failure('请先在设置里选择下载目录。', 409);
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 4096) throw failure('无效的下载地址。');
    const task = {
      id: randomUUID(), url, title: cleanName(title) || '未知歌曲', artist: cleanName(artist) || '未知歌手',
      quality: qualityLevels.includes(quality) ? quality : this.settings.quality,
      fileName: cleanName(fileName) || renderFileName(this.settings.naming, { title, artist, format }),
      status: 'queued', error: null, bytes: 0, createdAt: this.now(),
    };
    task.target = path.join(this.settings.directory, task.fileName);
    this.tasks.unshift(task);
    await this.save();
    this.pump();
    return this.snapshot();
  }
  async retry(id) {
    await this.ready;
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw failure('找不到该下载任务。', 404);
    if (task.status === 'done') return this.snapshot();
    if (!this.settings.directory) throw failure('请先在设置里选择下载目录。', 409);
    task.status = 'queued'; task.error = null; task.bytes = 0;
    task.target = path.join(this.settings.directory, task.fileName);
    await this.save();
    this.pump();
    return this.snapshot();
  }
  async remove(id) {
    await this.ready;
    const index = this.tasks.findIndex(item => item.id === id);
    if (index < 0) throw failure('找不到该下载任务。', 404);
    this.tasks.splice(index, 1);
    await this.save();
    return this.snapshot();
  }
  pump() {
    while (this.active < this.concurrency) {
      const task = this.tasks.find(item => item.status === 'queued');
      if (!task) return;
      task.status = 'downloading'; this.active++;
      void this.run(task).finally(() => { this.active--; this.pump(); });
    }
  }
  async run(task) {
    const partial = `${task.target}.part`;
    try {
      await fs.mkdir(path.dirname(task.target), { recursive: true });
      const response = await this.doFetch(task.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: '*/*' },
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok || !response.body) throw failure(`下载失败（HTTP ${response.status}），可重试。`, 502);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_BYTES) throw failure('文件超过 512 MiB 上限。');
      const stream = Readable.fromWeb(response.body);
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) stream.destroy(failure('文件超过 512 MiB 上限。'));
        task.bytes = bytes;
      });
      await pipeline(stream, createWriteStream(partial));
 // ★ 落盘前魔数校验：解密失败/服务端回加密内容时，绝不把废文件交给用户。
 // 读 partial 的头部做识别；不通过就删掉并标记失败（可重试）。
      const probe = await fs.open(partial, 'r');
      let head;
      try {
        const buffer = Buffer.alloc(64);
        const { bytesRead } = await probe.read(buffer, 0, 64, 0);
        head = buffer.subarray(0, bytesRead);
      } finally { await probe.close(); }
      const sniffed = sniffAudio(head);
      if (!sniffed.ok) throw failure(`${sniffed.reason} 该音源可能尚未解密或格式不受支持。`, 415);
 // ★ 扩展名以**实测内容**为准，而非上游声明的 format ——
 // 上游说 mflac 而实际送来的可能是 mgg/mp3，命名错了播放器仍打不开。
 // 例外：sniffAudio 对 ISO-BMFF 一律回 m4a（那是音频的常见后缀），但**声明
 // 是 .mp4 的视频**要保留 mp4 —— MV 走同一条下载管线，改成 .m4a 会让播放器
 // 把画面当成音频容器忽略掉。
      const declaredExt = path.extname(task.target);
      const sniffedExt = sniffed.kind === 'mp4' && declaredExt.toLowerCase() === '.mp4' ? 'mp4' : sniffed.ext;
      if (declaredExt.toLowerCase() !== `.${sniffedExt}`) {
        const corrected = `${task.target.slice(0, -declaredExt.length)}.${sniffedExt}`;
        task.target = corrected;
        task.fileName = path.basename(corrected);
      }
      await fs.rename(partial, task.target);
      task.status = 'done'; task.error = null; task.bytes = bytes;
      task.verifiedFormat = sniffed.kind;
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {});
      task.status = 'failed';
      task.error = error instanceof Error && error.message ? error.message : '下载失败，可重试。';
    }
    await this.save().catch(() => {});
  }
}
