/**
 * lib/budget.mjs —— 上下文预算档位
 *
 * 为什么需要：不同用户上下文预算差别很大。
 *   rich     ：预算充足，允许主会话频繁用 read_image 亲自看
 *   balanced ：默认，像我们现在这样每小时 ~6 张
 *   lean     ：预算紧张/盲模型，一律走 screen_describe（文字），不给本地路径
 *
 * 插件无法直接知道模型的上下文窗口，所以用"每小时图片配额 + 是否给路径"来控制
 * 主会话被图片撑爆的风险。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PROFILES = {
  rich: { imagesPerHour: 20, givePath: true, note: '上下文充足：可以直接 read_image 看图（每小时最多 20 张）' },
  balanced: { imagesPerHour: 6, givePath: true, note: '默认档：每小时最多 6 张进上下文；更多请用 screen_describe' },
  lean: { imagesPerHour: 0, givePath: false, note: '省预算：不给本地路径，一律用 screen_describe 看文字' },
}

export function resolveBudget(config = {}) {
  const b = config.budget || {}
  const name = String(b.profile || 'balanced').toLowerCase()
  const base = PROFILES[name] || PROFILES.balanced
  const imagesPerHour = Number.isFinite(Number(b.imagesPerHour)) ? Number(b.imagesPerHour) : base.imagesPerHour
  const givePath = b.givePath === undefined ? base.givePath : !!b.givePath
  return { profile: PROFILES[name] ? name : 'balanced', imagesPerHour, givePath, note: base.note }
}

export function makeBudgetUsage(dataDir) {
  const file = join(dataDir, 'usage.json')
  function read() {
    try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
  }
  function write(obj) {
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(file, JSON.stringify(obj)) } catch {}
  }
  function usedLastHour() {
    const st = read()
    const arr = Array.isArray(st.imageTimes) ? st.imageTimes : []
    const cut = Date.now() - 3600 * 1000
    return arr.filter((t) => Number(t) > cut).length
  }
  function bump() {
    const st = read()
    const cut = Date.now() - 3600 * 1000
    const arr = (Array.isArray(st.imageTimes) ? st.imageTimes : []).filter((t) => Number(t) > cut)
    arr.push(Date.now())
    st.imageTimes = arr
    write(st)
    return arr.length
  }
  return { file, read, write, usedLastHour, bump }
}
