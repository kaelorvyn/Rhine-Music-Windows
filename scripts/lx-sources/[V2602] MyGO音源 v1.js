/*!
 * @name MyGO音源
 * @description 接口来自简云，支持Q音，最高Hires，交流群1078955749
 * @version v1
 * @author 玥然OvO
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const CONFIG = {
    apiBase: 'https://api.vsaa.cn/api/music.qq',
    defaultApikey: 'fb5401d5dad8a2917a71e5d8a327fb71'
}

const qualityMap = {
    '128k': 'low',
    '320k': 'standard',
    'flac': 'high',
    'flac24bit': 'super'
}

function extractAlbumMidFromImgUrl(imgUrl) {
    if (!imgUrl) return null
    const match = imgUrl.match(/M000(\w+?)\.jpg/)
    return match && match[1] ? match[1] : null
}

const buildApiUrl = (musicInfo, quality = '128k') => {
    const songmid = musicInfo.songmid || musicInfo.id || musicInfo.mid
    
    if (!songmid) {
        throw new Error('找不到歌曲ID')
    }
    
    const mappedQuality = qualityMap[quality] || 'standard'
    
    const params = {
        apikey: CONFIG.defaultApikey,
        action: 'media_source',
        id: songmid,
        quality: mappedQuality
    }
    
    let media_mid = ''
    
    if (musicInfo.img) {
        const albumMid = extractAlbumMidFromImgUrl(musicInfo.img)
        if (albumMid) {
            media_mid = albumMid
        }
    }
    
    if (media_mid) {
        params.media_mid = media_mid
    }
    
    console.log(`[QQ音乐] 构建参数: songmid=${songmid}, media_mid=${media_mid || '空'}, quality=${mappedQuality}`)
    
    const queryParts = []
    for (const key in params) {
        if (params[key] !== undefined && params[key] !== null) {
            queryParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
        }
    }
    
    return `${CONFIG.apiBase}?${queryParts.join('&')}`
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
    if (source !== 'tx' || action !== 'musicUrl') {
        return
    }
    
    return new Promise((resolve, reject) => {
        try {
            const quality = info.type || '128k'
            const apiUrl = buildApiUrl(info.musicInfo, quality)
            
            console.log(`[QQ音乐] 源: tx, 音质: ${quality}, 请求API链接: ${apiUrl}`)
            
            request(apiUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*'
                },
                timeout: 10000
            }, (err, resp) => {
                if (err) {
                    console.error(`[QQ音乐] 请求失败: ${err.message}`)
                    return reject(new Error(`[QQ音乐] 请求失败: ${err.message}`))
                }
                
                try {
                    console.log(`[QQ音乐] API响应状态: ${resp.statusCode}`)
                    
                    let data
                    if (typeof resp.body === 'string') {
                        data = JSON.parse(resp.body)
                    } else {
                        data = resp.body
                    }
                    
                    console.log(`[QQ音乐] API响应数据:`, JSON.stringify(data).substring(0, 200))
                    
                    let audioUrl
                    
                    if (data && data.success === true && data.url) {
                        audioUrl = data.url
                    } else if (data && data.code === 200 && data.data && data.data.url) {
                        audioUrl = data.data.url
                    } else if (data && data.url) {
                        audioUrl = data.url
                    }
                    
                    if (!audioUrl) {
                        console.error(`[QQ音乐] 无法提取音频URL，响应数据:`, JSON.stringify(data))
                        return reject(new Error('API返回格式异常，未找到音频URL'))
                    }
                    
                    console.log(`[QQ音乐] 成功提取音频URL: ${audioUrl.substring(0, 80)}...`)
                    
                    resolve(audioUrl)
                    
                } catch (parseError) {
                    console.error(`[QQ音乐] 解析响应失败: ${parseError.message}`)
                    reject(new Error(`[QQ音乐] 解析响应失败: ${parseError.message}`))
                }
            })
            
        } catch (error) {
            console.error(`[QQ音乐] 错误: ${error.message}`)
            reject(new Error(`[QQ音乐] ${error.message}`))
        }
    })
})

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        tx: {
            name: 'QQ音乐',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit']
        }
    }
})

console.log('[QQ音乐] 音源初始化完成')