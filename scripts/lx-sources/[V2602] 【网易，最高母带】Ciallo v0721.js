/*!
 * @name Ciallo～(∠・ω< )⌒☆
 * @description 仅支持网易，理论支持全音质
 * @version v0721
 * @author 竹佀＆玥然OvO
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const API_BASE = 'https://www.s0o1.com/API/wyy_music'

const QUALITY_MAP = {
    '128k': '1',
    '320k': '2', 
    'flac': '3',
    'flac24bit': '4',
    'hires': '5',
    'atmos': '6',
    'master': '7'
}

const QUALITY_NAMES = {
    '128k': '128K',
    '320k': '320K',
    'flac': 'FLAC',
    'flac24bit': '24Bit',
    'hires': 'Hi-Res',
    'atmos': 'Atmos',
    'master': 'Master'
}

const urlCache = new Map()
const CACHE_TTL = 5 * 60 * 1000

const getCacheKey = (id, yz) => `${id}_${yz}`

const cleanExpiredCache = () => {
    const now = Date.now()
    for (const [key, value] of urlCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            urlCache.delete(key)
        }
    }
}

class AudioError extends Error {
    constructor(type, message, details = {}) {
        super(`[${type}] ${message}`)
        this.type = type
        this.details = details
    }
}

const getAudioUrl = (musicInfo, quality = '128k') => {
    return new Promise((resolve, reject) => {
        try {
            const id = musicInfo.songmid || musicInfo.id || musicInfo.mid
            if (!id) {
                return reject(new AudioError('PARAM_ERROR', '缺少歌曲ID', {
                    musicInfo,
                    field: 'songmid/id/mid'
                }))
            }
            
            const yz = QUALITY_MAP[quality]
            if (!yz) {
                console.warn(`[网易云解析] 未知音质: ${quality}, 使用默认128k`)
                quality = '128k'
            }
            
            const cacheKey = getCacheKey(id, yz)
            const cached = urlCache.get(cacheKey)
            
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
                console.log(`[网易云解析] 缓存命中: ${musicInfo.name || id}`)
                return resolve(cached.url)
            }
            
            cleanExpiredCache()
            
            const apiUrl = `${API_BASE}?id=${id}&yz=${QUALITY_MAP[quality] || '1'}`
            
            console.log(`[网易云解析] 请求: ${musicInfo.name || '未知歌曲'} (ID: ${id}, 音质: ${QUALITY_NAMES[quality] || quality})`)
            
            request(apiUrl, { 
                method: 'GET',
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, (err, resp) => {
                try {
                    if (err) {
                        if (err.message.includes('timeout')) {
                            throw new AudioError('NETWORK_TIMEOUT', '请求超时', {
                                url: apiUrl,
                                timeout: 8000
                            })
                        } else if (err.message.includes('ECONNREFUSED')) {
                            throw new AudioError('NETWORK_ERROR', '连接被拒绝', {
                                url: apiUrl,
                                error: err.message
                            })
                        } else {
                            throw new AudioError('NETWORK_ERROR', '网络请求失败', {
                                url: apiUrl,
                                error: err.message
                            })
                        }
                    }
                    
                    if (!resp || !resp.body) {
                        throw new AudioError('EMPTY_RESPONSE', 'API返回空响应', {
                            url: apiUrl,
                            statusCode: resp?.statusCode
                        })
                    }
                    
                    let data, rawBody
                    
                    if (typeof resp.body === 'string') {
                        rawBody = resp.body.trim()
                        
                        if (!rawBody || rawBody.length < 5) {
                            throw new AudioError('INVALID_RESPONSE', 'API返回无效响应', {
                                url: apiUrl,
                                bodyLength: rawBody.length,
                                preview: rawBody.substring(0, 100)
                            })
                        }
                        
                        try {
                            data = JSON.parse(rawBody)
                        } catch (parseError) {
                            throw new AudioError('JSON_PARSE_ERROR', 'API返回格式错误', {
                                url: apiUrl,
                                parseError: parseError.message,
                                bodyPreview: rawBody.substring(0, 200),
                                bodyLength: rawBody.length
                            })
                        }
                    } else {
                        data = resp.body
                    }
                    
                    if (data.status !== 200) {
                        throw new AudioError('API_ERROR', `API返回错误: ${data.status}`, {
                            url: apiUrl,
                            apiStatus: data.status,
                            apiMessage: data.message,
                            apiSuccess: data.success,
                            responseData: data
                        })
                    }
                    
                    if (!data.success) {
                        throw new AudioError('API_FAILED', 'API请求失败', {
                            url: apiUrl,
                            apiMessage: data.message,
                            responseData: data
                        })
                    }
                    
                    if (!data.data) {
                        throw new AudioError('NO_DATA', 'API未返回数据', {
                            url: apiUrl,
                            responseData: data
                        })
                    }
                    
                    if (!data.data.url) {
                        throw new AudioError('NO_AUDIO_URL', 'API未返回音频URL', {
                            url: apiUrl,
                            songName: data.data.name,
                            artists: data.data.artists,
                            responseData: data
                        })
                    }
                    
                    const audioUrl = data.data.url
                    if (!audioUrl.startsWith('http')) {
                        throw new AudioError('INVALID_URL', '音频URL格式错误', {
                            url: apiUrl,
                            audioUrl: audioUrl,
                            expected: 'http/https',
                            actual: audioUrl.substring(0, 20)
                        })
                    }
                    
                    urlCache.set(cacheKey, {
                        url: audioUrl,
                        timestamp: Date.now(),
                        songInfo: {
                            name: data.data.name,
                            artists: data.data.artists,
                            quality: data.data.level
                        }
                    })
                    
                    console.log(`[网易云解析] 成功获取: ${data.data.name || '未知歌曲'} - ${data.data.artists || '未知歌手'}`)
                    console.log(`  音质: ${data.data.level || QUALITY_NAMES[quality]}`)
                    console.log(`  URL长度: ${audioUrl.length}字符`)
                    
                    resolve(audioUrl)
                    
                } catch (error) {
                    console.error(`[网易云解析] 详细错误信息:`)
                    console.error(`  错误类型: ${error.type || 'UNKNOWN'}`)
                    console.error(`  错误信息: ${error.message}`)
                    console.error(`  歌曲: ${musicInfo.name || '未知'}`)
                    console.error(`  歌手: ${musicInfo.singer || '未知'}`)
                    console.error(`  音质: ${QUALITY_NAMES[quality] || quality}`)
                    
                    if (error.details) {
                        console.error(`  详细数据:`, error.details)
                    }
                    
                    let userMessage = error.message
                    if (error.type === 'NETWORK_TIMEOUT') {
                        userMessage = '网络连接超时，请检查网络后重试'
                    } else if (error.type === 'API_ERROR' && error.details?.apiStatus === 400) {
                        userMessage = 'API请求参数错误'
                    } else if (error.type === 'NO_AUDIO_URL') {
                        userMessage = '该歌曲暂无可用音源'
                    }
                    
                    reject(new Error(userMessage))
                }
            })
            
        } catch (outerError) {
            console.error(`[网易云解析] 外层错误:`, outerError)
            reject(new Error(`系统错误: ${outerError.message}`))
        }
    })
}

const searchMusic = (keyword, limit = 10) => {
    return new Promise((resolve) => {
        const apiUrl = `${API_BASE}?msg=${encodeURIComponent(keyword)}&sm=${limit}`
        
        request(apiUrl, {
            method: 'GET',
            timeout: 5000
        }, (err, resp) => {
            if (err) {
                console.error(`[网易云解析] 搜索失败:`, err.message)
                return resolve([])
            }
            
            try {
                let data = resp.body
                if (typeof data === 'string') {
                    data = JSON.parse(data.trim())
                }
                
                if (data.status !== 200 || !data.success || !data.data) {
                    return resolve([])
                }
                
                const results = []
                
                if (data.data.id) {
                    results.push({
                        songmid: data.data.id.toString(),
                        id: data.data.id.toString(),
                        name: data.data.name || keyword,
                        singer: data.data.artists || '未知',
                        albumName: data.data.album || '',
                        source: 'wy',
                        interval: '03:00',
                        img: data.data.pic
                    })
                }
                
                resolve(results)
                
            } catch (error) {
                console.error(`[网易云解析] 搜索解析失败:`, error.message)
                resolve([])
            }
        })
    })
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
    switch (action) {
        case 'musicUrl':
            return new Promise((resolve, reject) => {
                if (!info?.musicInfo) {
                    return reject(new Error('缺少音乐信息'))
                }
                getAudioUrl(info.musicInfo, info.type || '128k')
                    .then(resolve)
                    .catch(reject)
            })
            
        case 'search':
            return new Promise((resolve) => {
                if (!info?.keyword) {
                    return resolve({ list: [], total: 0, page: 1, limit: 10, source: 'wy', allPage: 1 })
                }
                
                const { keyword, page = 1, limit = 10 } = info
                
                searchMusic(keyword, limit)
                    .then(results => {
                        resolve({
                            list: results,
                            total: results.length,
                            page,
                            limit,
                            source: 'wy',
                            allPage: Math.max(1, Math.ceil(results.length / limit))
                        })
                    })
                    .catch(() => {
                        resolve({ list: [], total: 0, page, limit, source: 'wy', allPage: 1 })
                    })
            })
            
        default:
            return Promise.reject(new Error('不支持的操作'))
    }
})

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        wy: {
            name: '网易云解析',
            type: 'music',
            actions: ['musicUrl', 'search'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
            qualityName: QUALITY_NAMES,
            maxSearchCount: 20,
            hotSearchable: true,
            importable: true,
            supportBitRateTest: false
        }
    }
})

console.log('网易云解析初始化完成 ✓')