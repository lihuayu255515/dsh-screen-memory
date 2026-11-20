/**
 * scripts/doctor.mjs —— 只检查环境，**不改任何配置**
 *
 * 用法：
 *   node scripts/doctor.mjs            # 打印人看的报告
 *   node scripts/doctor.mjs --json     # 打印机器可读 JSON
 */
import { probeBackends } from '../lib/capture.mjs'
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
  console.log('仓库自检        :', report.store?.ok ? '✓ (' + report.store.backend + ')' : '✗ ' + (report.store?.error || ''))
  if (report.warnings.length) {
    console.log('\n注意：')
    for (const w of report.warnings) console.log('  -', w)
  }
  console.log('\n结论：', report.ok ? '可以安装' : '环境不满足，装了也用不了截图（仓库仍可用）')
}
process.exit(report.ok ? 0 : 1)
