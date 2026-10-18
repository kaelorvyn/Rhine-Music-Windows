export type MusicProvider = 'netease' | 'qq' | 'bodian' | 'kugou' | 'kuwo' | 'joox';
export const musicPlatforms: Record<MusicProvider, string> = { netease: '网易云音乐', qq: 'QQ 音乐', bodian: '波点音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', joox: 'JOOX' };
/** 歌单来源：平台 id，或本地伪来源（莱茵自建歌单/收藏）。 */
export type PlaylistSource = MusicProvider | 'local';
export const localPlaylistName = '莱茵音乐';
/** 歌单来源的显示名：本地歌单显示「本地」，其余按平台名。 */
export function playlistSourceName(source: PlaylistSource): string {
  return source === 'local' ? localPlaylistName : musicPlatforms[source];
}
export function musicProvider(value: unknown): MusicProvider {
  return value === 'qq' || value === 'bodian' || value === 'kugou' || value === 'kuwo' || value === 'joox' ? value : 'netease';
}
