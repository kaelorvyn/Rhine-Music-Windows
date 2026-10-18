import type { MusicTrack } from './music-types.ts';

/** Quality tier badges —— 7 级音质枚举。
 *
 * 顺序（低→高）：
 * Standard → High → Lossless → HiRes → HiFi → Surround → Master
 *
 * 格式码判定表：
 * 128k / m500 → Standard   320k / m800 → High
 * flac / f000 → Lossless   q000 / q001 → HiRes
 * hifi        → HiFi       d004 / dt03 → Surround
 * ai00        → Master
 *
 * 列表行右侧那排标签（母带 / HiFi / 5.1 / SQ / HQ）不是本地评定的，而是各平台
 * 搜索接口自带的「音质能力」字段：
 *
 *   size_128mp3 / size_320mp3 / size_flac / size_hires / size_dts ← QQ、网易：按档位文件大小
 *   jyeffect / sky / lossless / exhigh / jymaster                 ← 网易 privilege.maxBrLevel
 *   kbps_map（128 / 320 / flac / hires / master_tape / stereo_atmos）← 酷我
 *   audio_codec / channel_count / is_dolby_atmos                   ← 本地库字段
 *   preview（trybegin / tryend / trysize）                         ← 平台自报的试听窗口
 *
 * 如实解析这些字段即可渲染音质标签，不需要额外推断。 */
export type QualityTier =
  | 'standard' | 'high' | 'lossless' | 'hires' | 'hifi' | 'surround' | 'master';

export const qualityTierLabels: Record<QualityTier, string> = {
  standard: '标准',
  high: '高品',
  lossless: '无损',
  hires: 'Hi-Res',
  hifi: 'HiFi',
  surround: '环绕',
  master: '母带',
};

/** 音质权重（数字越大越高），搜索结果按此降序、歌单按最高音质排序共用。 */
export const qualityTierWeight: Record<QualityTier, number> = {
  standard: 0, high: 1, lossless: 2, hires: 3, hifi: 4, surround: 5, master: 6,
};

/** 平台侧的档位名 → 我们的 7 级枚举。
 * 网易云 maxBrLevel / QQ 的 level / 酷我 kbps_map 键 / 酷狗 quality 都用这套名字。 */
const LEVEL_TO_TIER: Record<string, QualityTier> = {
 // 网易云 privilege.maxBrLevel / plLevel / dlLevel 的取值（实测）
  jymaster: 'master', jyeffect: 'surround', sky: 'surround',
  hires: 'hires', lossless: 'lossless', exhigh: 'high', standard: 'standard',
 // QQ / 酷狗 / 酷我的档位名
  master: 'master', surround: 'surround', atmos: 'surround', dolby: 'surround',
  dts: 'surround', hifi: 'hifi', 'hi-res': 'hires', sq: 'lossless', hq: 'high',
  flac: 'lossless', '320k': 'high', '128k': 'standard',
};

/** 从原始能力字段里解析出该曲**真正具备**的最高档位。
 * 只在有明确证据时升级，绝不因为"文件大"就谎称母带。 */
export function qualityTierFromCapabilities(track: MusicTrack): QualityTier | null {
  const cap = track.onlineSource?.capabilities;
  if (!cap) return null;
  const tiers: QualityTier[] = [];

 // ① 平台自报的最高档位名（最权威）
  for (const name of cap.levels ?? []) {
    const tier = LEVEL_TO_TIER[String(name).toLowerCase()];
    if (tier) tiers.push(tier);
  }
 // ② 各档位文件大小 > 0 = 该档位真的存在
  if (cap.sizes) {
    if (cap.sizes.flac) tiers.push('lossless');
    if (cap.sizes.hires) tiers.push('hires');
    if (cap.sizes.dts) tiers.push('surround');
    if (cap.sizes.ape) tiers.push('lossless');
  }
 // ③ 网易云 sq/hr 对象
  if (cap.sq) tiers.push('lossless');
  if (cap.hr) tiers.push('hires');
 // ④ 酷我 kbps_map
  for (const key of cap.kbpsMap ?? []) {
    const tier = LEVEL_TO_TIER[String(key).toLowerCase()];
    if (tier) tiers.push(tier);
  }
  if (!tiers.length) return null;
  return tiers.reduce((best, tier) => qualityTierWeight[tier] > qualityTierWeight[best] ? tier : best);
}

export function qualityTierOf(track: MusicTrack): QualityTier {
  const source = track.onlineSource;
  const text = [track.format, track.codec, source?.qualityLabel].filter(Boolean).join(' ');

 // ⓪ 平台自报的音质能力（最准确，优先）
  const fromCapabilities = qualityTierFromCapabilities(track);
  if (fromCapabilities) return fromCapabilities;

 // ① Master（母带）：ai00 格式码 / master / 母带 / jymaster / jyeffect
  if (/master|母带|jymaster|jyeffect|ai00/i.test(text)) return 'master';
 // ② Surround（环绕）：d004 / dt03 / dolby / dts / atmos / 全景声
  if (/surround|dolby|\bdts\b|atmos|全景声|环绕|d004|dt03/i.test(text)) return 'surround';
 // ③ HiFi：显式 hifi 标签，或 24bit / ≥88.2kHz 的高解析母版
  if (/hifi|hi[- ]?fi/i.test(text) ||
      (track.bitsPerSample ?? 0) >= 24 || (track.sampleRate ?? 0) >= 88200) return 'hifi';
 // ④ HiRes（高解析）：q000 / q001 / hi-res / 高解析
  if (/hi[- ]?res|hires|高解析|q000|q001/i.test(text)) return 'hires';
 // ⑤ Lossless（无损）：flac / f000 / 无损 / alac / ape / wav
  if (track.lossless === true || /lossless|无损|flac|f000|alac|ape|wav|aiff|pcm/i.test(text)) return 'lossless';
 // ⑥ High（高品）：320k / m800 / exhigh / 极高 / 高品质
  if ((track.bitrate ?? 0) >= 320 || /high|hq|高品|超高|极高|320k|m800|exhigh/i.test(text)) return 'high';
 // ⑦ Standard（标准）：128k / m500 / 未知 —— 不谎称无损。
  return 'standard';
}

/** 一行里要展示的全部音质徽章（上游是多个标签并排，不是一个）。
 * 例：《風の住む街》→ [母带] [HiFi] ；《晴天》→ [SQ] [HQ]
 * 按档位从高到低排列，最多 3 个，避免挤爆行宽。 */
export function qualityBadges(track: MusicTrack): QualityTier[] {
  const cap = track.onlineSource?.capabilities;
  const found = new Set<QualityTier>();
  const top = qualityTierFromCapabilities(track);
  if (top) found.add(top);
  if (cap) {
    for (const name of cap.levels ?? []) {
      const tier = LEVEL_TO_TIER[String(name).toLowerCase()];
      if (tier) found.add(tier);
    }
    if (cap.sq) found.add('lossless');
    if (cap.hr) found.add('hires');
    if (cap.sizes?.flac) found.add('lossless');
    if (cap.sizes?.hires) found.add('hires');
    if (cap.sizes?.dts) found.add('surround');
    if (cap.sizes?.ape) found.add('lossless');
    for (const key of cap.kbpsMap ?? []) {
      const tier = LEVEL_TO_TIER[String(key).toLowerCase()];
      if (tier) found.add(tier);
    }
  }
  if (!found.size) found.add(qualityTierOf(track));
  return [...found].sort((a, b) => qualityTierWeight[b] - qualityTierWeight[a]).slice(0, 3);
}
