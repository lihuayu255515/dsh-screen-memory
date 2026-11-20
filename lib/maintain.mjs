/**
 * lib/maintain.mjs —— 分层仓库的整理动作
 *
 *   hot      → 归档：超过 N 天没被看过的，打成 tar.gz 放到 archive/，原图从 blobs 删掉（省空间）
 *   归档     → 恢复：screen_get 时按需从 tar.gz 解出来
 *   trashed  → 删除：进回收站 7 天后物理删除
 *
 * 用系统自带 tar（Windows 10+ 自带 bsdtar，macOS/Linux 都有），不引入依赖。
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { run } from './capture.mjs'

export async function makeArchive({ dataDir, ids, paths, tag }) {
  const archiveDir = join(dataDir, 'archive')
  mkdirSync(archiveDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '').slice(0, 14)
  const file = join(archiveDir, `screen-${stamp}-${tag || 'b'}.tar.gz`)
  // 把图片临时拷到同一个目录再打包（避免 tar 路径含盘符）
  const stage = join(dataDir, `_stage-${Date.now()}`)
  mkdirSync(stage, { recursive: true })
  const { copyFileSync } = await import('node:fs')
  for (const p of paths) {
    try { copyFileSync(p, join(stage, basename(p))) } catch {}
  }
  const r = await run('tar', ['-czf', file, '-C', stage, '.'], 120000)
  try { rmSync(stage, { recursive: true, force: true }) } catch {}
  if (r.code !== 0 || !existsSync(file)) {
    return { ok: false, err: 'tar 打包失败：' + (r.err || r.out || '').slice(0, 200) }
  }
  return { ok: true, file, bytes: statSync(file).size, count: paths.length }
}

/**
 * 是否该跑一次定时归档（纯函数，便于测试）
 * @param {object} cfg { enabled, hour, intervalDays }
 * @param {number} lastAt 上次归档时间戳（0=从没跑过）
 * @param {number} now
 */
export function shouldRunMaintain(cfg, lastAt, now = Date.now()) {
  if (!cfg || cfg.enabled === false) return false
  const hour = Math.max(0, Math.min(23, Number.isFinite(Number(cfg.hour)) ? Number(cfg.hour) : 22))
  const d = new Date(now)
  if (d.getHours() < hour) return false
  const intervalDays = Math.max(1, Math.min(365, Number.isFinite(Number(cfg.intervalDays)) ? Number(cfg.intervalDays) : 3))
  if (lastAt && now - Number(lastAt) < intervalDays * 86400 * 1000) return false
  return true
}

/** 从候选里挑最早的一批（每批最多 batch 张） */
export function pickDueForArchive(items, archiveAfterDays, batch, now = Date.now()) {
  const days = Number.isFinite(Number(archiveAfterDays)) ? Number(archiveAfterDays) : 30
  const cut = now - Math.max(0, days) * 86400 * 1000
  return (items || [])
    .filter((r) => (r.state || 'hot') === 'hot' && Number(r.created_at || 0) < cut)
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .slice(0, Math.max(1, Math.min(500, Number(batch) || 10)))
}

export async function restoreFromArchive({ dataDir, file, destDir }) {
  if (!existsSync(file)) return { ok: false, err: '归档文件不存在：' + file }
  mkdirSync(destDir, { recursive: true })
  const r = await run('tar', ['-xzf', file, '-C', destDir], 120000)
  if (r.code !== 0) return { ok: false, err: '解包失败：' + (r.err || r.out || '').slice(0, 200) }
  return { ok: true }
}
