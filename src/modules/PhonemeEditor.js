import { PIANO_ROLL } from '../config/constants.js'
import phonemeTimingStore from './PhonemeTimingStore.js'
import { commitPhonemeTimingPreview } from './PhonemeTimingCommit.js'
import { projectPhonemeTimingItem } from './PhonemeTimingProjection.js'
import {
  buildPhonemeTimingPreviewEdit,
  buildPhonemeTimingResetEdit,
  createPhonemeTimingSession,
} from './PhonemeTimingPreview.js'
import viewport from '../ui/PianoRollViewport.js'

const HIT_RADIUS = 5
const POSITION_HIT_X = 5

export function isPointInPhonemeTimingLane(point, laneRect) {
  const p = clientPoint(point), r = normalizedRect(laneRect)
  return Boolean(p && r && p.x >= r.left && p.y >= r.top && p.x <= r.left + r.width && p.y <= r.top + r.height)
}

export function hitTestPhonemeTiming(point, items, viewportAdapter, laneRect) {
  const r = normalizedRect(laneRect)
  const local = localPoint(point, r)
  if (!local) return null
  if ((viewportAdapter?.pixelsPerSecond ?? Infinity) < (viewportAdapter?.minPixelsPerSecond ?? 0)) return null

  for (const item of Array.isArray(items) ? items : []) {
    const projection = projectPhonemeTimingItem(item, viewportAdapter, r.height)
    if (!projection) continue
    if (within(projection.points[0], local, HIT_RADIUS)) return makeHit('preutter', item)
    if (within(projection.points[1], local, HIT_RADIUS)) return makeHit('overlap', item)
    if (Math.abs(projection.positionX - local.x) <= POSITION_HIT_X) return makeHit('position', item)
  }
  return null
}

class PhonemeEditor {
  constructor({
    store = phonemeTimingStore,
    getLaneRect = () => null,
    commitPreview = commitPhonemeTimingPreview,
    viewportAdapter = null,
  } = {}) {
    this.store = store
    this.getLaneRect = getLaneRect
    this.commitPreview = commitPreview
    this._injectedAdapter = typeof viewportAdapter === 'function' ? viewportAdapter : null
    this.session = null
  }

  setLaneRectProvider(getLaneRect) {
    this.getLaneRect = typeof getLaneRect === 'function' ? getLaneRect : () => null
  }

  hasSession() {
    return Boolean(this.session)
  }

  handlePointerDown(event) {
    const adapter = this._viewportAdapter()
    const laneRect = this.getLaneRect()
    const items = this.store.getItems()
    const hit = hitTestPhonemeTiming(event, items, adapter, laneRect)
    if (!hit) return false

    this.session = createPhonemeTimingSession(hit, event, adapter, laneRect, items)
    if (!this.session) return false
    this.store.setHover(targetOnly(hit))
    this.store.setPreview(buildPhonemeTimingPreviewEdit(this.session, event, adapter))
    return true
  }

  handlePointerMove(event) {
    const adapter = this._viewportAdapter()
    if (this.session) return this._previewActiveSession(event, adapter)

    const hit = hitTestPhonemeTiming(event, this.store.getItems(), adapter, this.getLaneRect())
    const nextHover = hit ? targetOnly(hit) : null
    if (!sameTarget(nextHover, this.store.getHover())) this.store.setHover(nextHover)
    return false
  }

  handlePointerUp() {
    if (!this.session) return false
    const preview = this.store.getPreview()
    this.session = null
    this.store.setPreview(null)
    if (preview) this._commitReleasedPreview(preview)
    return true
  }

  cancel() {
    this.session = null
    this.store.setHover(null)
    this.store.setPreview(null)
  }

  handleContextMenu(event) {
    if (this.session) return false
    const adapter = this._viewportAdapter()
    const laneRect = this.getLaneRect()
    const items = this.store.getItems()
    const hit = hitTestPhonemeTiming(event, items, adapter, laneRect)
    if (!hit) return false
    const reset = buildPhonemeTimingResetEdit(hit)
    if (!reset) return false
    this._commitReleasedPreview(reset)
    return true
  }

  _previewActiveSession(event, adapter) {
    this.store.setPreview(buildPhonemeTimingPreviewEdit(this.session, event, adapter))
    return true
  }

  _commitReleasedPreview(preview) {
    this.commitPreview(preview).catch((error) => {
      console.warn(`[PhonemeEditor] phoneme timing commit failed: ${error?.message || error}`)
    })
  }

  _viewportAdapter() {
    if (this._injectedAdapter) return this._injectedAdapter()
    return {
      pixelsPerSecond: viewport.pixelsPerSecond,
      minPixelsPerSecond: PIANO_ROLL.PHONEME_TIMING_MIN_PPS,
      timeToX: (seconds) => viewport.timeToX(seconds),
      durationToWidth: (seconds) => viewport.durationToWidth(seconds),
      xToMs: (x) => viewport.xToTime(x) * 1000,
      xToPartTick: (_item, x) => viewport.axis?.timeToTick?.(viewport.xToTime(x)) ?? 0,
    }
  }
}

function makeHit(kind, item) {
  return { kind, noteKey: item.noteKey, phonemeIndex: item.phonemeIndex, partIndex: item.partIndex, phraseIndex: item.phraseIndex, item }
}

function clientPoint(point) {
  const x = Number(point?.clientX ?? point?.x)
  const y = Number(point?.clientY ?? point?.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function normalizedRect(rect) {
  if (!rect) return null
  const left = Number(rect.left ?? 0), top = Number(rect.top ?? 0)
  const width = Number(rect.width), height = Number(rect.height)
  return [left, top, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { left, top, width, height } : null
}

function localPoint(point, rect) {
  const p = clientPoint(point)
  if (!p || !rect || !isPointInPhonemeTimingLane(p, rect)) return null
  return { x: p.x - rect.left, y: p.y - rect.top }
}

function targetOnly(hit) {
  return hit ? { kind: hit.kind, noteKey: hit.noteKey, phonemeIndex: hit.phonemeIndex, partIndex: hit.partIndex, phraseIndex: hit.phraseIndex } : null
}

function sameTarget(a, b) {
  return (!a && !b) || Boolean(a && b && a.kind === b.kind && a.noteKey === b.noteKey && a.phonemeIndex === b.phonemeIndex)
}

function within(target, point, radius) {
  return Boolean(target && point && Math.hypot(target.x - point.x, target.y - point.y) <= radius)
}

export { PhonemeEditor }
export default new PhonemeEditor()
