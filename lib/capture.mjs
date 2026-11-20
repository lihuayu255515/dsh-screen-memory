/**
 * lib/capture.mjs —— 截图后端（v0.4.16：全部子进程改为无管道，沙箱里也能跑）
 *
 * 为什么不用管道：受限沙箱（DSH 自己的 pwsh/bash 工具、CI 容器）会禁止子进程开管道，
 * 用 spawn + pipe 取 stdout 会 EPERM → 出现「没装 ffmpeg / 截图失败」的假阴性。
 * 现在只用 exit code 判断成功，尺寸从图片文件头（imageSize）或 .meta.json 读。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, readFileSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { imageSize } from './img.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PS1 = join(HERE, '..', 'scripts', 'capture.ps1')

/**
 * 无管道执行：只看退出码；可选把 stderr 重定向到文件（不是 pipe，避免沙箱 EPERM）。
 * 失败时 err 会带 stderr 尾部，便于排错。
 */
export function run(cmd, args, timeoutMs = 25000, opts = {}) {
  return new Promise((resolve) => {
    let done = false
    let child
    let timer = null
    let errFd = null
    const stderrPath = opts && opts.stderrPath ? String(opts.stderrPath) : ''

    if (stderrPath) {
      try { errFd = openSync(stderrPath, 'w') } catch { errFd = null }
    }

    const cleanupFd = () => {
      if (errFd != null) {
        try { closeSync(errFd) } catch {}
        errFd = null
      }
    }

    const finish = (result) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      cleanupFd()
      let err = result && result.err ? String(result.err) : ''
      if (stderrPath) {
        try {
          const raw = readFileSync(stderrPath, 'utf8').trim()
          if (raw) err = (err ? err + '; ' : '') + raw.slice(-1200)
        } catch {}
      }
      resolve({ ...(result || {}), err })
    }

    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: errFd != null ? ['ignore', 'ignore', errFd] : 'ignore',
      })
    } catch (e) {
      cleanupFd()
      resolve({ code: -1, err: String(e && e.message) })
      return
    }

    timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: -2, err: 'timeout' })
    }, timeoutMs)

    child.on('error', (e) => {
      finish({ code: -1, err: String(e && e.message) })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1 })
    })
  })
}

/** 找 ffmpeg：环境变量 → PATH → 常见位置（只用退出码） */
export async function findFfmpeg() {
  const env = process.env.FFMPEG_PATH || process.env.DSH_FFMPEG_PATH
  if (env && existsSync(env)) return env
  const candidates = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg', join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')]
    : ['ffmpeg']
  for (const c of candidates) {
    const r = await run(c, ['-hide_banner', '-version'], 6000)
    if (r.code === 0) return c
  }
  return null
}

export async function probeBackends() {
  const out = {
    platform: process.platform,
    powershell: { ok: false, path: null },
    ffmpeg: { ok: false, path: null },
    windowCapture: false,
    chosen: null,
  }
  if (process.platform === 'win32') {
    for (const c of ['powershell.exe', 'pwsh.exe']) {
      const r = await run(c, ['-NoProfile', '-Command', 'exit 0'], 5000)
      if (r.code === 0) { out.powershell = { ok: true, path: c }; break }
    }
  }
  const ff = await findFfmpeg()
  if (ff) out.ffmpeg = { ok: true, path: ff }
  // 按窗口截图走 PowerShell 的 GetWindowRect（不依赖 ffmpeg）
  out.windowCapture = out.powershell.ok && process.platform === 'win32'
  if (out.ffmpeg.ok) out.chosen = 'ffmpeg'
  else if (out.powershell.ok) out.chosen = 'powershell'
  return out
}

function qualityArgs(format, quality) {
  const q = Math.max(1, Math.min(31, Math.round(31 - (quality / 100) * 30)))
  return format === 'jpg' ? ['-q:v', String(q)] : []
}

function readMeta(path) {
  try {
    const meta = JSON.parse(readFileSync(path + '.meta.json', 'utf8'))
    return meta && typeof meta === 'object' ? meta : {}
  } catch {
    return {}
  }
}

/**
 * 截屏
 * @param {object} o
 * @param {string} [o.backend] auto|ffmpeg|powershell
 * @param {string} [o.window] 窗口标题（PowerShell 按窗口矩形截取）
 * @param {string} [o.format] jpg|png（默认 jpg）
 * @param {number} [o.quality] 1..100（jpg 有效，默认 85）
 */
