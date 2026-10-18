// Qishui (汽水音乐) protocol adapter — 逐字节对齐 service v3.6.2 src\platform\qishui.rs
// 依据：公开资料对照与实测确认
//
// 取曲端点（二进制原文）:
//   https://api.qishui.com/luna/track_v2?device_platform=android&os=android&ssmix=a
//   &cdid=46556f98-1720-4248-83da-62b74b60b46a&channel=xiaomi_8478_64&aid=8478
//   &app_name=luna&version_code=100198030&version_name=19.8.0
//   &manifest_version_code=100198030&update_version_code=100198030
//   &resolution=1080*1920&dpi=480&device_type=ABR-AL80&device_brand=HUAWEI
//   &language=zh&os_api=35&os_version=15&ac=wifi&device_model=ABR-AL80
//   &package=com.luna.music&iid=2204957404569386&device_id=2204957404565290
//   UA: com.luna.music/100187040 (Linux; U; Android 11; zh_CN; Pixel 4)
//
// 搜索端点（二进制原文）:
//   https://api.qishui.com/luna/search/track
//   UA: LunaPC/3.0.0(290101097)
//
// 响应字段（二进制原文）: track, bit_rates, name, lossless, size, file_size
// 质量值: standard/lossless/hires/master/dolby/dts/320kmp3/flac/128kmp3

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = value => (value === undefined || value === null ? '' : String(value)).trim();

// 完整设备链（逐字节对齐二进制）
const DEVICE_QUERY = new URLSearchParams({
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  cdid: '46556f98-1720-4248-83da-62b74b60b46a',
  channel: 'xiaomi_8478_64',
  aid: '8478',
  app_name: 'luna',
  version_code: '100198030',
  version_name: '19.8.0',
  manifest_version_code: '100198030',
  update_version_code: '100198030',
  resolution: '1080*1920',
  dpi: '480',
  device_type: 'ABR-AL80',
  device_brand: 'HUAWEI',
  language: 'zh',
  os_api: '35',
  os_version: '15',
  ac: 'wifi',
  device_model: 'ABR-AL80',
  package: 'com.luna.music',
  iid: '2204957404569386',
  device_id: '2204957404565290',
}).toString();

const UA_TRACK = 'com.luna.music/100187040 (Linux; U; Android 11; zh_CN; Pixel 4)';
const UA_SEARCH = 'LunaPC/3.0.0(290101097)';
const CT = 'application/json; charset=utf-8';

/** 质量值（二进制原文: standard/lossless/hires/master/dolby/dts/320kmp3/flac/128kmp3） */
function qualityFrom(item) {
  const q = clean(item?.quality ?? item?.bit_rate ?? item?.bitrate).toLowerCase();
  if (q.includes('hires') || q.includes('master')) return '无损';
  if (q.includes('lossless') || q.includes('flac')) return '无损';
  if (q.includes('320')) return '高品';
  return '标准';
}

function feeFrom(item) {
  if (item?.pay_type === 1 || item?.vip === 1 || item?.is_vip === 1) return 1;
  return 0;
}

export function qishuiTrack(item) {
  const id = clean(item?.track_id ?? item?.id ?? item?.vid ?? item?.song_id);
  if (!id) return null;
  return {
    id: `qishui-${id}`, albumId: `qishui-album-${clean(item?.album_id ?? item?.albumid ?? '')}`,
    title: clean(item?.title ?? item?.song_name ?? item?.name) || '未知歌曲',
    artist: clean(item?.artist ?? item?.artist_name ?? item?.singer_name ?? item?.author) || '未知歌手',
    duration: Math.max(0, Number(item?.duration ?? item?.play_time ?? 0)),
    format: '在线音频', browserPlayable: true, localDecodable: false, audioUrl: '', relativePath: '',
    onlineSource: {
      provider: 'qishui', id,
      albumTitle: clean(item?.album_title ?? item?.album_name ?? ''),
      coverUrl: clean(item?.cover_url ?? item?.album_pic ?? item?.pic_url ?? item?.albumPic) || undefined,
      pageUrl: 'https://qishui.com/', fee: feeFrom(item),
      albumId: clean(item?.album_id ?? item?.albumid ?? ''),
      aliases: [], original: false,
      qualityLabel: qualityFrom(item),
    },
  };
}

