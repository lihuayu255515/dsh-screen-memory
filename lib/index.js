/**
 * dsh-screen-memory —— DSH 屏幕记忆（v0.2.0 / P1.5 + P2）
 *
 * 工具：
 *   screen_status   环境与仓库状态
 *   screen_look     截屏（可选按窗口、可选特写）→ 入库
 *   screen_archive  把任意图片入库（QQ 图 / 上传图 / 本地文件）
 *   screen_list     列出仓库
 *   screen_get      按编号取回本地路径
 *   screen_hud      设置/查看/清除"按窗口记住的特写区域"
 *
 * 安全约束：
 *   · apply() 整体 try/catch，失败只写日志
 *   · 不开端口、不建计划任务、不注册全局 hook（HTTP 接口在 QQ 适配包里，可选）
 *   · 数据只写自己的目录（默认 ~/.dsh/storages/screen-memory）
 */
import {
  mkdirSync, appendFileSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync, renameSync, copyFileSync, unlinkSync, statSync,
} from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { makeStore } from './store.mjs'
import { probeBackends, capture, cleanup, findFfmpeg, run } from './capture.mjs'
import { resolveVisionConfig, makeVisionUsage, describeImage } from './vision.mjs'
import { attachWebUI } from './webui.mjs'
import { imageSize } from './img.mjs'
import { composeHud } from './compose.mjs'
import { makeHudProfiles } from './hud.mjs'
import { resolveBudget, makeBudgetUsage } from './budget.mjs'
import { makeArchive, restoreFromArchive, shouldRunMaintain, pickDueForArchive } from './maintain.mjs'

const NAME = 'screen-memory'
const NL = String.fromCharCode(10)
const VERSION = '0.4.27'

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDirOf(config) {
  const cfg = config || {}
  if (cfg.dataDir && typeof cfg.dataDir === 'string') return cfg.dataDir
  return join(homeDir(), 'storages', 'screen-memory')
}

function makeLogger(dir) {
  const logPath = join(dir, 'logs', 'plugin.log')
  let checked = 0
  return (msg) => {
    try {
      // 日志超过 1MB 就轮转一次（.1），避免无限增长
      if (checked !== -1 && Date.now() - checked > 60000) {
        checked = Date.now()
        try {
          const st = statSync(logPath)
          if (st.size > 1024 * 1024) {
            try { rmSync(logPath + '.1', { force: true }) } catch {}
            renameSync(logPath, logPath + '.1')
          }
        } catch {}
      }
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }
}

async function loadDefineTool() {
  if (process.env.DSM_NO_HOST_TOOLS === '1') return null
  const candidates = []
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p) }
  if (process.env.DSH_HOST_MODULES) push(process.env.DSH_HOST_MODULES)
  const dshHome = homeDir()
  const profilesDir = join(dshHome, 'profiles')
  try {
    for (const prof of readdirSync(profilesDir)) {
      const base = join(profilesDir, prof, 'node_modules')
      push(join(base, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
      try {
        const pnpm = join(base, '.pnpm')
        for (const d of readdirSync(pnpm)) {
          if (!d.startsWith('@deepseek-ai+dsh-tools@')) continue
          push(join(pnpm, d, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
        }
      } catch {}
    }
  } catch {}
  const globalPnpm = join(process.env.LOCALAPPDATA || '', 'pnpm', 'global')
  try {
    const stores = []
      // 两种布局：global/v11/node_modules/.pnpm 和 global/v11/<hash>/node_modules/.pnpm
      for (const v of readdirSync(globalPnpm)) {
        stores.push(join(globalPnpm, v, 'node_modules', '.pnpm'))
        try {
          for (const h of readdirSync(join(globalPnpm, v))) {
            stores.push(join(globalPnpm, v, h, 'node_modules', '.pnpm'))
          }
        } catch {}
      }
      for (const store of stores) {
      try {
        for (const d of readdirSync(store)) {
          if (!d.startsWith('@deepseek-ai+dsh-tools@')) continue
          push(join(store, d, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
        }
      } catch {}
      }
  } catch {}
  const failures = []
  for (const p of candidates) {
    try {
      if (!existsSync(p)) { failures.push('missing: ' + p); continue }
      const m = await import(pathToFileURL(p).href)
      if (m && typeof m.defineTool === 'function') return m.defineTool
      failures.push('no defineTool: ' + p)
    } catch (e) {
      failures.push('import fail: ' + p + ' → ' + (e && e.message))
    }
  }
  if (typeof loadDefineTool.lastFailureLog === 'function') {
    try { loadDefineTool.lastFailureLog(failures.slice(0, 6).join(' | ')) } catch {}
  }
  try {
    const m = await import('@deepseek-ai/dsh-tools')
    if (m && typeof m.defineTool === 'function') return m.defineTool
  } catch {}
  return null
}

function fallbackDefineTool(options) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(options.parameters || {})) {
    const node = { type: v.type || 'string' }
    if (v.description) node.description = v.description
    if (v.items) node.items = v.items
    if (v.properties) node.properties = v.properties
    if (v.enum) node.enum = v.enum
    if (v.type === 'object' && node.additionalProperties === undefined) node.additionalProperties = true
    if (v.additionalProperties !== undefined) node.additionalProperties = v.additionalProperties
    props[k] = node
    if (v.required) required.push(k)
  }
  // 兜底实现也必须用调用方给的 render，否则没有 text 的结果（如 screen_status）会渲染成空白
  const userRender = options.output && typeof options.output.render === 'function' ? options.output.render : null
  const outputSchema = (options.output && options.output.schema) || { type: 'object', additionalProperties: true }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties: props, required, additionalProperties: false },
    output: {
      schema: outputSchema,
      render: (args, value) => {
        if (userRender) return userRender(args, value)
        const text = value && typeof value === 'object'
          ? (value.text || (value.ok === false ? '✗ ' + (value.error || '失败') : JSON.stringify(value)))
          : String(value == null ? '' : value)
        return [{ type: 'text', text: String(text || '(无输出)') }]
      },
    },
    async execute(args, exec) { return options.execute(args || {}, exec) },
  }
}

function regionOf(v) {
  if (!v || typeof v !== 'object') return null
  const x = Number(v.x), y = Number(v.y)
  const w = Number(v.w ?? v.width), h = Number(v.h ?? v.height)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  return { x, y, w, h }
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''))
  if (!m) return null
  const mime = m[1] || 'image/png'
  const b64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64')
  return { mime, buf: Buffer.from(b64, 'base64') }
}

