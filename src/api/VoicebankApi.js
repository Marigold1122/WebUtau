import { buildRenderApiUrl } from '../config/serviceEndpoints.js'

let cachedVoicebanks = null

export async function fetchVoicebanks({ useCache = true } = {}) {
  if (useCache && cachedVoicebanks) return cachedVoicebanks
  const response = await fetch(buildRenderApiUrl('/api/voicebanks'))
  if (!response.ok) throw new Error('获取声库失败: HTTP ' + response.status)
  const voicebanks = await response.json()
  if (!Array.isArray(voicebanks) || voicebanks.length === 0) {
    throw new Error('后端没有可用声库')
  }
  cachedVoicebanks = voicebanks
  return voicebanks
}

export function getDefaultSingerId(voicebanks) {
  return voicebanks?.[0]?.id || null
}
