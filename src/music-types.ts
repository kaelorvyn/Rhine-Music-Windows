/** JSON contract shared by the local music service and the visual interface. */
export interface MusicTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  trackNumber?: number;
  discNumber?: number;
  duration: number;
  format: string;
  codec?: string;
  bitsPerSample?: number;
  sampleRate?: number;
  bitrate?: number;
  numberOfChannels?: number;
  lossless?: boolean;
  browserPlayable: boolean;
  audioUrl: string;
 /** Local FFmpeg PCM route; original source remains read-only. */
  decodedAudioUrl?: string;
  localDecodable?: boolean;
  relativePath: string;
  onlineSource?: {
    provider: import('./music-platform').MusicProvider;
    id: string;
    albumTitle: string;
    coverUrl?: string;
    pageUrl: string;
    fee: number;
    albumId?: string;
 /** QQ's audio file identifier can differ from the song identifier. */
    mediaId?: string;
    publishTime?: number;
    aliases?: string[];
 /** Provider marks this entry as the original recording (原唱标识). */
    original?: boolean;
 /** Raw provider quality label, classified by quality-tier.ts. */
    qualityLabel?: string;
 /** 平台搜索接口自报的**音质能力**（上游每行那排 母带/HiFi/5.1/SQ/HQ 标签的数据源）。
 * 各平台字段名不同，这里统一收拢；quality-tier.ts 据此渲染徽章。
 * netease: privilege.maxBrLevel / plLevel / dlLevel（jymaster/sky/exhigh/…）
 * qq: size128/size320/sizeflac/sizehires/sizedts + preview 试听窗口
 * kuwo: MINFO/N_MINFO 的 `level` 码（ff/p/h/s + zply/zpga501/zpga201/
 * zpga714/bcms/dtsx），辅以 pc_formats/phone_formats 标记
 * kugou: privilege.qualities[].quality（128/320/flac/viper_atmos/…） */
    capabilities?: {
 /** 平台自报的档位名列表，交给 quality-tier.ts 的 LEVEL_TO_TIER 翻译。 */
      levels?: string[];
 /** 各档位的文件字节数（>0 表示该档真实存在）。
 *
 * 键是**平台原生档位名**，各平台叫法不同：
 * 酷我 flac / 320k / 128k / dts / master / hifi / hires / surround
 * 酷狗 lossless / high / standard / hires / master
 * 网易云 hires / jymaster …
 * 所以必须是开放索引 —— 写死成几个字面量会让新增档位取不到大小
 * 。 */
      sizes?: Record<string, number>;
 /** 网易云的无损 / Hi-Res 对象是否存在。 */
      sq?: boolean; hr?: boolean;
 /** 酷我 kbps_map 的键（**保留字段，本机实测恒为 undefined**：r.s 与
 * music.pay、多首歌多种 src 变体都取不到 → 酷我改从 MINFO/N_MINFO 解析）。
 * 留着是为了 quality-tier.ts 的既有读取路径不报错。 */
      kbpsMap?: string[];
 /** QQ 自带的试听窗口（毫秒）；有值且非全长 ⇒ 该曲受试听限制。 */
      preview?: { start?: number; end?: number; size?: number };
 /** 平台自报的最高码率（bps）。网易 maxbr 母带为 999000；酷我取
 * MINFO/N_MINFO 里非占位条目的最高 bitrate（kbps × 1000）。 */
      maxBitrate?: number;
    };
 /** 共享池返回的加密音频解密密钥（QQ/酷我的 mflac/mgg 需要它才能还原
 * 成可播 FLAC）。酷狗等返回明文 flac 时为 undefined。 */
    ekey?: string | null;
 /** MV identity when the provider exposes one; watch-only in the UI. */
    mv?: { id?: string; url?: string };
 /** 备用音源模块的兜底结果：平台只给试听/拒绝播放时，备用音源给出的
 * 全曲地址。播放器直接采用它，不再走平台 prepare（否则只会再拿一次试听片段）。 */
    rescuedUrl?: string;
  };
 /** ── prepare 结果的**顶层**回填字段（对齐上游）────────────────────────
 *
 * 平台 prepare 的返回值**没有 onlineSource**（只回音源），所以档位与密钥
 * 必须放在**顶层**交给前端，由播放器回填到曲目上。
 *
 * 上游的真实行为：音质是**单一请求**，服务端 `actualQuality`
 * **自回落**，客户端**不做**降级阶梯 —— 我们对齐这一点。 */
  actualQuality?: string;
 /** 共享池返回的加密音频解密密钥（mflac/mgg 需要它才能还原成可播 FLAC）。 */
  ekey?: string | null;
 /** 池子返回的加密容器格式（mflac/mgg/flac/mp3…）。 */
  poolSource?: string;
}

