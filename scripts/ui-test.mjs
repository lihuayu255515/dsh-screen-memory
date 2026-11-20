/**
 * scripts/ui-test.mjs —— 仓库 UI 的接口契约测试（不需要启动 DSH）
 *
 * 用假 ctx 捕获路由，再直接调 handler，验证：
 *   · /api/list 只返回屏幕截图（source LIKE screen%）
 *   · /api/thumb、/api/full 能取到图片字节
 *   · /api/stats 结构正确
 *   · /ui 返回 HTML
 *   · 没 webServer 时 attachWebUI 安全跳过
 */
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'E:/dsh-screen-memory/dsh-screen-memory'
const { attachWebUI, API_BASE, UI_PATH } = await import(pathToFileURL(join(ROOT, 'lib', 'webui.mjs')).href)
const { makeStore } = await import(pathToFileURL(join(ROOT, 'lib', 'store.mjs')).href)

const out = []
const check = (name, ok, detail = '') => {
  out.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
}

// 假 store：真 store（临时目录）+ 两张图（一张 screen，一张 qq）
const dir = mkdtempSync(join(tmpdir(), 'dsm-ui-'))
const store = makeStore(dir)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
store.put(png, { width: 1, height: 1, source: 'screen', note: 'screen shot', mime: 'image/png' })
const png2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
store.put(png2, { width: 1, height: 1, source: 'qq', note: 'qq pic', mime: 'image/png' })

// 假 ctx
const routes = new Map()
const fakeCtx = {
  webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
  effect: (fn) => fn(),
}
const attached = attachWebUI(fakeCtx, {
  store,
  dataDir: dir,
  log: () => {},
  visionCfg: { configured: false },
  visionUsage: { used: () => 0 },
  describeById: async () => ({ ok: true, text: 'stub' }),
  archiveById: async (id) => {
    const rec = store.get(id)
    if (!rec) return { ok: false, error: '没有这张图' }
    store.update(id, { state: 'archived', archive_file: 'stub.tar.gz' })
    return { ok: true, id, file: 'stub.tar.gz' }
  },
  restoreById: async (id) => {
    const rec = store.get(id)
    if (!rec) return { ok: false, error: '没有这张图' }
    store.update(id, { state: 'hot', archive_file: null, judged: 0, judged_at: 0 })
    return { ok: true, id, path: 'stub' }
  },
})
check('attachWebUI 注册成功', attached === true, routes.size + ' 条路由')

function fakeReqRes(url, method = 'GET') {
  const res = { code: 0, headers: {}, body: Buffer.alloc(0), writeHead(c, h) { this.code = c; this.headers = h || {} }, end(b) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(String(b || '')) } }
  return [ { url, method }, res ]
}

const [reqL, resL] = fakeReqRes(API_BASE + '/list?limit=10')
await routes.get(API_BASE + '/list')(reqL, resL)
const list = JSON.parse(resL.body.toString('utf8'))
check('list 200 且只含屏幕截图', resL.code === 200 && list.ok && list.items.length === 1 && list.items[0].note === 'screen shot', JSON.stringify(list.items.map((x) => x.note)))
check('list 带 source 字段', list.items.length === 1 && list.items[0].source === 'screen')

const [reqQ, resQ] = fakeReqRes(API_BASE + '/list?limit=10&q=screen')
await routes.get(API_BASE + '/list')(reqQ, resQ)
const listQ = JSON.parse(resQ.body.toString('utf8'))
check('list 可按来源搜索', listQ.ok && listQ.total === 1 && listQ.items.length === 1)

const [reqZ, resZ] = fakeReqRes(API_BASE + '/list?limit=10&state=trashed')
await routes.get(API_BASE + '/list')(reqZ, resZ)
const listZ = JSON.parse(resZ.body.toString('utf8'))
check('list 可按状态筛选', listZ.ok && listZ.total === 0 && listZ.items.length === 0)

