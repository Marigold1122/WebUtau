// 轻量级 i18n 引擎
//   - 支持 zh / en / ja 三语
//   - 嵌套 key 解析（'menubar.file'）
//   - {var} 插值
//   - 缺失回落到默认语言（zh）
//   - DOM 扫描：data-i18n / data-i18n-attr / data-i18n-html
//   - 订阅广播：onLocaleChange，便于动态 UI 重渲
//
// 注意：CSS 加固样式 (i18n-overrides.css) 由各 web 入口（host/main.js、
// voice-runtime/main.js）显式 import，不放在这里——避免 Node 测试踩到 CSS

import { messages as zh } from './locales/zh.js'
import { messages as en } from './locales/en.js'
import { messages as ja } from './locales/ja.js'

const STORAGE_KEY = 'webutau:locale'
const DEFAULT_LOCALE = 'zh'
const FALLBACK_LOCALE = 'zh'

const REGISTRY = {
  zh: { code: 'zh', label: '中文', tag: 'zh-CN', short: '中', messages: zh },
  en: { code: 'en', label: 'English', tag: 'en', short: 'EN', messages: en },
  ja: { code: 'ja', label: '日本語', tag: 'ja', short: '日', messages: ja },
}

export const SUPPORTED_LOCALES = Object.keys(REGISTRY)

const listeners = new Set()
let currentLocale = detectInitialLocale()

function detectInitialLocale() {
  // 优先 URL 参数（用于 voice-runtime iframe）
  try {
    const params = new URLSearchParams(globalThis.location?.search || '')
    const fromQuery = params.get('lang')
    if (fromQuery && REGISTRY[fromQuery]) return fromQuery
  } catch (_e) {}
  // 再读父窗口（同源 iframe）
  try {
    const fromParent = window.parent?.document?.documentElement?.dataset?.locale
    if (fromParent && REGISTRY[fromParent]) return fromParent
  } catch (_e) {}
  // localStorage 用户偏好
  try {
    const saved = window.localStorage?.getItem(STORAGE_KEY)
    if (saved && REGISTRY[saved]) return saved
  } catch (_e) {}
  // 浏览器语言匹配
  try {
    const navLang = (navigator?.language || navigator?.userLanguage || '').toLowerCase()
    if (navLang.startsWith('ja')) return 'ja'
    if (navLang.startsWith('zh')) return 'zh'
    if (navLang.startsWith('en')) return 'en'
  } catch (_e) {}
  return DEFAULT_LOCALE
}

export function getLocale() {
  return currentLocale
}

export function getLocaleMeta(code = currentLocale) {
  return REGISTRY[code] || REGISTRY[DEFAULT_LOCALE]
}

export function listLocales() {
  return SUPPORTED_LOCALES.map((code) => ({
    code,
    label: REGISTRY[code].label,
    short: REGISTRY[code].short,
  }))
}

export function setLocale(code, { persist = true, broadcast = true } = {}) {
  if (!REGISTRY[code] || code === currentLocale) return false
  currentLocale = code
  // 更新 <html lang> 和 data-locale，便于 CSS 与 iframe 桥接
  try {
    const html = document.documentElement
    html.lang = REGISTRY[code].tag
    html.dataset.locale = code
  } catch (_e) {}
  if (persist) {
    try { window.localStorage?.setItem(STORAGE_KEY, code) } catch (_e) {}
  }
  if (broadcast) {
    listeners.forEach((fn) => {
      try { fn(code) } catch (_e) {}
    })
  }
  return true
}

export function onLocaleChange(handler) {
  if (typeof handler !== 'function') return () => {}
  listeners.add(handler)
  return () => listeners.delete(handler)
}

function lookup(messages, key) {
  if (!messages || !key) return undefined
  const parts = String(key).split('.')
  let cur = messages
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in cur) {
      cur = cur[part]
    } else {
      return undefined
    }
  }
  return cur
}

function interpolate(template, vars) {
  if (typeof template !== 'string' || !vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name]
    return v === undefined || v === null ? '' : String(v)
  })
}

export function t(key, vars) {
  const primary = lookup(REGISTRY[currentLocale]?.messages, key)
  if (typeof primary === 'string') return interpolate(primary, vars)
  const fallback = lookup(REGISTRY[FALLBACK_LOCALE]?.messages, key)
  if (typeof fallback === 'string') return interpolate(fallback, vars)
  return key
}

// 标记一段文本只在某语言可见——主要用于注释/调试
export function tHas(key) {
  return typeof lookup(REGISTRY[currentLocale]?.messages, key) === 'string'
    || typeof lookup(REGISTRY[FALLBACK_LOCALE]?.messages, key) === 'string'
}

// DOM 扫描：把 data-i18n / data-i18n-attr / data-i18n-html 转成实际文本
//   <button data-i18n="menubar.file">文件</button>
//   <input data-i18n-attr="placeholder:lyric.placeholder" />
//   <div data-i18n-attr="title:tip.x,aria-label:tip.x"></div>
//   <p data-i18n-html="about.body"></p>  <!-- 仅资源里允许 HTML 时使用 -->
export function applyI18n(root = document) {
  if (!root) return
  const scope = root.nodeType === 9 /* document */ ? root : root
  const target = scope.documentElement ? scope : scope
  const queryRoot = target.querySelectorAll ? target : null
  if (!queryRoot) return

  queryRoot.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (!key) return
    el.textContent = t(key)
  })
  queryRoot.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html')
    if (!key) return
    el.innerHTML = t(key)
  })
  queryRoot.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr')
    if (!spec) return
    spec.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s && s.trim())
      if (!attr || !key) return
      el.setAttribute(attr, t(key))
    })
  })
}

// 应用首次：将 <html> 标记同步好（即便用户没改过偏好）
try {
  const html = document.documentElement
  html.lang = REGISTRY[currentLocale].tag
  html.dataset.locale = currentLocale
} catch (_e) {}
