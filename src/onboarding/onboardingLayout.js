export const SPOTLIGHT_PADDING = 6
const INSPECTOR_SELECTOR = '#main-inspector'
const VIEWPORT_MARGIN = 16

export function applySpotlight(spotlight, target) {
  if (!spotlight) return
  if (target) {
    const rect = target.getBoundingClientRect()
    spotlight.classList.add('wu-onboarding__spotlight--visible')
    spotlight.style.top = `${rect.top - SPOTLIGHT_PADDING}px`
    spotlight.style.left = `${rect.left - SPOTLIGHT_PADDING}px`
    spotlight.style.width = `${rect.width + SPOTLIGHT_PADDING * 2}px`
    spotlight.style.height = `${rect.height + SPOTLIGHT_PADDING * 2}px`
  } else {
    spotlight.classList.remove('wu-onboarding__spotlight--visible')
  }
}

/**
 * 将气泡固定在右侧检视栏中央。若检视栏不存在（极端情况），退化为视口右侧中部。
 * 忽略 step.anchor（用户要求所有步骤都使用同一位置）。
 */
export function applyPopoverPosition(popover) {
  if (!popover) return
  popover.style.visibility = 'hidden'
  popover.style.left = '0px'
  popover.style.top = '0px'
  const popRect = popover.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  const inspector = document.querySelector(INSPECTOR_SELECTOR)
  let left
  let top
  if (inspector) {
    const r = inspector.getBoundingClientRect()
    left = r.left + r.width / 2 - popRect.width / 2
    top = r.top + r.height / 2 - popRect.height / 2
  } else {
    left = vw - popRect.width - 24
    top = (vh - popRect.height) / 2
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(vw - popRect.width - VIEWPORT_MARGIN, left))
  top = Math.max(VIEWPORT_MARGIN, Math.min(vh - popRect.height - VIEWPORT_MARGIN, top))

  popover.style.left = `${Math.round(left)}px`
  popover.style.top = `${Math.round(top)}px`
  popover.style.visibility = ''
}
