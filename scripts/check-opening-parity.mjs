/**
 * 自检：片头/启动时间轴是否与预览版对齐。
 *
 * 预览版是编译产物，没有 TS 源码，所以把它的常量表钉在这里做基准：
 * 任何一次改动只要动了这些数字，这个脚本就会红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 预览版 dist 里提取到的常量（music-app-aJDylBVI.js）。 */
const PREVIEW = {
  revealTime: 6.32,
  sceneStart: 6.4,
  sceneTime: 21.92,
  bootEnd: 11.6,
  revealDurationMs: 720,
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  slogan: '一张一张，慢慢听',
}

const timing = read('src/music-boot-timing.ts')
const opening = read('src/music-opening.ts')
const boot = read('src/music-boot.ts')

const failures = []
const check = (label, actual, expected) => {
  const same = typeof actual === 'number' && typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-6
    : actual === expected
  if (!same) failures.push(`${label}: 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

const num = (source, pattern) => {
  const match = source.match(pattern)
  return match ? Number(match[1]) : NaN
}

check('MUSIC_BOOT_SCENE_REVEAL_TIME', num(timing, /MUSIC_BOOT_SCENE_REVEAL_TIME\s*=\s*([\d.]+)/), PREVIEW.revealTime)
check('MUSIC_BOOT_SCENE_START', num(timing, /MUSIC_BOOT_SCENE_START\s*=\s*([\d.]+)/), PREVIEW.sceneStart)
check('MUSIC_BOOT_SCENE_TIME', num(timing, /MUSIC_BOOT_SCENE_TIME\s*=\s*([\d.]+)/), PREVIEW.sceneTime)
const bootEnd = (() => {
  const expression = timing.match(/MUSIC_BOOT_END_TIME\s*=\s*(.+)/)
  if (!expression) return NaN
  // 表达式里可能引用其它常量（如 SCENE_START + 5.2），先把常量名换成数值。
  const resolved = expression[1].replace(/[;\\s]+$/, '').replace(/MUSIC_BOOT_[A-Z_]+/g, (name) => {
    const value = num(timing, new RegExp(`${name}\\s*=\\s*([\\d.]+)`))
    return Number.isFinite(value) ? String(value) : 'NaN'
  })
  try { return Number(Function(`return (${resolved})`)()) } catch { return NaN }
})()
check('MUSIC_BOOT_END_TIME', bootEnd, PREVIEW.bootEnd)
check('REVEAL_DURATION', num(boot, /REVEAL_DURATION\s*=\s*(\d+)/), PREVIEW.revealDurationMs)

const ease = (boot.match(/REVEAL_EASE\s*=\s*["']([^"']+)["']/) ?? [])[1]
check('REVEAL_EASE', ease, PREVIEW.ease)

if (!opening.includes(PREVIEW.slogan)) failures.push(`副标题应当是「${PREVIEW.slogan}」`)

// 片头关键帧：这些数字来自预览版 nr(t) 的时间轴。
const KEYFRAMES = ['2.72', '3.58', '5.7', '6.32', '0.48', '2.26', '1.64', '1.5', '2.05', '3.28', '2.82', '3.8', '5.56', '6.08']
for (const frame of KEYFRAMES) {
  if (!opening.includes(frame)) failures.push(`music-opening.ts 缺少关键帧 ${frame}`)
}

if (failures.length) {
  console.error('✗ 片头时间轴与预览版不一致：')
  for (const line of failures) console.error('  · ' + line)
  process.exit(1)
}
console.log('✓ 片头时间轴与预览版一致（6.32 / 6.4 / 21.92 / 11.6 / 720ms / 关键帧）')