export const name = NAME
export const inject = ['tools']

export async function apply(ctx, config = {}) {
  const dir = dataDirOf(config)
  const log = makeLogger(dir)
  let store = null
  let hud = null
  let disposed = false
  const registered = []
  let maintTimer = null
  let maintKickTimer = null

  try {
    mkdirSync(dir, { recursive: true })
    store = makeStore(dir)
    hud = makeHudProfiles(dir)
    log(`启动 v${VERSION}：dataDir=${dir} store=${store.sqliteOk ? 'sqlite' : 'json'}`)
  } catch (e) {
    log('仓库初始化失败：' + (e && e.message))
    return
  }

  const visionCfg = resolveVisionConfig(config)
  const budget = resolveBudget(config)
  const toolsCfg = config.tools || {}
  const onlyTools = Array.isArray(toolsCfg.only) && toolsCfg.only.length ? new Set(toolsCfg.only) : null
  const deferHeavy = toolsCfg.deferLoading === true
  const budgetUsage = makeBudgetUsage(dir)
  // 定时归档（可配置）：默认 22:00、每 3 天、每批 10 张；只做归档，不自动清回收站
  const maintCfg = Object.assign(
    { enabled: true, hour: 22, intervalDays: 3, batch: 10, archiveAfterDays: 30, trashAfterDays: 7 },
    config.maintain || {},
  )
  const maintLastFile = join(dir, 'maintain-last.json')
  const visionUsage = makeVisionUsage(dir)

  const started = Date.now()

  async function doStatus() {
    const backends = await probeBackends()
    return {
      ok: true,
      version: VERSION,
      platform: process.platform,
      node: process.version,
      uptimeMs: Date.now() - started,
      dataDir: dir,
      store: store.stats(),
      capture: backends,
      hudProfiles: hud.list().length,
      tools: {
        screen_status: true,
        screen_look: !!backends.chosen,
        screen_archive: true,
        screen_list: true,
        screen_get: true,
        screen_hud: true,
        windowCapture: !!backends.windowCapture,
        hudCompose: !!backends.ffmpeg.ok,
      },
      budget: {
        profile: budget.profile,
        imagesPerHour: budget.imagesPerHour,
        givePath: budget.givePath,
        usedThisHour: budgetUsage.usedLastHour(),
        note: budget.note,
      },
      vision: {
        configured: visionCfg.configured,
        model: visionCfg.model,
        baseUrl: visionCfg.baseUrl,
        usedToday: visionUsage.used(),
        dailyCap: visionCfg.dailyCap,
      },
      note: backends.chosen ? '' : '没有可用的截图后端',
    }
  }

  async function doLook(args = {}) {
    const window = args.window ? String(args.window) : ''
    const quality = Number(args.quality) || 85
    const shot = await capture({ backend: args.backend, window, format: args.format || 'jpg', quality })
    if (!shot.ok) return { ok: false, error: shot.err }

    let buf
    try { buf = readFileSync(shot.path) } catch (e) {
      cleanup(shot.path)
      return { ok: false, error: '读截图失败：' + (e && e.message) }
    }
    let info = imageSize(buf)
    let finalPath = shot.path
    let composedPath = null
    let plan = null
    let hudFailNote = ''

    // 特写：显式 region 优先，其次用该窗口记住的档案
    const wanted = regionOf(args.region) || (window ? (hud.get(window)?.region || null) : null)
    const place = String(args.place || (window ? (hud.get(window)?.place || 'corner') : 'corner'))
    if (wanted && info.width && info.height) {
      const out = join(tmpdir(), 'dsh-screen-memory', `hud-${randomUUID()}.jpg`)
      const c = await composeHud({
        srcPath: shot.path, width: info.width, height: info.height,
        region: wanted, place, outPath: out, quality: 3,
      })
      if (c.ok) {
        composedPath = out
        buf = readFileSync(out)
        info = imageSize(buf)
        finalPath = out
        plan = c.plan
      } else {
        log('特写合成失败（退回原图）：' + c.err)
        hudFailNote = '特写未生成：' + String(c.err || '').slice(0, 160)
      }
    }

    const rec = store.put(buf, {
      width: info.width, height: info.height,
      mime: info.mime, ext: info.ext,
      source: window ? 'screen:window' : 'screen',
      note: String(args.note || (window ? `窗口：${window}` : '')).slice(0, 200),
    })
    cleanup(shot.path)
    if (composedPath) cleanup(composedPath)

    const st = store.stats()
    const used = budgetUsage.bump()
    const overBudget = budget.imagesPerHour <= 0 || used > budget.imagesPerHour
    const givePath = budget.givePath && !overBudget
    const lines = [
      `屏幕截图已存 #${rec.id}（${info.width}x${info.height}，${Math.round(buf.length / 1024)} KB，${info.ext}）`,
      window ? `窗口：${window}` : '范围：整屏',
      plan ? `特写：${plan.place}${plan.corner ? '(' + plan.corner + ')' : ''}，区域 ${plan.region.w}x${plan.region.h}@${plan.region.x},${plan.region.y}` : '',
      hudFailNote,
      givePath
        ? `路径：${rec.path}`
        : `（省预算档：不返回本地路径，请用 screen_describe(id=${rec.id}) 看文字）`,
      budget.imagesPerHour > 0
        ? `仓库共 ${st.images} 张 / ${(st.bytes / 1024 / 1024).toFixed(1)} MB（本小时已用 ${used}/${budget.imagesPerHour} 张）`
        : `仓库共 ${st.images} 张 / ${(st.bytes / 1024 / 1024).toFixed(1)} MB（本小时已用 ${used} 张 · 当前档位不鼓励主会话看图）`,
      givePath
        ? `要看这张图：用你的看图工具打开 ${rec.path}（如 read_image）；没有看图能力就改用 screen_describe(id=${rec.id})`
        : `调用 screen_describe({id:${rec.id}}) 让它告诉你画面内容`,
    ].filter(Boolean)
    return {
      ok: true,
      id: rec.id,
      path: givePath ? rec.path : '',
      width: info.width,
      height: info.height,
      text: lines.join('\n'),
    }
  }

  /** 眼睛：把仓库里的一张图交给视觉 API，返回文字描述（不占模型上下文） */
  async function doDescribe(args = {}) {
    if (!visionCfg.configured) {
      return {
        ok: false,
        error: '没有配置视觉 API。解决办法（任选其一）：'
          + ' / 1) 插件配置里填 vision: { apiKey, baseUrl?, model? }'
          + ' / 2) 环境变量 DSH_VISION_API_KEY'
          + ' / 3) 在 ~/.dsh/.credentials.yaml 里放 DEEPSEEK_API_KEY',
      }
    }
    const used = visionUsage.used()
    if (used >= visionCfg.dailyCap) {
      return { ok: false, error: '今日眼睛次数已用完（' + used + '/' + visionCfg.dailyCap + '）' }
    }

    let buf = null
    let rec = null
    let srcPath = ''
    if (args.path) {
      srcPath = String(args.path)
      try {
        const probe = imageSize(readFileSync(srcPath))
        if (!/^image\//.test(probe.mime)) {
          return { ok: false, error: '拒绝：不是图片文件（只接受 png/jpg/webp），不会上传：' + (probe.mime || '未知') }
        }
      } catch (e) {
        return { ok: false, error: '读图失败：' + (e && e.message) }
      }
    } else if (args.id) {
      rec = store.get(args.id)
      if (!rec) return { ok: false, error: '没有 #' + args.id }
      const eb = await ensureBlob(rec)
      if (!eb.ok) return { ok: false, error: eb.error }
      srcPath = eb.path
    } else {
      const last = store.list({ limit: 1 })[0]
      if (!last) return { ok: false, error: '仓库里还没有图，先 screen_look 或 screen_archive' }
      rec = last
      const eb = await ensureBlob(last)
      if (!eb.ok) return { ok: false, error: eb.error }
      srcPath = eb.path
    }
    try {
      buf = readFileSync(srcPath)
    } catch (e) {
      return { ok: false, error: '读图失败：' + (e && e.message) }
    }

    const info = imageSize(buf)
    let b64 = null
    let mime = info.mime
    const longEdge = Math.max(info.width, info.height) || 0
    const tooBig = buf.length > 2 * 1024 * 1024
    if (longEdge > visionCfg.maxEdge || tooBig) {
      const ff = await findFfmpeg()
      if (!ff) {
        if (buf.length > 4 * 1024 * 1024) {
          return { ok: false, error: '图片太大且没有 ffmpeg 可用于压缩，请先装 ffmpeg' }
        }
        b64 = buf.toString('base64')
      } else {
        mkdirSync(join(tmpdir(), 'dsh-screen-memory'), { recursive: true })
        const tmp = join(tmpdir(), 'dsh-screen-memory', 'eye-' + randomUUID() + '.jpg')
        const scale = visionCfg.maxEdge / longEdge
        const w = Math.max(2, Math.round(info.width * scale))
        const h = Math.max(2, Math.round(info.height * scale))
        const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', srcPath, '-vf', 'scale=' + w + ':' + h, '-q:v', '3', '-y', tmp], 30000)
        if (r.code !== 0) return { ok: false, error: '缩图失败：' + String(r.err || r.out || '').slice(0, 200) }
        try {
          buf = readFileSync(tmp)
          b64 = buf.toString('base64')
          mime = 'image/jpeg'
        } finally {
          try { rmSync(tmp, { force: true }) } catch {}
        }
      }
    } else {
      if (buf.length > 4 * 1024 * 1024) {
        return { ok: false, error: '图片太大（>4MB）且没有 ffmpeg 可用于压缩，请先装 ffmpeg' }
      }
      b64 = buf.toString('base64')
    }

    const question = String(args.question || '').trim()
    const r = await describeImage({ imageBase64: b64, mime, question, cfg: visionCfg })
    if (!r.ok) return { ok: false, error: '眼睛没看成：' + r.error }

    const n = visionUsage.bump()
    const tok = r.usage && r.usage.total_tokens ? ' · ' + r.usage.total_tokens + ' token' : ''
    return {
      ok: true,
      text: r.text + NL + '（模型 ' + visionCfg.model + ' · 今日第 ' + n + ' 次' + tok + '）',
    }
  }

  /** 回顾：列出还没判断的图 */
  async function doReview(args = {}) {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
    let rows = store.list({ limit: limit * 3, state: 'hot' })
    rows = rows.filter((r) => !Number(r.judged)).slice(0, limit)
    const st = store.stats()
    if (!rows.length) {
      return { ok: true, text: '没有待判断的图。仓库：' + st.images + ' 张（hot ' + (st.byState.hot || 0) + ' / archived ' + (st.byState.archived || 0) + ' / trashed ' + (st.byState.trashed || 0) + '）' }
    }
    const lines = rows.map((r) => {
      const t = new Date(Number(r.created_at) || Date.now()).toISOString().slice(5, 16).replace('T', ' ')
      return '#' + r.id + '  ' + t + '  ' + r.width + 'x' + r.height + '  ' + Math.round((r.bytes || 0) / 1024) + ' KB  ' + (r.note || r.source || '')
    })
    return {
      ok: true,
      text: [
        '待判断 ' + rows.length + ' 张（仓库共 ' + st.images + ' 张，未判断 ' + st.unjudged + '）：',
        lines.join(NL),
        '',
        '判断方式：screen_judge({id, keep:true}) 保留 / screen_judge({id, keep:false}) 丢进回收站（7 天后物理删除）。',
        '不判断的图：超过 ' + 30 + ' 天会被自动归档（不删除，仍可 screen_get 取回）。',
      ].join(NL),
    }
  }

  /** 判断一张图：保留 / 进回收站 */
  async function doJudge(args = {}) {
    const id = Number(args.id)
    if (!id) return { ok: false, error: '需要 id' }
    const rec = store.get(id)
    if (!rec) return { ok: false, error: '没有 #' + id }
    const keep = args.keep !== false && String(args.keep) !== 'false'
    if (keep) {
      store.update(id, { judged: 1, judged_at: Date.now(), state: 'hot' })
      return { ok: true, text: '#' + id + ' 已标记保留（仍在 hot）' }
    }
    store.update(id, { judged: 1, judged_at: Date.now(), state: 'trashed' })
    return { ok: true, text: '#' + id + ' 已移入回收站，7 天后物理删除（想反悔：screen_judge({id,keep:true})）' }
  }

  /** 整理：归档旧的 hot → tar.gz；清理回收站过期 */
  async function doMaintain(args = {}) {
    const dryRun = args.dryRun === true || String(args.dryRun) === 'true'
    const archiveAfterDays = Number.isFinite(Number(args.archiveAfterDays)) ? Number(args.archiveAfterDays) : 30
    const trashAfterDays = Number.isFinite(Number(args.trashAfterDays)) ? Number(args.trashAfterDays) : 7
    const now = Date.now()
    const cut = now - archiveAfterDays * 86400 * 1000

    const batch = Math.max(1, Math.min(500, Number(args.limit) || 500))
    const hot = pickDueForArchive(store.list({ limit: 500, state: 'hot' }), archiveAfterDays, batch, now)
    const trashed = store.list({ limit: 500, state: 'trashed' }).filter((r) => Number(r.judged_at || 0) < now - trashAfterDays * 86400 * 1000)

    const report = { dryRun, toArchive: hot.length, toPurge: trashed.length, archived: 0, purged: 0, archiveFile: '', error: '' }

    if (!dryRun && hot.length) {
      const paths = hot.map((r) => store.findBlob(r.sha256)).filter(Boolean)
      if (paths.length) {
        const r = await makeArchive({ dataDir: dir, ids: hot.map((x) => x.id), paths, tag: 'auto' })
        if (r.ok) {
          report.archived = hot.length
          report.archiveFile = r.file
          store.addArchive({ file: r.file, count: r.count, bytes: r.bytes })
          for (const row of hot) {
            store.update(row.id, { state: 'archived', archive_file: r.file })
            try {
              const p = store.findBlob(row.sha256)
              if (p) rmSync(p, { force: true })
            } catch {}
          }
        } else {
          report.error = r.err
        }
      }
    }

    if (!dryRun && trashed.length && args.purgeTrash !== false) {
      for (const row of trashed) {
        try {
          const p = store.findBlob(row.sha256)
          if (p) rmSync(p, { force: true })
        } catch {}
        store.remove(row.id)
        report.purged += 1
      }
    }

    const st = store.stats()
    return {
      ok: !report.error,
      text: [
        (dryRun ? '【预演】' : '【已执行】') + '归档旧图 + 清理回收站（本次最多归档 ' + batch + ' 张）',
        '归档（hot 超过 ' + archiveAfterDays + ' 天）：' + report.toArchive + ' 张 → 实际 ' + report.archived,
        report.archiveFile ? '归档包：' + report.archiveFile : '',
        '回收站（超过 ' + trashAfterDays + ' 天）：' + report.toPurge + ' 张 → 实际清理 ' + report.purged,
        report.error ? '错误：' + report.error : '',
        '现状：共 ' + st.images + ' 张 / ' + (st.bytes / 1024 / 1024).toFixed(1) + ' MB（hot ' + (st.byState.hot || 0) + ' · archived ' + (st.byState.archived || 0) + ' · trashed ' + (st.byState.trashed || 0) + '）',
      ].filter(Boolean).join(NL),
    }
  }

  /** 检索：按关键词 / 时间范围找图 */
  async function doSearch(args = {}) {
    let since = Number(args.since) || 0
    let until = Number(args.until) || 0
    const days = Number(args.days) || 0
    if (!since && days) since = Date.now() - days * 86400 * 1000
    const rows = store.search({ query: args.query || '', since, until, limit: args.limit || 20, state: args.state || null })
    if (!rows.length) return { ok: true, text: '没找到符合条件的图。' }
    const lines = rows.map((r) => {
      const t = new Date(Number(r.created_at) || Date.now()).toISOString().slice(5, 16).replace('T', ' ')
      return '#' + r.id + '  ' + t + '  [' + (r.state || 'hot') + ']  ' + r.width + 'x' + r.height + '  ' + (r.note || r.source || '')
    })
    return { ok: true, text: '找到 ' + rows.length + ' 张：' + NL + lines.join(NL) }
  }

  async function doArchive(args = {}) {
    let buf = null
    let source = String(args.source || 'archive')
    try {
      if (args.dataUrl) {
        const d = parseDataUrl(args.dataUrl)
        if (!d) return { ok: false, error: 'dataUrl 解析失败' }
        buf = d.buf
      } else if (args.path) {
        const p = String(args.path)
        if (!existsSync(p)) return { ok: false, error: `文件不存在：${p}` }
        buf = readFileSync(p)
      } else {
        return { ok: false, error: '需要 path 或 dataUrl' }
      }
    } catch (e) {
      return { ok: false, error: '读图失败：' + (e && e.message) }
    }
    const info = imageSize(buf)
    // 只接受图片：防止被当成"把任意文件塞进仓库"的通道
    if (!/^image\//.test(info.mime)) {
      return { ok: false, error: '不是图片文件（只接受 png/jpg/webp）：' + (info.mime || '未知类型') }
    }
    const rec = store.put(buf, {
      width: info.width, height: info.height,
      mime: info.mime, ext: info.ext,
      source,
      note: String(args.note || '').slice(0, 400),
    })
    const st = store.stats()
    return {
      ok: true, id: rec.id, path: rec.path,
      text: [
        `已入库 #${rec.id}（${info.width}x${info.height}，${Math.round(buf.length / 1024)} KB）`,
        `路径：${rec.path}`,
        `仓库共 ${st.images} 张 / ${(st.bytes / 1024 / 1024).toFixed(1)} MB`,
      ].join('\n'),
    }
  }

  async function doList(args = {}) {
    const rows = store.list({ query: args.query || '', limit: args.limit || 20 })
    if (!rows.length) return { ok: true, text: '仓库里还没有图。' }
    const lines = rows.map((r) => {
      const t = new Date(Number(r.created_at) || Date.now()).toISOString().slice(5, 16).replace('T', ' ')
      const kb = Math.round((r.bytes || 0) / 1024)
      return `#${r.id}  ${t}  ${r.width}x${r.height}  ${kb} KB  ${r.note || r.source || ''}`
    })
    return { ok: true, text: `最近 ${rows.length} 张：\n` + lines.join('\n') }
  }

  /** 确保这张图的原图文件存在：归档的会自动从 tar.gz 解出来 */
  async function ensureBlob(rec) {
    if (!rec) return { ok: false, error: '没有这张图' }
    if (store.findBlob(rec.sha256)) return { ok: true, path: store.findBlob(rec.sha256) }
    if (!(rec.state === 'archived' && rec.archive_file)) {
      return { ok: false, error: '原图文件不存在，且没有可用的归档记录' }
    }
    const tmpDir = join(tmpdir(), 'dsh-screen-memory', 'restore-' + randomUUID())
    const r = await restoreFromArchive({ dataDir: dir, file: rec.archive_file, destDir: tmpDir })
    if (!r.ok) return { ok: false, error: '从归档恢复失败：' + r.err }
    try {
      const safe = /^[0-9a-f]{64}\.(jpg|png|webp)$/i
      for (const f of readdirSync(tmpDir)) {
        if (!safe.test(f)) continue
        const sha = f.replace(/\.[^.]+$/, '')
        const dstDir = join(dir, 'blobs', sha.slice(0, 2))
        mkdirSync(dstDir, { recursive: true })
        const src = join(tmpDir, f)
        const dst = join(dstDir, f)
        try {
          renameSync(src, dst)
        } catch (e) {
          // tmpdir 可能在另一个卷；renameSync 跨卷会 EXDEV，退化成复制 + 删除
          if (e && e.code !== 'EXDEV') throw e
          copyFileSync(src, dst)
          unlinkSync(src)
        }
      }
    } catch (e) {
      return { ok: false, error: '恢复文件失败：' + (e && e.message) }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
    if (!store.findBlob(rec.sha256)) return { ok: false, error: '归档里没有找到这张图的文件（可能已被清理）' }
    store.update(rec.id, { state: 'hot', archive_file: null })
    return { ok: true, path: store.findBlob(rec.sha256) }
  }

  async function doGet(args = {}) {
    const rec = store.get(args.id)
    if (!rec) return { ok: false, error: `没有 #${args.id}` }
    const r = await ensureBlob(rec)
    if (!r.ok) return { ok: false, error: r.error }
    return {
      ok: true,
      path: r.path,
      text: `#${rec.id}  ${rec.width}x${rec.height}  ${Math.round((rec.bytes || 0) / 1024)} KB\n路径：${r.path}`,
    }
  }

  async function doHud(args = {}) {
    const window = args.window ? String(args.window) : ''
    if (args.clear) {
      const ok = window ? hud.remove(window) : false
      return { ok: true, text: ok ? `已清除「${window}」的特写档案` : '没有可清除的档案（要指定 window）' }
    }
    if (args.region) {
      if (!window) return { ok: false, error: '要记住特写区域，需要同时给 window（窗口标题）' }
      const r = regionOf(args.region)
      if (!r) return { ok: false, error: 'region 需要 x/y/w/h 四个数字' }
      const saved = hud.set(window, { region: r, place: String(args.place || 'corner') })
      return { ok: true, text: `已记住「${window}」的特写：${r.w}x${r.h}@${r.x},${r.y}，摆放 ${saved.place}` }
    }
    if (window) {
      const p = hud.get(window)
      if (!p) return { ok: true, text: `「${window}」还没有特写档案` }
      return { ok: true, text: `「${window}」特写：${p.region.w}x${p.region.h}@${p.region.x},${p.region.y}，摆放 ${p.place}` }
    }
    const all = hud.list()
    if (!all.length) return { ok: true, text: '还没有任何特写档案。' }
    return { ok: true, text: '特写档案：\n' + all.map((x) => `· ${x.window} → ${x.region.w}x${x.region.h}@${x.region.x},${x.region.y}（${x.place}）`).join('\n') }
  }

  async function registerTools() {
    try {
      let hostWhy = ''
      loadDefineTool.lastFailureLog = (m) => { hostWhy = m }
      const hostDefine = await loadDefineTool()
      const defineTool = typeof hostDefine === 'function' ? hostDefine : fallbackDefineTool
      log(hostDefine ? '使用宿主 defineTool' : ('宿主 defineTool 不可用，使用内置等价实现' + (hostWhy ? '（' + hostWhy.slice(0, 300) + '）' : '')))

      const commonOutput = {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          // 有 text 就用 text；失败就给错误；否则把整个结果 JSON 化 —— 绝不能返回空内容
          let out = ''
          if (value && typeof value === 'object') {
            if (value.text) out = String(value.text)
            else if (value.ok === false) out = '✗ ' + String(value.error || '失败')
            else {
              const clone = { ...value }
              delete clone.path
              out = JSON.stringify(clone, null, 2)
            }
          } else if (value !== undefined && value !== null) {
            out = String(value)
          }
          if (!out) out = '(无输出)'
          return [{ type: 'text', text: out.slice(0, 20000) }]
        },
      }
      // 宿主 defineTool 对 schema 更严格：单个工具定义失败时退回内置实现，保证不会整批丢掉
      const mkTool = (options) => {
        try {
          if (deferHeavy && HEAVY.has(options.name)) options.deferLoading = true
          return defineTool(options)
        } catch (e) {
          log('defineTool 失败（' + options.name + '）：' + (e && e.message) + ' → 改用内置实现')
          return fallbackDefineTool(options)
        }
      }

      const HEAVY = new Set(['screen_hud', 'screen_review', 'screen_judge', 'screen_maintain', 'screen_search'])
      const reg = (t) => {
        if (disposed) return
        if (onlyTools && !onlyTools.has(t.name)) { log('按配置跳过 ' + t.name); return }
        try {
          const handle = ctx.tools.register(t)
          log('已注册 ' + t.name)
          if (typeof handle === 'function') {
            if (disposed) { try { handle() } catch {} }
            else registered.push(handle)
          }
        } catch (e) {
          log('注册失败 ' + t.name + '：' + (e && e.message))
        }
      }

      reg(mkTool({
        name: 'screen_status',
        description: '屏幕记忆状态：截图后端（ffmpeg/PowerShell）、是否支持按窗口截、特写合成是否可用、仓库多少张。',
        parameters: {},
        output: commonOutput,
        async execute() { return doStatus() },
      }))

      reg(mkTool({
        name: 'screen_look',
        description: '截屏并存入图片仓库，返回编号与本地路径。可选按窗口标题截、可选把某个区域放大成特写（region + place），或使用该窗口记住的特写档案。看图请再用 read_image 打开返回的路径。',
        parameters: {
          window: { type: 'string', description: '窗口标题（完整标题；需要 ffmpeg）。省略=整屏' },
          region: {
            type: 'object',
            description: '特写区域 {x,y,w,h}（相对截图左上角像素）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
            additionalProperties: false,
          },
          place: { type: 'string', description: '特写摆放：corner（默认右下）/ br bl tr tl / rail（右侧）/ strip（下方）' },
          format: { type: 'string', description: 'jpg（默认）或 png' },
          quality: { type: 'number', description: 'JPEG 质量 1~100，默认 85' },
          note: { type: 'string', description: '可选备注，方便以后检索' },
        },
        output: commonOutput,
        async execute(args) { return doLook(args) },
      }))

      reg(mkTool({
        name: 'screen_archive',
        description: '把一张已有图片存进仓库（本地路径或 data URL）。QQ 里看到对方发的图、网页截图、临时文件都可以这样归档。',
        parameters: {
          path: { type: 'string', description: '本地图片绝对路径' },
          dataUrl: { type: 'string', description: 'data:image/...;base64,... 形式的图片' },
          note: { type: 'string', description: '备注（写一句图里是什么，方便以后找）' },
          source: { type: 'string', description: '来源标记，如 qq / web / 截图' },
        },
        output: commonOutput,
        async execute(args) { return doArchive(args) },
      }))

      reg(mkTool({
        name: 'screen_list',
        description: '列出图片仓库里的图（按时间倒序，可按关键词过滤）。',
        parameters: {
          query: { type: 'string', description: '关键词（匹配备注/来源）' },
          limit: { type: 'number', description: '最多几条，默认 20' },
        },
        output: commonOutput,
        async execute(args) { return doList(args) },
      }))

      reg(mkTool({
        name: 'screen_get',
        description: '按编号取回一张图，返回本地路径（配合 read_image 使用）。',
        parameters: { id: { type: 'number', description: '图片编号', required: true } },
        output: commonOutput,
        async execute(args) { return doGet(args) },
      }))

      reg(mkTool({
        name: 'screen_hud',
        description: '管理"按窗口记住的特写区域"：给 window + region 记住；给 window 查询；clear=true 清除；都不给则列出全部。',
        parameters: {
          window: { type: 'string', description: '窗口标题' },
          region: {
            type: 'object',
            description: '特写区域 {x,y,w,h}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
            additionalProperties: false,
          },
          place: { type: 'string', description: '摆放：corner/br/bl/tr/tl/rail/strip' },
          clear: { type: 'boolean', description: 'true=清除该窗口的档案' },
        },
        output: commonOutput,
        async execute(args) { return doHud(args) },
      }))

      reg(mkTool({
        name: 'screen_describe',
        description: '眼睛：让视觉模型看一张图（仓库里最新的一张、指定 id 或本地路径），只返回文字描述，不把图片放进你的上下文。适合模型本身不能看图、或想省 token 的情况。',
        parameters: {
          id: { type: 'number', description: '仓库里的图片编号；省略则用最新一张' },
          path: { type: 'string', description: '本地图片路径（与 id 二选一）' },
          question: { type: 'string', description: '可选：你特别想知道什么（会作为关注点）' },
        },
        output: commonOutput,
        async execute(args) { return doDescribe(args) },
      }))

      reg(mkTool({
        name: 'screen_review',
        description: '回顾：列出还没判断（留/删）的截图，供逐个判断。',
        parameters: { limit: { type: 'number', description: '最多列几张，默认 10' } },
        output: commonOutput,
        async execute(args) { return doReview(args) },
      }))
      reg(mkTool({
        name: 'screen_judge',
        description: '判断一张图的去留：keep=true 保留；keep=false 进回收站（7 天后物理删除，期间可反悔）。',
        parameters: {
          id: { type: 'number', description: '图片编号', required: true },
          keep: { type: 'boolean', description: 'true=保留，false=丢回收站' },
        },
        output: commonOutput,
        async execute(args) { return doJudge(args) },
      }))
      reg(mkTool({
        name: 'screen_maintain',
        description: '整理仓库：把超过 N 天的 hot 图打包归档（省空间、可从归档取回），并清理回收站里超过 7 天的。可 dryRun 预演。',
        parameters: {
          dryRun: { type: 'boolean', description: 'true=只报告不执行' },
          archiveAfterDays: { type: 'number', description: 'hot 超过多少天归档，默认 30' },
          trashAfterDays: { type: 'number', description: '回收站超过多少天删除，默认 7' },
        },
        output: commonOutput,
        async execute(args) { return doMaintain(args) },
      }))
      reg(mkTool({
        name: 'screen_search',
        description: '检索图片仓库：按关键词（备注/来源）和时间范围找图。',
        parameters: {
          query: { type: 'string', description: '关键词' },
          days: { type: 'number', description: '最近多少天' },
          since: { type: 'number', description: '起始时间戳（毫秒，可选）' },
          until: { type: 'number', description: '结束时间戳（毫秒，可选）' },
          limit: { type: 'number', description: '最多几条，默认 20' },
          state: { type: 'string', description: '只看某个状态：hot / archived / trashed' },
        },
        output: commonOutput,
        async execute(args) { return doSearch(args) },
      }))
    } catch (e) {
      log('工具注册流程异常：' + (e && e.message))
    }
  }

  // 定时归档：每 5 分钟检查一次；到点且间隔够了才跑一批
  try {
    const readLast = () => {
      try { return Number(JSON.parse(readFileSync(maintLastFile, 'utf8')).lastAt) || 0 } catch { return 0 }
    }
    const writeLast = () => {
      try { writeFileSync(maintLastFile, JSON.stringify({ lastAt: Date.now() })) } catch {}
    }
    const tick = async () => {
      try {
        if (!shouldRunMaintain(maintCfg, readLast(), Date.now())) return
        const r = await doMaintain({
          archiveAfterDays: maintCfg.archiveAfterDays,
          trashAfterDays: maintCfg.trashAfterDays,
          limit: maintCfg.batch,
          purgeTrash: false,
        })
        writeLast()
        log('定时归档：' + (r && r.text ? r.text.split(NL)[1] || '完成' : '完成'))
      } catch (e) {
        log('定时归档失败：' + (e && e.message))
      }
    }
    maintTimer = setInterval(tick, 5 * 60 * 1000)
    if (maintTimer.unref) maintTimer.unref()
    maintKickTimer = setTimeout(tick, 30 * 1000)
    maintKickTimer.unref?.()
    log('定时归档已启用：' + maintCfg.hour + ':00 起，每 ' + maintCfg.intervalDays + ' 天一批，每批 ' + maintCfg.batch + ' 张')
  } catch (e) {
    log('定时归档初始化失败：' + (e && e.message))
  }

  // 只读仓库 UI（webServer 不存在时自行跳过，不影响任何工具）
  try {
    attachWebUI(ctx, {
      store,
      dataDir: dir,
      log,
      visionCfg,
      visionUsage,
      describeById: (id, question) => doDescribe({ id, question }),
    })
  } catch (e) {
    log('webUI 挂载失败：' + (e && e.message))
  }

  // 等工具真正注册完再返回，避免 apply 返回后 HMR 立刻禁用却留下残余注册。
  await registerTools()
  log('apply 完成')

  return () => {
    disposed = true
    if (maintTimer) { try { clearInterval(maintTimer) } catch {} maintTimer = null }
    if (maintKickTimer) { try { clearTimeout(maintKickTimer) } catch {} maintKickTimer = null }
    for (const dispose of registered.splice(0)) {
      try { dispose() } catch {}
    }
    try { store?.close?.() } catch {}
  }
}

export default { name, inject, apply }
