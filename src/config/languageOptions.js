import { t } from '../i18n/index.js'

export const DEFAULT_LANGUAGE_CODE = 'ZH'

// 内部存储语言代码，显示名称在使用时由 i18n 解析
const LANGUAGE_CODES = ['ZH', 'JA']

export const LANGUAGE_OPTIONS = LANGUAGE_CODES.map((code) => ({
  code,
  get label() {
    return t(`language.${code.toLowerCase()}`)
  },
}))

function getLanguageCode(value) {
  return String(value || '').toUpperCase()
}

export function isLanguageCodeSupported(value) {
  const code = getLanguageCode(value)
  return LANGUAGE_CODES.includes(code)
}

export function normalizeLanguageCode(value) {
  const code = getLanguageCode(value)
  return isLanguageCodeSupported(code) ? code : DEFAULT_LANGUAGE_CODE
}

export function normalizeOptionalLanguageCode(value) {
  const code = getLanguageCode(value)
  return isLanguageCodeSupported(code) ? code : null
}

export function getLanguageLabel(value, fallback) {
  const code = getLanguageCode(value)
  if (!isLanguageCodeSupported(code)) {
    return fallback ?? t('inspector.track.lang_unset')
  }
  return t(`language.${code.toLowerCase()}`)
}
