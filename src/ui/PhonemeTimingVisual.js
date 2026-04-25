import { PIANO_ROLL } from '../config/constants.js'
import viewport from './PianoRollViewport.js'
const C = PIANO_ROLL.PHONEME_TIMING
const labelOf = (note) => {
  const lyric = String(note?.lyric || '').trim().replace(/\s+/g, '')
  return (lyric ? (lyric.includes('/') ? lyric : `${lyric}/a`) : 'zh/a').slice(0, 12)
}
const visual = {
  canvas: null, ctx: null, phrases: [], frame: 0,
  init(canvas) { this.canvas = canvas; this.ctx = canvas?.getContext('2d') || null },
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
        notes(ctx, this.phrases, left, w, h)
      } finally { ctx.restore() }
      border(ctx, w, h, left)
    } finally { ctx.restore() }
  },
}
function shell(ctx, w, h, left) {
  ctx.fillStyle = C.BG; ctx.fillRect(left, 0, w - left, h)
}
function grid(ctx, left, w, h) {
  const minor = 30
  const offset = -(((viewport.scrollX % minor) + minor) % minor)
  for (let x = left + offset; x < w; x += minor) {
    const major = Math.round((x - left + viewport.scrollX) / minor) % 4 === 0
    ctx.strokeStyle = major ? C.GRID_DARK : C.GRID_LIGHT; ctx.lineWidth = major ? 1.2 : 1
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
}
function notes(ctx, phrases, left, w, h) {
  const range = viewport.getVisibleTimeRange()
  const rows = [-Infinity, -Infinity]
  for (const phrase of phrases) for (const note of phrase?.notes || []) {
    const time = Number(note?.time), duration = Number(note?.duration), end = time + duration
    if (Number.isFinite(end) && end >= range.start && time <= range.end) block(ctx, note, left, w, h, time, duration, rows)
  }
}
function block(ctx, note, left, w, h, time, duration, rows) {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return
  const x = left + viewport.timeToX(time), width = viewport.durationToWidth(duration)
  if (x + width < left || x > w) return
  const y1 = 32, y2 = Math.min(64, h - 12), slope = Math.min(20, Math.max(8, width * 0.24))
  const showLabel = viewport.pixelsPerSecond >= PIANO_ROLL.PHONEME_TIMING_MIN_PPS
  if (width < 8) return tick(ctx, note, x, width, y1, y2, showLabel, rows)
  const topEnd = x + Math.max(4, width - slope), end = x + width
  ctx.fillStyle = C.FILL; ctx.strokeStyle = C.STROKE; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, y2); ctx.lineTo(x, y1); ctx.lineTo(topEnd, y1); ctx.lineTo(end, y2); ctx.closePath(); ctx.fill(); ctx.stroke()
  ctx.strokeStyle = C.ATTACK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke()
  handle(ctx, x, y2); handle(ctx, x, y1); handle(ctx, topEnd, y1); handle(ctx, end, y2)
  if (showLabel) placeLabel(ctx, note, x + 4, Math.min(Math.max(20, width - 8), 72), rows)
}
function tick(ctx, note, x, width, y1, y2, showLabel, rows) {
  const end = x + Math.max(1, width), topEnd = x + Math.max(1, Math.min(width, 3))
  ctx.fillStyle = C.FILL; ctx.fillRect(x, y1, Math.max(1, Math.min(width, 3)), y2 - y1)
  ctx.strokeStyle = C.ATTACK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke()
  handle(ctx, x, y2); handle(ctx, x, y1); handle(ctx, topEnd, y1); handle(ctx, end, y2)
  if (showLabel) placeLabel(ctx, note, x + 4, 20, rows)
}
function placeLabel(ctx, note, x, maxWidth, rows) {
  ctx.font = '600 10px "Inter", sans-serif'
  const text = labelOf(note), width = Math.min(maxWidth, ctx.measureText(text).width + 10)
  let row = x > rows[0] + 2 ? 0 : 1
  if (x <= rows[row] + 2) row = rows[0] <= rows[1] ? 0 : 1
  rows[row] = Math.max(rows[row], x + width)
  label(ctx, text, x, row ? 0 : 16, width)
}
function label(ctx, text, x, y, width) {
  ctx.font = '600 10px "Inter", sans-serif'
  ctx.fillStyle = C.PANEL_BG; ctx.strokeStyle = C.BORDER; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(x, y, width, 14, 3); ctx.fill(); ctx.stroke()
  ctx.fillStyle = C.TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y + 7, width - 8)
}
function handle(ctx, x, y) {
  ctx.fillStyle = C.PANEL_BG; ctx.strokeStyle = C.STROKE; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
}
function border(ctx, w, h, left) {
  ctx.strokeStyle = C.BORDER; ctx.lineWidth = 1; ctx.strokeRect(left + 0.5, 0.5, Math.max(0, w - left - 1), Math.max(0, h - 1))
}
export default visual
