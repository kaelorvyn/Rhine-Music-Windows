import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalPlaylists } from './local-playlists.mjs'
import { trackToLocalSong, localSongToTrack } from '../src/local-playlists.ts'
import { playbackAlbums } from '../src/playback-albums.ts'

test('favorite -> persisted song -> playlist track -> 3D card keeps its cover and can be favorited again', () => {
  for (const [provider, coverUrl] of [
    ['qq', 'https://covers.example.test/song.jpg'],
    ['netease', '/api/online/netease/cover?id=1'],
    ['qq', '/api/online/qq/cover?id=1'],
  ]) {
    const track = { id: `${provider}-1`, albumId: 'album', title: 'Song', artist: 'Artist', duration: 100,
      format: 'mp3', browserPlayable: true, audioUrl: '', relativePath: '',
      onlineSource: { provider, id: '1', albumTitle: 'Album', coverUrl, pageUrl: '', fee: 0 } }
    const store = new LocalPlaylists()
    store.favorite(trackToLocalSong(track))
    const serialized = JSON.parse(JSON.stringify(store.songs('favorites').tracks[0]))
    assert.equal(serialized.cover, coverUrl)
    const restored = localSongToTrack(serialized)
    assert.equal(restored.onlineSource.coverUrl, coverUrl)
    assert.equal(playbackAlbums([restored], [])[0].coverUrl, coverUrl)
    assert.equal(trackToLocalSong(restored).cover, coverUrl)
    assert.equal(restored.id, track.id)
  }
})

test('missing and invalid covers keep a safe placeholder; signed URLs are not truncated', () => {
  const store = new LocalPlaylists()
  for (const [id, cover] of [['1', 'javascript:alert(1)'], ['2', '//untrusted.example/test'], ['3', '/api/cover\\bad']]) {
    store.favorite({ id, cover })
    assert.equal(store.songs('favorites').tracks.find(s => s.id === id).cover, '')
  }
  const cover = `https://covers.example.test/a?signature=${'x'.repeat(800)}`
  store.favorite({ id: 'long', cover })
  assert.equal(store.songs('favorites').tracks[0].cover, cover)
  assert.equal(playbackAlbums([localSongToTrack({ id: 'empty' })], [])[0].coverUrl, undefined)
})
