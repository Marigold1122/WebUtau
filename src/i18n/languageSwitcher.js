// 检查器底栏的"语言"切换链接：点击展开下拉，选中后立即广播 locale 变更并重扫 DOM。
// 浮窗位置自适应：上方放不下就放下方，反之亦然。
import { applyI18n, getLocale, getLocaleMeta, listLocales, setLocale } from './index.js'

const POPUP_CLASS = 'lang-toggle-popup'

export function installLanguageSwitcher() {
  const button = document.getElementById('btn-lang-toggle')
  const text = document.getElementById('btn-lang-toggle-text')
  if (!button) return null

  const sync = () => {
    if (text) text.textContent = getLocaleMeta().label || getLocale()
    button.dataset.locale = getLocale()
  }
  sync()

  let popup = null
  const close = () => {
    if (!popup) return
    popup.remove()
    popup = null
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onOutside, true)
    document.removeEventListener('keydown', onEsc, true)
    window.removeEventListener('resize', position, true)
  }
  const onOutside = (event) => {
    if (popup?.contains(event.target) || button.contains(event.target)) return
    close()
  }
  const onEsc = (event) => { if (event.key === 'Escape') close() }

  // 浮窗定位：优先放在按钮上方（底栏场景）；上方放不下就翻到下方
  const position = () => {
    if (!popup) return
    const rect = button.getBoundingClientRect()
    const popRect = popup.getBoundingClientRect()
    const margin = 6
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    let top
    if (spaceAbove >= popRect.height + margin || spaceAbove >= spaceBelow) {
      top = Math.max(8, rect.top - popRect.height - margin)
      popup.dataset.placement = 'above'
    } else {
      top = Math.min(window.innerHeight - popRect.height - 8, rect.bottom + margin)
      popup.dataset.placement = 'below'
    }
    // 与按钮右沿对齐，但不出屏
    const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.right - popRect.width))
    popup.style.top = `${Math.round(top)}px`
    popup.style.left = `${Math.round(left)}px`
  }

  const open = () => {
    close()
    popup = document.createElement('div')
    popup.className = POPUP_CLASS
    popup.setAttribute('role', 'menu')
    listLocales().forEach((locale) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'lang-toggle-item'
      item.setAttribute('role', 'menuitemradio')
      const isCurrent = locale.code === getLocale()
      item.setAttribute('aria-checked', String(isCurrent))
      if (isCurrent) item.dataset.current = '1'
      item.dataset.locale = locale.code
      item.textContent = locale.label
      item.addEventListener('click', (event) => {
        event.preventDefault()
        if (setLocale(locale.code)) {
          // setLocale 已广播，再扫一次 DOM 确保静态节点立即刷新
          applyI18n(document)
          sync()
        }
        close()
      })
      popup.appendChild(item)
    })
    document.body.appendChild(popup)
    requestAnimationFrame(() => {
      position()
      // 第二帧再算一次：第一帧 popup 字体/边距尺寸可能尚未稳定
      requestAnimationFrame(position)
    })
    button.setAttribute('aria-expanded', 'true')
    setTimeout(() => {
      document.addEventListener('click', onOutside, true)
      document.addEventListener('keydown', onEsc, true)
      window.addEventListener('resize', position, true)
    }, 0)
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (popup) close()
    else open()
  })

  return { refresh: sync }
}
