/**
 * lib/webui.mjs —— 仓库 UI（右侧栏面板 / 独立页面共用）
 *
 * 设计约束（M1.6）：
 *   · 浏览：GET 列表/缩略图/原图/统计
 *   · 写操作：让 AI 看这张（视觉 API）、单张移入回收站（需前端二次确认）、改备注、从回收站恢复
 *   · 只展示/操作屏幕截图（source LIKE 'screen%'）
 *   · 不提供永久删除；回收站由 screen_maintain 在 7 天后清理
 *   · 不改动任何已有工具/存储逻辑；外部依赖由 index.js 传入（store / describeById）
 *   · webServer 不存在时（例如测试环境）整体跳过，绝不抛
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './capture.mjs'

export const UI_PATH = '/dsh-screen-memory/ui'
export const API_BASE = '/dsh-screen-memory/api'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(res, code, obj) {
  res.writeHead(code, JSON_HEADERS)
  res.end(JSON.stringify(obj))
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
 * @param {object} deps { store, dataDir, log, visionCfg, visionUsage, describeById }
 */
export function attachWebUI(ctx, deps) {
  const { store, dataDir, log, visionCfg, visionUsage, describeById } = deps || {}
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
    const state = String(q.get('state') || '').trim() || null
    const page = store.page({ limit, offset, query, state, sourceLike: 'screen%' })
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

  // 缩略图：按需生成并缓存
  route(`${API_BASE}/thumb`, async (req, res) => {
    const id = Number(queryOf(req).get('id'))
    const rec = id ? store.get(id) : null
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    const cached = join(thumbsDir, String(id) + '.jpg')
    if (existsSync(cached) && statSync(cached).size > 0) return sendImage(res, cached, 'image/jpeg')
    try {
      const src = store.readBlob(rec.sha256)
      const tmp = join(thumbsDir, String(id) + '.tmp.jpg')
      const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src === undefined ? '' : store.blobPath(rec.sha256), '-vf', 'scale=320:-2', '-q:v', '5', '-y', tmp], 20000)
      if (r.code === 0 && existsSync(tmp)) {
        try { /* rename */ } catch {}
        return sendImage(res, tmp, 'image/jpeg')
      }
      // 没 ffmpeg：退回原图（浏览器缩放）
      return sendImage(res, store.blobPath(rec.sha256), rec.mime || 'image/jpeg')
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message) })
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

  // 从回收站恢复到活跃：只允许屏幕截图，恢复后重新进入 review 范围
  route(`${API_BASE}/restore`, async (req, res) => {
    if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    const id = Number(queryOf(req).get('id'))
    if (!id) return sendJson(res, 400, { ok: false, error: '需要 id' })
    const rec = store.get(id)
    if (!rec) return sendJson(res, 404, { ok: false, error: '没有这张图' })
    if (!String(rec.source || '').startsWith('screen')) {
      return sendJson(res, 403, { ok: false, error: '只能恢复屏幕截图' })
    }
    if (rec.state !== 'trashed') return sendJson(res, 409, { ok: false, error: '这张图不在回收站' })
    const ok = store.update(id, { state: 'hot', judged: 0, judged_at: 0 })
    if (!ok) return sendJson(res, 500, { ok: false, error: '恢复失败' })
    try { log && log('UI 从回收站恢复：#' + id) } catch {}
    return sendJson(res, 200, { ok: true, id, state: 'hot' })
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
  header { position:sticky; top:0; background:var(--bg); padding:10px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; z-index:2; }
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
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; cursor:pointer; }
  .card img { display:block; width:100%; aspect-ratio:16/10; object-fit:cover; background:#000; }
  .meta { padding:5px 7px; font-size:11px; color:var(--dim); display:flex; justify-content:space-between; gap:4px; }
  .empty { padding:40px 12px; text-align:center; color:var(--dim); }
  .overlay { position:fixed; inset:0; background:#000a; display:none; align-items:center; justify-content:center; z-index:9; }
  .overlay.on { display:flex; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; max-width:94vw; max-height:92vh; overflow:auto; width:min(1100px,94vw); }
  .panel img { width:100%; display:block; background:#000; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border-top:1px solid var(--line); }
  .bar .sp { flex:1; }
  .noteEdit { display:flex; gap:8px; align-items:center; padding:10px; border-top:1px solid var(--line); }
  .noteEdit input { flex:1; width:auto; }
  .dim { color:var(--dim); font-size:12px; }
  pre#eye { white-space:pre-wrap; margin:0; padding:10px; border-top:1px solid var(--line); font:12px/1.6 inherit; display:none; }
  footer { padding:4px 12px 14px; color:var(--dim); font-size:11px; }
</style></head><body>
<header>
  <h1>屏幕记忆 <span id="count" class="dim"></span></h1>
  <input id="q" type="search" placeholder="搜索备注 / 来源 / 编号" autocomplete="off">
  <select id="state" title="按状态筛选">
    <option value="">全部状态</option>
    <option value="hot">活跃</option>
    <option value="archived">已归档</option>
    <option value="trashed">回收站</option>
  </select>
  <button id="refresh">刷新</button>
  <button id="help">这是什么？</button>
</header>
<div id="notice" style="padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap">
  <span>浏览 + 备注 + 回收站/恢复 · 只显示屏幕截图 · 不占对话上下文</span><span id="eyeNotice"></span>
</div>
<div id="helpBox" style="display:none;padding:12px;border-bottom:1px solid var(--line);font-size:12px;line-height:1.8">
  <b>这是什么</b>：DSH 屏幕记忆插件截过的屏幕图。<br>
  <b>能做什么</b>：浏览缩略图、看原图、按备注/来源/编号搜索、按状态筛选、加载更多、编辑单张备注、让视觉模型描述某一张；单张图可移入回收站（会二次确认），回收站里的图可恢复。<br>
  <b>不能做什么</b>：永久删除、判断留/删、归档、设置特写（这些用工具做；回收站 7 天后由定时归档物理删除，移入前会确认）。<br>
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
  <div class="bar">
    <span id="info" class="dim"></span><span class="sp"></span>
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
  var noteInput = document.getElementById('noteInput');
  var saveNoteBtn = document.getElementById('saveNote');
  var qEl = document.getElementById('q');
  var stateEl = document.getElementById('state');
  var more = document.getElementById('more');
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

  function makeCard(it) {
    var c = document.createElement('div'); c.className = 'card';
    var img = document.createElement('img');
    img.loading = 'lazy'; img.src = B + '/thumb?id=' + it.id; img.alt = '#' + it.id;
    var m = document.createElement('div'); m.className = 'meta';
    var left = document.createElement('span'); left.textContent = '#' + it.id;
    var right = document.createElement('span'); right.textContent = it.time || '';
    m.appendChild(left); m.appendChild(right);
    var badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = stateLabel(it.state);
    m.appendChild(badge);
    c.appendChild(img); c.appendChild(m);
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
    full.src = B + '/full?id=' + it.id;
    var bits = ['#' + it.id, it.width + 'x' + it.height, (it.bytes / 1024).toFixed(0) + ' KB', it.time || '', stateLabel(it.state)];
    if (it.note) bits.push(it.note);
    info.textContent = bits.join(' · ');
    noteInput.value = it.note || '';
    restoreBtn.style.display = it.state === 'trashed' ? '' : 'none';
    trashBtn.disabled = it.state === 'trashed';
    trashBtn.textContent = it.state === 'trashed' ? '已在回收站' : '移到回收站';
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
    if (!cur || cur.state !== 'trashed') return;
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
