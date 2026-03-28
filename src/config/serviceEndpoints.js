function normalizeBaseUrl(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const baseUrl = raw || fallback
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.replace(/\/+$/, '')
}

export const RENDER_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_RENDER_API_BASE_URL, '')
export const SEEDVC_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_SEEDVC_API_BASE_URL, '/seedvc')

export function buildRenderApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${RENDER_API_BASE_URL}${normalizedPath}`
}

export function buildSeedVcApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${SEEDVC_API_BASE_URL}${normalizedPath}`
}
