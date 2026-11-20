/**
 * scripts/doctor.mjs —— 只检查环境，**不改任何配置**
 *
 * 用法：
 *   node scripts/doctor.mjs            # 打印人看的报告
 *   node scripts/doctor.mjs --json     # 打印机器可读 JSON
 */
import { probeBackends, run } from '../lib/capture.mjs'
import { readDeepseekKey } from '../lib/vision.mjs'
import { makeStore } from '../lib/store.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const asJson = process.argv.includes('--json')

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const report = {
  ok: true,
  platform: process.platform,
  node: process.version,
  nodeOk: Number(process.versions.node.split('.')[0]) >= 22,
  dataDir: join(homeDir(), 'storages', 'screen-memory'),
  backends: null,
  store: null,
  vision: null,
  tar: null,
  warnings: [],
}

try {
  report.backends = await probeBackends()
  if (!report.backends.chosen) {
    report.ok = false
    report.warnings.push('没有可用的截图后端（P1 仅支持 Windows PowerShell）')
  }
} catch (e) {
  report.ok = false
  report.warnings.push('后端探测失败：' + (e && e.message))
}

// 可选的眼睛 API：不影响核心安装，但提前告诉用户是不是已经能复用
try {
  const key = readDeepseekKey()
  report.vision = {
    configured: !!key,
    hint: key
      ? ''
      : '未配置眼睛（可选）：复用 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY，或设置 DSH_VISION_API_KEY，或在插件配置填 vision.apiKey。不配也能截图和用仓库。',
  }
  if (!key) report.warnings.push('眼睛未配置（可选）：screen_describe 不可用；截图/仓库不受影响')
} catch (e) {
  report.vision = { configured: false, hint: '检查眼睛配置失败：' + (e && e.message) }
}

// 归档依赖系统 tar；缺了不影响截图，只影响归档/恢复
try {
  const r = await run('tar', ['--version'], 5000)
  report.tar = {
    ok: r.code === 0,
    detail: String(r.out || r.err || '').trim().slice(0, 160),
    hint: r.code === 0
      ? ''
      : '未找到可用的 tar（归档需要）：Windows 10+ 自带；缺失时安装 bsdtar/libarchive，并把 tar 加入 PATH。',
  }
  if (r.code !== 0) report.warnings.push('tar 不可用（只影响归档/恢复，不影响截图和浏览）')
} catch (e) {
  report.tar = { ok: false, detail: String(e && e.message || e), hint: 'tar 探测失败（只影响归档/恢复）' }
}

// 用一个临时目录试建仓库，不碰真实数据
try {
  const tmp = mkdtempSync(join(tmpdir(), 'dsm-doctor-'))
  const store = makeStore(tmp)
  store.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { width: 1, height: 1, source: 'doctor' })
  report.store = { ok: true, backend: store.sqliteOk ? 'sqlite' : 'json', testDir: tmp }
  store.close()
  rmSync(tmp, { recursive: true, force: true })
} catch (e) {
  report.ok = false
  report.store = { ok: false, error: String(e && e.message) }
  report.warnings.push('仓库测试失败：' + (e && e.message))
}

if (!report.nodeOk) {
  report.warnings.push('Node < 22：会退化成 JSON 索引（可用，但图片多了会慢）')
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== dsh-screen-memory doctor ===')
  console.log('平台            :', report.platform)
  console.log('Node            :', report.node, report.nodeOk ? '(OK)' : '(建议 >=22)')
  console.log('数据目录        :', report.dataDir)
  console.log('截图后端        :', report.backends?.chosen || '（无）')
  console.log('  powershell    :', report.backends?.powershell?.ok ? '✓' : '✗')
  console.log('  ffmpeg        :', report.backends?.ffmpeg?.ok ? '✓（特写 / 整屏更快）' : '✗')
  console.log('眼睛 API        :', report.vision?.configured ? '✓（可复用已有 Key）' : '✗（可选，不配也能截图/仓库）')
  console.log('归档 tar        :', report.tar?.ok ? '✓' : '✗（只影响归档/恢复）')
  console.log('仓库自检        :', report.store?.ok ? '✓ (' + report.store.backend + ')' : '✗ ' + (report.store?.error || ''))
  if (!report.vision?.configured && report.vision?.hint) console.log('  眼睛提示      :', report.vision.hint)
  if (!report.tar?.ok && report.tar?.hint) console.log('  tar 提示      :', report.tar.hint)
  if (report.warnings.length) {
    console.log('\n注意：')
    for (const w of report.warnings) console.log('  -', w)
  }
  console.log('\n结论：', report.ok ? '可以安装' : '环境不满足，装了也用不了截图（仓库仍可用）')
}
process.exit(report.ok ? 0 : 1)
