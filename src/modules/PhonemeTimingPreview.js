import {
  phonemeTimingEditTypeForHit,
  phonemeTimingResetEditTypeForHit,
} from '../shared/phonemeTimingContract.js'

export function createPhonemeTimingSession(hit, point, viewportAdapter, laneRect, items = []) {
  const item = cloneItem(hit?.item)
  const x = localPoint(point, normalizedRect(laneRect))?.x
  if (!item || x == null) return null
  return {
    hit: targetOnly(hit),
    laneRect: normalizedRect(laneRect),
    startItem: item,
    previousItem: findPreviousItem(hit, items),
    startMs: screenXToMs(item, x, viewportAdapter),
    startTick: screenXToPartTick(item, x, viewportAdapter),
    startOffsetTick: item.offsetTick ?? 0,
  }
}

export function buildPhonemeTimingPreviewEdit(session, point, viewportAdapter) {
  const x = localPoint(point, session?.laneRect, true)?.x
  if (!session || x == null) return null

  const item = cloneItem(session.startItem)
  const currentMs = screenXToMs(item, x, viewportAdapter)
  const currentTick = screenXToPartTick(item, x, viewportAdapter)
  if (session.hit.kind === 'position') return buildPositionPreview(session, item, currentMs, currentTick)
  if (session.hit.kind === 'preutter') return buildPreutterPreview(session, item, currentMs)
  return buildOverlapPreview(session, item, currentMs)
}

export function buildPhonemeTimingResetEdit(hit) {
  const editType = phonemeTimingResetEditTypeForHit(hit?.kind)
  return editType ? { hit: targetOnly(hit), editType, value: null } : null
}

export function screenXToMs(_item, x, adapter) {
  if (typeof adapter?.xToMs === 'function') return adapter.xToMs(x)
  if (typeof adapter?.xToTime === 'function') return adapter.xToTime(x) * 1000
  return 0
}

export function screenXToPartTick(item, x, adapter) {
  if (typeof adapter?.xToPartTick === 'function') return adapter.xToPartTick(item, x)
  if (typeof adapter?.xToTick === 'function') return adapter.xToTick(x)

  const spanMs = item.endMs - item.positionMs
  const spanTick = item.endTick - item.positionTick
  if (spanMs <= 0) return item.positionTick
  return item.positionTick + (screenXToMs(item, x, adapter) - item.positionMs) * spanTick / spanMs
}

function buildPositionPreview(session, item, currentMs, currentTick) {
  const tickDelta = Math.round(currentTick - session.startTick)
  const msDelta = currentMs - session.startMs
  item.positionTick += tickDelta
  item.positionMs += msDelta
  item.offsetTick = session.startOffsetTick + tickDelta

  const previous = buildPreviousPositionPreview(session.previousItem, item)
  item.envelopePoints = rebuildPositionEnvelopePoints(item, session.startItem, {
    isOverlapped: isOverlappedWithPrevious(previous, item),
  })
  return preview(session, item, item.offsetTick, [previous])
}

function buildPreutterPreview(session, item, currentMs) {
  const preutterMs = Math.max(0, item.positionMs - currentMs)
  item.preutterDeltaMs = roundMs(Math.max(preutterMs - item.autoPreutterMs, -item.autoPreutterMs))
  item.preutterMs = roundMs(item.autoPreutterMs + item.preutterDeltaMs)
  item.envelopePoints = rebuildEnvelopePoints(item, {
    clampOverlapPoint: true,
    isOverlapped: isOverlappedWithPrevious(session.previousItem, item),
  })
  return preview(session, item, item.preutterDeltaMs, [buildPreviousTailPreview(session.previousItem, item)])
}

function buildOverlapPreview(session, item, currentMs) {
  const originMs = item.positionMs - item.preutterMs
  item.overlapMs = roundMs(currentMs - originMs)
  item.overlapDeltaMs = roundMs(item.overlapMs - item.autoOverlapMs)
  item.envelopePoints = rebuildEnvelopePoints(item, {
    clampOverlapPoint: true,
    isOverlapped: isOverlappedWithPrevious(session.previousItem, item),
  })
  return preview(session, item, item.overlapDeltaMs, [buildPreviousTailPreview(session.previousItem, item)])
}

function preview(session, item, value, linkedItems = []) {
  const editType = phonemeTimingEditTypeForHit(session.hit.kind)
  if (!editType) return null
  return {
    hit: session.hit,
    item,
    items: [item, ...linkedItems.filter(Boolean)],
    editType,
    value,
  }
}

