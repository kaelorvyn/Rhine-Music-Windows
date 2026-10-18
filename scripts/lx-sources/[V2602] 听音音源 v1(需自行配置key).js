/*!
 * @name 听音音源
 * @description 请到https://api.yaohud.cn/自行去获取key，支持除酷狗以外的所有平台
 * @version v1
 * @author 竹佀
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx

// 配置
const API_KEY = ''

// 平台配置
const SOURCE_CONFIGS = {
    'kw': {  // 酷我
        name: '酷我音乐',
        url: 'https://api.yaohud.cn/api/music/kuwo',
        qualitys: ['128k', '320k', 'flac', 'hi-res'],
        lxQualityMap: {
            '128k': 'standard',
            '320k': 'exhigh',
            'flac': 'lossless',
            'hi-res': 'hires'
        },
        buildParams: (keyword, quality, apiKey) => {
            const q = SOURCE_CONFIGS.kw.lxQualityMap[quality] || 'exhigh'
            return `key=${apiKey}&msg=${encodeURIComponent(keyword)}&n=1&size=${q}`
        },
        getUrl: (data) => data?.vipmusic?.url || data?.url
    },
    'tx': {  // QQ
        name: 'QQ音乐',
        url: 'https://api.yaohud.cn/api/music/qq_plus',
        qualitys: ['128k', '320k', 'flac', 'hi-res'],
        lxQualityMap: {
            '128k': 'mp3',
            '320k': 'hq',
            'flac': 'sq',
            'hi-res': 'hires'
        },
        buildParams: (keyword, quality, apiKey) => {
            const q = SOURCE_CONFIGS.tx.lxQualityMap[quality] || 'hq'
            return `key=${apiKey}&msg=${encodeURIComponent(keyword)}&n=1&size=${q}`
        },
        getUrl: (data, quality) => {
            if (data.musicurl) return data.musicurl
            if (data.music_url) {
                if (quality === 'flac' && data.music_url.flac?.url) return data.music_url.flac.url
                if (quality === '320k' && data.music_url['320']?.url) return data.music_url['320'].url
                if (quality === '128k' && data.music_url.mp3?.url) return data.music_url.mp3.url
            }
            return data.url
        }
    },
    'wy': {  // 网易云
        name: '网易云音乐',
        url: 'https://api.yaohud.cn/api/music/wyvip',
        qualitys: ['128k', '320k', 'flac', 'hi-res'],
        lxQualityMap: {
            '128k': 'standard',
            '320k': 'exhigh',
            'flac': 'lossless',
            'hi-res': 'hires'
        },
        buildParams: (keyword, quality, apiKey) => {
            const q = SOURCE_CONFIGS.wy.lxQualityMap[quality] || 'exhigh'
            return `key=${apiKey}&msg=${encodeURIComponent(keyword)}&n=1&level=${q}`
        },
        getUrl: (data) => data?.vipmusic?.url || data?.url
    },
    'mg': {  // 咪咕
        name: '咪咕音乐',
        url: 'https://api.yaohud.cn/api/music/migu',
        qualitys: ['128k', '320k', 'flac'],
        buildParams: (keyword, quality, apiKey) => {
            return `key=${apiKey}&msg=${encodeURIComponent(keyword)}&n=1`
        },
        getUrl: (data) => data?.music_url
    }
}

// 获取音频链接
async function getMusicUrl(source, musicInfo, quality) {
    const config = SOURCE_CONFIGS[source]
    if (!config) throw new Error(`没这音源: ${source}`)
    
    const songName = (musicInfo.name || '').trim()
    if (!songName) throw new Error('歌名呢')
    
    const params = config.buildParams(songName, quality, API_KEY)
    const requestUrl = `${config.url}?${params}`
    
    const resp = await new Promise((resolve, reject) => {
        request(requestUrl, {
            method: 'GET',
            timeout: 8000
        }, (err, resp) => {
            if (err) reject(err)
            else resolve(resp)
        })
    })
    
    const data = resp.body
    if (!data) throw new Error('空的')
    if (data.code !== 200) throw new Error(data.msg || `错误: ${data.code}`)
    if (!data.data) throw new Error('数据不对')
    
    const audioUrl = config.getUrl(data.data, quality)
    if (!audioUrl) throw new Error('没拿到链接')
    
    return String(audioUrl)
}

// 处理请求
on(EVENT_NAMES.request, ({ action, source, info }) => {
    if (action !== 'musicUrl') return Promise.reject(new Error('搞不了这个'))
    if (!SOURCE_CONFIGS[source]) return Promise.reject(new Error(`没这音源: ${source}`))
    if (!info || !info.musicInfo) return Promise.reject(new Error('参数少了'))
    
    const quality = info.type || '320k'
    return getMusicUrl(source, info.musicInfo, quality)
})

// 设置界面
on(EVENT_NAMES.showConfigView, () => {
    const view = {
        title: '听音音源',
        width: 400,
        height: 180,
        config: [
            {
                key: 'tip',
                type: 'help',
                title: '说明',
                help: '自己到 https://api.yaohud.cn/ 拿key\n现在用的key: ' + API_KEY.substring(0, 12) + '...',
                helpType: 'text'
            }
        ]
    }
    
    view.onSave = () => {
        return {
            result: true,
            message: '就看看，不用保存'
        }
    }
    
    send(EVENT_NAMES.showConfigView, view)
})

// 注册音源
const registeredSources = {
    'wy': {
        name: '网易云音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k', '320k', 'flac', 'hi-res']
    },
    'tx': {
        name: 'QQ音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k', '320k', 'flac', 'hi-res']
    },
    'kw': {
        name: '酷我音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k', '320k', 'flac', 'hi-res']
    },
    'mg': {
        name: '咪咕音乐',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k', '320k', 'flac']
    }
}

send(EVENT_NAMES.inited, {
    sources: registeredSources
})