// 明暗主题控制：把当前主题写到 <html data-theme="light|dark">；
// 默认按系统时间自动决定（傍晚 18 点到次日清晨 6 点为暗），用户在按钮上点击后
// 就当作"显式偏好"持久化到 localStorage，之后不再被自动逻辑覆盖。
//
// 切换动画走 View Transitions API：浏览器对当前状态拍快照 → 瞬间切主题 →
// 合成器层面交叉淡入。整页 GPU 复合，永远 60fps 不丢帧。
// 之前用 * 选择器给几千个 DOM 元素挂 transition 的方案性能太差（4-5 帧）已废弃。
// 不支持 View Transitions 的浏览器（Firefox 旧版等）退化到瞬间切换——总比卡顿好

const STORAGE_KEY = 'webutau:theme'
const NIGHT_START_HOUR = 18 // 18:00 起算暗
const NIGHT_END_HOUR = 6    // 06:00 起算亮

function safeReadStorage() {
  try { return globalThis.localStorage?.getItem?.(STORAGE_KEY) || null }
  catch (_e) { return null }
}

function safeWriteStorage(value) {
  try { globalThis.localStorage?.setItem?.(STORAGE_KEY, value) }
  catch (_e) { /* private mode 等场景静默失败 */ }
}

function computeAutoTheme(now = new Date()) {
  const hour = now.getHours()
  // 18:00–05:59 算"夜"，其余算"日"
  return (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR) ? 'dark' : 'light'
}

function broadcastThemeToIframes(theme) {
  // 三道保险把主题塞到 iframe 里：
  //   1. 直接同源访问 contentDocument，set data-theme（最快、最确定）
  //   2. postMessage 给 iframe 的 message 监听者（处理 contentDocument 还没 ready 的情况）
  //   3. iframe 自己启动时还会从 URL ?theme= 读取一次（首屏不闪）
  // 任何一道生效都行；多道并存不会冲突
  const iframes = document.querySelectorAll('iframe')
  iframes.forEach((iframe) => {
    try {
      const idoc = iframe.contentDocument || iframe.contentWindow?.document
      if (idoc?.documentElement) {
        idoc.documentElement.dataset.theme = theme
      }
    } catch (_e) { /* 跨域 / 还没装载，忽略 */ }
    try { iframe.contentWindow?.postMessage({ type: 'webutau:theme', theme }, '*') }
    catch (_e) {}
  })
}

function commitThemeChange(next) {
  // 实际改 attr + 同步到 iframe——这一步是同步的，View Transitions API 会把它包在
  // "拍快照 → 切换 → 交叉淡入" 的中间一拍执行
  document.documentElement.dataset.theme = next
  broadcastThemeToIframes(next)
}

function applyTheme(theme, { animated = true } = {}) {
  const root = document.documentElement
  if (!root) return
  const next = theme === 'dark' ? 'dark' : 'light'
  if (root.dataset.theme === next) return

  // 首屏不动画——直接同步切，避免 startViewTransition 的额外开销
  if (!animated || typeof document.startViewTransition !== 'function') {
    commitThemeChange(next)
    return
  }

  // View Transitions：浏览器把"切换前"的视口拍成一张纹理，commit 完后用合成器
  // 把新视口跟旧纹理做 cross-fade。不需要给每个 DOM 元素挂 transition，
  // GPU 直接做合成层动画，几千个色值"同时"插值跟一个色值插值的开销几乎一样
  const transition = document.startViewTransition(() => {
    commitThemeChange(next)
  })
  // 不需要 await——浏览器自己管理动画生命周期。仅在异常时退化
  transition?.finished?.catch?.(() => {})
}

export function initThemeController({ buttonId = 'btn-theme-toggle' } = {}) {
  const stored = safeReadStorage() // 'light' | 'dark' | null
  const initial = (stored === 'light' || stored === 'dark') ? stored : computeAutoTheme()
  // 首屏不要过渡——避免页面加载时颜色"闪一下"
  applyTheme(initial, { animated: false })

  // iframe 起来后会发 ready 消息——这时再把当前主题推给它（首屏的广播可能 iframe 还没装载）
  globalThis.addEventListener?.('message', (event) => {
    if (event?.data?.type === 'webutau:theme:ready') {
      const current = document.documentElement.dataset.theme || 'light'
      try { event.source?.postMessage?.({ type: 'webutau:theme', theme: current }, '*') }
      catch (_e) {}
    }
  })

  const button = document.getElementById(buttonId)
  if (!button) return { getTheme: () => document.documentElement.dataset.theme || 'light' }

  // 按钮反映当前 effective 主题；点击切到对面，并标记为"显式偏好"
  const refreshButton = () => {
    const current = document.documentElement.dataset.theme || 'light'
    button.dataset.theme = current
    button.setAttribute('aria-pressed', String(current === 'dark'))
    button.title = current === 'dark' ? '切换到日间模式' : '切换到夜间模式'
  }
  refreshButton()

  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const current = document.documentElement.dataset.theme || 'light'
    const next = current === 'dark' ? 'light' : 'dark'
    applyTheme(next, { animated: true })
    safeWriteStorage(next)
    refreshButton()
  })

  // 用户没有显式偏好时，每分钟检查一次时间——跨过 6:00 / 18:00 自动切。
  // 已设过显式偏好则不打扰
  let autoCheckHandle = null
  if (!stored) {
    autoCheckHandle = globalThis.setInterval?.(() => {
      // 显式偏好若中途被设置（用户点了按钮），就停掉自动检查
      if (safeReadStorage()) {
        if (autoCheckHandle != null) globalThis.clearInterval?.(autoCheckHandle)
        autoCheckHandle = null
        return
      }
      const want = computeAutoTheme()
      const current = document.documentElement.dataset.theme || 'light'
      if (want !== current) {
        applyTheme(want, { animated: true })
        refreshButton()
      }
    }, 60 * 1000)
  }

  return {
    getTheme: () => document.documentElement.dataset.theme || 'light',
    setTheme: (theme) => {
      applyTheme(theme, { animated: true })
      safeWriteStorage(theme === 'dark' ? 'dark' : 'light')
      refreshButton()
    },
  }
}
