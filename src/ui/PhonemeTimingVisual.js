import { PIANO_ROLL } from '../config/constants.js'
import { projectPhonemeTimingItem } from '../modules/PhonemeTimingProjection.js'
import phonemeTimingStore from '../modules/PhonemeTimingStore.js'
import viewport from './PianoRollViewport.js'

const fallbackLabelOf = (note) => {
  const lyric = String(note?.lyric || '').trim().replace(/\s+/g, '')
  return (lyric ? (lyric.includes('/') ? lyric : `${lyric}/a`) : 'zh/a').slice(0, 12)
}

const visual = {
  canvas: null, ctx: null, phrases: [], frame: 0, unsubscribeStore: null,
  init(canvas) {
    this.canvas = canvas
    this.ctx = canvas?.getContext('2d') || null
    if (!this.unsubscribeStore) {
      this.unsubscribeStore = phonemeTimingStore.subscribe(() => this.requestDraw())
    }
  },
  setPhrases(phrases) { this.phrases = Array.isArray(phrases) ? phrases : []; this.requestDraw() },
  requestDraw() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw() })
  },
  draw(phrases = this.phrases) {
    if (Array.isArray(phrases)) this.phrases = phrases
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0 }
    const ctx = this.ctx
    if (!ctx || !this.canvas) return
    const w = this.canvas.clientWidth || this.canvas.width
    const h = this.canvas.clientHeight || PIANO_ROLL.PHONEME_TIMING_HEIGHT
    const left = 0
    ctx.clearRect(0, 0, w, h); ctx.save()
    try {
      shell(ctx, w, h, left); ctx.save(); ctx.beginPath(); ctx.rect(left, 0, Math.max(0, w - left), h); ctx.clip()
      try {
        grid(ctx, left, w, h)
        if (phonemeTimingStore.hasSnapshot()) {
          phonemes(ctx, phonemeTimingStore.getItems(), left, w, h, {
            hover: phonemeTimingStore.getHover(),
            preview: phonemeTimingStore.getPreview(),
          })
        } else {
          fallbackNotes(ctx, this.phrases, left, w, h)
        }
      } finally { ctx.restore() }
      border(ctx, w, h, left)
    } finally { ctx.restore() }
  },
}

function shell(ctx, w, h, left) {
  const C = PIANO_ROLL.PHONEME_TIMING
  ctx.fillStyle = C.BG; ctx.fillRect(left, 0, w - left, h)
}