export async function capture(o = {}) {
  const backend = String(o.backend || 'auto').toLowerCase()
  const format = String(o.format || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg'
  const quality = Number(o.quality) || 85
  const window = o.window ? String(o.window) : ''

  const tmpDir = join(tmpdir(), 'dsh-screen-memory')
  mkdirSync(tmpDir, { recursive: true })
  const out = join(tmpDir, `shot-${randomUUID()}.${format}`)
  const metaPath = out + '.meta.json'

  let chosen = backend
  let psPath = null
  if (chosen === 'auto') {
    const p = await probeBackends()
    chosen = p.chosen || 'powershell'
    psPath = p.powershell?.path || null
  } else if (chosen === 'powershell') {
    const p = await probeBackends()
    psPath = p.powershell?.path || null
  }

  try {
    if (chosen !== 'ffmpeg' && process.platform !== 'win32') {
      return { ok: false, err: '非 Windows 环境没有可用的截图后端（当前版本只实现了 Windows 采集）' }
    }
    if (window && process.platform !== 'win32') {
      return { ok: false, err: '按窗口截图需要 Windows PowerShell' }
    }

    if (window) {
      // 按窗口：用 probeBackends 探测到的 PowerShell（powershell.exe 或 pwsh.exe）
      if (!psPath) {
        const p = await probeBackends()
        psPath = p.powershell?.path || null
      }
      if (!psPath) {
        return { ok: false, err: '按窗口截图需要 PowerShell（未找到 powershell.exe / pwsh.exe）' }
      }
      const errPath = join(tmpDir, `err-${randomUUID()}.txt`)
      const r = await run(psPath, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
        '-Out', out, '-Format', format, '-Quality', String(quality), '-WindowTitle', window,
      ], 30000, { stderrPath: errPath })
      try { rmSync(errPath, { force: true }) } catch {}
      if (r.code !== 0 || !existsSync(out)) {
        const detail = r.err ? `：${String(r.err).slice(-500)}` : ''
        return { ok: false, err: `窗口截图失败（退出码 ${r.code}）${detail}。确认窗口存在、未最小化、标题完整` }
      }
    } else if (chosen === 'ffmpeg') {
      const ff = await findFfmpeg()
      if (!ff) return { ok: false, err: '找不到 ffmpeg（可设 FFMPEG_PATH）' }
      if (process.platform !== 'win32') {
        return { ok: false, err: '当前版本的 ffmpeg 后端只实现了 Windows（gdigrab）' }
      }
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
        '-frames:v', '1', ...qualityArgs(format, quality), '-y', out]
      const r = await run(ff, args, 25000)
      if (r.code !== 0 || !existsSync(out)) {
        return { ok: false, err: `ffmpeg 截图失败（退出码 ${r.code}）。全屏独占游戏通常拿不到画面，请改无边框窗口` }
      }
    } else {
      if (!psPath) {
        const p = await probeBackends()
        psPath = p.powershell?.path || null
      }
      if (!psPath) {
        return { ok: false, err: '截图需要 PowerShell（未找到 powershell.exe / pwsh.exe）' }
      }
      const errPath = join(tmpDir, `err-${randomUUID()}.txt`)
      const r = await run(psPath, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
        '-Out', out, '-Format', format, '-Quality', String(quality),
      ], 30000, { stderrPath: errPath })
      try { rmSync(errPath, { force: true }) } catch {}
      if (r.code !== 0 || !existsSync(out)) {
        const detail = r.err ? `：${String(r.err).slice(-500)}` : ''
        return { ok: false, err: `PowerShell 截图失败（退出码 ${r.code}）${detail}` }
      }
    }

    const size = statSync(out).size
    if (size < 500) return { ok: false, err: '截图文件异常（太小）' }
    const meta = readMeta(metaPath)
    let w = Number(meta.width) || 0
    let h = Number(meta.height) || 0
    if (!w || !h) {
      const info = imageSize(readFileSync(out))
      w = info.width
      h = info.height
    }
    if (window && (w < 32 || h < 32)) {
      return { ok: false, err: `窗口截图区域异常（${w}x${h}）。窗口可能已最小化、被遮挡或移出屏幕` }
    }
    try { rmSync(metaPath, { force: true }) } catch {}
    return { ok: true, path: out, backend: window ? 'powershell' : chosen, format, bytes: size, width: w, height: h, window }
  } catch (e) {
    return { ok: false, err: '截图异常：' + (e && e.message) }
  }
}

export function cleanup(path) {
  try { rmSync(path, { force: true }) } catch {}
}
