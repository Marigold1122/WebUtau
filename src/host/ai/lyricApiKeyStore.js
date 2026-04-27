// 用户自带 API key 的本地存储——直接 localStorage，不走任何加密。
// 这是用户自己的本地浏览器存储，不会被发到任何第三方服务（除了用户主动调用时
// 走我们后端 / 直接走 LLM 厂商）。前端不做加密：
//   1. 真要安全得让用户在 LLM 厂商配 IP 白名单 / 时效 token
//   2. 浏览器加密拦不住任何稍懂的人，只是制造"安全幻觉"
//
// 字段：
//   - apiKey: 用户填的 key
//   - baseUrl: 用户用的 OpenAI 兼容 endpoint（DeepSeek / 通义 / GLM / 自托管）
//   - model: 模型名（deepseek-chat / qwen-max / glm-4-flash 等）

const STORAGE_KEY = 'webutau:ai-lyric-config'

function safeRead() {
  try {
    const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch (_e) { return null }
}

function safeWrite(value) {
  try { globalThis.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(value || {})) }
  catch (_e) {}
}

export function getUserApiConfig() {
  const stored = safeRead() || {}
  return {
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
    model: typeof stored.model === 'string' ? stored.model : '',
  }
}

export function hasUserApiKey() {
  const cfg = getUserApiConfig()
  return Boolean(cfg.apiKey && cfg.apiKey.trim())
}

export function setUserApiConfig({ apiKey = '', baseUrl = '', model = '' } = {}) {
  safeWrite({
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
    baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
    model: typeof model === 'string' ? model.trim() : '',
  })
}

export function clearUserApiConfig() {
  try { globalThis.localStorage?.removeItem?.(STORAGE_KEY) } catch (_e) {}
}