function grid(ctx, left, w, h) {
  const C = PIANO_ROLL.PHONEME_TIMING
  const minor = 30
  const offset = -(((viewport.scrollX % minor) + minor) % minor)
  for (let x = left + offset; x < w; x += minor) {
    const major = Math.round((x - left + viewport.scrollX) / minor) % 4 === 0
    ctx.strokeStyle = major ? C.GRID_DARK : C.GRID_LIGHT; ctx.lineWidth = major ? 1.2 : 1
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
}

function phonemes(ctx, items, left, w, h, state = {}) {
  const adapter = visualViewportAdapter()
  const rows = [-Infinity, -Infinity]
  const sorted = items
    .filter((item) => !item.hiddenReason)
    .sort((leftItem, rightItem) => (leftItem.positionMs ?? 0) - (rightItem.positionMs ?? 0))
  for (const item of sorted) {
    const source = previewItemFor(item, state.preview) || item
    const projection = projectPhonemeTimingItem(source, adapter, h)
    if (!projection || projection.rightX < left || projection.leftX > w) continue
    const targetKind = sameTarget(item, state.preview?.hit)
      ? state.preview.hit.kind
      : sameTarget(item, state.hover) ? state.hover.kind : null
    drawPhoneme(ctx, projection, {
      label: (source.label || source.rawLabel || 'phoneme').slice(0, 12),
      active: Boolean(targetKind),
      targetKind,
    }, rows)
  }
}

function fallbackNotes(ctx, phrases, left, w, h) {
  const range = viewport.getVisibleTimeRange()
  const rows = [-Infinity, -Infinity]
  for (const phrase of phrases) for (const note of phrase?.notes || []) {
    const time = Number(note?.time), duration = Number(note?.duration), end = time + duration
    if (!Number.isFinite(end) || end < range.start || time > range.end) continue
    block(ctx, {
      startSec: time,
      durationSec: duration,
      label: fallbackLabelOf(note),
      envelopePoints: [],
    }, left, w, h, rows)
  }
}

function drawPhoneme(ctx, projection, options, rows) {
  const C = PIANO_ROLL.PHONEME_TIMING
  const points = projection.points
  if (points.length < 2) return
  ctx.save()
  ctx.fillStyle = options.active ? 'rgba(201, 66, 52, 0.18)' : C.FILL
  ctx.strokeStyle = options.active ? C.ATTACK : C.STROKE
  ctx.lineWidth = options.active ? 1.5 : 1
  ctx.beginPath()
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath(); ctx.fill(); ctx.stroke()

  const positionTarget = options.targetKind === 'position'
  if (positionTarget) {
    ctx.strokeStyle = 'rgba(247, 183, 49, 0.28)'
    ctx.lineWidth = 8
    ctx.beginPath(); ctx.moveTo(projection.positionX, projection.top - 2); ctx.lineTo(projection.positionX, projection.bottom + 2); ctx.stroke()
  }
  ctx.strokeStyle = positionTarget ? '#F7B731' : C.ATTACK
  ctx.lineWidth = positionTarget ? 4 : projection.item?.hasOffsetOverride || projection.item?.offsetTick ? 3 : 2
  ctx.beginPath(); ctx.moveTo(projection.positionX, projection.top); ctx.lineTo(projection.positionX, projection.bottom); ctx.stroke()

  for (const point of points) {
    const draggable = point.index < 2
    if (!draggable) continue
    const pointTarget = (point.index === 0 && options.targetKind === 'preutter') || (point.index === 1 && options.targetKind === 'overlap')
    ctx.beginPath(); ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = C.PANEL_BG
    ctx.strokeStyle = pointTarget ? C.ATTACK : options.active ? C.ATTACK : C.STROKE
    ctx.lineWidth = pointTarget ? 2 : options.active ? 2 : 1.5
    ctx.fill(); ctx.stroke()
  }
  ctx.restore()
  placeLabel(ctx, options.label, projection.positionX + 4, 72, rows)
}

function block(ctx, item, left, w, h, rows) {
  const C = PIANO_ROLL.PHONEME_TIMING
  if (!Number.isFinite(item.startSec) || !Number.isFinite(item.durationSec) || item.durationSec <= 0) return
  const x = left + viewport.timeToX(item.startSec), width = viewport.durationToWidth(item.durationSec)
  if (x + width < left || x > w) return
  const y1 = 32, y2 = Math.min(64, h - 12), slope = Math.min(20, Math.max(8, width * 0.24))
  const showLabel = viewport.pixelsPerSecond >= PIANO_ROLL.PHONEME_TIMING_MIN_PPS
  if (width < 8) return tick(ctx, item, x, width, y1, y2, showLabel, rows)
  const topEnd = x + Math.max(4, width - slope), end = x + width
  ctx.fillStyle = item.active ? 'rgba(201, 66, 52, 0.2)' : C.FILL
  ctx.strokeStyle = item.active ? C.ATTACK : C.STROKE
  ctx.lineWidth = item.active ? 1.5 : 1
  ctx.beginPath(); ctx.moveTo(x, y2); ctx.lineTo(x, y1); ctx.lineTo(topEnd, y1); ctx.lineTo(end, y2); ctx.closePath(); ctx.fill(); ctx.stroke()
  ctx.strokeStyle = C.ATTACK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke()
  envelope(ctx, x, y1, y2, item.envelopePoints, item.active)
  if (showLabel) placeLabel(ctx, item.label, x + 4, Math.min(Math.max(20, width - 8), 72), rows)
}

function tick(ctx, item, x, width, y1, y2, showLabel, rows) {
  const C = PIANO_ROLL.PHONEME_TIMING
  const end = x + Math.max(1, width), topEnd = x + Math.max(1, Math.min(width, 3))
  ctx.fillStyle = C.FILL; ctx.fillRect(x, y1, Math.max(1, Math.min(width, 3)), y2 - y1)
  ctx.strokeStyle = C.ATTACK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke()
  envelope(ctx, x, y1, y2, item.envelopePoints, item.active)
  if (showLabel) placeLabel(ctx, item.label, x + 4, 20, rows)
}

function envelope(ctx, x, y1, y2, points, active = false) {
  const C = PIANO_ROLL.PHONEME_TIMING
  if (!Array.isArray(points) || points.length < 2) return
  const height = y2 - y1
  ctx.save()
  ctx.strokeStyle = 'rgba(43, 40, 37, 0.48)'
  ctx.fillStyle = C.PANEL_BG
  ctx.lineWidth = 1
  ctx.beginPath()
  let moved = false
  for (const point of points) {
    const px = x + viewport.durationToWidth(point.xMs / 1000)
    const py = y2 - clamp(point.yPercent, 0, 100) / 100 * height
    if (!moved) {
      ctx.moveTo(px, py)
      moved = true
    } else {
      ctx.lineTo(px, py)
    }
  }
  if (moved) ctx.stroke()
  for (const [index, point] of points.entries()) {
    const px = x + viewport.durationToWidth(point.xMs / 1000)
    const py = y2 - clamp(point.yPercent, 0, 100) / 100 * height
    const draggable = index < 2
    ctx.beginPath(); ctx.arc(px, py, draggable ? (active ? 4.5 : 3.5) : 2, 0, Math.PI * 2)
    ctx.fillStyle = draggable ? C.PANEL_BG : 'rgba(43, 40, 37, 0.32)'
    ctx.strokeStyle = draggable ? (active ? C.ATTACK : C.STROKE) : 'rgba(43, 40, 37, 0.36)'
    ctx.lineWidth = draggable ? (active ? 2 : 1.5) : 1
    ctx.fill(); ctx.stroke()
  }
  ctx.restore()
}

function placeLabel(ctx, text, x, maxWidth, rows) {
  ctx.font = '600 10px "Inter", sans-serif'
  const width = Math.min(maxWidth, ctx.measureText(text).width + 10)
  let row = x > rows[0] + 2 ? 0 : 1
  if (x <= rows[row] + 2) row = rows[0] <= rows[1] ? 0 : 1
  rows[row] = Math.max(rows[row], x + width)
  label(ctx, text, x, row ? 0 : 16, width)
}

function label(ctx, text, x, y, width) {
  const C = PIANO_ROLL.PHONEME_TIMING
  ctx.font = '600 10px "Inter", sans-serif'
  ctx.fillStyle = C.PANEL_BG; ctx.strokeStyle = C.BORDER; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(x, y, width, 14, 3); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y + 7, width - 8)
}

function border(ctx, w, h, left) {
  const C = PIANO_ROLL.PHONEME_TIMING
  ctx.strokeStyle = C.BORDER; ctx.lineWidth = 1; ctx.strokeRect(left + 0.5, 0.5, Math.max(0, w - left - 1), Math.max(0, h - 1))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function sameTarget(item, target) {
  return Boolean(item && target && item.noteKey === target.noteKey && item.phonemeIndex === target.phonemeIndex)
}

function previewItemFor(item, preview) {
  const items = Array.isArray(preview?.items) ? preview.items : preview?.item ? [preview.item] : []
  return items.find((candidate) => sameTarget(item, candidate)) || null
}

function visualViewportAdapter() {
  return {
    timeToX: (seconds) => viewport.timeToX(seconds),
    durationToWidth: (seconds) => viewport.durationToWidth(seconds),
  }
}

export default visual
