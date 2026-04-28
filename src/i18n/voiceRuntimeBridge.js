// host 端：把 locale 推给 voice-runtime iframe，并在 iframe 创建/重载时附带 ?lang=xx
import { getLocale, onLocaleChange } from './index.js'

export function installVoiceRuntimeLocaleBridge() {
  // iframe 启动时主动读 URL 参数；如果初始化时 src 上没有 ?lang，主动推一次
  const broadcast = (locale) => {
    document.querySelectorAll('iframe.voice-runtime-frame').forEach((frame) => {
      try { frame.contentWindow?.postMessage({ type: 'webutau:locale', locale }, '*') } catch (_e) {}
    })
  }
  // iframe 准备好时回推（voice-runtime/main.js 上线时会发 ready 消息）
  window.addEventListener('message', (event) => {
    if (event?.data?.type === 'webutau:locale:ready') {
      broadcast(getLocale())
    }
  })
  onLocaleChange((locale) => {
    broadcast(locale)
  })
}

// iframe src 设置时附 ?lang= —— 与 theme 一致的策略
export function appendLocaleQuery(url) {
  if (!url) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}lang=${encodeURIComponent(getLocale())}`
}