export class QishuiCatalog {
  constructor({ fetch: doFetch = globalThis.fetch, base = 'https://api.qishui.com' } = {}) {
    this.doFetch = doFetch; this.base = base;
  }

  async search(query, offset = 0) {
    const keyword = clean(query);
    if (!keyword || keyword.length > 100) throw failure('请输入 1 至 100 个字符的搜索词。', 400);
    const page = Math.floor(Math.max(0, offset) / 20);
    const cursor = page * 20;

    // 搜索端点（逐字节对齐二进制）
    const params = new URLSearchParams({
      device_id: '46556f98-1720-4248-83da-62b74b60b46a',
      keyword, count: '20', offset: String(cursor),
      search_id: '', cursor: String(cursor),
      type: 'search_one_track',
    });
    const response = await this.doFetch(`${this.base}/luna/search/track?${params}`, {
      headers: { 'User-Agent': UA_SEARCH, 'Content-Type': CT },
    });
    const body = await response.json().catch(() => null);
    if (!body) throw failure('汽水音乐没有返回有效数据。', 502);

    const list = body?.data?.resultList ?? body?.resultList ?? body?.data?.tracks ?? body?.tracks ?? [];
    const tracks = (Array.isArray(list) ? list : []).map(item => qishuiTrack(item)).filter(Boolean);
    const total = Math.max(0, Number(body?.data?.total ?? body?.total ?? tracks.length));
    return { provider: 'qishui', query: keyword, offset, limit: 20, total, hasMore: (page + 1) * 20 < total, tracks };
  }

  async prepare(value) {
    const id = clean(value).replace(/^qishui-/, '');
    if (!id) throw failure('无效的汽水歌曲标识。', 400);

    // 取曲端点（逐字节对齐二进制）
    const qs = `${DEVICE_QUERY}&track_id=${encodeURIComponent(id)}`;
    const response = await this.doFetch(`${this.base}/luna/track_v2?${qs}`, {
      headers: { 'User-Agent': UA_TRACK, 'Content-Type': CT },
    });
    const body = await response.json().catch(() => null);
    if (!body) throw failure('汽水音乐没有返回可播放的音源。', 502);

    const data = Array.isArray(body?.data) ? body.data[0] : body?.data ?? body;
    const audioUrl = clean(data?.audio_url ?? data?.play_url ?? data?.url ?? data?.audio?.url);
    if (!audioUrl) {
      // 用户可见文案不得出现「付费/地区」字样（硬规则）。
      throw failure('汽水音乐暂时没有返回这首歌的播放地址，已自动尝试其他音源。', 403);
    }
    return { audioUrl, format: 'MP3' };
  }

  async songInfo(value) {
    const id = clean(value).replace(/^qishui-/, '');
    if (!id) throw failure('无效的汽水歌曲标识。', 400);
    const qs = `${DEVICE_QUERY}&track_id=${encodeURIComponent(id)}`;
    const response = await this.doFetch(`${this.base}/luna/track_v2?${qs}`, {
      headers: { 'User-Agent': UA_TRACK, 'Content-Type': CT },
    });
    const body = await response.json().catch(() => null);
    const data = Array.isArray(body?.data) ? body.data[0] : body?.data ?? body;
    const track = qishuiTrack(data);
    if (!track) throw failure('汽水歌曲详情不可用。', 502);
    return track;
  }

  async playlists() {
    throw failure('汽水歌单尚未接入。', 501);
  }

  async playlistTracks() {
    throw failure('汽水歌单尚未接入。', 501);
  }

  async cover() {
    throw failure('汽水封面尚未接入。', 501);
  }
}
