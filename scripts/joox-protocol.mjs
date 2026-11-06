














const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = value => (value === undefined || value === null ? '' : String(value)).trim();

/** JOOX encodes metadata as Base64 of the UTF-8 bytes; plain text passes
 * through untouched when decoding would mangle it. */
export function decodeName(value) {
  const raw = clean(value);
  if (!raw || !/^[A-Za-z0-9+/=]{4,}$/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded && !decoded.includes('\uFFFD') ? decoded : raw;
  } catch { return raw; }
}

/** qualityLabel follows the kbps_map the record declares: flac/hires keys are
 * lossless evidence, a 320 key is high-tier evidence. */
function qualityFrom(kbpsMap) {
  let map = {};
  try { map = typeof kbpsMap === 'string' ? JSON.parse(kbpsMap) : (kbpsMap ?? {}); } catch { map = {}; }
  const keys = Object.keys(map).map(key => key.toLowerCase());
  if (keys.some(key => key.includes('flac') || key.includes('hires'))) return '无损';
  if (keys.some(key => key.startsWith('320'))) return '高品';
  return '标准';
}

/** fee=1 when the record's badge list carries a decoded VIP tag. */
function feeFrom(subscript) {
  try {
    const badges = typeof subscript === 'string' ? JSON.parse(subscript) : (subscript ?? []);
    return badges.some(badge => decodeName(badge?.title).toUpperCase() === 'VIP') ? 1 : 0;
  } catch { return 0; }
}

export function jooxTrack(info) {
  const songid = clean(info.songid);
  if (!songid) return null;
  return {
    id: `joox-${songid}`, albumId: `joox-album-${clean(info.albumid)}`, title: decodeName(info.songname) || '未知歌曲',
    artist: decodeName(info.singername) || '未知歌手',
    duration: Math.max(0, Number(info.playtime) || 0), format: '在线音频',
    browserPlayable: true, localDecodable: false, audioUrl: '', relativePath: '',
    onlineSource: {
      provider: 'joox', id: songid, albumTitle: decodeName(info.albumname) || '',
      coverUrl: clean(info.album_url) || undefined, pageUrl: 'https://www.joox.com/', fee: feeFrom(info.subscript),
      albumId: clean(info.albumid),
      aliases: [],
      original: false,
      qualityLabel: qualityFrom(info.kbps_map),
    },
  };
}

export class JooxCatalog {
  constructor({ fetch: doFetch = globalThis.fetch, searchBase = 'http://avatar.api.joox.com' } = {}) {
    this.doFetch = doFetch; this.searchBase = searchBase;
    this.headers = { 'User-Agent': 'okhttp/5.3.2', iAppStoreChannel: 'hkiAppStoreChannel' };
  }
  async search(query, offset = 0) {
    const keyword = clean(query);
    if (!keyword || keyword.length > 100) throw failure('请输入 1 至 100 个字符的搜索词。', 400);
    const page = Math.floor(Math.max(0, offset) / 20);
    const params = new URLSearchParams({ keyword, search_id: '', type: '0' });
    const response = await this.doFetch(`${this.searchBase}/commonCgi/search/get?${params}`, { headers: this.headers });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.common?.iRet !== 0) throw failure('JOOX 搜索暂时不可用，请稍后重试。', 502);
    const tracks = (Array.isArray(body.song_aggregation_list) ? body.song_aggregation_list : [])
      .flatMap(group => (Array.isArray(group?.item_list) ? group.item_list : []))
      .flatMap(item => { const track = jooxTrack(item?.song_info ?? {}); return track ? [track] : []; })
      .slice(page * 20, page * 20 + 20);
    const total = Math.max(0, Number(body.sum) || tracks.length);
    return { provider: 'joox', query: keyword, offset, limit: 20, total, hasMore: (page + 1) * 20 < total, tracks };
  }





  async prepare(value) {
    const songid = clean(value).replace(/^joox-/, '');
    if (!songid) throw failure('无效的 JOOX 歌曲标识。', 400);
    throw failure('JOOX 播放交给共享音源解析。', 403);
  }

  async songInfo() {
    throw failure('JOOX 歌曲详情与歌词尚未接入，仅提供搜索。', 501);
  }
  async playlists() {
    throw failure('JOOX 歌单尚未接入。', 501);
  }
  async playlistTracks() {
    throw failure('JOOX 歌单尚未接入。', 501);
  }
}
