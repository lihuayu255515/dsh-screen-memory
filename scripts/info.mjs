/**
 * scripts/info.mjs —— 给「只拿到一个 tgz」的 AI/人用的一页纸摘要
 *
 * 用法：
 *   node scripts/info.mjs          # 人看
 *   node scripts/info.mjs --json   # 机器读（agent 可以直接转述）
 *
 * 它会现场探测环境，告诉你：这是什么、能干什么、现在缺什么、怎么补、怎么装。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const AS_JSON = process.argv.includes('--json')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const cap = JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8'))

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const profiles = []
try {
  const { readdirSync } = await import('node:fs')
  for (const d of readdirSync(join(DSH_HOME, 'profiles'))) profiles.push(d)
} catch {}

function probe(cmd, args = ['-version']) {
  try {
    const { spawnSync } = require('node:child_process')
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 6000 })
    return r.status === 0
  } catch { return false }
}
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

const env = {
  platform: process.platform,
  node: process.version,
  powershell: process.platform === 'win32' ? probe('powershell.exe', ['-NoProfile', '-Command', 'exit 0']) : false,
  ffmpeg: probe(process.env.FFMPEG_PATH || 'ffmpeg'),
  tar: probe('tar', ['--version']),
  visionKey: (() => {
    if (process.env.DSH_VISION_API_KEY) return 'DSH_VISION_API_KEY'
    if (process.env.DEEPSEEK_API_KEY) return 'DEEPSEEK_API_KEY'
    try {
      const t = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
      return /DEEPSEEK_API_KEY:\s*\S+/.test(t) ? 'credentials.yaml' : ''
    } catch { return '' }
  })(),
  profiles,
}

const missing = []
if (process.platform === 'win32' && !env.powershell) missing.push({ item: 'PowerShell', fix: 'Windows 自带；被禁用时安装 ffmpeg 走 ffmpeg 后端' })
if (process.platform !== 'win32') missing.push({ item: 'Windows 截图后端', fix: '当前版本只支持 Windows 截图；仓库/眼睛对已有图片仍可用' })
if (!env.ffmpeg) missing.push({ item: 'ffmpeg（只有特写需要）', fix: 'winget install Gyan.FFmpeg 后重启 DSH；不装也能整屏/按窗口截图' })
if (!env.tar) missing.push({ item: 'tar（只有归档需要）', fix: 'Windows 10 1803+ 自带；Linux/macOS 默认有' })
if (!env.visionKey) missing.push({ item: '视觉 API Key（只有眼睛需要）', fix: '插件配置填 vision.apiKey，或设置 DSH_VISION_API_KEY / DEEPSEEK_API_KEY，或在 ~/.dsh/.credentials.yaml 里加 DEEPSEEK_API_KEY' })

const tools = (cap.tools || []).map((t) => t.name)
const summary = {
  name: pkg.name,
  version: pkg.version,
  what: 'DSH 屏幕记忆：截屏（整屏/指定窗口/区域特写）→ 存本地图片仓库 → 按编号/关键词找回 → 分层归档与回顾 → 眼睛（把图交给视觉 API 转成文字，不占聊天上下文）。',
  tools,
  environment: env,
  missing,
  install: {
    cli: 'dsh plugin --profile <profile> add "<你手上的 tgz 路径>"',
    cliNote: 'profile 常见是 web；如果是桌面版 App，命令行会被拒绝（profile "desktop" is managed exclusively by the Electron application），请在 App 的插件管理里安装本地插件。',
    restart: '装完必须完全退出 DSH 再打开。',
    verify: ['node scripts/doctor.mjs', 'node scripts/verify.mjs'],
  },
  usage: [
    '截个屏 → screen_look',
    '看当前窗口 → screen_look({window:"auto"}) 或完整窗口标题',
    '放大某块 → screen_look({region:{x,y,w,h}, place:"corner"})（需要 ffmpeg）',
    '让模型看到内容 → 把 screen_look 的 path 传给 read_image；模型不能看图就用 screen_describe',
    '找图 → screen_list / screen_search / screen_get',
    '清理 → screen_review → screen_judge → screen_maintain',
  ],
  tellUser: [
    '它会截屏，截的是整个桌面（录屏/共享内容也会被拍到）',
    '眼睛会把图片发给视觉 API（不配 Key 就不会外发）',
    '归档会删除原图（tar.gz 留备份，可 screen_get 恢复）；回收站超过 7 天后可由手动整理清理，定时任务默认不清理',
  ],
  data: cap.dataDir,
  docs: ['README.md（完整）', 'NEWBIE_QUICKSTART.md（零基础）', 'TESTING.md（测试清单）', 'capabilities.json（机器可读）'],
}

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const ok = (b) => (b ? '✓' : '✗')
console.log(`\n  ${pkg.name} v${pkg.version}`)
console.log(`  ${summary.what}\n`)
console.log('  —— 环境（现场探测）——')
console.log(`  平台      ${env.platform}`)
console.log(`  Node      ${env.node}`)
console.log(`  PowerShell ${ok(env.powershell)}   ffmpeg ${ok(env.ffmpeg)}   tar ${ok(env.tar)}`)
console.log(`  视觉 Key  ${env.visionKey || '（没有）'}`)
console.log(`  profiles  ${env.profiles.join(', ') || '（没找到 ~/.dsh/profiles）'}`)
console.log('\n  —— 缺什么 / 怎么补 ——')
if (!missing.length) console.log('  都齐了')
else for (const m of missing) console.log(`  · ${m.item}\n    补法：${m.fix}`)
console.log('\n  —— 工具（11 个）——')
console.log('  ' + tools.join(' · '))
console.log('\n  —— 怎么装 ——')
console.log('  命令行：' + summary.install.cli)
console.log('  桌面版：在 App 里「设置 → 插件 → 安装本地插件」选 tgz（命令行会被拒绝）')
console.log('  ' + summary.install.restart)
console.log('  验证：' + summary.install.verify.join('  /  '))
console.log('\n  —— 怎么用 ——')
for (const u of summary.usage) console.log('  · ' + u)
console.log('\n  —— 必须告诉用户 ——')
for (const t of summary.tellUser) console.log('  · ' + t)
console.log('\n  文档：' + summary.docs.join('  /  '))
console.log('')
