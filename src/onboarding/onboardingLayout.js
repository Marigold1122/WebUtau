export const SPOTLIGHT_PADDING = 6

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

export function applyPopoverPosition(popover, anchor) {
  if (!popover) return
  const resolved = anchor || { type: 'center' }
  popover.style.visibility = 'hidden'
  popover.style.left = '0px'
  popover.style.top = '0px'
  const popRect = popover.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = (vw - popRect.width) / 2
  let top = (vh - popRect.height) / 2

  if (resolved.type === 'above' && resolved.selector) {
    const el = document.querySelector(resolved.selector)
    if (el) {
      const r = el.getBoundingClientRect()
      left = Math.max(16, Math.min(vw - popRect.width - 16, r.left + r.width / 2 - popRect.width / 2))
      top = Math.max(16, r.top - popRect.height - 20)
    }
  } else if (resolved.type === 'near-top') {
    top = Math.max(16, vh * 0.18)
  } else if (resolved.type === 'near-bottom') {
    top = Math.min(vh - popRect.height - 16, vh * 0.62)
  }

  popover.style.left = `${Math.round(left)}px`
  popover.style.top = `${Math.round(top)}px`
  popover.style.visibility = ''
}