function rebuildEnvelopePoints(item, { clampOverlapPoint = true, isOverlapped = false } = {}) {
  const points = item.envelopePoints
  const durationMs = Math.max(0, item.endMs - item.positionMs)
  const p0x = -item.preutterMs
  const overlapSpan = clampOverlapPoint ? Math.max(item.overlapMs, 5) : item.overlapMs
  const p1x = p0x + (!isOverlapped && item.overlapDeltaMs == null ? 5 : overlapSpan)
  const p2x = Math.max(0, p1x)
  let p3x = points[3]?.xMs ?? Math.max(p2x, durationMs - 35)
  const p4x = points[4]?.xMs ?? durationMs
  if (p3x === p4x) p3x = Math.max(p2x, p3x - 35)
  return [
    { xMs: roundMs(p0x), yPercent: 0 },
    { xMs: roundMs(p1x), yPercent: points[1]?.yPercent ?? 100 },
    { xMs: roundMs(p2x), yPercent: points[2]?.yPercent ?? points[1]?.yPercent ?? 100 },
    { xMs: roundMs(p3x), yPercent: points[3]?.yPercent ?? 100 },
    { xMs: roundMs(p4x), yPercent: points[4]?.yPercent ?? 0 },
  ]
}

function rebuildPositionEnvelopePoints(item, startItem, options) {
  const points = rebuildEnvelopePoints(item, options)
  for (const index of [3, 4]) {
    const startPoint = startItem.envelopePoints[index]
    if (!startPoint) continue
    points[index] = {
      ...points[index],
      xMs: roundMs(startItem.positionMs + startPoint.xMs - item.positionMs),
      yPercent: startPoint.yPercent,
    }
  }
  return points
}

function buildPreviousPositionPreview(previousItem, currentItem) {
  const previous = cloneItem(previousItem)
  if (!previous || !isSamePart(previous, currentItem)) return null
  previous.endTick = currentItem.positionTick
  previous.endMs = currentItem.positionMs
  return buildPreviousTailPreview(previous, currentItem)
}

function buildPreviousTailPreview(previousItem, currentItem) {
  const previous = cloneItem(previousItem)
  if (!isOverlappedWithPrevious(previous, currentItem)) return null
  const tailIntrude = Math.max(currentItem.preutterMs, currentItem.preutterMs - currentItem.overlapMs)
  const tailOverlap = Math.max(currentItem.overlapMs, 0)
  previous.envelopePoints = rebuildTailEnvelopePoints(previous, tailIntrude, tailOverlap)
  return previous
}

function rebuildTailEnvelopePoints(item, tailIntrude, tailOverlap) {
  const points = item.envelopePoints.map((point) => ({ ...point }))
  if (points.length < 5) return points
  const durationMs = Math.max(0, item.endMs - item.positionMs)
  let p3x = durationMs - tailIntrude
  const p4x = p3x + tailOverlap
  if (p3x === p4x) p3x = Math.max(points[2]?.xMs ?? 0, p3x - 35)
  points[3] = { ...points[3], xMs: roundMs(p3x) }
  points[4] = { ...points[4], xMs: roundMs(p4x) }
  return points
}

function findPreviousItem(hit, items) {
  const list = Array.isArray(items) ? items : []
  const index = list.findIndex((item) => samePhoneme(item, hit))
  const previous = index > 0 ? list[index - 1] : null
  return previous && isSamePart(previous, hit) ? cloneItem(previous) : null
}

function normalizedRect(rect) {
  if (!rect) return null
  const left = Number(rect.left ?? 0), top = Number(rect.top ?? 0)
  const width = Number(rect.width), height = Number(rect.height)
  return [left, top, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { left, top, width, height }
    : null
}

function localPoint(point, rect, allowOutside = false) {
  const p = clientPoint(point)
  if (!p || !rect) return null
  if (!allowOutside && !isPointInRect(p, rect)) return null
  return { x: p.x - rect.left, y: p.y - rect.top }
}

function isPointInRect(point, rect) {
  return point.x >= rect.left && point.y >= rect.top
    && point.x <= rect.left + rect.width && point.y <= rect.top + rect.height
}

function clientPoint(point) {
  const x = Number(point?.clientX ?? point?.x)
  const y = Number(point?.clientY ?? point?.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function targetOnly(hit) {
  return hit ? { kind: hit.kind, noteKey: hit.noteKey, phonemeIndex: hit.phonemeIndex, partIndex: hit.partIndex, phraseIndex: hit.phraseIndex } : null
}

function cloneItem(item) {
  return item ? { ...item, envelopePoints: (item.envelopePoints || []).map((point) => ({ ...point })) } : null
}

function samePhoneme(a, b) {
  return Boolean(a && b && a.noteKey === b.noteKey && a.phonemeIndex === b.phonemeIndex)
}

function isSamePart(a, b) {
  return Boolean(a && b && a.partIndex === b.partIndex)
}

function isOverlappedWithPrevious(previous, current) {
  return Boolean(previous && current && isSamePart(previous, current) && current.positionMs - previous.endMs <= 0)
}

function roundMs(value) {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? 0 : rounded
}
