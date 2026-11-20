/**
 * scripts/release-check.mjs —— 发布前回归检查（防止改一个坏另一个）
 *
 * 做 5 件事：
 *   1) 工具 API 快照比对：工具名 / 参数 schema 有没有被意外改动（api-snapshot.json）
 *   2) verify（宿主路径）必须 0 FAIL
 *   3) verify（强制兜底实现）必须 0 FAIL
 *   4) integration-test 退出码 0
 *   5) 静态检查：版本一致 / PowerShell BOM / package.json files 都存在 / 无遗留调试文件
 *
 * 用法：
 *   node scripts/release-check.mjs                # 检查
 *   node scripts/release-check.mjs --update-baseline  # 有意改 API 时更新快照
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP_DATA = join(ROOT, '.tmp-release-check')
const PKG_PATH = join(ROOT, 'package.json')
const SNAP_PATH = join(ROOT, 'api-snapshot.json')
const UPDATE = process.argv.includes('--update-baseline')
const results = []
const rec = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
}

// ---------- 0. 基础信息 ----------
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
console.log(`  发布检查：${pkg.name} v${pkg.version}\n`)

// ---------- 1. API 快照 ----------
let snapshotOk = false
try {
  const reg = []
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  mod.apply({ tools: { register(t) { reg.push(t); return () => {} } } }, { dataDir: TMP_DATA })
  await new Promise((r) => setTimeout(r, 1500))
  const snap = {
    version: pkg.version,
    tools: Object.fromEntries(reg.map((t) => [t.name, { parameters: t.parameters, output: (t.output && t.output.schema) || null }])),
  }
  if (UPDATE || !existsSync(SNAP_PATH)) {
    writeFileSync(SNAP_PATH, JSON.stringify(snap, null, 2))
    rec('API 快照', true, UPDATE ? '已更新基线' : '首次生成基线')
    snapshotOk = true
  } else {
    const old = JSON.parse(readFileSync(SNAP_PATH, 'utf8'))
    const diffs = []
    const oldNames = Object.keys(old.tools || {})
    const newNames = Object.keys(snap.tools)
    for (const n of newNames) if (!oldNames.includes(n)) diffs.push('新增工具 ' + n)
    for (const n of oldNames) if (!newNames.includes(n)) diffs.push('删除工具 ' + n)
    for (const n of newNames) {
      if (!old.tools[n]) continue
      const a = JSON.stringify(old.tools[n].parameters)
      const b = JSON.stringify(snap.tools[n].parameters)
      if (a !== b) diffs.push('参数变化 ' + n)
    }
    if (diffs.length) {
      rec('API 快照', false, diffs.join('; ') + '（确认无意外后用 --update-baseline）')
    } else {
      rec('API 快照', true, newNames.length + ' 个工具与基线一致')
      snapshotOk = true
    }
  }
} catch (e) {
  rec('API 快照', false, (e && e.message) || String(e))
}

// ---------- 2/3. verify 两条路径 ----------
function runVerify(env) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), '--json'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
    })
    const start = out.indexOf('{')
    return JSON.parse(out.slice(start))
  } catch (e) {
    return { ok: false, error: String(e && e.message).slice(0, 300) }
  }
}
const host = runVerify({})
rec('verify（宿主）', host.ok === true && host.fail === 0, host.error || `PASS ${host.pass} / FAIL ${host.fail} / SKIP ${host.skip}`)
const fb = runVerify({ DSM_NO_HOST_TOOLS: '1' })
rec('verify（兜底）', fb.ok === true && fb.fail === 0, fb.error || `PASS ${fb.pass} / FAIL ${fb.fail} / SKIP ${fb.skip}`)

// ---------- 3.4 定时归档测试 ----------
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'schedule-test.mjs')], { encoding: 'utf8', timeout: 5 * 60 * 1000 })
  rec('定时归档逻辑', true, '22:00 / 3 天 / 每批 10 张')
} catch (e) {
  rec('定时归档逻辑', false, String(e && e.message).slice(0, 200))
}

// ---------- 3.5 UI 契约测试 ----------
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'ui-test.mjs')], { encoding: 'utf8', timeout: 10 * 60 * 1000 })
  rec('仓库 UI 契约', true, '路由/列表/缩略图/页面')
} catch (e) {
  rec('仓库 UI 契约', false, String(e && e.message).slice(0, 200))
}

// ---------- 4. 集成测试 ----------
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'integration-test.mjs')], { encoding: 'utf8', timeout: 10 * 60 * 1000 })
  rec('集成测试', true, '11 工具全链路')
} catch (e) {
  rec('集成测试', false, String(e && e.message).slice(0, 200))
}

// ---------- 清理临时产物 ----------
try { rmSync(join(ROOT, 'verify-report.json'), { force: true }) } catch {}
try { rmSync(TMP_DATA, { recursive: true, force: true }) } catch {}

// ---------- 5. 静态检查 ----------
try {
  const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const m = /const VERSION = '([^']+)'/.exec(idx)
  const cap = JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8'))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const testing = readFileSync(join(ROOT, 'TESTING.md'), 'utf8')
  const rm = /版本\s+(\d+\.\d+\.\d+)/.exec(readme)
  const tm = /测试说明[（(]\s*(\d+\.\d+\.\d+)/.exec(testing)
  let snapVer = null
  try { snapVer = JSON.parse(readFileSync(SNAP_PATH, 'utf8')).version } catch {}
  const versions = new Set([pkg.version, m && m[1], cap.version, rm && rm[1], tm && tm[1], snapVer])
  rec('版本一致', versions.size === 1 && versions.has(pkg.version),
    'package ' + pkg.version + ' / index ' + (m && m[1]) + ' / cap ' + cap.version +
    ' / readme ' + (rm && rm[1]) + ' / testing ' + (tm && tm[1]) + ' / snapshot ' + snapVer)
} catch (e) {
  rec('版本一致', false, (e && e.message) || String(e))
}

try {
  const ps = ['scripts/capture.ps1', 'rollback.ps1']
  const bad = ps.filter((rel) => {
    const b = readFileSync(join(ROOT, rel))
    return !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
  })
  rec('PowerShell BOM', bad.length === 0, bad.join(', ') || '两个脚本都有 BOM')
} catch (e) {
  rec('PowerShell BOM', false, (e && e.message) || String(e))
}

try {
  const missing = (pkg.files || []).filter((f) => {
    const p = join(ROOT, f)
    return !existsSync(p)
  })
  rec('package files', missing.length === 0, missing.join(', ') || `${(pkg.files || []).length} 项都存在`)
} catch (e) {
  rec('package files', false, (e && e.message) || String(e))
}

try {
  const junks = readdirSync(ROOT).filter((n) => /^_|\.tmp$|\.bak$/.test(n))
  const real = junks.filter((n) => n !== 'api-snapshot.json' && !n.startsWith('.tmp'))
  rec('无遗留调试文件', real.length === 0, real.join(', ') || '干净')
} catch (e) {
  rec('无遗留调试文件', false, (e && e.message) || String(e))
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok)
console.log('')
if (failed.length) {
  console.log(`  ❌ 发布检查未通过：${failed.length} 项失败`)
  for (const f of failed) console.log(`     · ${f.name} — ${f.detail}`)
  process.exit(1)
}
console.log('  ✅ 发布检查通过（可以打包）')
process.exit(0)
