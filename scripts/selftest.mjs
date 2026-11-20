/**
 * 独立自测：截图 → 入库 → 列出（不依赖 DSH）
 */
import { capture } from '../lib/capture.mjs'
import { makeStore } from '../lib/store.mjs'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'dsm-selftest-'))
const store = makeStore(tmp)

console.log('  store backend:', store.sqliteOk ? 'sqlite' : 'json')

const shot = await capture()
if (!shot.ok) {
  console.log('  ✗ 截图失败:', shot.err)
  process.exit(1)
}
console.log('  ✓ 截图:', shot.path, `${Math.round((shot.bytes || 0) / 1024)} KB`, `${shot.width}x${shot.height}`)

const buf = readFileSync(shot.path)
const rec = store.put(buf, { width: shot.width, height: shot.height, source: 'selftest', note: '自测' })
console.log('  ✓ 入库:', JSON.stringify({ id: rec.id, dedup: rec.dedup, path: rec.path }))

const rows = store.list({ limit: 5 })
console.log('  ✓ 列表:', rows.length, '条')
const st = store.stats()
console.log('  ✓ 统计:', JSON.stringify(st))

// 去重测试：再存同一张
const rec2 = store.put(buf, { width: shot.width, height: shot.height, source: 'selftest' })
console.log('  ✓ 去重:', rec2.id === rec.id ? '同一张复用 id' : '新建了 id（异常）')

store.close()
rmSync(shot.path, { force: true })
rmSync(tmp, { recursive: true, force: true })
console.log('  ✓ 自测结束，临时数据已清理')
