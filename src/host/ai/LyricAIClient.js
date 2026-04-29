// AI 写词请求路由——核心安全设计：
//
// 路径 A（用户用平台免费额度）：
//   浏览器 → WebUtau 后端 (/api/ai/lyric) → 平台密钥 → LLM 厂商
//   后端按 IP 限速 5/天。我们的 key 不暴露给用户、用户也没有自带 key
//
// 路径 B（用户填了自己的 API key）：
//   浏览器 → 直接 fetch LLM 厂商（DeepSeek / 通义 / GLM）
//   ★★★ 用户 key 永不经过 WebUtau 后端 ★★★
//   这是核心安全保证：我们的服务器看不到、也碰不到用户的 key
//
// 用户 key 走浏览器直连，依赖 LLM 厂商支持 CORS。绝大多数主流厂商都支持
// （通义 / GLM / DeepSeek 都能从浏览器直连）。如果厂商不支持，浏览器会报
// CORS 错——前端识别后给出明确指引（换厂商或用桌面版）

import { buildLyricAIUrl } from '../../config/serviceEndpoints.js'
import { buildLyricPrompt, parseLyricResponse } from './buildLyricPrompt.js'
import { getUserApiConfig, hasUserApiKey } from './lyricApiKeyStore.js'
import {
  bumpQuotaOptimistically,
  setQuotaFromServer,
  unbumpQuotaOptimistically,
} from './lyricUsageQuota.js'

const DEFAULT_BACKEND_URL = buildLyricAIUrl('/api/ai/lyric')

// 用户填的 baseUrl 可能是 "https://api.deepseek.com" 或 "https://api.deepseek.com/v1"
// 或带或不带 /chat/completions——统一规整一次
function resolveLLMUrl(baseUrl) {
  if (!baseUrl) return ''
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}

