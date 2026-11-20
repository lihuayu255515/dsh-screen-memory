/**
 * 集成自测（v0.4.0）：9 个工具
 * 覆盖：截图、窗口、特写、归档、眼睛、回顾、判断、整理、检索、预算档位
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(ROOT, 'lib', 'index.js')
const DO_VISION = process.argv.includes('--vision')
const tmp = mkdtempSync(join(tmpdir(), 'dsm-int4-'))
const registered = []
const fakeCtx = { tools: { register(t) { registered.push(t); return () => {} } } }

const mod = await import(pathToFileURL(pkg).href)
await mod.apply(fakeCtx, { dataDir: tmp, budget: { profile: process.env.TEST_PROFILE || 'balanced' } })
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const failures = []
const failIf = (label, r) => { if (!r || r.ok === false) failures.push(label + ': ' + ((r && r.error) || '失败')); return r }
console.log('  工具(' + registered.length + '):', registered.map((t) => t.name).join(', '))

let st = await byName.screen_status.execute({}, {})
failIf('status', st)
console.log('  status:', JSON.stringify({ v: st.version, budget: st.budget, store: st.store && { images: st.store.images, byState: st.store.byState } }))

// 造 3 张图（1 真截图 + 2 小图）
const tiny = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')
for (let i = 1; i <= 2; i++) {
  const p = join(tmp, 'tiny' + i + '.png')
  writeFileSync(p, tiny)
  const r = await byName.screen_archive.execute({ path: p, note: '自测图' + i, source: 'test' }, {})
  failIf('archive' + i, r)
  console.log('  archive' + i + ':', r.ok ? '#' + r.id : r.error)
}
let r = await byName.screen_look.execute({ note: '整屏' }, {})
failIf('look', r)
console.log('  look:', r.ok ? '#' + r.id : r.error)
if (r.ok && !String(r.text || '').includes('路径：')) console.log('     （预算档：未给路径）')

// 回顾 + 判断
r = await byName.screen_review.execute({ limit: 5 }, {})
failIf('review', r)
console.log('  review:', (r.text || r.error || '').split('\n')[0])
r = await byName.screen_judge.execute({ id: 1, keep: false }, {})
failIf('judge(trash)', r)
console.log('  judge(trash):', (r.text || r.error || '').slice(0, 60))
r = await byName.screen_judge.execute({ id: 2, keep: true }, {})
failIf('judge(keep)', r)
console.log('  judge(keep):', (r.text || r.error || '').slice(0, 60))

// 检索
r = await byName.screen_search.execute({ query: '自测图' }, {})
failIf('search', r)
console.log('  search:', (r.text || r.error || '').split('\n')[0])

// 整理（预演 → 用 0 天强制归档）
r = await byName.screen_maintain.execute({ dryRun: true }, {})
failIf('maintain(dry)', r)
console.log('  maintain(dry):', (r.text || r.error || '').split('\n').slice(0, 2).join(' | '))
r = await byName.screen_maintain.execute({ archiveAfterDays: 0, trashAfterDays: 0 }, {})
failIf('maintain(exec)', r)
console.log('  maintain(exec):', (r.text || r.error || '').split('\n').slice(0, 4).join(' | '))

st = await byName.screen_status.execute({}, {})
console.log('  after maintain:', JSON.stringify({ images: st.store.images, byState: st.store.byState, archives: st.store.archives }))

// 取回归档的图（从状态里找 archived 的 id）
st = await byName.screen_status.execute({}, {})
const listArchived = await byName.screen_list.execute({ limit: 10 }, {})
const mId = /#(\d+)\s+\S+\s+\S+\s+\S+\s+\S*/.exec('')
const archivedRow = (await byName.screen_search.execute({ state: 'archived', limit: 5 }, {})).text || ''
const archId = (/#(\d+)/.exec(archivedRow) || [])[1]
if (archId) {
  r = await byName.screen_get.execute({ id: Number(archId) }, {})
  failIf('get(archived)', r)
  console.log('  get(archived→restore):', r.ok ? 'OK ' + (r.text || '').split('\n')[0] : r.error)
} else {
  console.log('  get(archived→restore): 跳过（没有归档的图）')
}

// 眼睛：默认不外发，只有显式 --vision 才调用
if (DO_VISION) {
  r = await byName.screen_describe.execute({ question: '这是什么' }, {})
  console.log('  describe:', r.ok ? String(r.text).split('\n')[0].slice(0, 50) : r.error)
} else {
  console.log('  describe: 跳过（未传 --vision，不外发图片）')
}

st = await byName.screen_status.execute({}, {})
console.log('  预算用量:', JSON.stringify(st.budget && { profile: st.budget.profile, used: st.budget.usedThisHour, perHour: st.budget.imagesPerHour }))

try { rmSync(tmp, { recursive: true, force: true }) } catch {}
if (failures.length) {
  console.error('  ❌ 集成测试失败：' + failures.length + ' 项')
  failures.slice(0, 10).forEach((x) => console.error('    - ' + x))
  process.exit(1)
}
process.exit(0)
