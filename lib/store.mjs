/**
 * lib/store.mjs —— 图片仓库（内容寻址 blob + SQLite 索引）
 *
 * 分层（P4）：
 *   state    = hot | archived | trashed
 *   judged   = 0/1（是否已回顾判断）
 *   archives 表记录打包文件
 *
 * 目录结构（默认 ~/.dsh/storages/screen-memory/）：
 *   index.db                     SQLite 索引
 *   blobs/<sha 前2位>/<sha>.<ext> 原图
 *   archive/*.tar.gz             归档包
 *   logs/plugin.log              插件日志
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function makeStore(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'blobs'), { recursive: true })
  mkdirSync(join(dataDir, 'logs'), { recursive: true })
  mkdirSync(join(dataDir, 'archive'), { recursive: true })

  let db = null
  let sqliteOk = false
  try {
    if (process.env.DSM_FORCE_JSON === '1') throw new Error('forced json mode')
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(join(dataDir, 'index.db'))
    db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256     TEXT UNIQUE NOT NULL,
        width      INTEGER,
        height     INTEGER,
        bytes      INTEGER,
        source     TEXT,
        note       TEXT,
        mime       TEXT,
        state      TEXT DEFAULT 'hot',
        judged     INTEGER DEFAULT 0,
        judged_at  INTEGER DEFAULT 0,
        seen_at    INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS archives (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file       TEXT NOT NULL,
        count      INTEGER,
        bytes      INTEGER,
        created_at INTEGER
      );
    `)
    for (const [col, decl] of [
      ['mime', 'TEXT'], ['state', "TEXT DEFAULT 'hot'"], ['judged', 'INTEGER DEFAULT 0'],
      ['judged_at', 'INTEGER DEFAULT 0'], ['seen_at', 'INTEGER DEFAULT 0'],
      ['archive_file', 'TEXT'],
    ]) {
      try { db.exec(`ALTER TABLE images ADD COLUMN ${col} ${decl}`) } catch {}
    }
    sqliteOk = true
  } catch {
    sqliteOk = false
    db = null
  }

  const jsonPath = join(dataDir, 'json-index.json')
  function readJsonIndex() {
    try { return JSON.parse(readFileSync(jsonPath, 'utf8')) } catch { return { nextId: 1, images: [], archives: [] } }
  }
  function writeJsonIndex(idx) {
    const tmp = jsonPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(idx, null, 1))
    renameSync(tmp, jsonPath)
  }

  const blobsDir = join(dataDir, 'blobs')
  function blobPath(sha, ext = null) {
    if (!ext) {
      for (const e of ['jpg', 'png', 'webp']) {
        const p = join(blobsDir, sha.slice(0, 2), sha + '.' + e)
        if (existsSync(p)) return p
      }
      return join(blobsDir, sha.slice(0, 2), sha + '.jpg')
    }
    return join(blobsDir, sha.slice(0, 2), sha + '.' + ext)
  }

  function findBlob(sha) {
    for (const e of ['jpg', 'png', 'webp']) {
      const p = blobPath(sha, e)
      if (existsSync(p)) return p
    }
    return null
  }

  function put(buf, { width = 0, height = 0, source = 'screen', note = '', mime = 'image/png', ext = 'png' } = {}) {
    const sha = createHash('sha256').update(buf).digest('hex')
    const path = blobPath(sha, ext)
    mkdirSync(join(blobsDir, sha.slice(0, 2)), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, buf)
    const now = Date.now()
    if (sqliteOk) {
      const row = db.prepare('SELECT id FROM images WHERE sha256 = ?').get(sha)
      if (row) {
        db.prepare("UPDATE images SET seen_at = ?, state = CASE WHEN state = 'trashed' THEN 'hot' ELSE state END, judged = CASE WHEN state = 'trashed' THEN 0 ELSE judged END, judged_at = CASE WHEN state = 'trashed' THEN 0 ELSE judged_at END WHERE id = ?").run(now, row.id)
        return { id: row.id, sha256: sha, path, dedup: true }
      }
      const info = db.prepare(
        'INSERT INTO images (sha256,width,height,bytes,source,note,mime,state,judged,judged_at,seen_at,created_at) VALUES (?,?,?,?,?,?,?,?,0,0,?,?)'
      ).run(sha, width, height, buf.length, source, note, mime, 'hot', now, now)
      return { id: Number(info.lastInsertRowid), sha256: sha, path, dedup: false }
    }
    const idx = readJsonIndex()
    const hit = idx.images.find((x) => x.sha256 === sha)
    if (hit) {
      hit.seen_at = now
      if (hit.state === 'trashed') { hit.state = 'hot'; hit.judged = 0; hit.judged_at = 0 }
      writeJsonIndex(idx)
      return { id: hit.id, sha256: sha, path, dedup: true }
    }
    const id = idx.nextId++
    idx.images.push({
      id, sha256: sha, width, height, bytes: buf.length, source, note, mime,
      state: 'hot', judged: 0, judged_at: 0, seen_at: now, created_at: now,
    })
    writeJsonIndex(idx)
    return { id, sha256: sha, path, dedup: false }
  }

  function list({ query = '', limit = 20, state = null } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 20))
    if (sqliteOk) {
      const where = []
      const args = []
      if (state) { where.push('state = ?'); args.push(state) }
      if (query) { where.push('(note LIKE ? OR source LIKE ?)'); args.push(`%${query}%`, `%${query}%`) }
      const sql = 'SELECT * FROM images' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
      return db.prepare(sql).all(...args, n)
    }
    const idx = readJsonIndex()
    let arr = idx.images.slice().reverse()
    if (state) arr = arr.filter((x) => (x.state || 'hot') === state)
    if (query) arr = arr.filter((x) => String(x.note || '').includes(query) || String(x.source || '').includes(query))
    return arr.slice(0, n)
  }

  function search({ query = '', since = 0, until = 0, limit = 20, state = null } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 20))
    if (sqliteOk) {
      const where = []
      const args = []
      if (state) { where.push('state = ?'); args.push(state) }
      if (query) { where.push('(note LIKE ? OR source LIKE ?)'); args.push(`%${query}%`, `%${query}%`) }
      if (since) { where.push('created_at >= ?'); args.push(Number(since)) }
      if (until) { where.push('created_at <= ?'); args.push(Number(until)) }
      const sql = 'SELECT * FROM images' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
      return db.prepare(sql).all(...args, n)
    }
    const idx = readJsonIndex()
    let arr = idx.images.slice().reverse()
    if (state) arr = arr.filter((x) => (x.state || 'hot') === state)
    if (query) arr = arr.filter((x) => String(x.note || '').includes(query))
    if (since) arr = arr.filter((x) => Number(x.created_at) >= since)
    if (until) arr = arr.filter((x) => Number(x.created_at) <= until)
    return arr.slice(0, n)
  }

  function get(id) {
    if (sqliteOk) return db.prepare('SELECT * FROM images WHERE id = ?').get(Number(id)) || null
    const idx = readJsonIndex()
    return idx.images.find((x) => x.id === Number(id)) || null
  }

  function update(id, patch) {
    const keys = Object.keys(patch)
    if (!keys.length) return false
    if (sqliteOk) {
      const sets = keys.map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE images SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k]), Number(id))
      return true
    }
    const idx = readJsonIndex()
    const row = idx.images.find((x) => x.id === Number(id))
    if (!row) return false
    Object.assign(row, patch)
    writeJsonIndex(idx)
    return true
  }

  /** 只读分页查询（UI 用）：可按状态/来源前缀/关键词过滤，不改任何已有逻辑 */
  function page({ limit = 20, offset = 0, query = '', state = null, sourceLike = null } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 20))
    const off = Math.max(0, Number(offset) || 0)
    if (sqliteOk) {
      const where = []
      const args = []
      if (state) { where.push('state = ?'); args.push(String(state)) }
      if (sourceLike) { where.push('source LIKE ?'); args.push(String(sourceLike)) }
      if (query) { where.push('(note LIKE ? OR source LIKE ? OR CAST(id AS TEXT) = ?)'); args.push('%' + query + '%', '%' + query + '%', String(query)) }
      const w = where.length ? ' WHERE ' + where.join(' AND ') : ''
      const total = Number((db.prepare('SELECT COUNT(*) c FROM images' + w).get(...args) || {}).c || 0)
      const items = db.prepare('SELECT * FROM images' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, lim, off)
      return { total, items }
    }
    const idx = readJsonIndex()
    let arr = (idx.images || []).slice().sort((a, b) => b.id - a.id)
    if (state) arr = arr.filter((x) => (x.state || 'hot') === state)
    if (sourceLike) {
      const p = String(sourceLike).replace(/%/g, '')
      arr = arr.filter((x) => String(x.source || '').startsWith(p))
    }
    if (query) arr = arr.filter((x) => String(x.note || '').includes(query) || String(x.source || '').includes(query) || String(x.id) === String(query))
    return { total: arr.length, items: arr.slice(off, off + lim) }
  }

  function stats() {
    if (sqliteOk) {
      const rows = db.prepare('SELECT state, COUNT(*) c, COALESCE(SUM(bytes),0) b FROM images GROUP BY state').all()
      const by = {}
      let total = 0
      let bytes = 0
      for (const r of rows) { by[r.state || 'hot'] = Number(r.c); total += Number(r.c); bytes += Number(r.b) }
      const unjudged = Number((db.prepare("SELECT COUNT(*) c FROM images WHERE judged = 0 AND state != 'trashed'").get() || {}).c || 0)
      const archives = Number((db.prepare('SELECT COUNT(*) c FROM archives').get() || {}).c || 0)
      return { backend: 'sqlite', images: total, bytes, byState: by, unjudged, archives }
    }
    const idx = readJsonIndex()
    const by = {}
    for (const x of idx.images) by[x.state || 'hot'] = (by[x.state || 'hot'] || 0) + 1
    return {
      backend: 'json',
      images: idx.images.length,
      bytes: idx.images.reduce((s, x) => s + (x.bytes || 0), 0),
      byState: by,
      unjudged: idx.images.filter((x) => !x.judged && x.state !== 'trashed').length,
      archives: (idx.archives || []).length,
    }
  }

  function addArchive(rec) {
    if (sqliteOk) {
      db.prepare('INSERT INTO archives (file,count,bytes,created_at) VALUES (?,?,?,?)')
        .run(rec.file, rec.count, rec.bytes, Date.now())
    } else {
      const idx = readJsonIndex()
      idx.archives = idx.archives || []
      idx.archives.push({ ...rec, created_at: Date.now() })
      writeJsonIndex(idx)
    }
  }

  function remove(id) {
    if (sqliteOk) { db.prepare('DELETE FROM images WHERE id = ?').run(Number(id)); return true }
    const idx = readJsonIndex()
    const i = idx.images.findIndex((x) => x.id === Number(id))
    if (i < 0) return false
    idx.images.splice(i, 1)
    writeJsonIndex(idx)
    return true
  }

  function purge() {
    if (sqliteOk) { db.exec('DELETE FROM images'); db.exec('DELETE FROM archives') } else { writeJsonIndex({ nextId: 1, images: [], archives: [] }) }
    return true
  }

  // 进程退出时自动关库，避免 node:sqlite 在 teardown 阶段抛错导致退出码非 0
  try { process.once('exit', () => { try { db?.close() } catch {} }) } catch {}

  function close() {
    try { db?.close() } catch {}
  }

  return {
    dataDir, sqliteOk, blobPath, findBlob, put, list, search, get, update,
    stats, page, purge, close, addArchive, remove,
    readBlob: (sha) => readFileSync(findBlob(sha) || blobPath(sha)),
  }
}