const [reqS, resS] = fakeReqRes(API_BASE + '/stats')
await routes.get(API_BASE + '/stats')(reqS, resS)
const stats = JSON.parse(resS.body.toString('utf8'))
check('stats 结构', stats.ok && stats.store && typeof stats.vision.usedToday === 'number')

const [reqT, resT] = fakeReqRes(API_BASE + '/thumb?id=1')
await routes.get(API_BASE + '/thumb')(reqT, resT)
check('thumb 返回图片', resT.code === 200 && resT.body.length > 100 && String(resT.headers['content-type']).startsWith('image/'), resT.body.length + ' bytes')

const [reqF, resF] = fakeReqRes(API_BASE + '/full?id=1')
await routes.get(API_BASE + '/full')(reqF, resF)
check('full 返回原图', resF.code === 200 && resF.body.equals(png))

const [reqU, resU] = fakeReqRes(UI_PATH)
await routes.get(UI_PATH)(reqU, resU)
const uiHtml = resU.body.toString('utf8')
check('UI 页面', resU.code === 200 && uiHtml.includes('屏幕记忆'))
check('UI 含搜索/筛选/分页控件', uiHtml.includes('id="q"') && uiHtml.includes('id="state"') && uiHtml.includes('id="more"'))
check('UI 含回收站按钮和确认提示', uiHtml.includes('id="trash"') && uiHtml.includes('window.confirm('))
check('UI 含备注编辑和恢复按钮', uiHtml.includes('id="noteInput"') && uiHtml.includes('id="saveNote"') && uiHtml.includes('id="restore"'))
check('UI 含待判断筛选与保留/不要按钮', uiHtml.includes('value="review"') && uiHtml.includes('id="keep"') && uiHtml.includes('id="discard"'))
check('UI 含归档按钮与归档占位', uiHtml.includes('id="archive"') && uiHtml.includes('id="archivedNote"'))
try {
  const script = uiHtml.match(/<script>([\s\S]*)<\/script>/)
  if (!script) throw new Error('没有找到内联脚本')
  new Function(script[1])
  check('UI 内联脚本语法', true)
} catch (e) {
  check('UI 内联脚本语法', false, String(e && e.message))
}

const [reqA, resA] = fakeReqRes(API_BASE + '/ask?id=1', 'POST')
await routes.get(API_BASE + '/ask')(reqA, resA)
const ask = JSON.parse(resA.body.toString('utf8'))
check('ask 未配置 Key 时被拒绝', ask.ok === false && /没有配置视觉 API/.test(ask.error || ''))

const [reqD, resD] = fakeReqRes(API_BASE + '/trash?id=1', 'POST')
await routes.get(API_BASE + '/trash')(reqD, resD)
const trash = JSON.parse(resD.body.toString('utf8'))
check('trash 只把屏幕截图移入回收站', trash.ok === true && store.get(1).state === 'trashed')

const [reqD2, resD2] = fakeReqRes(API_BASE + '/trash?id=2', 'POST')
await routes.get(API_BASE + '/trash')(reqD2, resD2)
const trash2 = JSON.parse(resD2.body.toString('utf8'))
check('trash 拒绝非屏幕图片', trash2.ok === false && store.get(2).state === 'hot')

const [reqD3, resD3] = fakeReqRes(API_BASE + '/list?limit=10&state=trashed')
await routes.get(API_BASE + '/list')(reqD3, resD3)
const listTrash = JSON.parse(resD3.body.toString('utf8'))
check('回收站筛选可见', listTrash.ok && listTrash.total === 1 && listTrash.items[0].id === 1)

const [reqN, resN] = fakeReqRes(API_BASE + '/note?id=1', 'POST')
reqN.body = JSON.stringify({ note: '  新的备注  ' })
await routes.get(API_BASE + '/note')(reqN, resN)
const note = JSON.parse(resN.body.toString('utf8'))
check('备注可保存并 trim', note.ok === true && note.note === '新的备注' && store.get(1).note === '新的备注')

