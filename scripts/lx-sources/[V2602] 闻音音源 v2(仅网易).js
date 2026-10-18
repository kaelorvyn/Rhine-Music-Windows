/*!
 * @name 闻音音源
 * @description 仅支持网易，无法选择音质，不同开头版本号不代表更新
 * @version v2
 * @author 竹佀
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx

// API配置
const API_URL = 'https://api.jkyai.top/API/wyyyjs.php'

// 事件处理
on(EVENT_NAMES.request, ({ action, source, info }) => {
    if (action !== 'musicUrl') return Promise.reject(new Error('不支持的操作类型'))
    if (source !== 'wy') return Promise.reject(new Error('不支持的平台'))
    if (!info || !info.musicInfo) return Promise.reject(new Error('请求参数不完整'))

    return getMusicUrl(info.musicInfo, info.type || '128k')
})

// 获取音频链接
function getMusicUrl(musicInfo, quality) {
    return new Promise((resolve, reject) => {
        if (!musicInfo.name) return reject(new Error('需要歌曲名'))
        
        // 清理歌曲名
        let songName = musicInfo.name.trim()
        songName = songName.replace(/\(\s*Live\s*\)/gi, '')
        songName = songName.replace(/\s+/g, ' ').trim()
        
        if (!songName) return reject(new Error('无效的歌曲名'))
        
        const keyword = encodeURIComponent(songName)
        const requestUrl = `${API_URL}?msg=${keyword}&n=1`
        
        console.log(`[闻音音源] 请求: ${requestUrl}`)
        
        request(requestUrl, { 
            method: 'GET',
            timeout: 10000
        }, (err, resp) => {
            if (err) {
                console.error(`[闻音音源] 网络异常: ${err.message}`)
                return reject(new Error(`网络请求异常: ${err.message}`))
            }
            
            try {
                let responseData = resp.body
                
                // 解析JSON
                if (typeof responseData === 'string') {
                    responseData = JSON.parse(responseData.trim())
                }
                
                // 检查API响应
                if (!responseData || responseData.code !== 200) {
                    const errMsg = responseData?.message || 'API返回异常'
                    console.error(`[闻音音源] API异常: ${errMsg}`)
                    return reject(new Error(errMsg))
                }
                
                // 提取音频链接
                const audioUrl = responseData.data?.media?.audio_url
                if (!audioUrl) {
                    console.error(`[闻音音源] 无有效音频地址`)
                    return reject(new Error('无有效音频地址'))
                }
                
                console.log(`[闻音音源] 成功: ${responseData.data.basic_info.title}`)
                resolve(audioUrl)
                
            } catch (error) {
                console.error(`[闻音音源] 解析失败: ${error.message}`)
                reject(new Error(`解析失败: ${error.message}`))
            }
        })
    })
}

// 初始化
send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        wy: {
            name: '网易云音乐',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['128k', '320k']
        }
    }
})

console.log('[闻音音源] 初始化完成')