/*!
 * @name 西瓜糖音乐
 * @description 西瓜糖API，支持tx标准音质
 * @version v1
 * @author 玥然OvO
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const apiKey = '78ba562b6b7de94edb2f4465f1a2a1feaffe9878e3b98385c4d7e7b4cf98a524'

on(EVENT_NAMES.request, async ({ source, action, info }) => {
  if (source !== 'tx' || action !== 'musicUrl') return
  
  const mid = info.musicInfo.mid || info.musicInfo.songmid || info.musicInfo.id
  if (!mid) throw new Error('缺少音乐ID')
  
  const apiUrl = `https://api.nki.pw/API/music_open_api_web.php?apikey=${apiKey}&mid=${mid}`
  
  return new Promise((resolve, reject) => {
    request(apiUrl, {
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    }, (err, resp) => {
      if (err) return reject(new Error('网络请求失败'))
      
      if (!resp.body) return reject(new Error('API返回空数据'))
      
      try {
        const data = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
        
        if (data.music_url) {
          resolve(data.music_url)
        } else if (data.url) {
          resolve(data.url)
        } else if (data.data && typeof data.data === 'string' && data.data.startsWith('http')) {
          resolve(data.data)
        } else {
          reject(new Error(data.msg || '未找到音频链接'))
        }
      } catch {
        if (resp.body.includes('http')) {
          resolve(resp.body.trim())
        } else {
          reject(new Error('数据解析失败'))
        }
      }
    })
  })
})

send(EVENT_NAMES.inited, {
  sources: {
    tx: {
      name: 'QQ音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: [
        { 
          type: '128k', 
          label: '标准品质'
        }
      ]
    }
  }
})