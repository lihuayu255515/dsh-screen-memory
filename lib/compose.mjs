/**
 * lib/compose.mjs —— 特写合成（用 ffmpeg 的滤镜，不引入 sharp）
 *
 * 支持的摆放：
 *   corner  （默认右下角，留 8px 边距；也可指定 br/bl/tr/tl）
 *   rail    （特写放右侧，主图缩窄）
 *   strip   （特写下加一条，主图在上）
 */
import { run, findFfmpeg } from './capture.mjs'
import { fitWidth } from './img.mjs'

function clampRegion(region, W, H) {
  if (!region) return null
  const rawW = Number(region.w || region.width) || 0
  const rawH = Number(region.h || region.height) || 0
  // 尺寸太小直接判为非法（避免悄悄截个 14x14 的碎片当特写）
  if (rawW < 16 || rawH < 16) return null
  const x = Math.max(0, Math.min(W - 1, Math.round(Number(region.x) || 0)))
  const y = Math.max(0, Math.min(H - 1, Math.round(Number(region.y) || 0)))
  const w = Math.max(16, Math.min(W - x, Math.round(rawW)))
  const h = Math.max(16, Math.min(H - y, Math.round(rawH)))
  if (w < 16 || h < 16) return null
  // 偶数化，避免部分编码器要求
  return { x: x - (x % 2), y: y - (y % 2), w: w - (w % 2), h: h - (h % 2) }
}

/**
 * 合成一张带特写的图
 * @returns {Promise<{ok:boolean, path?:string, err?:string, plan?:object}>}
 */
export async function composeHud({ srcPath, width, height, region, place = 'corner', outPath, quality = 3 }) {
  const ff = await findFfmpeg()
  if (!ff) return { ok: false, err: '没有 ffmpeg，无法合成特写（可以先不用特写）' }
  const r = clampRegion(region, width, height)
  if (!r) return { ok: false, err: 'region 不合法（需要 x/y/w/h，且在画面内）' }

  const Wm = Math.max(140, fitWidth(width, height))
  const hw = Math.max(28, Math.round(Wm * 0.30) - (Math.round(Wm * 0.30) % 2))
  const crop = `crop=${r.w}:${r.h}:${r.x}:${r.y}`
  const rawPlace = String(place || 'corner').toLowerCase()
  // 兼容旧档案/旧调用；新 UI 只写规范名
  const placeAliases = { auto: 'corner', right: 'rail', left: 'bl', top: 'tr', 'top-left': 'tl' }
  const p = placeAliases[rawPlace] || rawPlace

  let filter
  let plan
  const mainH = width ? Math.round((height * Wm) / width) : 0
  const stripH = Math.max(60, Math.round(mainH * 0.28))
  if (p === 'strip') {
    filter = [
      `[0:v]split=2[a][b]`,
      `[b]${crop},scale=-1:${stripH},pad=${Wm}:ih:(ow-iw)/2:0:color=black[h]`,
      `[a]scale=${Wm}:-1[m]`,
      `[m][h]vstack=inputs=2[out]`,
    ].join(';')
    plan = { place: 'strip', mainWidth: Wm, hudWidth: hw, region: r }
  } else if (p === 'rail') {
    const mw = Math.max(140, Wm - hw - 16 - ((Wm - hw - 16) % 2))
    filter = [
      `[0:v]split=2[a][b]`,
      `[b]${crop},scale=${hw}:-1[h]`,
      `[a]scale=${mw}:-1,pad=${Wm}:ih:0:0:color=black[m]`,
      `[m][h]overlay=x=W-w-8:y=(H-h)/2:format=auto[out]`,
    ].join(';')
    plan = { place: 'rail', mainWidth: Wm, hudWidth: hw, region: r }
  } else {
    const corner = ['tl', 'tr', 'bl', 'br'].includes(p) ? p : 'br'
    const x = corner.endsWith('r') ? 'W-w-8' : '8'
    const y = corner.startsWith('b') ? 'H-h-8' : '8'
    filter = [
      `[0:v]split=2[a][b]`,
      `[b]${crop},scale=${hw}:-1[h]`,
      `[a]scale=${Wm}:-1[m]`,
      `[m][h]overlay=x=${x}:y=${y}:format=auto[out]`,
    ].join(';')
    plan = { place: 'corner', corner, mainWidth: Wm, hudWidth: hw, region: r }
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', srcPath,
    '-filter_complex', filter,
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', String(quality),
    '-y', outPath,
  ]
  const res = await run(ff, args, 30000)
  if (res.code !== 0) {
    return { ok: false, err: 'ffmpeg 合成失败：' + (res.err || res.out || '').trim().slice(0, 300) }
  }
  return { ok: true, path: outPath, plan }
}