/** Queue playback mode: in-order, list loop, single repeat, shuffle (bag), or
 * true shuffle (may repeat). Mirrors the upstream five modes. */
export type PlayMode = "order" | "loop" | "repeat-one" | "shuffle" | "shuffle-all";

export interface OnlineSongInfo {
  track: MusicTrack;
  album: { title: string; artist: string; published?: string; company?: string; description?: string };
  lyrics: { original: string; translated: string; instrumental: boolean; unavailable: boolean; error?: string };
  metadataError?: string;
}

export interface OnlineSearchResults {
  provider: import('./music-platform').MusicProvider;
  query: string;
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  tracks: MusicTrack[];
}

export interface MusicProducer {
  name: string;
  role: string;
  source: "local" | "MusicBrainz" | "QQ Music" | "manual";
  trackId?: string;
  trackTitle?: string;
  url?: string;
}

export interface MusicAlbum {
 /** 歌单来源：平台 id 或本地伪来源 'local'。 */
  playlistCell?: { playlistId: string; playlistName: string; playlistIndex: number; songIndex: number; total: number; provider?: import('./music-platform').MusicProvider | 'local'; favorites?: boolean };
 /** A playback display card; this identity never rewrites library metadata.
 * 主标题是歌名，albumTitle 只作次要信息（详情页小字/悬停）。 */
  playback?: { trackId: string; albumId: string; songTitle: string; albumTitle: string };
 /** Search-results anchor: the collection record behind the per-song card
 * wall. It never occupies a wall slot; its detail lists every result song. */
  searchAnchor?: boolean;
  id: string;
  title: string;
  artist: string;
  year?: number;
  discCount?: number;
  description?: string;
  descriptionSource?: {
    name: string;
    url: string;
    checkedAt?: string;
    license?: string;
  };
  localNote?: string;
  introduction?: {
    status: "unqueried" | "matched" | "not-found" | "uncertain" | "error";
    checkedAt?: string;
    error?: string;
    candidateUrl?: string;
  };
  genreId: string;
  rawGenres: string[];
  folder: string;
  coverUrl?: string;
  tracks: MusicTrack[];
  producers: MusicProducer[];
  creditsLookup?: {
    status: "unqueried" | "matched" | "partial" | "not-found" | "uncertain" | "error";
    source: "QQ Music";
    checkedAt?: string;
    matchedTracks?: number;
    totalTracks?: number;
    error?: string;
    retryAt?: string;
  };
  offline: boolean;
  online?: {
    status: "unqueried" | "matched" | "uncertain" | "not-found" | "error";
    releaseId?: string;
    releaseGroupId?: string;
    checkedAt?: string;
    sourceUrl?: string;
    error?: string;
    descriptionStatus?: "available" | "not-found" | "error";
    descriptionError?: string;
  };
}

export interface NeteasePlaylist {
  id: string;
  name: string;
  trackCount: number;
  coverUrl?: string;
  owned: boolean;
}

export interface MusicGenre {
  id: string;
  name: string;
  aliases?: string[];
  albumCount?: number;
}

export interface GenreRules {
  version: 1;
  genres: MusicGenre[];
  albumOverrides: Record<string, string>;
}

export interface LibraryRoot {
  path: string;
  status: "online" | "offline" | "unscanned";
  error?: string;
}

export interface MusicLibrary {
  version: 1;
  albums: MusicAlbum[];
  genres: MusicGenre[];
  roots: LibraryRoot[];
  scan: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  onlineEnabled: boolean;
  enrich?: {
    running: boolean;
    completed: number;
    total: number;
    error?: string;
  };
  introductions?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    error?: string;
  };
  credits?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    trackCompleted?: number;
    trackTotal?: number;
    error?: string;
  };
}
