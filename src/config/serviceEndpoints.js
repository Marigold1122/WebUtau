function normalizeBaseUrl(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const baseUrl = raw || fallback
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.replace(/\/+$/, '')
}

const env = import.meta.env || {}

export const RENDER_API_BASE_URL = normalizeBaseUrl(env.VITE_RENDER_API_BASE_URL, '')
export const SEEDVC_API_BASE_URL = normalizeBaseUrl(env.VITE_SEEDVC_API_BASE_URL, '/seedvc')
// AI 写词 endpoint：默认走 vite proxy 的 /api/* → 38510 后端；prod 同源部署也走 /api
export const LYRIC_AI_API_BASE_URL = normalizeBaseUrl(env.VITE_LYRIC_AI_API_BASE_URL, '')

export function buildRenderApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${RENDER_API_BASE_URL}${normalizedPath}`
}

export function buildSeedVcApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${SEEDVC_API_BASE_URL}${normalizedPath}`
}

export function buildLyricAIUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${LYRIC_AI_API_BASE_URL}${normalizedPath}`
}
