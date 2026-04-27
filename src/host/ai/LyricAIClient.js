// 前端到后端 /ai/lyric 的薄网络层。
// 后端职责：
//   1) 把 messages 转发给 LLM 厂商（OpenAI 兼容协议），返回 raw 文本
//   2) 没传 user-api-key 时按 IP 限速（5/天默认），传了就跳过限速
//   3) 在响应里告诉客户端今日剩余量
//
// 前端职责：
//   1) 收集 musicStructure / theme / 用户 key（如果有）
//   2) 调 buildLyricPrompt 拼 messages
//   3) 把 messages 发到后端
//   4) parseLyricResponse 校验 LLM 输出格式 + 字数对齐
import { buildLyricAIUrl } from '../../config/serviceEndpoints.js'
import { buildLyricPrompt, parseLyricResponse } from './buildLyricPrompt.js'
import { getUserApiConfig, hasUserApiKey } from './lyricApiKeyStore.js'
import { setQuotaFromServer } from './lyricUsageQuota.js'

const DEFAULT_BACKEND_URL = buildLyricAIUrl('/api/ai/lyric')

export class LyricAIClient {
  constructor({ backendUrl = DEFAULT_BACKEND_URL, fetchImpl = null } = {}) {
    this.backendUrl = backendUrl
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch?.(...args))
  }

  // 主入口：传一个 musicStructure + theme，返回校验过的 flatChars / phrases
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

    const userKey = hasUserApiKey() ? getUserApiConfig() : null
    const body = {
      messages,
      // 把音乐结构也发过去——后端做日志 / 二次校验用
      musicStructure,
      // 用户带自己的 key + endpoint + model 时，后端不限速、直接转发
      userApi: userKey ? {
        apiKey: userKey.apiKey,
        baseUrl: userKey.baseUrl || null,
        model: userKey.model || null,
      } : null,
    }

    let response
    try {
      response = await this.fetchImpl(this.backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      return { ok: false, reason: 'network-error', error: error?.message }
    }

    if (!response) {
      return { ok: false, reason: 'no-response' }
    }

    let payload = null
    try { payload = await response.json() } catch (_e) {}

    if (!response.ok) {
      // 服务端返回的非 200——常见状态：429（超限）、401（key 无效）、500（LLM 出错）
      const reason = response.status === 429 ? 'quota-exceeded'
        : response.status === 401 ? 'invalid-key'
        : `http-${response.status}`
      // 即使失败也尝试同步配额（429 时后端会带回 used/remaining）
      if (payload && (Number.isFinite(payload.used) || Number.isFinite(payload.remaining))) {
        setQuotaFromServer(payload)
      }
      return { ok: false, reason, message: payload?.message || response.statusText }
    }

    // 成功：后端在响应 metadata 里带 quota 信息（用户用自己 key 时为 null）
    if (payload?.quota) {
      setQuotaFromServer(payload.quota)
    }

    // 解析 LLM 返回的 JSON 文本
    const rawText = typeof payload?.content === 'string' ? payload.content : ''
    const parsed = parseLyricResponse(rawText, musicStructure)
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'parse-failed',
        parseReason: parsed.reason,
        rawText,
        details: parsed,
      }
    }
    return {
      ok: true,
      phrases: parsed.phrases,
      flatChars: parsed.flatChars,
      rawText,
      quota: payload?.quota || null,
    }
  }
}
