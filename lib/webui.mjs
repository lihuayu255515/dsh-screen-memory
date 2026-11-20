/**
 * lib/webui.mjs —— 仓库 UI（右侧栏面板 / 独立页面共用）
 *
 * 设计约束（M2.0）：
 *   · 浏览：GET 列表/缩略图/原图/统计
 *   · 写操作：让 AI 看这张（视觉 API）、判断保留/不要、单张归档、单张移入回收站（需前端二次确认）、改备注、从归档/回收站恢复、导入图片、窗口特写档案、存储清理（需确认）
 *   · 只展示/操作屏幕截图（source LIKE 'screen%'）
 *   · 不提供永久删除；回收站由 screen_maintain 在 7 天后清理
 *   · 不改动任何已有工具/存储逻辑；外部依赖由 index.js 传入（store / describeById）
 *   · webServer 不存在时（例如测试环境）整体跳过，绝不抛
 */
import { existsSync, mkdirSync, readFileSync, statSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { run } from './capture.mjs'

export const UI_PATH = '/dsh-screen-memory/ui'
export const API_BASE = '/dsh-screen-memory/api'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(res, code, obj) {
  res.writeHead(code, JSON_HEADERS)
  res.end(JSON.stringify(obj))
}

function nonEmptyFile(path) {
  try { return existsSync(path) && statSync(path).size > 0 } catch { return false }
}

function queryOf(req) {
  try { return new URL(req.url || '/', 'http://127.0.0.1').searchParams } catch { return new URLSearchParams() }
}

async function readJsonBody(req, maxBytes = 16384) {
  let raw = ''
  if (req && req.body != null) {
    raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)
  } else {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > maxBytes) throw new Error('请求体过大')
      chunks.push(buf)
    }
    raw = Buffer.concat(chunks).toString('utf8')
  }
  if (!raw.trim()) throw new Error('请求体为空')
  try { return JSON.parse(raw) } catch { throw new Error('请求体不是合法 JSON') }
}

