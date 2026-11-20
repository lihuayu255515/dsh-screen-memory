/**
 * lib/vision.mjs —— 眼睛（screen_describe 的后端）
 *
 * 走 OpenAI 兼容的 /chat/completions，支持任意带视觉的模型：
 *   · DeepSeek 官方（默认，key 从 ~/.dsh/.credentials.yaml 读）
 *   · 任何 OpenAI 兼容服务（qwen-vl / gpt-4o / glm-4v / 本地 vLLM…）
 *
 * 配置（插件 config）：
 *   vision: { baseUrl, apiKey, model, maxEdge, timeoutMs, dailyCap }
 *   maxEdge 默认 1400：实测 900 会把小字缩糊、模型开始“猜”（反而更贵），1400 更准也更省
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'

export const EYE_SYSTEM = [
  '你是一双「眼睛」，只负责看图片，不做别的事。',
  '规则：',
  '1. 你不是任何角色：不自称、不叫任何人「主人」、不用软话/玩笑/语气词。',
  '2. 只写画面上真的有的东西。认不出的就写「没看清」，绝不猜测，不编游戏名或剧情。',
  '3. 输出固定三段，不要写段标签，直接空一行分三段：',
  '   第一段：这是什么界面（一句话）',
  '   第二段：能点的东西和数字，一行一个（按钮/选项/标题/数值）',
  '   第三段：看不清的地方，一行一个；完全没有就只写「没有看不清的」',
  '4. 不要 Markdown、不要编号符号、不要感想或建议。',
  '5. 整段输出控制在 400 字以内，啰嗦不如说清楚。',
].join('\n')

export function readDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, '.credentials.yaml')
  try {
    if (!existsSync(file)) return null
    const txt = readFileSync(file, 'utf8')
    const m = /DEEPSEEK_API_KEY:\s*["']?([A-Za-z0-9_\-]+)["']?/.exec(txt)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function resolveVisionConfig(config = {}) {
  const v = config.vision || {}
  const baseUrl = String(v.baseUrl || process.env.DSH_VISION_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  const apiKey = v.apiKey || process.env.DSH_VISION_API_KEY || readDeepseekKey()
  const model = String(v.model || process.env.DSH_VISION_MODEL || DEFAULT_MODEL)
  const maxEdge = Number(v.maxEdge) || 1400
  const timeoutMs = Number(v.timeoutMs) || 75000
  const dailyCap = Number(v.dailyCap) || 100
  const maxTokens = Number(v.maxTokens) || 2500
  return { baseUrl, apiKey, model, maxEdge, timeoutMs, dailyCap, maxTokens, configured: !!apiKey }
}

/** 每日用量（存在 dataDir） */
export function makeVisionUsage(dataDir) {
  const file = join(dataDir, 'vision-usage.json')
  const today = () => new Date().toISOString().slice(0, 10)
  function read() {
    try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
  }
  function bump() {
    const st = read()
    const d = today()
    if (st.day !== d) { st.day = d; st.used = 0 }
    st.used = Number(st.used || 0) + 1
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(file, JSON.stringify(st)) } catch {}
    return st.used
  }
  function used() {
    const st = read()
    return st.day === today() ? Number(st.used || 0) : 0
  }
  return { file, bump, used }
}

/**
 * 让眼睛看一张图
 * @param {object} o
 * @param {string} o.imageBase64
 * @param {string} o.mime
 * @param {string} [o.question]
 * @param {object} o.cfg  resolveVisionConfig() 的返回
 */
export async function describeImage({ imageBase64, mime = 'image/jpeg', question = '', cfg }) {
  if (!cfg || !cfg.configured) {
    return { ok: false, error: '没有配置视觉 API：请在插件配置里填 vision.apiKey（或设置环境变量 DSH_VISION_API_KEY），或让 ~/.dsh/.credentials.yaml 里有 DEEPSEEK_API_KEY' }
  }
  const url = `${cfg.baseUrl}/chat/completions`
  const userContent = [
    { type: 'text', text: '看图，按规则报告。' + (question ? `关注点：${question}` : '') },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
  ]
  let lastErr = ''
  const ladder = [cfg.maxTokens || 2500, Math.round((cfg.maxTokens || 2500) * 1.6)]
  for (const maxTokens of ladder) {
    const body = {
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: EYE_SYSTEM },
        { role: 'user', content: userContent },
      ],
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`
        continue
      }
      let data = {}
      try { data = JSON.parse(text) } catch { lastErr = '返回不是 JSON'; continue }
      const msg = ((data.choices || [{}])[0] || {}).message || {}
      const content = String(msg.content || '').trim()
      if (content) return { ok: true, text: content, usage: data.usage || {} }
      lastErr = `模型只产出了思考、没有正文（max_tokens=${maxTokens}）`
    } catch (e) {
      lastErr = String(e && e.message).includes('abort') ? '请求超时' : `${e && e.name}: ${e && e.message}`
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastErr || '未知错误' }
}
