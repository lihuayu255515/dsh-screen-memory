/**
 * lib/hud.mjs —— 特写档案（按窗口标题记住"放大哪儿"）
 * 文件：<dataDir>/hud-profiles.json
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export function makeHudProfiles(dataDir) {
  const file = join(dataDir, 'hud-profiles.json')
  function read() {
    try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
  }
  function write(obj) {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(obj, null, 1))
    renameSync(tmp, file)
  }
  function get(window) {
    const all = read()
    return all[String(window || '')] || null
  }
  function set(window, plan) {
    const all = read()
    const key = String(window || '')
    if (!key) return null
    all[key] = { ...plan, updatedAt: Date.now() }
    write(all)
    return all[key]
  }
  function remove(window) {
    const all = read()
    const key = String(window || '')
    if (!all[key]) return false
    delete all[key]
    write(all)
    return true
  }
  function list() {
    const all = read()
    return Object.entries(all).map(([w, v]) => ({ window: w, ...v }))
  }
  return { file, get, set, remove, list, read }
}
