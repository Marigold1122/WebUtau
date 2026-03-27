export const DEFAULT_LANGUAGE_CODE = 'ZH'

export const LANGUAGE_OPTIONS = [
  { code: 'ZH', label: '中文' },
  { code: 'JA', label: '日语' },
]

function getLanguageCode(value) {
  return String(value || '').toUpperCase()
}

export function isLanguageCodeSupported(value) {
  const code = getLanguageCode(value)
  return LANGUAGE_OPTIONS.some((option) => option.code === code)
}

export function normalizeLanguageCode(value) {
  const code = getLanguageCode(value)
  return isLanguageCodeSupported(code) ? code : DEFAULT_LANGUAGE_CODE
}

export function normalizeOptionalLanguageCode(value) {
  const code = getLanguageCode(value)
  return isLanguageCodeSupported(code) ? code : null
}

export function getLanguageLabel(value, fallback = '未设置') {
  const code = getLanguageCode(value)
  return LANGUAGE_OPTIONS.find((option) => option.code === code)?.label || fallback
}