function fmtTime(t) {
  if (!t) return ''
  const d = new Date(Number(t))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * @param {object} ctx 宿主 ctx（需要 ctx.webServer / ctx.effect）
 * @param {object} deps { store, dataDir, log, visionCfg, visionUsage, describeById, archiveById, restoreById, hud, importImage, maintain }
 */
export function attachWebUI(ctx, deps) {
  const { store, dataDir, log, visionCfg, visionUsage, describeById, archiveById, restoreById, hud, importImage, maintain } = deps || {}
  if (!ctx || !ctx.webServer || !store) { try { log && log('webUI 跳过：没有 webServer 或 store') } catch {} ; return false }

  const thumbsDir = join(dataDir, 'thumbs')
  try { mkdirSync(thumbsDir, { recursive: true }) } catch {}

  const route = (path, handler) => {
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try { await handler(req, res) }
          catch (e) { try { sendJson(res, 500, { ok: false, error: String(e && e.message) }) } catch {} }
        },
      }))
      return true
    } catch (e) {
      try { log && log('注册路由失败 ' + path + '：' + (e && e.message)) } catch {}
      return false
    }
  }

  // 列表：只读，只要屏幕截图
  route(`${API_BASE}/list`, async (req, res) => {
    const q = queryOf(req)
    const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 60))
    const offset = Math.max(0, Number(q.get('offset')) || 0)
    const query = String(q.get('q') || '').trim()
    let state = String(q.get('state') || '').trim() || null
    let judged = null
    // UI 的「待判断」不是独立 state，而是 hot + judged=0
    if (state === 'review') { state = 'hot'; judged = 0 }
    const page = store.page({ limit, offset, query, state, judged, sourceLike: 'screen%' })
    sendJson(res, 200, {
      ok: true,
      total: page.total,
      items: page.items.map((r) => ({
        id: r.id,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        note: r.note || '',
        source: r.source || '',
        state: r.state || 'hot',
        judged: !!r.judged,
        created_at: r.created_at,
        time: fmtTime(r.created_at),
      })),
    })
  })

  route(`${API_BASE}/stats`, async (req, res) => {
    const st = store.stats()
    sendJson(res, 200, {
      ok: true,
      store: st,
      vision: {
        configured: !!(visionCfg && visionCfg.configured),
        model: (visionCfg && visionCfg.model) || '',
        usedToday: visionUsage ? visionUsage.used() : 0,
        dailyCap: (visionCfg && visionCfg.dailyCap) || 0,
      },
    })
  })

  // 缩略图：按需生成并缓存；同一张图只生成一次
  route(`${API_BASE}/thumb`, async (req, res) => {
    const id = Number(queryOf(req).get('id'))
    const rec = id ? store.get(id) : null
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    const cached = join(thumbsDir, String(id) + '.jpg')
    if (nonEmptyFile(cached)) return sendImage(res, cached, 'image/jpeg')
    const blob = store.findBlob(rec.sha256)
    if (!blob) return sendJson(res, 404, { ok: false, error: '原图不在本地（可能已归档）' })
    const tmp = join(thumbsDir, String(id) + '.' + randomUUID() + '.tmp.jpg')
    try {
      const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', blob, '-vf', 'scale=320:-2', '-q:v', '5', '-y', tmp], 20000)
      if (r.code === 0 && nonEmptyFile(tmp)) {
        try { renameSync(tmp, cached) } catch {}
        // 并发请求时另一个请求可能已经写好缓存；优先返回缓存
        if (nonEmptyFile(cached)) return sendImage(res, cached, 'image/jpeg')
        return sendImage(res, tmp, 'image/jpeg')
      }
      // 没 ffmpeg：退回原图（浏览器缩放），不写缓存
      return sendImage(res, blob, rec.mime || 'image/jpeg')
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message) })
    } finally {
      try { rmSync(tmp, { force: true }) } catch {}
    }
  })

  // 原图
  route(`${API_BASE}/full`, async (req, res) => {
    const id = Number(queryOf(req).get('id'))
    const rec = id ? store.get(id) : null
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    try { return sendImage(res, store.blobPath(rec.sha256), rec.mime || 'image/jpeg') }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e && e.message) }) }
  })

  // 让 AI 看这张（复用 screen_describe 的逻辑：限额/压缩/计数都一致）
  route(`${API_BASE}/ask`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const q = queryOf(req)
    const id = Number(q.get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    if (!visionCfg || !visionCfg.configured) return sendJson(res, 200, { ok: false, error: '没有配置视觉 API（看 README 11.3）' })
    if (typeof describeById !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供 describeById' })
    const r = await describeById(id, String(q.get('q') || '').trim())
    return sendJson(res, 200, r)
  })

  // 单张移入回收站：只允许屏幕截图，不提供永久删除；7 天后由 screen_maintain 清理
  route(`${API_BASE}/trash`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能把屏幕截图移入回收站' })
    }
    if (rec.state === 'archived') return sendJson(res, 409, { ok: false, error: '已归档的图请先恢复，再决定是否移入回收站' })
    if (rec.state === 'trashed') return sendJson(res, 200, { ok: true, id, state: 'trashed', already: true })
    const ok = store.update(id, { state: 'trashed' })
    if (!ok) return sendJson(res, 500, { ok: false, error: '移入回收站失败' })
    try { log && log('UI 移入回收站：#' + id) } catch {}
    return sendJson(res, 200, { ok: true, id, state: 'trashed' })
  })

  // 改备注：只允许屏幕截图，最多 500 字；空字符串表示清除备注
  route(`${API_BASE}/note`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能编辑屏幕截图的备注' })
    }
    let body
    try { body = await readJsonBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const note = String(body && body.note != null ? body.note : '').trim()
    if (note.length > 500) return sendJson(res, 400, { ok: false, error: '备注最多 500 字' })
    const ok = store.update(id, { note })
    if (!ok) return sendJson(res, 500, { ok: false, error: '保存备注失败' })
    return sendJson(res, 200, { ok: true, id, note })
  })

  // 单张归档：只允许 hot 屏幕截图；归档后可恢复
  route(`${API_BASE}/archive`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能归档屏幕截图' })
    }
    if (rec.state === 'archived') return sendJson(res, 200, { ok: true, id, state: 'archived', already: true })
    if (rec.state !== 'hot') return sendJson(res, 409, { ok: false, error: '只有活跃图可以归档' })
    if (typeof archiveById !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供归档能力' })
    const r = await archiveById(id)
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || '归档失败' })
    try { log && log('UI 归档：#' + id) } catch {}
    return sendJson(res, 200, { ok: true, id, state: 'archived', file: r.file || '' })
  })

  // 从归档或回收站恢复到活跃：只允许屏幕截图，恢复后重新进入 review 范围
  route(`${API_BASE}/restore`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能恢复屏幕截图' })
    }
    if (rec.state === 'archived') {
      if (typeof restoreById !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供归档恢复能力' })
      const r = await restoreById(id)
      if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || '恢复失败' })
      try { log && log('UI 从归档恢复：#' + id) } catch {}
      return sendJson(res, 200, { ok: true, id, state: 'hot' })
    }
    if (rec.state !== 'trashed') return sendJson(res, 409, { ok: false, error: '这张图不在回收站或归档里' })
    const ok = store.update(id, { state: 'hot', judged: 0, judged_at: 0 })
    if (!ok) return sendJson(res, 500, { ok: false, error: '恢复失败' })
    try { log && log('UI 从回收站恢复：#' + id) } catch {}
    return sendJson(res, 200, { ok: true, id, state: 'hot' })
  })

  // 判断留/删：keep=true 保留到 hot；keep=false 移入回收站（UI 负责二次确认）
  route(`${API_BASE}/judge`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能判断屏幕截图' })
    }
    if (rec.state === 'archived') return sendJson(res, 409, { ok: false, error: '已归档的图请先恢复，再判断' })
    let body
    try { body = await readJsonBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const keep = !(body && body.keep === false)
    const ok = store.update(id, keep
      ? { state: 'hot', judged: 1, judged_at: Date.now() }
      : { state: 'trashed', judged: 1, judged_at: Date.now() })
    if (!ok) return sendJson(res, 500, { ok: false, error: '判断失败' })
    try { log && log('UI 判断：#' + id + (keep ? ' 保留' : ' 不要')) } catch {}
    return sendJson(res, 200, { ok: true, id, keep, state: keep ? 'hot' : 'trashed' })
  })

  // 批量操作：只对屏幕截图；逐条返回结果，前端负责二次确认
  route(`${API_BASE}/batch`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    let body
    try { body = await readJsonBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const action = String(body && body.action || '')
    const allowed = new Set(['keep', 'discard', 'trash', 'archive', 'restore'])
    if (!allowed.has(action)) return sendJson(res, 400, { ok: false, error: '不支持的批量动作' })
    const raw = Array.isArray(body && body.ids) ? body.ids : []
    const ids = [...new Set(raw.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 100)
    if (!ids.length) return sendJson(res, 400, { ok: false, error: '需要至少一张图' })
    const results = []
    for (const id of ids) {
      const rec = store.get(id)
      if (!rec) { results.push({ id, ok: false, error: '没有这张图' }); continue }
      if (!String(rec.source || '').startsWith('screen')) { results.push({ id, ok: false, error: '不是屏幕截图' }); continue }
      try {
        if (action === 'keep') {
          store.update(id, { state: 'hot', judged: 1, judged_at: Date.now() })
          results.push({ id, ok: true, state: 'hot' })
        } else if (action === 'discard') {
          store.update(id, { state: 'trashed', judged: 1, judged_at: Date.now() })
          results.push({ id, ok: true, state: 'trashed' })
        } else if (action === 'trash') {
          if (rec.state === 'archived') { results.push({ id, ok: false, error: '已归档，请先恢复' }); continue }
          if (rec.state !== 'trashed') store.update(id, { state: 'trashed' })
          results.push({ id, ok: true, state: 'trashed' })
        } else if (action === 'archive') {
          if (typeof archiveById !== 'function') { results.push({ id, ok: false, error: '宿主没有提供归档能力' }); continue }
          const r = await archiveById(id)
          results.push(r.ok ? { id, ok: true, state: 'archived' } : { id, ok: false, error: r.error || '归档失败' })
        } else if (action === 'restore') {
          if (rec.state === 'archived') {
            if (typeof restoreById !== 'function') { results.push({ id, ok: false, error: '宿主没有提供归档恢复能力' }); continue }
            const r = await restoreById(id)
            results.push(r.ok ? { id, ok: true, state: 'hot' } : { id, ok: false, error: r.error || '恢复失败' })
          } else if (rec.state === 'trashed') {
            store.update(id, { state: 'hot', judged: 0, judged_at: 0 })
            results.push({ id, ok: true, state: 'hot' })
          } else {
            results.push({ id, ok: false, error: '不在归档或回收站' })
          }
        }
      } catch (e) {
        results.push({ id, ok: false, error: String(e && e.message) })
      }
    }
    const changed = results.filter((x) => x.ok).length
    try { log && log('UI 批量 ' + action + '：成功 ' + changed + '/' + results.length) } catch {}
    return sendJson(res, 200, { ok: changed > 0, action, changed, total: results.length, results })
  })

  // 窗口特写档案：列出 / 保存 / 删除
  route(`${API_BASE}/hud`, async (req, res) => {
    if (!hud || typeof hud.list !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供 HUD 能力' })
    if (!req.method || req.method === 'GET') {
      return sendJson(res, 200, { ok: true, items: hud.list() })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 GET/POST' })
    let body
    try { body = await readJsonBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const window = String(body && body.window || '').trim()
    if (!window) return sendJson(res, 400, { ok: false, error: '需要 window' })
    if (body.clear === true) {
      const removed = hud.remove(window)
      return sendJson(res, 200, { ok: true, removed, window })
    }
    const r = body.region || {}
    const region = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }
    if (![region.x, region.y, region.w, region.h].every((n) => Number.isFinite(n) && n >= 0) || region.w < 1 || region.h < 1) {
      return sendJson(res, 400, { ok: false, error: 'region 需要非负 x/y 和大于 0 的 w/h' })
    }
    const place = String(body.place || 'corner')
    if (!['auto', 'corner', 'right', 'left', 'top', 'top-left', 'strip'].includes(place)) {
      return sendJson(res, 400, { ok: false, error: '不支持的 place' })
    }
    const saved = hud.set(window, { region, place })
    return sendJson(res, 200, { ok: true, window, profile: saved })
  })

  // 导入本地图片：前端转 data URL，宿主复用 screen_archive 的验图/入库逻辑
  route(`${API_BASE}/import`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    if (typeof importImage !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供导入能力' })
    let body
    try { body = await readJsonBody(req, 32 * 1024 * 1024) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const dataUrl = String(body && body.dataUrl || '')
    if (!dataUrl.startsWith('data:image/')) return sendJson(res, 400, { ok: false, error: '只接受 data:image/... 图片' })
    const note = String(body && body.note || '').slice(0, 400)
    const r = await importImage({ dataUrl, source: 'screen:import', note })
    if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error || '导入失败' })
    try { log && log('UI 导入图片：#' + r.id) } catch {}
    return sendJson(res, 200, { ok: true, id: r.id })
  })

  // 存储清理：预演/执行归档和回收站清理；执行前前端必须确认
  route(`${API_BASE}/cleanup`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    if (typeof maintain !== 'function') return sendJson(res, 500, { ok: false, error: '宿主没有提供清理能力' })
    let body
    try { body = await readJsonBody(req) } catch (e) { return sendJson(res, 400, { ok: false, error: String(e && e.message) }) }
    const dryRun = body && body.dryRun === true
    const archiveAfterDays = Math.max(1, Math.min(3650, Number(body && body.archiveAfterDays) || 30))
    const trashAfterDays = Math.max(1, Math.min(3650, Number(body && body.trashAfterDays) || 7))
    const purgeTrash = body && body.purgeTrash === true
    const r = await maintain({ dryRun, archiveAfterDays, trashAfterDays, purgeTrash, limit: 500 })
    if (!r || r.ok === false) return sendJson(res, 500, { ok: false, error: (r && r.error) || '清理失败', text: (r && r.text) || '' })
    if (!dryRun) try { log && log('UI 执行存储清理') } catch {}
    return sendJson(res, 200, { ok: true, dryRun, text: r.text || '' })
  })

  // 页面
  route(UI_PATH, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(UI_HTML)
  })

  try { log && log('webUI 已注册：' + UI_PATH) } catch {}
  return true
}

