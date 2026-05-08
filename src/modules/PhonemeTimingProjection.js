import { PIANO_ROLL } from '../config/constants.js'

const ENVELOPE_TOP = 35.5
const ENVELOPE_HEIGHT = 24

// Pure geometry projection shared by editor hit-testing and visual drawing.
// Keep this module free of store, network, cache, and editor session state.
export function projectPhonemeTimingItem(item, adapter, laneHeight = PIANO_ROLL.PHONEME_TIMING_HEIGHT) {
  if (!isEditableItem(item) || !adapter || typeof adapter.timeToX !== 'function') return null

  const positionX = adapter.timeToX(item.positionMs / 1000)
  const endX = adapter.timeToX(item.endMs / 1000)
  const height = Math.min(ENVELOPE_HEIGHT, Math.max(12, laneHeight - 20))
  const top = Math.max(6, Math.min(ENVELOPE_TOP, laneHeight - height - 12))
  const bottom = top + height
  const points = item.envelopePoints.map((point, index) => ({
    index,
    xMs: point.xMs,
    yPercent: point.yPercent,
    x: adapter.timeToX((item.positionMs + point.xMs) / 1000),
    y: bottom - clamp(point.yPercent, 0, 100) / 100 * height,
    draggable: index < 2,
  }))

  return {
    item,
    positionX,
    endX,
    top,
    bottom,
    height,
    points,
    leftX: Math.min(positionX, endX, ...points.map((point) => point.x)),
    rightX: Math.max(positionX, endX, ...points.map((point) => point.x)),
  }
}

function isEditableItem(item) {
  return Boolean(
    item &&
    !item.hiddenReason &&
    !item.error &&
    item.noteKey &&
    item.phonemeIndex >= 0 &&
    item.positionMs != null &&
    item.endMs != null &&
    item.endMs > item.positionMs &&
    Array.isArray(item.envelopePoints) &&
    item.envelopePoints.length >= 2
  )
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
