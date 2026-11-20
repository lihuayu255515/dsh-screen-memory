/**
 * scripts/verify.mjs —— 一键验收
 *
 * 输出：每条检查 PASS / FAIL / SKIP（附原因），最后给 PASS/FAIL 汇总
 * 退出码：0 = 没有 FAIL；1 = 有 FAIL；2 = 环境完全无法运行
 * 参数：--json（只输出 JSON）、--keep（保留临时目录）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'

const PKG = new URL('../lib/index.js', import.meta.url).href
const JSON_ONLY = process.argv.includes('--json')
const KEEP = process.argv.includes('--keep')
const DO_VISION = process.argv.includes('--vision')

const results = []
function rec(name, status, detail = '', hint = '') {
  results.push({ name, status, detail: String(detail || '').slice(0, 300), hint: String(hint || '').slice(0, 300) })
  if (!JSON_ONLY) {
    const mark = status === 'PASS' ? '✓ PASS' : status === 'FAIL' ? '✗ FAIL' : '· SKIP'
    console.log(`  ${mark}  ${name}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`)
  }
}
function pass(n, d) { rec(n, 'PASS', d) }
function fail(n, d, h) { rec(n, 'FAIL', d, h) }
function skip(n, d, h) { rec(n, 'SKIP', d, h) }

const tmp = mkdtempSync(join(tmpdir(), 'dsm-verify-'))
let store = null

try {
  // ---------- 1. 环境 ----------
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 22) pass('node 版本', process.version)
  else if (major >= 18) skip('node 版本', process.version + '（<22，将用 JSON 索引）', '影响不大；想用 SQLite 索引就升级 DSH（它自带 Node）')
  else { fail('node 版本', process.version + '（需要 ≥18）'); }

  if (process.platform === 'win32') pass('平台', 'win32')
  else skip('平台', process.platform + '（截图仅 Windows）', '仓库/眼睛对已有图片仍可用；截图需 Windows')

  // ---------- 1.4 插件版本与 package.json 一致 ----------
  try {
    const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    // 等 screen_status 拿到实际版本后再比，这里先记下来
    globalThis.__expectedVersion = pkgJson.version
  } catch { /* 忽略 */ }

  // ---------- 1.5 PowerShell 脚本编码（Windows PowerShell 需要 UTF-8 BOM）----------
  try {
    const psFiles = ['scripts/capture.ps1', 'rollback.ps1']
    const noBom = psFiles.filter((rel) => {
      try {
        const buf = readFileSync(new URL('../' + rel, import.meta.url))
        return !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      } catch { return true }
    })
    if (!noBom.length) pass('PowerShell 编码', '两个脚本都有 UTF-8 BOM')
    else fail('PowerShell 编码', '缺 BOM（PS 会乱码报错）：' + noBom.join(', '), '用 UTF-8 with BOM 保存这些文件')
  } catch (e) {
    fail('PowerShell 编码', (e && e.message) || String(e))
  }

  // ---------- 2. 插件加载与工具注册 ----------
  const registered = []
  const mod = await import(PKG)
  mod.apply({ tools: { register(t) { registered.push(t); return () => {} } } }, { dataDir: tmp })
  await new Promise((r) => setTimeout(r, 1500))
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  const want = ['screen_status', 'screen_look', 'screen_archive', 'screen_list', 'screen_get',
    'screen_hud', 'screen_describe', 'screen_review', 'screen_judge', 'screen_maintain', 'screen_search']
  const missing = want.filter((n) => !byName[n])
  if (!missing.length) pass('工具注册', registered.length + ' 个')
  else fail('工具注册', '缺少：' + missing.join(', '))

  if (!byName.screen_status) throw new Error('screen_status 未注册，无法继续')

  // ---------- 3. 状态 ----------
  const st = await byName.screen_status.execute({}, {})
  if (st.ok && st.version) pass('screen_status', 'version=' + st.version + ' capture=' + (st.capture && st.capture.chosen))
  else fail('screen_status', JSON.stringify(st).slice(0, 120))
  if (st.setup && typeof st.setup.ready === 'boolean' && Array.isArray(st.setup.missing) && st.setup.hints && st.setup.hints.vision) {
    pass('setup 引导', 'missing=' + (st.setup.missing.join(',') || '无'))
  } else {
    fail('setup 引导', 'screen_status.setup 缺少 ready/missing/hints', '检查 buildSetup()')
  }
  try {
    const expect = globalThis.__expectedVersion
    if (!expect) skip('版本一致', '拿不到 package.json 版本')
    else if (String(st.version) === String(expect)) pass('版本一致', 'v' + st.version)
    else fail('版本一致', `代码 ${st.version} ≠ package.json ${expect}`, '统一版本号后重新打包')
  } catch (e) { fail('版本一致', (e && e.message) || String(e)) }

  // 所有工具的 render 都不能返回空（否则界面上是空白结果）
  try {
    const bad = []
    for (const t of registered) {
      if (!t.output || typeof t.output.render !== 'function') { bad.push(t.name + '(无 render)'); continue }
      const rendered = t.output.render({}, { ok: true, demo: 1 })
      const txt = Array.isArray(rendered)
        ? rendered.map((b) => String((b && b.text) || '')).join('')
        : String(rendered || '')
      if (!txt.trim()) bad.push(t.name)
    }
    if (!bad.length) pass('render 非空', registered.length + ' 个工具都能渲染')
    else fail('render 非空', '空渲染：' + bad.join(', '))
  } catch (e) {
    fail('render 非空', (e && e.message) || String(e))
  }

  const backend = st.capture && st.capture.chosen
  const hasFfmpeg = !!(st.capture && st.capture.ffmpeg && st.capture.ffmpeg.ok)
  const visionOn = !!(st.vision && st.vision.configured)

  // ---------- 4. 整屏截图 ----------
  let lastId = null
  if (backend) {
    const t0 = Date.now()
    const r = await byName.screen_look.execute({ note: 'verify-full' }, {})
    const ms = Date.now() - t0
    if (r.ok && r.id && r.width > 0 && r.height > 0) {
      lastId = r.id
      pass('整屏截图', `${r.width}x${r.height} ${ms}ms #${r.id}`)
      if (ms > 8000) skip('截图延迟', ms + 'ms（超过 8s）', '全屏独占游戏/远程桌面会拖慢；改无边框窗口再试')
      else pass('截图延迟', ms + 'ms')
    } else {
      fail('整屏截图', r.error || '返回不完整')
    }
  } else {
    skip('整屏截图', '没有可用截图后端', 'Windows 需要 PowerShell；或安装 ffmpeg（README 11.1）')
  }

  // ---------- 5. 按窗口截图 ----------
  if (process.platform === 'win32' && (hasFfmpeg || backend === 'powershell')) {
    let titles = []
    try {
      const prefer = ['Edge', 'Chrome', 'Terminal', 'cmd', 'Notepad', 'Code', 'Word']
      const all = execSync(
        'powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 3 } | Select-Object -ExpandProperty MainWindowTitle"',
        { encoding: 'utf8', timeout: 15000 }).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      titles = [...all.filter((t) => prefer.some((k) => t.includes(k))), ...all.filter((t) => !prefer.some((k) => t.includes(k)))]
    } catch {}
    if (!titles.length) {
      skip('按窗口截图', '找不到带标题的窗口', '先打开一个普通窗口（不要最小化）再跑一次')
    } else {
      let lastError = ''
      let passed = false
      // 可能第一个候选是最小化窗口；逐个试到可见窗口
      for (const title of titles.slice(0, 8)) {
        const r = await byName.screen_look.execute({ window: title, note: 'verify-window' }, {})
        if (r.ok && r.width >= 32 && r.height >= 32) {
          pass('按窗口截图', `#${r.id} ${r.width}x${r.height}`)
          passed = true
          break
        }
        lastError = r.ok ? `返回 ${r.width}x${r.height}，疑似窗口最小化/移出屏幕` : r.error
      }
      if (!passed) skip('按窗口截图', '没有可用的可见窗口', lastError || '候选窗口都不可截取')
    }
  } else {
    skip('按窗口截图', '需要 Windows 截图后端（PowerShell 或 ffmpeg）', '在 Windows 上这通常不会发生；检查 PowerShell 是否可用')
  }

  // ---------- 6. 特写 ----------
  if (hasFfmpeg && backend) {
    const r = await byName.screen_look.execute({ region: { x: 50, y: 50, w: 400, h: 240 }, place: 'strip', note: 'verify-hud' }, {})
    if (r.ok) pass('特写合成', `#${r.id} ${r.width}x${r.height}`)
    else fail('特写合成', r.error)
  } else {
    skip('特写合成', '需要 ffmpeg', '安装 ffmpeg 后重跑（README 11.1：winget install Gyan.FFmpeg）')
  }

  // ---------- 7. 归档 + 去重 ----------
  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const p1 = join(tmp, 'tiny.png')
  writeFileSync(p1, tiny)
  const a1 = await byName.screen_archive.execute({ path: p1, note: 'verify-archive' }, {})
  const a2 = await byName.screen_archive.execute({ path: p1, note: 'verify-archive' }, {})
  if (a1.ok && a2.ok && a1.id === a2.id) pass('归档 + 去重', '#' + a1.id)
  else if (a1.ok) skip('去重', `两次 id 不同：${a1.id} / ${a2.id}`, '内容寻址异常，把这两条日志发我')
  else fail('归档', a1.error)

  // ---------- 8. 回顾 / 判断 ----------
  const rev = await byName.screen_review.execute({ limit: 5 }, {})
  if (rev.ok && /待判断|没有待判断/.test(rev.text || '')) pass('review', (rev.text || '').split('\n')[0].slice(0, 60))
  else fail('review', rev.error || rev.text)

  if (a1.ok) {
    const j = await byName.screen_judge.execute({ id: a1.id, keep: false }, {})
    if (j.ok && /回收站/.test(j.text || '')) pass('judge → 回收站')
    else fail('judge', j.error || j.text)
  } else skip('judge', '没有可判断的图')

  // ---------- 9. 检索 ----------
  const se = await byName.screen_search.execute({ query: 'verify' }, {})
  if (se.ok) pass('search', (se.text || '').split('\n')[0].slice(0, 60))
  else fail('search', se.error)

  // ---------- 10. 整理（归档 + 恢复）----------
  const dry = await byName.screen_maintain.execute({ dryRun: true }, {})
  if (dry.ok && /预演/.test(dry.text || '')) pass('maintain 预演')
  else fail('maintain 预演', dry.error || dry.text)

  const mt = await byName.screen_maintain.execute({ archiveAfterDays: 0, trashAfterDays: 3650 }, {})
  if (mt.ok && /已执行/.test(mt.text || '')) pass('maintain 执行')
  else fail('maintain 执行', mt.error || mt.text)

  const archivedList = await byName.screen_search.execute({ state: 'archived', limit: 5 }, {})
  const archId = (/\#(\d+)/.exec(archivedList.text || '') || [])[1]
  if (archId) {
    const g = await byName.screen_get.execute({ id: Number(archId) }, {})
    if (g.ok && g.path && existsSync(g.path)) pass('归档恢复', '#archId=' + archId)
    else fail('归档恢复', g.error || '路径不存在')
  } else {
    skip('归档恢复', '没有归档的图（可能去重导致）', '先 screen_look 一张，再跑 once')
  }

  // ---------- 11. 预算档位 ----------
  // lean 档：必须不给路径
  const leanTmp = mkdtempSync(join(tmpdir(), 'dsm-verify-lean-'))
  const leanReg = []
  const mod2 = await import(PKG + '?lean=1')
  mod2.apply({ tools: { register(t) { leanReg.push(t); return () => {} } } }, { dataDir: leanTmp, budget: { profile: 'lean' } })
  await new Promise((r) => setTimeout(r, 1200))
  const leanLook = leanReg.find((t) => t.name === 'screen_look')
  if (leanLook && backend) {
    const r = await leanLook.execute({ note: 'verify-lean' }, {})
    if (r.ok && !String(r.text || '').includes('路径：')) pass('lean 档不给路径')
    else fail('lean 档', '仍返回了路径')
  } else skip('lean 档', '没有截图后端或工具未注册', '需要先有截图能力')
  try { rmSync(leanTmp, { recursive: true, force: true }) } catch {}

  // ---------- 12. 眼睛（默认不测：会真的把图片发到视觉 API）----------
  if (!DO_VISION) {
    skip('眼睛', '默认不调用视觉 API（避免验收时外发图片）', '要测眼睛：node scripts/verify.mjs --vision')
  } else if (visionOn) {
    const d = await byName.screen_describe.execute({ question: '这是什么界面' }, {})
    if (d.ok && String(d.text || '').length > 20) pass('眼睛', String(d.text).split('\n')[0].slice(0, 60))
    else fail('眼睛', d.error || '返回太短')
  } else {
    skip('眼睛', '未配置视觉 API', '配 vision.apiKey 或 DSH_VISION_API_KEY（README 11.3）')
  }

  // ---------- 13. 错误处理 ----------
  const g404 = await byName.screen_get.execute({ id: 999999 }, {})
  if (!g404.ok && /没有/.test(g404.error || '')) pass('错误处理', '不存在的 id 返回明确错误')
  else fail('错误处理', '不存在的 id 没有正确报错')
} catch (e) {
  fail('验收脚本', (e && e.message) || String(e))
} finally {
  try { store && store.close && store.close() } catch {}
  if (!KEEP) { try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
  else console.log('  临时目录：' + tmp)
}

// ---------- 汇总 ----------
const passN = results.filter((r) => r.status === 'PASS').length
const failN = results.filter((r) => r.status === 'FAIL').length
const skipN = results.filter((r) => r.status === 'SKIP').length
const skips = results.filter((r) => r.status === 'SKIP')
const fails = results.filter((r) => r.status === 'FAIL')
const summary = { ok: failN === 0, pass: passN, fail: failN, skip: skipN, at: new Date().toISOString(), skips, fails, results }
const outFile = join(process.cwd(), 'verify-report.json')
try { writeFileSync(outFile, JSON.stringify(summary, null, 2)) } catch {}

if (JSON_ONLY) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log('')
  console.log(`  汇总：PASS ${passN} · FAIL ${failN} · SKIP ${skipN}`)
  if (skips.length) {
    console.log('')
    console.log('  跳过项（这些没测到，不代表通过）：')
    for (const s of skips) {
      console.log(`   · ${s.name} — ${s.detail || '原因未记录'}`)
      if (s.hint) console.log(`     解决：${s.hint}`)
    }
  }
  if (fails.length) {
    console.log('')
    console.log('  失败项：')
    for (const f of fails) {
      console.log(`   · ${f.name} — ${f.detail || ''}`)
      if (f.hint) console.log(`     解决：${f.hint}`)
    }
  }
  console.log('')
  console.log(`  报告：${outFile}`)
  console.log(failN === 0
    ? (skips.length ? '  ✅ 验收通过（有跳过项，见上）' : '  ✅ 验收通过')
    : '  ❌ 有失败项，见上面失败项清单')
}
process.exit(failN === 0 ? 0 : 1)
