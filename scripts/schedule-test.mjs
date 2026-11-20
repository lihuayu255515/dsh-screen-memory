/**
 * scripts/schedule-test.mjs —— 定时归档的纯函数测试（不启动 DSH、不碰真实数据）
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = 'E:/dsh-screen-memory/dsh-screen-memory'
const { shouldRunMaintain, pickDueForArchive } = await import(pathToFileURL(join(ROOT, 'lib', 'maintain.mjs')).href)

const out = []
const check = (name, ok, detail = '') => {
  out.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
}

const H = 3600 * 1000
const D = 24 * H
const at = (h) => { const d = new Date(2026, 10, 16, h, 0, 0); return d.getTime() }

const cfg = { enabled: true, hour: 22, intervalDays: 3 }
check('22:00 前不跑', shouldRunMaintain(cfg, 0, at(21)) === false)
check('22:00 后跑', shouldRunMaintain(cfg, 0, at(22)) === true)
check('关掉后不跑', shouldRunMaintain({ ...cfg, enabled: false }, 0, at(23)) === false)
check('隔 2 天不跑', shouldRunMaintain(cfg, at(22) - 2 * D, at(22)) === false)
check('隔 3 天跑', shouldRunMaintain(cfg, at(22) - 3 * D - H, at(22)) === true)
check('自定义 1 天：隔 1 天跑', shouldRunMaintain({ ...cfg, intervalDays: 1 }, at(22) - D - H, at(22)) === true)

const now = at(22)
const items = []
for (let i = 0; i < 30; i++) {
  items.push({ id: i + 1, state: 'hot', created_at: now - (31 + i) * D })
}
for (let i = 0; i < 5; i++) items.push({ id: 100 + i, state: 'archived', created_at: now - 40 * D })
const picked = pickDueForArchive(items, 30, 10, now)
check('每批最多 10 张', picked.length === 10, '取到 ' + picked.length)
check('只挑 hot 且够老', picked.every((r) => r.state === 'hot'), '含 archived=' + picked.some((r) => r.state !== 'hot'))
check('按最老优先', picked[0].id === 30 && picked[1].id === 29, '前两张 #' + picked[0].id + ' #' + picked[1].id)

const failed = out.filter((x) => !x.ok)
console.log('')
if (failed.length) {
  console.log('  ❌ 定时归档测试失败：' + failed.length + ' 项')
  process.exit(1)
}
console.log('  ✅ 定时归档测试通过')
