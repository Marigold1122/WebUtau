const DEFAULT_PADDING = 48

export const PLAYHEAD_FOLLOW_MODES = {
  FOLLOW: 'follow',
  PAGE: 'page',
  PUSH: 'push',
}

export const PLAYHEAD_FOLLOW_MODE_LABELS = {
  [PLAYHEAD_FOLLOW_MODES.FOLLOW]: '跟踪',
  [PLAYHEAD_FOLLOW_MODES.PAGE]: '翻页',
  [PLAYHEAD_FOLLOW_MODES.PUSH]: '推移',
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function normalizePlayheadFollowMode(mode) {
  if (mode === PLAYHEAD_FOLLOW_MODES.FOLLOW) return PLAYHEAD_FOLLOW_MODES.FOLLOW
  if (mode === PLAYHEAD_FOLLOW_MODES.PAGE) return PLAYHEAD_FOLLOW_MODES.PAGE
  return PLAYHEAD_FOLLOW_MODES.PUSH
}

export function computeFollowScrollLeft({
  mode,
  currentScrollLeft,
  playheadX,
  viewportWidth,
  contentWidth,
  leadingInset = 0,
  trailingInset = 0,
  padding = DEFAULT_PADDING,
}) {
  if (!Number.isFinite(playheadX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return Number.isFinite(currentScrollLeft) ? Math.max(0, currentScrollLeft) : 0
  }

  const normalizedMode = normalizePlayheadFollowMode(mode)
  const safeScrollLeft = Number.isFinite(currentScrollLeft) ? Math.max(0, currentScrollLeft) : 0
  const safeLeadingInset = Number.isFinite(leadingInset) ? Math.max(0, leadingInset) : 0
  const safeTrailingInset = Number.isFinite(trailingInset) ? Math.max(0, trailingInset) : 0
  const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : DEFAULT_PADDING
  const visibleWidth = Math.max(1, viewportWidth - safeLeadingInset - safeTrailingInset)
  const playheadVisibleX = playheadX - safeScrollLeft
  const minVisibleX = safeLeadingInset
  const maxVisibleX = safeLeadingInset + visibleWidth
  const maxScrollLeft = Number.isFinite(contentWidth)
    ? Math.max(0, contentWidth - viewportWidth)
    : Number.POSITIVE_INFINITY

  let nextScrollLeft = safeScrollLeft

  if (normalizedMode === PLAYHEAD_FOLLOW_MODES.FOLLOW) {
    const targetVisibleX = safeLeadingInset + visibleWidth / 2
    nextScrollLeft = playheadX - targetVisibleX
  } else if (normalizedMode === PLAYHEAD_FOLLOW_MODES.PAGE) {
    if (playheadVisibleX < minVisibleX || playheadVisibleX > maxVisibleX) {
      nextScrollLeft = Math.floor(Math.max(0, playheadX - safeLeadingInset) / visibleWidth) * visibleWidth
    }
  } else {
    const leftBound = Math.min(maxVisibleX, safeLeadingInset + safePadding)
    const rightBound = Math.max(leftBound, maxVisibleX - safePadding)
    if (playheadVisibleX < leftBound) {
      nextScrollLeft = playheadX - leftBound
    } else if (playheadVisibleX > rightBound) {
      nextScrollLeft = playheadX - rightBound
    }
  }

  const clampedScrollLeft = clamp(nextScrollLeft, 0, maxScrollLeft)
  if (Math.abs(clampedScrollLeft - safeScrollLeft) < 0.5) return safeScrollLeft
  return clampedScrollLeft
}
