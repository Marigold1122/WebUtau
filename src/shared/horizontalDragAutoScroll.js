const DEFAULT_EDGE_DISTANCE = 48
const DEFAULT_MAX_STEP = 28

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function computeHorizontalEdgeAutoScrollStep({
  clientX,
  viewportRect,
  edgeDistance = DEFAULT_EDGE_DISTANCE,
  maxStep = DEFAULT_MAX_STEP,
}) {
  if (!Number.isFinite(clientX) || !viewportRect) return 0
  const safeEdgeDistance = Number.isFinite(edgeDistance) ? Math.max(1, edgeDistance) : DEFAULT_EDGE_DISTANCE
  const safeMaxStep = Number.isFinite(maxStep) ? Math.max(1, maxStep) : DEFAULT_MAX_STEP
  const leftZone = viewportRect.left + safeEdgeDistance
  const rightZone = viewportRect.right - safeEdgeDistance

  if (clientX < leftZone) {
    const ratio = clamp((leftZone - clientX) / safeEdgeDistance, 0, 1)
    return -safeMaxStep * ratio
  }
  if (clientX > rightZone) {
    const ratio = clamp((clientX - rightZone) / safeEdgeDistance, 0, 1)
    return safeMaxStep * ratio
  }
  return 0
}

export function createHorizontalDragAutoScroller({
  getViewportRect,
  getScrollLeft,
  setScrollLeft,
  getMaxScrollLeft = () => Number.POSITIVE_INFINITY,
  onScroll = null,
  edgeDistance = DEFAULT_EDGE_DISTANCE,
  maxStep = DEFAULT_MAX_STEP,
} = {}) {
  let active = false
  let frameId = 0
  let lastClientX = null

  function readNextState() {
    const viewportRect = getViewportRect?.()
    const delta = computeHorizontalEdgeAutoScrollStep({
      clientX: lastClientX,
      viewportRect,
      edgeDistance,
      maxStep,
    })
    if (!delta) return null

    const currentScrollLeft = Number.isFinite(getScrollLeft?.()) ? Math.max(0, getScrollLeft()) : 0
    const maxScrollLeft = Number.isFinite(getMaxScrollLeft?.())
      ? Math.max(0, getMaxScrollLeft())
      : Number.POSITIVE_INFINITY
    const nextScrollLeft = clamp(currentScrollLeft + delta, 0, maxScrollLeft)
    return {
      currentScrollLeft,
      nextScrollLeft,
    }
  }

  function stopFrame() {
    if (!frameId) return
    cancelAnimationFrame(frameId)
    frameId = 0
  }

  function schedule() {
    if (frameId || !active) return
    frameId = requestAnimationFrame(tick)
  }

  function applyNow() {
    const nextState = readNextState()
    if (!nextState) return false
    if (Math.abs(nextState.nextScrollLeft - nextState.currentScrollLeft) < 0.5) return false
    setScrollLeft?.(nextState.nextScrollLeft)
    onScroll?.(nextState.nextScrollLeft)
    return true
  }

  function tick() {
    frameId = 0
    if (!active) return
    const changed = applyNow()
    if (changed || readNextState()) schedule()
  }

  return {
    start(clientX) {
      active = true
      lastClientX = clientX
      const changed = applyNow()
      if (changed || readNextState()) schedule()
      return changed
    },
    update(clientX) {
      if (!active) return false
      lastClientX = clientX
      const changed = applyNow()
      if (changed || readNextState()) schedule()
      return changed
    },
    stop() {
      active = false
      lastClientX = null
      stopFrame()
    },
    isActive() {
      return active
    },
  }
}
