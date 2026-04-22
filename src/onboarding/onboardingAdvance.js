import eventBus from '../core/EventBus.js'
import { BRANCH_CONFIG } from './onboardingSteps.js'

/**
 * 为一个屏安装自动推进监听。
 * 返回 cleanup 函数；若该屏无 advanceOn，返回 null。
 *
 * callbacks:
 *   onAdvance()                —— 触发下一步
 *   onBranchCaptured(branchKey) —— 若该屏配置了 captureBranchAttr 且匹配到合法分支，调用此回调
 */
export function installAdvanceListener(screen, { onAdvance, onBranchCaptured }) {
  const advance = screen?.advanceOn
  if (!advance) return null

  if (advance.type === 'dom-click') {
    const handler = (event) => {
      const hit = event.target?.closest?.(advance.selector)
      if (!hit) return
      if (advance.captureBranchAttr) {
        const captured = hit.dataset?.[advance.captureBranchAttr]
        if (captured && BRANCH_CONFIG[captured]) onBranchCaptured?.(captured)
      }
      onAdvance?.()
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }

  if (advance.type === 'dom-dblclick-track') {
    // 改用 MutationObserver 监视编辑面板的可见性变化：
    // 原生 dblclick 在单击引发轨道列表重绘时可能不派发，观察"打开结果"比观察"输入手势"更稳。
    const panel = document.querySelector('#editor-panel')
    if (!panel) return null
    const isEditorVisible = () => !panel.classList.contains('hidden')
    const check = () => { if (isEditorVisible()) onAdvance?.() }
    const observer = new MutationObserver(check)
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }

  if (advance.type === 'eventbus' && advance.event) {
    const handler = () => onAdvance?.()
    eventBus.on(advance.event, handler)
    return () => eventBus.off(advance.event, handler)
  }

  return null
}