function sendImage(res, path, mime) {
  const buf = readFileSync(path)
  res.writeHead(200, { 'content-type': mime || 'application/octet-stream', 'cache-control': 'private, max-age=60', 'content-length': buf.length })
  res.end(buf)
}

const UI_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>屏幕记忆</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e8ee; --dim:#9aa3b2; --acc:#6ea8fe; }
  @media (prefers-color-scheme: light) { :root { --bg:#f7f8fa; --card:#fff; --line:#e3e6ec; --fg:#1a1d23; --dim:#6b7280; --acc:#2563eb; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif; }
  header { position:sticky; top:0; background:var(--bg); padding:10px 12px; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:8px; align-items:center; z-index:2; }
  header h1 { font-size:14px; margin:0; flex:1; font-weight:600; }
  button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:5px 10px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--acc); }
  button:disabled { opacity:.45; cursor:default; }
  input, select { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:5px 8px; font:inherit; min-width:0; }
  input { width:180px; }
  input:focus, select:focus { outline:none; border-color:var(--acc); }
  .note { padding:0 7px 6px; font-size:11px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .badge { display:inline-block; padding:0 5px; border-radius:4px; border:1px solid var(--line); font-size:10px; color:var(--dim); }
  .danger { border-color:#7f1d1d; color:#fca5a5; }
  .danger:hover { border-color:#ef4444; }
  #moreWrap { padding:12px; text-align:center; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; padding:10px; }
  .card { position:relative; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; cursor:pointer; }
  .pick { position:absolute; top:6px; left:6px; z-index:1; width:16px; height:16px; margin:0; accent-color:var(--acc); cursor:pointer; }
  #batchbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); font-size:12px; color:var(--dim); }
  #batchbar .sp { flex:1; }
  #batchbar button { padding:4px 8px; }
  #batchbar.danger { color:#fca5a5; }
  .card img { display:block; width:100%; aspect-ratio:16/10; object-fit:cover; background:#000; }
  .placeholder { width:100%; aspect-ratio:16/10; display:flex; align-items:center; justify-content:center; background:#000; color:#9aa3b2; font-size:12px; }
  .panel .placeholder { aspect-ratio:auto; min-height:220px; }
  .meta { padding:5px 7px; font-size:11px; color:var(--dim); display:flex; flex-wrap:wrap; justify-content:space-between; gap:2px 4px; }
  .meta span { white-space:nowrap; }
  .empty { padding:40px 12px; text-align:center; color:var(--dim); }
  .overlay { position:fixed; inset:0; background:#000a; display:none; align-items:center; justify-content:center; z-index:9; }
  .overlay.on { display:flex; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; max-width:94vw; max-height:92vh; overflow:auto; width:min(1100px,94vw); }
  .panel img { width:100%; display:block; background:#000; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border-top:1px solid var(--line); }
  .bar .sp { flex:1; }
  .noteEdit { display:flex; gap:8px; align-items:center; padding:10px; border-top:1px solid var(--line); flex-wrap:wrap; }
  .noteEdit input { flex:1; width:auto; }
  .hudItem { display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); }
  .hudItem .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dim { color:var(--dim); font-size:12px; }
  pre#eye { white-space:pre-wrap; margin:0; padding:10px; border-top:1px solid var(--line); font:12px/1.6 inherit; display:none; }
  footer { padding:4px 12px 14px; color:var(--dim); font-size:11px; }
</style></head><body>
<header>
  <h1>屏幕记忆 <span id="count" class="dim"></span></h1>
  <input id="q" type="search" placeholder="搜索备注 / 来源 / 编号" autocomplete="off">
  <select id="state" title="按状态筛选">
    <option value="">全部状态</option>
    <option value="review">待判断</option>
    <option value="hot">活跃</option>
    <option value="archived">已归档</option>
    <option value="trashed">回收站</option>
  </select>
  <button id="importBtn">导入</button>
  <button id="hudBtn">特写</button>
  <button id="cleanupBtn">清理</button>
  <button id="refresh">刷新</button>
  <button id="help">这是什么？</button>
  <input id="importFile" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
</header>
<div id="notice" style="padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap">
  <span>浏览 + 备注 + 判断/归档/回收站/恢复 + 导入/特写/清理 · 只显示屏幕截图 · 不占对话上下文</span><span id="eyeNotice"></span>
</div>
<div id="batchbar">
  <label><input id="selectAll" type="checkbox"> 全选当前页</label>
  <span id="selCount">已选 0</span>
  <span class="sp"></span>
  <button data-batch="keep">批量保留</button>
  <button data-batch="discard" class="danger">批量不要</button>
  <button data-batch="archive">批量归档</button>
  <button data-batch="restore">批量恢复</button>
  <button id="clearSel">清除选择</button>
</div>
<div id="helpBox" style="display:none;padding:12px;border-bottom:1px solid var(--line);font-size:12px;line-height:1.8">
  <b>这是什么</b>：DSH 屏幕记忆插件截过的屏幕图。<br>
  <b>能做什么</b>：浏览缩略图、看原图、按备注/来源/编号搜索、按状态筛选（含「待判断」）、加载更多、编辑单张备注、判断保留/不要、批量保留/不要/归档/恢复、导入本地图片、管理窗口特写档案、预演/执行存储清理、让视觉模型描述某一张。<br>
  <b>不能做什么</b>：直接永久删除单张图；清理回收站必须在「清理」里单独勾选并确认。单张「不要/移到回收站」会先二次确认。<br>
  <b>「让 AI 看这张」</b>：需要配置视觉 API（当前：<span id="eyeState">检测中…</span>）。点一次会把那一张图发给视觉 API，并消耗一次眼睛日限。<br>
  <b>隐私</b>：图片只存在本机 dataDir；只有你点按钮时才把那一张外发。<br>
  <b>没出现这个面板</b>：直接在浏览器打开 <code>/dsh-screen-memory/ui</code> 也能用。
</div>
<div id="grid" class="grid"></div>
<div id="empty" class="empty" style="display:none">还没有屏幕截图。让 AI 调一次 <code>screen_look</code> 就会出现。</div>
<div id="moreWrap"><button id="more" disabled>加载更多</button></div>
<footer id="foot"></footer>
<div id="ov" class="overlay"><div class="panel">
  <img id="full" alt="">
  <div id="archivedNote" class="placeholder" style="display:none">已归档，点「恢复」后可查看原图</div>
  <div class="bar">
    <span id="info" class="dim"></span><span class="sp"></span>
    <button id="keep">保留</button>
    <button id="discard" class="danger">不要</button>
    <button id="archive">归档</button>
    <button id="ask">让 AI 看这张</button>
    <button id="restore">恢复</button>
    <button id="trash" class="danger">移到回收站</button>
    <button id="close">关闭</button>
  </div>
  <div class="noteEdit">
    <input id="noteInput" maxlength="500" placeholder="给这张图写备注（最多 500 字）" autocomplete="off">
    <button id="saveNote">保存备注</button>
  </div>
  <pre id="eye"></pre>
</div></div>
<div id="hudOv" class="overlay"><div class="panel" style="max-width:760px">
  <div class="bar"><b style="flex:1">窗口特写档案</b><button id="hudClose">关闭</button></div>
  <div id="hudList" style="padding:10px 12px;max-height:280px;overflow:auto"></div>
  <div class="noteEdit">
    <input id="hudWindow" placeholder="窗口标题（完整或包含）" autocomplete="off">
  </div>
  <div class="noteEdit">
    <span class="dim">x</span><input id="hudX" type="number" value="0" style="width:76px">
    <span class="dim">y</span><input id="hudY" type="number" value="0" style="width:76px">
    <span class="dim">w</span><input id="hudW" type="number" value="320" style="width:84px">
    <span class="dim">h</span><input id="hudH" type="number" value="180" style="width:84px">
    <select id="hudPlace">
      <option value="corner">corner</option>
      <option value="auto">auto</option>
      <option value="right">right</option>
      <option value="left">left</option>
      <option value="top">top</option>
      <option value="top-left">top-left</option>
      <option value="strip">strip</option>
    </select>
    <button id="hudSave">保存</button>
  </div>
</div></div>
<div id="cleanupOv" class="overlay"><div class="panel" style="max-width:620px">
  <div class="bar"><b style="flex:1">存储清理</b><button id="cleanupClose">关闭</button></div>
  <div style="padding:12px;line-height:2">
    <div>归档超过 <input id="archiveDays" type="number" min="1" value="30" style="width:80px"> 天的活跃图</div>
    <div>清理超过 <input id="trashDays" type="number" min="1" value="7" style="width:80px"> 天的回收站</div>
    <div><label><input id="purgeTrash" type="checkbox"> 执行时同时物理清理回收站（不可恢复）</label></div>
    <div class="dim">建议先点「预演」看数量；执行清理前会再确认一次。</div>
    <div class="bar" style="padding:10px 0 0;border-top:1px solid var(--line)">
      <button id="cleanupPreview">预演</button>
      <button id="cleanupRun" class="danger">执行清理</button>
    </div>
    <pre id="cleanupResult" class="dim" style="white-space:pre-wrap;max-height:260px;overflow:auto;margin:10px 0 0"></pre>
  </div>
</div></div>
<script>
(function () {
  var B = ${JSON.stringify(API_BASE)};
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var foot = document.getElementById('foot');
  var ov = document.getElementById('ov');
  var full = document.getElementById('full');
  var info = document.getElementById('info');
  var eye = document.getElementById('eye');
  var trashBtn = document.getElementById('trash');
  var restoreBtn = document.getElementById('restore');
  var importBtn = document.getElementById('importBtn');
  var importFile = document.getElementById('importFile');
  var hudBtn = document.getElementById('hudBtn');
  var hudOv = document.getElementById('hudOv');
  var hudList = document.getElementById('hudList');
  var cleanupBtn = document.getElementById('cleanupBtn');
  var cleanupOv = document.getElementById('cleanupOv');
  var cleanupResult = document.getElementById('cleanupResult');
  var keepBtn = document.getElementById('keep');
  var discardBtn = document.getElementById('discard');
  var archiveBtn = document.getElementById('archive');
  var archivedNote = document.getElementById('archivedNote');
  var noteInput = document.getElementById('noteInput');
  var saveNoteBtn = document.getElementById('saveNote');
  var qEl = document.getElementById('q');
  var stateEl = document.getElementById('state');
  var more = document.getElementById('more');
  var selectAll = document.getElementById('selectAll');
  var selCount = document.getElementById('selCount');
  var selected = new Set();
  var cur = null;
  var query = '';
  var stateFilter = '';
  var offset = 0;
  var total = 0;
  var loading = false;
  var reqSeq = 0;
  var qTimer = null;
  var stateNames = { hot: '活跃', archived: '已归档', trashed: '回收站' };

  function stateLabel(s) { return stateNames[s] || s || '活跃'; }

  function loadStats() {
    fetch(B + '/stats', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) return;
      var s = d.store;
      foot.textContent = '屏幕截图共 ' + s.images + ' 张 · ' + (s.bytes / 1048576).toFixed(1) + ' MB · 眼睛今日 ' + d.vision.usedToday + '/' + d.vision.dailyCap;
      var ok = d.vision.configured, ask = document.getElementById('ask'), n = document.getElementById('eyeNotice'), st = document.getElementById('eyeState');
      st.textContent = ok ? ('已配置' + (d.vision.model ? ('（' + d.vision.model + '）') : '')) : '未配置';
      if (!ok) { ask.disabled = true; ask.title = '未配置视觉 API'; ask.textContent = '让 AI 看这张（未配置）'; n.textContent = '· 「让 AI 看这张」需要配置视觉 API（当前未配置，按钮不可用）'; }
      else { n.textContent = '· 「让 AI 看这张」会消耗眼睛次数（今日 ' + d.vision.usedToday + '/' + d.vision.dailyCap + '）'; }
    }).catch(function () {});
  }

  function updateSelCount() {
    selCount.textContent = '已选 ' + selected.size;
    var picks = grid.querySelectorAll('.pick');
    var all = picks.length > 0;
    picks.forEach(function (x) { if (!x.checked) all = false; });
    selectAll.checked = all;
    selectAll.indeterminate = !all && Array.from(picks).some(function (x) { return x.checked; });
  }

  function toggleSelect(id, on) {
    if (on) selected.add(Number(id)); else selected.delete(Number(id));
    updateSelCount();
  }

  function makeCard(it) {
    var c = document.createElement('div'); c.className = 'card';
    var pick = document.createElement('input');
    pick.type = 'checkbox'; pick.className = 'pick'; pick.checked = selected.has(Number(it.id)); pick.dataset.id = String(it.id);
    pick.title = '选择这张图';
    pick.onclick = function (e) { e.stopPropagation(); toggleSelect(it.id, pick.checked); };
    c.appendChild(pick);
    if (it.state === 'archived') {
      var ph = document.createElement('div'); ph.className = 'placeholder'; ph.textContent = '已归档 · #' + it.id;
      c.appendChild(ph);
    } else {
      var img = document.createElement('img');
      img.loading = 'lazy'; img.src = B + '/thumb?id=' + it.id; img.alt = '#' + it.id;
      c.appendChild(img);
    }
    var m = document.createElement('div'); m.className = 'meta';
    var left = document.createElement('span'); left.textContent = '#' + it.id;
    var right = document.createElement('span'); right.textContent = it.time || '';
    m.appendChild(left); m.appendChild(right);
    var badge = document.createElement('span'); badge.className = 'badge';
    badge.textContent = it.state === 'hot' && !it.judged ? '待判断' : stateLabel(it.state);
    m.appendChild(badge);
    c.appendChild(m);
    var noteText = String(it.note || it.source || '').trim();
    if (noteText) {
      var note = document.createElement('div'); note.className = 'note';
      note.textContent = noteText;
      note.title = noteText;
      c.appendChild(note);
    }
    c.onclick = function () { open(it); };
    return c;
  }

  function load(reset) {
    var seq = ++reqSeq;
    if (reset) {
      offset = 0;
      grid.innerHTML = '';
      selected.clear();
      updateSelCount();
    }
    loading = true;
    more.disabled = true;
    var url = B + '/list?limit=60&offset=' + offset;
    if (query) url += '&q=' + encodeURIComponent(query);
    if (stateFilter) url += '&state=' + encodeURIComponent(stateFilter);
    fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
      if (seq !== reqSeq) return;
      if (!d.ok) throw new Error(d.error || '列表加载失败');
      total = Number(d.total) || 0;
      count.textContent = '(' + total + ')';
      var items = d.items || [];
      items.forEach(function (it) { grid.appendChild(makeCard(it)); });
      offset += items.length;
      updateSelCount();
      empty.style.display = total ? 'none' : 'block';
      empty.textContent = total ? '' : (query || stateFilter ? '没有匹配的屏幕截图。' : '还没有屏幕截图。让 AI 调一次 screen_look 就会出现。');
      more.disabled = offset >= total || items.length === 0;
      more.textContent = offset >= total ? '已全部加载' : ('加载更多（' + offset + '/' + total + '）');
    }).catch(function (e) {
      if (seq !== reqSeq) return;
      empty.style.display = 'block';
      empty.textContent = String(e && e.message ? e.message : e);
      more.disabled = true;
    }).finally(function () {
      if (seq === reqSeq) loading = false;
    });
  }

  function open(it) {
    cur = it;
    var archived = it.state === 'archived';
    var inactive = archived || it.state === 'trashed';
    if (archived) {
      full.style.display = 'none';
      full.removeAttribute('src');
      archivedNote.style.display = 'flex';
    } else {
      full.style.display = '';
      archivedNote.style.display = 'none';
      full.src = B + '/full?id=' + it.id;
    }
    var status = it.state === 'hot' ? (it.judged ? '已判断' : '待判断') : stateLabel(it.state);
    var bits = ['#' + it.id, it.width + 'x' + it.height, (it.bytes / 1024).toFixed(0) + ' KB', it.time || '', status];
    if (it.note) bits.push(it.note);
    info.textContent = bits.join(' · ');
    noteInput.value = it.note || '';
    archiveBtn.style.display = it.state === 'hot' ? '' : 'none';
    restoreBtn.style.display = (archived || it.state === 'trashed') ? '' : 'none';
    keepBtn.style.display = inactive ? 'none' : '';
    discardBtn.style.display = inactive ? 'none' : '';
    trashBtn.style.display = archived ? 'none' : '';
    trashBtn.disabled = it.state === 'trashed';
    trashBtn.textContent = it.state === 'trashed' ? '已在回收站' : '移到回收站';
    document.getElementById('ask').style.display = archived ? 'none' : '';
    eye.style.display = 'none'; eye.textContent = '';
    ov.classList.add('on');
  }

  document.getElementById('close').onclick = function () { ov.classList.remove('on'); };
  ov.onclick = function (e) { if (e.target === ov) ov.classList.remove('on'); };
  trashBtn.onclick = function () {
    if (!cur || cur.state === 'trashed') return;
    var label = '#' + cur.id + (cur.note ? '「' + String(cur.note).slice(0, 30) + '」' : '');
    var ok = window.confirm('确定把 ' + label + ' 移到回收站吗？' + String.fromCharCode(10, 10) + '它会从当前列表移走，可在「回收站」筛选里找到；7 天后由定时归档物理删除，无法恢复。');
    if (!ok) return;
    var btn = this;
    btn.disabled = true; btn.textContent = '正在移入…';
    fetch(B + '/trash?id=' + cur.id, { method: 'POST' }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '移入失败');
      ov.classList.remove('on');
      cur = null;
      load(true);
      loadStats();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '移到回收站';
      window.alert('移入回收站失败：' + (e && e.message ? e.message : e));
    });
  };
  keepBtn.onclick = function () {
    if (!cur || cur.state !== 'hot') return;
    var btn = this;
    btn.disabled = true; btn.textContent = '保留中…';
    fetch(B + '/judge?id=' + cur.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: true })
    }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '保留失败');
      ov.classList.remove('on');
      cur = null;
      load(true);
      loadStats();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '保留';
      window.alert('保留失败：' + (e && e.message ? e.message : e));
    });
  };
  discardBtn.onclick = function () {
    if (!cur || cur.state !== 'hot') return;
    var label = '#' + cur.id + (cur.note ? '「' + String(cur.note).slice(0, 30) + '」' : '');
    var ok = window.confirm('确定不要 ' + label + ' 吗？' + String.fromCharCode(10, 10) + '它会移入回收站，可在「回收站」筛选里找到；7 天后由定时归档物理删除，无法恢复。');
    if (!ok) return;
    var btn = this;
    btn.disabled = true; btn.textContent = '处理中…';
    fetch(B + '/judge?id=' + cur.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: false })
    }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '判断失败');
      ov.classList.remove('on');
      cur = null;
      load(true);
      loadStats();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '不要';
      window.alert('判断失败：' + (e && e.message ? e.message : e));
    });
  };
  archiveBtn.onclick = function () {
    if (!cur || cur.state !== 'hot') return;
    var btn = this;
    btn.disabled = true; btn.textContent = '归档中…';
    fetch(B + '/archive?id=' + cur.id, { method: 'POST' }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '归档失败');
      ov.classList.remove('on');
      cur = null;
      load(true);
      loadStats();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '归档';
      window.alert('归档失败：' + (e && e.message ? e.message : e));
    });
  };
  saveNoteBtn.onclick = function () {
    if (!cur) return;
    var note = noteInput.value.trim();
    if (note.length > 500) { window.alert('备注最多 500 字'); return; }
    var btn = this;
    btn.disabled = true; btn.textContent = '保存中…';
    fetch(B + '/note?id=' + cur.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: note })
    }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '保存失败');
      cur.note = d.note || '';
      noteInput.value = cur.note;
      info.textContent = ['#' + cur.id, cur.width + 'x' + cur.height, (cur.bytes / 1024).toFixed(0) + ' KB', cur.time || '', stateLabel(cur.state)].concat(cur.note ? [cur.note] : []).join(' · ');
      load(true);
    }).catch(function (e) {
      window.alert('保存备注失败：' + (e && e.message ? e.message : e));
    }).finally(function () {
      btn.disabled = false; btn.textContent = '保存备注';
    });
  };
  restoreBtn.onclick = function () {
    if (!cur || (cur.state !== 'trashed' && cur.state !== 'archived')) return;
    var btn = this;
    btn.disabled = true; btn.textContent = '恢复中…';
    fetch(B + '/restore?id=' + cur.id, { method: 'POST' }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '恢复失败');
      ov.classList.remove('on');
      cur = null;
      load(true);
      loadStats();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '恢复';
      window.alert('恢复失败：' + (e && e.message ? e.message : e));
    });
  };
  selectAll.onchange = function () {
    selected.clear();
    grid.querySelectorAll('.pick').forEach(function (x) {
      x.checked = selectAll.checked;
      if (selectAll.checked) selected.add(Number(x.getAttribute('data-id')));
    });
    updateSelCount();
  };
  document.getElementById('clearSel').onclick = function () {
    selected.clear();
    grid.querySelectorAll('.pick').forEach(function (x) { x.checked = false; });
    updateSelCount();
  };
  document.querySelectorAll('[data-batch]').forEach(function (btn) {
    btn.onclick = function () {
      var action = btn.getAttribute('data-batch');
      if (!selected.size) { window.alert('先勾选要操作的图'); return; }
      var ids = Array.from(selected);
      var label = ({ keep: '保留', discard: '不要', archive: '归档', restore: '恢复' })[action] || action;
      if (action === 'discard' && !window.confirm('确定把选中的 ' + ids.length + ' 张图都标为「不要」并移入回收站吗？' + String.fromCharCode(10, 10) + '会先二次确认；7 天后由定时归档物理删除。')) return;
      btn.disabled = true;
      fetch(B + '/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, ids: ids })
      }).then(function (r) { return r.json() }).then(function (d) {
        var errs = (d.results || []).filter(function (x) { return !x.ok; });
        var msg = '批量' + label + '：成功 ' + (d.changed || 0) + '/' + (d.total || ids.length);
        if (errs.length) msg += String.fromCharCode(10, 10) + '失败 ' + errs.length + ' 张：' + errs.slice(0, 3).map(function (x) { return '#' + x.id + ' ' + (x.error || '失败'); }).join('；');
        window.alert(msg);
        selected.clear();
        load(true);
        loadStats();
      }).catch(function (e) {
        window.alert('批量' + label + '失败：' + (e && e.message ? e.message : e));
      }).finally(function () { btn.disabled = false; });
    };
  });
  importBtn.onclick = function () { importFile.click(); };
  importFile.onchange = function () {
    var files = Array.from(importFile.files || []);
    if (!files.length) return;
    var btn = importBtn;
    btn.disabled = true; btn.textContent = '导入中…';
    (async function () {
      var ok = 0; var errors = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          if (f.size > 20 * 1024 * 1024) throw new Error(f.name + ' 超过 20MB');
          var dataUrl = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('读取文件失败')); };
            reader.readAsDataURL(f);
          });
          var r = await fetch(B + '/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dataUrl: dataUrl, note: f.name })
          });
          var d = await r.json();
          if (!d.ok) throw new Error(d.error || '导入失败');
          ok++;
        } catch (e) { errors.push(String(e && e.message ? e.message : e)); }
      }
      window.alert('导入完成：成功 ' + ok + ' 张' + (errors.length ? String.fromCharCode(10, 10) + '失败：' + errors.slice(0, 3).join('；') : ''));
      load(true);
      loadStats();
    })().finally(function () {
      btn.disabled = false; btn.textContent = '导入';
      importFile.value = '';
    });
  };

  function renderHud(items) {
    hudList.innerHTML = '';
    if (!items || !items.length) {
      hudList.textContent = '还没有窗口特写档案。';
      return;
    }
    items.forEach(function (p) {
      var row = document.createElement('div'); row.className = 'hudItem';
      var text = document.createElement('span'); text.className = 'grow';
      var r = p.region || {};
      text.textContent = p.window + ' · ' + (r.w || 0) + 'x' + (r.h || 0) + '@' + (r.x || 0) + ',' + (r.y || 0) + ' · ' + (p.place || 'corner');
      var del = document.createElement('button'); del.textContent = '删除';
      del.onclick = function () {
        if (!window.confirm('删除「' + p.window + '」的特写档案？')) return;
        fetch(B + '/hud', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ window: p.window, clear: true })
        }).then(function (r) { return r.json() }).then(function (d) {
          if (!d.ok) throw new Error(d.error || '删除失败');
          loadHud();
        }).catch(function (e) { window.alert('删除失败：' + (e && e.message ? e.message : e)); });
      };
      row.appendChild(text); row.appendChild(del); hudList.appendChild(row);
    });
  }

  function loadHud() {
    fetch(B + '/hud', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '读取特写档案失败');
      renderHud(d.items || []);
    }).catch(function (e) {
      hudList.textContent = String(e && e.message ? e.message : e);
    });
  }

  hudBtn.onclick = function () { hudOv.classList.add('on'); loadHud(); };
  document.getElementById('hudClose').onclick = function () { hudOv.classList.remove('on'); };
  hudOv.onclick = function (e) { if (e.target === hudOv) hudOv.classList.remove('on'); };
  document.getElementById('hudSave').onclick = function () {
    var windowTitle = document.getElementById('hudWindow').value.trim();
    var region = {
      x: Number(document.getElementById('hudX').value) || 0,
      y: Number(document.getElementById('hudY').value) || 0,
      w: Number(document.getElementById('hudW').value) || 0,
      h: Number(document.getElementById('hudH').value) || 0
    };
    if (!windowTitle) { window.alert('需要窗口标题'); return; }
    if (region.w < 1 || region.h < 1) { window.alert('w/h 必须大于 0'); return; }
    var btn = this; btn.disabled = true; btn.textContent = '保存中…';
    fetch(B + '/hud', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: windowTitle, region: region, place: document.getElementById('hudPlace').value })
    }).then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '保存失败');
      loadHud();
    }).catch(function (e) {
      window.alert('保存特写失败：' + (e && e.message ? e.message : e));
    }).finally(function () { btn.disabled = false; btn.textContent = '保存'; });
  };

  cleanupBtn.onclick = function () { cleanupOv.classList.add('on'); cleanupResult.textContent = ''; };
  document.getElementById('cleanupClose').onclick = function () { cleanupOv.classList.remove('on'); };
  cleanupOv.onclick = function (e) { if (e.target === cleanupOv) cleanupOv.classList.remove('on'); };
  function runCleanup(dryRun) {
    var archiveDays = Number(document.getElementById('archiveDays').value) || 30;
    var trashDays = Number(document.getElementById('trashDays').value) || 7;
    var purgeTrash = document.getElementById('purgeTrash').checked;
    if (!dryRun) {
      var msg = '确定执行存储清理吗？' + String.fromCharCode(10, 10) + '会归档超过 ' + archiveDays + ' 天的活跃图' + (purgeTrash ? '，并物理删除回收站里超过 ' + trashDays + ' 天的图（不可恢复）' : '；回收站暂不物理清理') + '。';
      if (!window.confirm(msg)) return;
    }
    var btn = dryRun ? document.getElementById('cleanupPreview') : document.getElementById('cleanupRun');
    btn.disabled = true; cleanupResult.textContent = '处理中…';
    fetch(B + '/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: dryRun, archiveAfterDays: archiveDays, trashAfterDays: trashDays, purgeTrash: purgeTrash })
    }).then(function (r) { return r.json() }).then(function (d) {
      cleanupResult.textContent = d.ok ? d.text : ('失败：' + (d.error || '未知'));
      if (d.ok && !dryRun) { load(true); loadStats(); }
    }).catch(function (e) {
      cleanupResult.textContent = '失败：' + (e && e.message ? e.message : e);
    }).finally(function () { btn.disabled = false; });
  }
  document.getElementById('cleanupPreview').onclick = function () { runCleanup(true); };
  document.getElementById('cleanupRun').onclick = function () { runCleanup(false); };

  document.getElementById('help').onclick = function(){var b=document.getElementById('helpBox');b.style.display=b.style.display==='none'?'block':'none'};
  document.getElementById('refresh').onclick = function () { load(true); loadStats(); };
  more.onclick = function () { load(false); };
  qEl.oninput = function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { query = qEl.value.trim(); load(true); }, 300);
  };
  qEl.onkeydown = function (e) {
    if (e.key === 'Enter') { clearTimeout(qTimer); query = qEl.value.trim(); load(true); }
  };
  stateEl.onchange = function () { stateFilter = stateEl.value; load(true); };

  document.getElementById('ask').onclick = function () {
    if (!cur) return;
    var btn = this; btn.disabled = true; btn.textContent = '正在看…';
    eye.style.display = 'block'; eye.textContent = '（请求中）';
    fetch(B + '/ask?id=' + cur.id, { method: 'POST' }).then(function (r) { return r.json() }).then(function (d) {
      eye.textContent = d.ok ? d.text : ('失败：' + (d.error || '未知'));
    }).catch(function (e) { eye.textContent = '失败：' + e; }).finally(function () {
      btn.disabled = false; btn.textContent = '让 AI 看这张';
    });
  };

  load();
  loadStats();
})();
</script>
</body></html>`