export class LyricAIClient {
  constructor({ backendUrl = DEFAULT_BACKEND_URL, fetchImpl = null } = {}) {
    this.backendUrl = backendUrl
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch?.(...args))
  }

  async generate({ musicStructure, theme, style = '', extraInstruction = '', signal = null } = {}) {
    if (!musicStructure) {
      return { ok: false, reason: 'missing-music-structure' }
    }
    let messages
    try {
      messages = buildLyricPrompt({ musicStructure, theme, style, extraInstruction })
    } catch (error) {
      return { ok: false, reason: 'prompt-build-failed', error: error?.message }
    }

    // 关键判断：用户有自己的 key → 走直连 LLM 厂商；否则走我们后端
    if (await hasUserApiKey()) {
      return this._directGenerate(messages, musicStructure, signal)
    }
    return this._backendGenerate(messages, musicStructure, signal)
  }

  // 路径 A：走 WebUtau 后端（平台密钥 + 限速）。用户 key 不会出现在请求里
  async _backendGenerate(messages, musicStructure, signal) {
    const body = {
      messages,
      musicStructure,
      // 关键：不再发送任何 userApi 字段。后端也不接收
    }
    // 发送前先乐观自增本地计数：UI 立刻 -1。任何"实际没消耗"的失败分支
    // 都要在返回前调用 unbump 撤回，否则次数会被错误地扣掉
    bumpQuotaOptimistically()

    let response
    try {
      response = await this.fetchImpl(this.backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      // 网络 / abort / 浏览器拒发——根本没到服务端
      unbumpQuotaOptimistically()
      return { ok: false, reason: 'network-error', error: error?.message }
    }
    if (!response) {
      unbumpQuotaOptimistically()
      return { ok: false, reason: 'no-response' }
    }

    let payload = null
    try { payload = await response.json() } catch (_e) {}

    if (!response.ok) {
      // 所有非 2xx：服务端要么没扣（429），要么扣了但已 Refund（5xx / 422）。
      // 都属于"用户没真正消耗"——撤回 UI 上的乐观自增。
      // 服务端报的 quota 仍然走一次"只增不减"同步：让多设备等场景下别的会话
      // 消耗的真实计数也能反映过来；不会让本地凭空多出额度
      unbumpQuotaOptimistically()
      if (payload?.quota) setQuotaFromServer(payload.quota)

      // 422 = 服务端已校验出"AI 返回与音乐结构不匹配"——结构化的 parseFailure
      // 直接转成前端原有的 parse-failed 错误形态
      if (response.status === 422 && payload?.parseFailure) {
        return {
          ok: false,
          reason: 'parse-failed',
          parseReason: payload.parseFailure.reason,
          phraseIndex: payload.parseFailure.phraseIndex,
          expected: payload.parseFailure.expected,
          actual: payload.parseFailure.actual,
          // _formatAIError 通过 result.details?.* 取这些值，保持兼容
          details: {
            reason: payload.parseFailure.reason,
            phraseIndex: payload.parseFailure.phraseIndex,
            expected: payload.parseFailure.expected,
            actual: payload.parseFailure.actual,
          },
          message: payload.message || '',
        }
      }
      const reason = response.status === 429 ? 'quota-exceeded'
        : response.status === 401 ? 'invalid-key'
        : `http-${response.status}`
      return { ok: false, reason, message: payload?.message || response.statusText }
    }

    // 200 OK：服务端正常扣了一次——乐观自增就是对的，不要 unbump。
    // setQuotaFromServer 会把客户端 used 与服务端对齐（向上同步）
    if (payload?.quota) setQuotaFromServer(payload.quota)

    const rawText = typeof payload?.content === 'string' ? payload.content : ''
    return this._parseAndPack(rawText, musicStructure, payload?.quota || null)
  }

  // 路径 B：浏览器直接 fetch LLM 厂商。用户 key 在 Authorization 里，
  // 经过 HTTPS 加密后发往用户填的 baseUrl，从此 WebUtau 不再插手任何环节
  async _directGenerate(messages, musicStructure, signal) {
    const cfg = await getUserApiConfig()
    if (!cfg.apiKey) {
      return { ok: false, reason: 'missing-user-key' }
    }
    if (!cfg.baseUrl) {
      return { ok: false, reason: 'missing-user-baseurl', message: '用户配置缺 BaseUrl，请补全' }
    }
    if (!cfg.model) {
      return { ok: false, reason: 'missing-user-model', message: '用户配置缺 Model，请补全' }
    }
    const url = resolveLLMUrl(cfg.baseUrl)
    const requestBody = {
      model: cfg.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.85,
      stream: false,
    }
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      })
    } catch (error) {
      // CORS / 网络错误——大概率是 LLM 厂商不允许浏览器直连
      const message = error?.message || ''
      if (/CORS|cross-origin|Failed to fetch|NetworkError/i.test(message) || !message) {
        return {
          ok: false,
          reason: 'cors-blocked',
          message: '该厂商不允许浏览器直连（CORS 限制）。建议换 DeepSeek / 通义 / GLM，或使用桌面版。',
          error: message,
        }
      }
      return { ok: false, reason: 'network-error', error: message }
    }
    if (!response) return { ok: false, reason: 'no-response' }

    let payload = null
    let bodyText = ''
    try {
      bodyText = await response.text()
      payload = bodyText ? JSON.parse(bodyText) : null
    } catch (_e) { /* 厂商返回不是 JSON 也兜得住 */ }

    if (!response.ok) {
      // 这一步 401 / 403 几乎都是用户 key 不对 / 余额不足等
      const reason = response.status === 401 ? 'invalid-user-key'
        : response.status === 403 ? 'user-key-forbidden'
        : response.status === 429 ? 'user-key-rate-limited'
        : `http-${response.status}`
      const upstreamMsg = payload?.error?.message || payload?.message || bodyText.slice(0, 200)
      return { ok: false, reason, message: upstreamMsg }
    }

    // OpenAI 兼容格式：choices[0].message.content
    const rawText = payload?.choices?.[0]?.message?.content
    if (typeof rawText !== 'string') {
      return { ok: false, reason: 'parse-failed', parseReason: 'no-content', rawText: bodyText }
    }
    // 用户 key 走的路径不更新平台配额（不消耗平台额度）
    return this._parseAndPack(rawText, musicStructure, null)
  }

  // 共用：把 LLM 返回的 JSON 文本校验成 phrases / flatChars
  _parseAndPack(rawText, musicStructure, quota) {
    const parsed = parseLyricResponse(rawText, musicStructure)
    if (!parsed.ok) {
      return { ok: false, reason: 'parse-failed', parseReason: parsed.reason, rawText, details: parsed }
    }
    return {
      ok: true,
      phrases: parsed.phrases,
      flatChars: parsed.flatChars,
      rawText,
      quota,
    }
  }
}
