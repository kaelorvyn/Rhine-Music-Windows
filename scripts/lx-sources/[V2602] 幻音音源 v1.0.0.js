/*!
 * @name 幻音音源
 * @description 使用TuneHub API的音源
 * @version 1.0.0
 * @author 竹佀
 */
const { EVENT_NAMES, on, send } = globalThis.lx

// ============== 核心配置 ==============
const SOURCE_MAP = {
    'tx': 'qq',      // LX的tx源 -> TuneHub的qq平台
    'kw': 'kuwo',    // LX的kw源 -> TuneHub的kuwo平台
    'wy': 'netease'  // LX的wy源 -> TuneHub的netease平台
}

const ID_FIELD_MAP = {
    'tx': 'songmid',  // QQ音乐ID字段
    'kw': 'songmid',  // 酷我音乐ID字段
    'wy': 'id'        // 网易云音乐ID字段
}

const QUALITY_MAP = {
    '128k': '128k',
    '320k': '320k',
    flac: 'flac',
    flac24bit: 'flac24bit'
}
// ============== 配置结束 ==============

const log = (msg, data) => {
    const time = new Date().toLocaleTimeString()
    if (data) {
        // 特别处理URL的显示
        if (typeof data === 'string' && data.includes('http')) {
            console.log(`[${time}] [TuneHub-Pass] ${msg}: ${data}`)
        } else {
            console.log(`[${time}] [TuneHub-Pass] ${msg}`, JSON.stringify(data))
        }
    } else {
        console.log(`[${time}] [TuneHub-Pass] ${msg}`)
    }
}

/**
 * 主处理函数 - 直接返回TuneHub API链接
 */
const handleMusicRequest = (source, musicInfo, quality) => {
    log('收到播放请求', {
        source,
        song: musicInfo.name,
        singer: musicInfo.singer,
        quality
    })

    // 1. 验证源是否支持
    const tunehubSource = SOURCE_MAP[source]
    if (!tunehubSource) {
        const errorMsg = `不支持的音源: ${source}`
        log('源不支持', { source, supported: Object.keys(SOURCE_MAP) })
        throw new Error(errorMsg)
    }

    // 2. 提取ID（仅用于构建URL）
    const idField = ID_FIELD_MAP[source]
    let musicId = musicInfo[idField]
    
    // 备用ID提取
    if (!musicId) {
        musicId = musicInfo.id || musicInfo.songId || musicInfo.mid
    }
    
    if (!musicId) {
        log('ID提取失败', {
            requiredField: idField,
            availableFields: Object.keys(musicInfo).filter(k => musicInfo[k] && typeof musicInfo[k] === 'string')
        })
        throw new Error(`无法提取歌曲ID (需要字段: ${idField})`)
    }
    
    log('成功提取ID', { source, idField, musicId })

    // 3. 获取音质参数
    const tunehubQuality = QUALITY_MAP[quality] || quality

    // 4. 构建TuneHub API链接
    const tunehubApiUrl = `https://music-dl.sayqz.com/api/?source=${tunehubSource}&id=${musicId}&type=url&br=${tunehubQuality}`
    
    log('构建的TuneHub API链接', tunehubApiUrl)
    
    // 5. 关键：直接返回API链接，而不是音频链接
    return tunehubApiUrl
}

// ============== 事件监听器 ==============
on(EVENT_NAMES.request, ({ source, action, info }) => {
    log('LX请求事件', { 
        source, 
        action, 
        song: info.musicInfo?.name,
        quality: info.type 
    })
    
    // 只处理musicUrl请求
    if (action !== 'musicUrl') {
        log('跳过不支持的操作', { action })
        return Promise.reject(new Error(`仅支持musicUrl操作`))
    }
    
    try {
        // 直接调用处理函数
        const apiUrl = handleMusicRequest(source, info.musicInfo, info.type)
        
        log('返回给LX的API链接', apiUrl)
        log('处理完成说明', {
            注意: '返回的是TuneHub API链接，LX播放器需自行请求并解析JSON获取音频',
            预期: 'LX应能正确处理此API链接并播放音乐'
        })
        
        return Promise.resolve(apiUrl)
        
    } catch (error) {
        const finalError = `[TuneHub-Pass] ${error.message}`
        log('处理失败', { error: finalError })
        return Promise.reject(new Error(finalError))
    }
})

// ============== 初始化 ==============
send(EVENT_NAMES.inited, {
    openDevTools: true, // 开启调试
    sources: {
        tx: {
            name: 'QQ音乐 - TuneHub(直通)',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit'],
            description: '返回TuneHub API链接，由LX自行处理'
        },
        kw: {
            name: '酷我音乐 - TuneHub(直通)',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit'],
            description: '返回TuneHub API链接，由LX自行处理'
        },
        wy: {
            name: '网易云音乐 - TuneHub(直通)',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k', 'flac', 'flac24bit'],
            description: '返回TuneHub API链接，由LX自行处理'
        }
    }
})

log('直通版脚本初始化完成', {
    version: '1.0.0',
    工作模式: '直接返回TuneHub API链接',
    优势: '避免脚本内网络请求被拦截',
    要求: 'LX播放器需能处理返回的API链接并自行解析JSON'
})