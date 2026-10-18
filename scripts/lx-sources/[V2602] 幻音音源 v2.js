/*!
 * @name 幻音音源
 * @description 支持除酷狗以外的所有平台
 * @version v2
 * @author 竹佀
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx

on(EVENT_NAMES.request, ({ source, action, info }) => {
    if (action !== 'musicUrl') {
        return Promise.reject(new Error('仅支持musicUrl操作'))
    }
    
    const quality = info.type || '128k'
    const musicInfo = info.musicInfo
    
    try {
        if (source === 'mg') {
            return getMiguMusicUrl(musicInfo, quality)
        }
        
        return getTunehubMusicUrl(source, musicInfo, quality)
        
    } catch (error) {
        console.error(`[幻音音源] 错误: ${error.message}`)
        return Promise.reject(new Error(`[幻音音源] ${error.message}`))
    }
})

function getMiguMusicUrl(musicInfo, quality) {
    return new Promise((resolve, reject) => {
        if (!musicInfo.name) {
            return reject(new Error('咪咕平台需要歌曲名'))
        }
        
        let songName = musicInfo.name.trim()
        songName = songName.replace(/\(\s*Live\s*\)/gi, '')
        songName = songName.replace(/\s+/g, ' ').trim()
        
        if (!songName) {
            return reject(new Error('无效的歌曲名'))
        }
        
        const keyword = encodeURIComponent(songName)
        const apiUrl = `https://api.xcvts.cn/api/music/migu?gm=${keyword}&n=1&num=1&type=json`
        
        console.log(`[幻音音源] MG请求: ${apiUrl}`)
        
        request(apiUrl, { 
            method: 'GET',
            timeout: 10000
        }, (err, resp) => {
            if (err) {
                console.error(`[幻音音源] MG请求失败: ${err.message}`)
                return reject(new Error(`咪咕请求失败: ${err.message}`))
            }
            
            try {
                const text = resp.body
                const data = typeof text === 'string' ? JSON.parse(text) : text
                
                if (data.code === 200 && data.music_url) {
                    console.log(`[幻音音源] MG成功: ${data.title || songName}`)
                    resolve(data.music_url)
                } else {
                    reject(new Error(`咪咕API错误: ${data.code || '无链接'}`))
                }
            } catch (e) {
                console.error(`[幻音音源] MG解析失败:`, e.message)
                reject(new Error('解析咪咕响应失败'))
            }
        })
    })
}

function getTunehubMusicUrl(source, musicInfo, quality) {
    const sourceMap = {
        'tx': 'qq',
        'kw': 'kuwo', 
        'wy': 'netease'
    }
    
    const platform = sourceMap[source]
    if (!platform) {
        throw new Error(`不支持的平台: ${source}`)
    }
    
    const songmid = musicInfo.songmid || musicInfo.id || musicInfo.mid
    if (!songmid) {
        throw new Error('找不到歌曲ID')
    }
    
    const qualityMap = {
        '128k': '128k',
        '320k': '320k',
        'flac': 'flac',
        'flac24bit': 'flac24bit'
    }
    
    const br = qualityMap[quality] || '128k'
    const url = `https://music-dl.sayqz.com/api/?source=${platform}&id=${songmid}&type=url&br=${br}`
    
    console.log(`[幻音音源] ${source.toUpperCase()}返回: ${url}`)
    return Promise.resolve(url)
}

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        tx: {
            name: 'QQ音乐 - TuneHub',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit']
        },
        kw: {
            name: '酷我音乐 - TuneHub',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit']
        },
        wy: {
            name: '网易云音乐 - TuneHub',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit']
        },
        mg: {
            name: '咪咕音乐',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k']
        }
    }
})

console.log('[幻音音源] 初始化完成')