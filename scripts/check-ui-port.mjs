/**
 * 自检：这一版从预览版移植过来的三块 UI（音浪 / 标签栏 / 音源管理）与
 * 共享音源探测，关键契约还在不在。纯静态检查，跑得快，适合提交前过一遍。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail ? '：' + detail : ''}`)
}

// ── 音浪取样：参数在播放器侧（2026-10-23 为「音浪条随声音动」重新调过）
// 旧断言查的是 preview 版 music-spectrum-tap 的常量，那套常量已随重写移除。
const playerSrc = read('src/music-player.ts')
const gaplessSrc = read('src/music-browser-gapless.ts')
for (const [scope, src] of [['播放器', playerSrc], ['无缝衔接', gaplessSrc]]) {
  check(`${scope} fftSize 2048`, /analyser\.fftSize\s*=\s*2048/.test(src))
  check(`${scope} smoothing .72`, /smoothingTimeConstant\s*=\s*0\.72/.test(src))
  check(`${scope} minDecibels -95`, /minDecibels\s*=\s*-95/.test(src))
  check(`${scope} maxDecibels -25`, /maxDecibels\s*=\s*-25/.test(src))
}

const wave = read('src/music-flowing-wave.ts')
check('波形 32 段', /WAVE_BANDS\s*=\s*32/.test(wave))
check('频段 60Hz–12kHz', /BAND_LOW_HZ\s*=\s*60/.test(wave) && /BAND_HIGH_HZ\s*=\s*12000/.test(wave))
check('弹簧参数 300 / 22', /SPRING\s*=\s*300/.test(wave) && /DAMPING\s*=\s*22/.test(wave))

const visualizer = read('src/music-visualizer.ts')
check('四种样式', ['bars', 'dots', 'mini', 'outline'].every((style) => visualizer.includes(`"${style}"`)))
check('两个位置', visualizer.includes('"progress"') && visualizer.includes('"bottom"'))
check('默认 进度条上方 · 细柱', /: "bars"/.test(visualizer) && /position === "bottom" \? "bottom" : "progress"/.test(visualizer))
check('设置项 id 与预览版一致', ['visualizer-enabled', 'visualizer-position', 'visualizer-style'].every((id) => visualizer.includes(id)))
check('底边模式隐藏 bottomline', visualizer.includes('has-bottom-visualizer'))

// ── 标签栏
const songView = read('src/music-song-view.ts')
check('song-view-tabs 存在', songView.includes('song-view-tabs'))
check('两个 tab', songView.includes('data-song-view-tab="details"') && songView.includes('data-song-view-tab="lyrics"'))
check('aria-selected 同步', songView.includes('aria-selected'))
const songCss = read('src/music-song-view.css')
check('标签栏样式', songCss.includes('.song-view-tabs'))

// ── 共享音源
const pool = read('scripts/shared-pool.mjs')
check('请求超时 9s', /POOL_REQUEST_TIMEOUT_MS\s*=\s*9000/.test(pool))
check('探测超时 8s', /LINE_PROBE_TIMEOUT_MS\s*=\s*8000/.test(pool))
check('签名探测头', pool.includes("signedHeaders('GET', PROBE_PATH, null)"))
check('DNS 预解析剔除死线', pool.includes('dns.lookup'))
check('平台探针表', pool.includes('POOL_PROBES') && pool.includes('probeUpstreams'))
check('探针 10s 上限', /UPSTREAM_PROBE_TIMEOUT_MS\s*=\s*10000/.test(pool))

const server = read('scripts/music-server.mjs')
for (const route of ['/api/lx/sources/add', '/api/lx/sources/remove', '/api/lx/sources/toggle', '/api/lx/selfcheck']) {
  check(`路由 ${route}`, server.includes(route))
}
check('自检单源 10s', /LX_SELFCHECK_CALL_TIMEOUT_MS\s*=\s*10000/.test(server))
check('credential 导入吃二进制', server.includes('importKeyFile(credDir'))

// ── 客户端不再提到账号名 / 旧配置项
const app = read('src/music-app.ts')
check('状态不显示账号名', !app.includes('账号 ${state.account}'))
check('删掉音源目录输入框', !app.includes('lx-sources-dir'))
check('删掉启用自定义音源开关', !app.includes('lx-sources-enabled'))
check('删掉旧说明句', !app.includes('插件由你自己提供与维护'))
check('保留检测连通性按钮', app.includes('data-action="pool-connectivity"'))
check('音源计数文案', app.includes('已加载 ${loaded}/${total} 个音源'))

if (failures.length) {
  console.error('✗ UI/接口契约自检未通过：')
  for (const line of failures) console.error('  · ' + line)
  process.exit(1)
}
console.log('✓ 音浪 / 标签栏 / 音源管理 / 共享音源探测 契约自检通过')
