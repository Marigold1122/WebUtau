import { isKeyboardShortcutTargetEditable } from '../../shared/isKeyboardShortcutTargetEditable.js'

/**
 * 轨道列表视口的临时抓手：
 *   - 按住 H + 左键拖动 → 平移视口
 *   - 按住鼠标中键拖动 → 同上，随时可用（无需键盘）
 *
 * 与乐器编辑器 / 人声 runtime 的 H-pan 相互独立：各自监听自己容器内的 mousedown，
 * 所以即使同时按住 H，其它容器的 pan 不会串扰（mousedown 的事件目标自然决定谁响应）。
 */
export function installTrackViewportPan(viewport) {
  if (!viewport) return

  let drag = null
  let panOverride = false

  const beginPan = (event) => {
    drag = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    }
    viewport.dataset.panning = '1'
    event.preventDefault()
    event.stopPropagation()
  }

  const updatePan = (event) => {
    if (!drag) return
    const dx = event.clientX - drag.startClientX
    const dy = event.clientY - drag.startClientY
    const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollLeft = Math.max(0, Math.min(maxLeft, drag.startScrollLeft - dx))
    viewport.scrollTop = Math.max(0, Math.min(maxTop, drag.startScrollTop - dy))
  }

  const endPan = () => {
    if (!drag) return
    drag = null
    delete viewport.dataset.panning
  }

  viewport.addEventListener('mousedown', (event) => {
    // 中键任何时候都进入抓手
    if (event.button === 1) return beginPan(event)
    if (event.button !== 0) return
    // H 按住时，左键也是抓手
    if (panOverride) beginPan(event)
  }, true)  // capture 阶段，抢在轨道行的 click/dblclick 监听之前

  document.addEventListener('mousemove', updatePan)
  document.addEventListener('mouseup', endPan)

  document.addEventListener('keydown', (event) => {
    if (event.repeat) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key?.toLowerCase?.() !== 'h') return
    if (isKeyboardShortcutTargetEditable(event.target)) return
    if (!panOverride) {
      panOverride = true
      viewport.dataset.panOverride = '1'
    }
    // 不 preventDefault —— 让同级的 voiceRuntimePanBridge / InstrumentEditor 也能看到
  }, true)

  document.addEventListener('keyup', (event) => {
    if (event.key?.toLowerCase?.() !== 'h') return
    if (!panOverride) return
    panOverride = false
    delete viewport.dataset.panOverride
    if (drag) endPan()
  }, true)
}
