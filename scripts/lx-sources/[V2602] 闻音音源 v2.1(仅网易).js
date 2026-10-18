/*!
 * @name 闻音音源
 * @description 仅网易 提高了区配正确性
 * @version v2.1
 * @author 竹佀
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const API_URL = 'https://api.jkyai.top/API/wyyyjs.php'

on(EVENT_NAMES.request, ({ action, source, info }) => {
    if (source !== 'wy') return Promise.reject(new Error('不支持的平台'))
    
    switch (action) {
        case 'musicUrl':
            if (!info || !info.musicInfo) {
                return Promise.reject(new Error('请求参数不完整'))
            }
            return getMusicUrl(info.musicInfo, info.type || '128k')
            
        case 'search':
            if (!info || !info.keyword) {
                return Promise.reject(new Error('搜索关键词为空'))
            }
            return searchMusic(info.keyword, info.page || 1, info.limit || 20)
            
        default:
            return Promise.reject(new Error('不支持的操作类型'))
    }
})

async function getMusicUrl(musicInfo, quality) {
    if (!musicInfo.name) {
        throw new Error('需要歌曲名')
    }
    
    // 1. 专辑匹配
    if (musicInfo.albumName || musicInfo.album) {
        const album = musicInfo.albumName || musicInfo.album
        const keyword = cleanKeyword(musicInfo.name + album)
        
        try {
            const url = await getAudioUrl(keyword, 1, 2000)
            if (url) return url
        } catch (error) {}
    }
    
    // 2. 歌手匹配
    if (musicInfo.singer) {
        const keyword = cleanKeyword(musicInfo.name + musicInfo.singer)
        
        try {
            const url = await getAudioUrl(keyword, 1, 2500)
            if (url) return url
        } catch (error) {}
    }
    
    // 3. 歌名匹配
    const keyword = cleanKeyword(musicInfo.name)
    
    try {
        const url = await getAudioUrl(keyword, 1, 3000)
        if (url) return url
    } catch (error) {}
    
    throw new Error('无法获取音频链接')
}

async function searchMusic(keyword, page = 1, limit = 20) {
    const results = []
    const maxLimit = Math.min(limit, 20)
    
    for (let i = 1; i <= maxLimit; i++) {
        try {
            const song = await fetchSongInfo(keyword, i, 2000)
            if (song && song.name) {
                results.push(song)
                if (results.length >= limit) break
            }
        } catch (error) {
            // 跳过错误
        }
        
        if (i % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }
    }
    
    if (results.length === 0) {
        throw new Error('未找到相关歌曲')
    }
    
    return results
}

async function getAudioUrl(keyword, index = 1, timeout = 3000) {
    for (let tryCount = 1; tryCount <= 2; tryCount++) {
        try {
            const url = await fetchAudioUrl(keyword, index, timeout)
            if (url) return url
        } catch (error) {
            if (tryCount === 2) throw error
            await new Promise(resolve => setTimeout(resolve, tryCount * 300))
        }
    }
    
    return null
}

async function fetchAudioUrl(keyword, index, timeout = 3000) {
    const encodedKeyword = encodeURIComponent(keyword)
    const requestUrl = `${API_URL}?msg=${encodedKeyword}&n=${index}`
    
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('请求超时'))
        }, timeout)
        
        request(requestUrl, {
            method: 'GET',
            timeout: timeout
        }, (err, resp) => {
            clearTimeout(timer)
            
            if (err) {
                reject(new Error(`网络错误: ${err.message}`))
                return
            }
            
            try {
                let data = resp.body
                if (typeof data === 'string') {
                    data = JSON.parse(data.trim())
                }
                
                let audioUrl = null
                
                if (data.data?.media?.audio_url) {
                    audioUrl = data.data.media.audio_url
                } else if (data.audio_url) {
                    audioUrl = data.audio_url
                } else if (data.music_url) {
                    audioUrl = data.music_url
                }
                
                if (audioUrl) {
                    resolve(audioUrl)
                } else {
                    reject(new Error('未找到音频链接'))
                }
                
            } catch (error) {
                reject(new Error(`解析失败`))
            }
        })
    })
}

async function fetchSongInfo(keyword, index, timeout = 2000) {
    const cleanKeyword = keyword.trim()
    const encodedKeyword = encodeURIComponent(cleanKeyword)
    const requestUrl = `${API_URL}?msg=${encodedKeyword}&n=${index}`
    
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('请求超时'))
        }, timeout)
        
        request(requestUrl, {
            method: 'GET',
            timeout: timeout
        }, (err, resp) => {
            clearTimeout(timer)
            
            if (err) {
                reject(new Error(`网络错误`))
                return
            }
            
            try {
                let data = resp.body
                if (typeof data === 'string') {
                    data = JSON.parse(data.trim())
                }
                
                const song = parseSongInfo(data)
                if (song) {
                    resolve(song)
                } else {
                    reject(new Error('无效的歌曲信息'))
                }
                
            } catch (error) {
                reject(new Error(`解析失败`))
            }
        })
    })
}

function parseSongInfo(data) {
    if (!data) return null
    
    let songName = ''
    let songArtist = ''
    
    if (data.data?.basic_info?.title) {
        songName = data.data.basic_info.title
        songArtist = data.data.basic_info.artist || ''
    } else if (data.title) {
        songName = data.title
        songArtist = data.artist || ''
    }
    
    if (!songName) return null
    
    return {
        name: songName,
        singer: songArtist,
        albumName: data.data?.basic_info?.album || data.album || '',
        id: `wy_${Date.now()}_${Math.random().toString(36).substr(2)}`,
        source: 'wy',
        interval: '00:00'
    }
}

function cleanKeyword(text) {
    if (!text) return ''
    return text
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+/g, '')
        .replace(/[^\w\u4e00-\u9fa5]/g, '')
}

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        wy: {
            name: '网易云音乐',
            type: 'music',
            actions: ['musicUrl', 'search'],
            qualitys: ['128k', '320k'],
            supportSearchSuggestions: true,
            description: '闻音音源'
        }
    }
})

console.log('[闻音音源] 已加载')