const [reqN2, resN2] = fakeReqRes(API_BASE + '/note?id=2', 'POST')
reqN2.body = JSON.stringify({ note: '不该写进去' })
await routes.get(API_BASE + '/note')(reqN2, resN2)
const note2 = JSON.parse(resN2.body.toString('utf8'))
check('备注拒绝非屏幕图片', note2.ok === false && store.get(2).note === 'qq pic')

const [reqR, resR] = fakeReqRes(API_BASE + '/restore?id=1', 'POST')
await routes.get(API_BASE + '/restore')(reqR, resR)
const restored = JSON.parse(resR.body.toString('utf8'))
check('回收站可恢复为活跃', restored.ok === true && store.get(1).state === 'hot')

const [reqR2, resR2] = fakeReqRes(API_BASE + '/restore?id=2', 'POST')
await routes.get(API_BASE + '/restore')(reqR2, resR2)
const restored2 = JSON.parse(resR2.body.toString('utf8'))
check('恢复拒绝非屏幕图片', restored2.ok === false && store.get(2).state === 'hot')

const [reqRev, resRev] = fakeReqRes(API_BASE + '/list?limit=10&state=review')
await routes.get(API_BASE + '/list')(reqRev, resRev)
const review = JSON.parse(resRev.body.toString('utf8'))
check('待判断筛选只列未判断 hot', review.ok && review.total === 1 && review.items[0].id === 1)

const [reqJ, resJ] = fakeReqRes(API_BASE + '/judge?id=1', 'POST')
reqJ.body = JSON.stringify({ keep: true })
await routes.get(API_BASE + '/judge')(reqJ, resJ)
const judged = JSON.parse(resJ.body.toString('utf8'))
check('judge 保留并标记已判断', judged.ok === true && store.get(1).state === 'hot' && store.get(1).judged === 1)

const [reqRev2, resRev2] = fakeReqRes(API_BASE + '/list?limit=10&state=review')
await routes.get(API_BASE + '/list')(reqRev2, resRev2)
const review2 = JSON.parse(resRev2.body.toString('utf8'))
check('判断后离开待判断列表', review2.ok && review2.total === 0)

const [reqArc, resArc] = fakeReqRes(API_BASE + '/archive?id=1', 'POST')
await routes.get(API_BASE + '/archive')(reqArc, resArc)
const archived = JSON.parse(resArc.body.toString('utf8'))
check('archive 把活跃图归档', archived.ok === true && store.get(1).state === 'archived' && store.get(1).archive_file === 'stub.tar.gz')

const [reqAR, resAR] = fakeReqRes(API_BASE + '/restore?id=1', 'POST')
await routes.get(API_BASE + '/restore')(reqAR, resAR)
const archivedRestored = JSON.parse(resAR.body.toString('utf8'))
check('archive 可从归档恢复', archivedRestored.ok === true && store.get(1).state === 'hot' && store.get(1).judged === 0)

const [reqJ2, resJ2] = fakeReqRes(API_BASE + '/judge?id=1', 'POST')
reqJ2.body = JSON.stringify({ keep: false })
await routes.get(API_BASE + '/judge')(reqJ2, resJ2)
const judged2 = JSON.parse(resJ2.body.toString('utf8'))
check('judge 不要时移入回收站', judged2.ok === true && store.get(1).state === 'trashed' && store.get(1).judged === 1)

// 没有 webServer 时必须安全跳过
check('无 webServer 安全跳过', attachWebUI({ effect: (f) => f() }, { store, dataDir: dir, log: () => {} }) === false)

try { store.close() } catch {}
const failed = out.filter((x) => !x.ok)
console.log('')
if (failed.length) {
  console.log('  ❌ UI 契约测试失败：' + failed.length + ' 项')
  process.exit(1)
}
console.log('  ✅ UI 契约测试通过')
