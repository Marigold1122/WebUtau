import eventBus from '../core/EventBus.js'
import { EVENTS, PHRASE_STATUS, PIANO_ROLL } from '../config/constants.js'
import noteSelection from './NoteSelection.js'
import phraseStore from '../core/PhraseStore.js'
import viewport from './PianoRollViewport.js'
import phraseRenderStateStore from '../voice-runtime/app/phraseRenderStateStore.js'
import pitchEditor from '../modules/PitchEditor.js'

class PianoRollNotes {
  constructor() {
    this.canvas = null
    this.ctx = null
    this.phrases = []
    this.drawFrame = 0
  }

  init(noteCanvas) {
    this.canvas = noteCanvas
    this.ctx = noteCanvas.getContext('2d')
    this._listenEvents()
  }

  setPhrases(phrases) {
    this.phrases = Array.isArray(phrases) ? phrases : []
    this.requestDraw()
  }

  draw() {
    if (this.drawFrame) {
      cancelAnimationFrame(this.drawFrame)
      this.drawFrame = 0
    }
    if (!this.ctx) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const timeRange = viewport.getVisibleTimeRange()
    const pitchRange = viewport.getVisiblePitchRange()
    const high = Math.min(PIANO_ROLL.PITCH_MAX, pitchRange.high)
    const low = Math.max(PIANO_ROLL.PITCH_MIN, pitchRange.low)
    for (const phrase of this.phrases) {
      if (phrase.endTime < timeRange.start || phrase.startTime > timeRange.end) continue
      const fillColor = this._getPhraseColor(phrase)
      const strokeColor = this._darkenColor(fillColor)
      for (const note of phrase.notes) {
        if (note.time + note.duration < timeRange.start || note.time > timeRange.end) continue
        if (note.midi < low || note.midi > high) continue
        const x = viewport.timeToX(note.time)
        const y = viewport.pitchToY(note.midi) + PIANO_ROLL.NOTE_VERTICAL_OFFSET
        const width = viewport.durationToWidth(note.duration)
        const height = PIANO_ROLL.KEY_HEIGHT - PIANO_ROLL.NOTE_VERTICAL_GAP
        this.ctx.fillStyle = fillColor
        this.ctx.beginPath()
        this.ctx.roundRect(x, y, width, height, PIANO_ROLL.NOTE_CORNER_RADIUS)
        this.ctx.fill()
        this.ctx.strokeStyle = strokeColor
        this.ctx.beginPath()
        this.ctx.roundRect(x, y, width, height, PIANO_ROLL.NOTE_CORNER_RADIUS)
        this.ctx.stroke()
        if (note.lyric && width > 14) {
          this.ctx.fillStyle = '#f8f5ee'
          this.ctx.font = '600 10px "Inter", sans-serif'
          this.ctx.textBaseline = 'middle'
          this.ctx.fillText(note.lyric, x + 3, y + height / 2, width - 6)
        }
        if (noteSelection.isSelected(note) && width > 4) {
          this.ctx.save()
          this.ctx.strokeStyle = 'rgba(248, 245, 238, 0.95)'
          this.ctx.lineWidth = 2
          this.ctx.strokeRect(x + 1, y + 1, width - 2, height - 2)
          this.ctx.restore()
        }
      }
    }
    this._drawPitchCurve()
    this._drawMarquee()
  }

  _drawPitchCurve() {
    const pitchData = phraseStore.getPitchData()
    if (!pitchData?.pitchCurve?.length) return
    if (viewport.pixelsPerSecond < 30) return

    if (pitchEditor.isEnabled()) {
      this._drawPitchPath(pitchData, { applyDeviation: false, dashed: true, color: PIANO_ROLL.PITCH_BASE_LINE_COLOR, width: 1 })
    }
    this._drawPitchPath(pitchData, {
      applyDeviation: true,
      dashed: false,
      color: PIANO_ROLL.PITCH_LINE_COLOR,
      width: pitchEditor.isEnabled() ? 1.8 : PIANO_ROLL.PITCH_LINE_WIDTH,
    })
    if (pitchEditor.isEnabled()) {
      this._drawSelectedPitchSegment()
      this._drawPitchControlPoints(pitchData)
    }
  }

  requestDraw() {
    if (this.drawFrame) return
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = 0
      this.draw()
    })
  }

  _drawPitchPath(pitchData, options = {}) {
    const bpm = phraseStore.getBpm()
    const timeRange = viewport.getVisibleTimeRange()
    const curve = pitchData.pitchCurve
    const midiPpq = Number.isFinite(pitchData?.midiPpq) ? pitchData.midiPpq : 480
    const tickToSec = 60 / (midiPpq * bpm)
    const visibleStartTick = timeRange.start / tickToSec
    const visibleEndTick = timeRange.end / tickToSec
    const dev = pitchData.pitchDeviation
    const devXs = dev?.xs || []
    const devYs = dev?.ys || []

    this.ctx.save()
    this.ctx.strokeStyle = options.color
    this.ctx.lineWidth = options.width
    this.ctx.lineJoin = 'round'
    this.ctx.lineCap = 'round'
    if (options.dashed) this.ctx.setLineDash([5, 5])

    for (const phrase of this.phrases) {
      if (phrase.endTime < timeRange.start || phrase.startTime > timeRange.end) continue

      const pStartTick = Math.max(phrase.startTime / tickToSec, visibleStartTick)
      const pEndTick = Math.min(phrase.endTime / tickToSec, visibleEndTick)
      let lo = this._bisect(curve, pStartTick)
      let hi = this._bisect(curve, pEndTick + 0.000001)
      if (hi <= lo) continue

      this.ctx.beginPath()
      let moved = false
      for (let i = lo; i < hi; i++) {
        const pt = curve[i]
        if (pt.pitch <= 0) {
          if (moved) {
            this.ctx.stroke()
            this.ctx.beginPath()
            moved = false
          }
          continue
        }

        const pitch = options.applyDeviation
          ? pt.pitch + this._interpolateDev(devXs, devYs, pt.tick) / 100
          : pt.pitch
        const x = viewport.timeToX(pt.tick * tickToSec)
        const y = viewport.pitchToY(pitch) + PIANO_ROLL.KEY_HEIGHT / 2
        if (!moved) {
          this.ctx.moveTo(x, y)
          moved = true
        } else {
          this.ctx.lineTo(x, y)
        }
      }
      if (moved) this.ctx.stroke()
    }

    this.ctx.restore()
  }

  _drawSelectedPitchSegment() {
    const segment = pitchEditor.getSelectedSegment()
    if (!segment) return
    const timeRange = viewport.getVisibleTimeRange()
    if (segment.endTime < timeRange.start || segment.startTime > timeRange.end) return

    const x1 = viewport.timeToX(segment.startTime)
    const y1 = viewport.pitchToY(segment.startPitch) + PIANO_ROLL.KEY_HEIGHT / 2
    const x2 = viewport.timeToX(segment.endTime)
    const y2 = viewport.pitchToY(segment.endPitch) + PIANO_ROLL.KEY_HEIGHT / 2

    this.ctx.save()
    this.ctx.strokeStyle = 'rgba(201, 66, 52, 0.4)'
    this.ctx.lineWidth = 6
    this.ctx.lineCap = 'round'
    this.ctx.beginPath()
    this.ctx.moveTo(x1, y1)
    this.ctx.lineTo(x2, y2)
    this.ctx.stroke()
    this.ctx.restore()
  }

  _drawPitchControlPoints(_pitchData) {
    const timeRange = viewport.getVisibleTimeRange()
    const points = pitchEditor.getDisplayPoints(undefined, { includeAnchors: true })
    if (points.length === 0) return

    this.ctx.save()
    const minGapPx = Math.max(6, PIANO_ROLL.PITCH_POINT_RADIUS * 2)
    let lastDrawnX = -Infinity
    let selectedPoint = null
    const focusedNotes = new Set(
      noteSelection.getSelected().map((entry) => `${entry.phrase.index}:${entry.phrase.notes.indexOf(entry.note)}`),
    )

    for (const point of points) {
      if (point.time < timeRange.start || point.time > timeRange.end) continue
      const x = viewport.timeToX(point.time)
      const y = viewport.pitchToY(point.pitch) + PIANO_ROLL.KEY_HEIGHT / 2
      const selected = pitchEditor.getSelectedPointId() === point.id
      const focusKey = `${point.phraseIndex}:${point.noteIndex}`
      const focused = focusedNotes.has(focusKey)
      if (selected) {
        selectedPoint = { x, y, point }
        continue
      }
      if (point.kind !== 'normal' && !focused) continue
      if (point.kind === 'normal' && point.source !== 'user' && x - lastDrawnX < minGapPx) continue
      lastDrawnX = x

      this._drawPitchControlPoint(x, y, point, false)
    }

    if (selectedPoint) {
      this._drawPitchControlPoint(selectedPoint.x, selectedPoint.y, selectedPoint.point, true)
    }
    this.ctx.restore()
  }

  _drawPitchControlPoint(x, y, point, selected) {
    if (point.kind !== 'normal') {
      const size = selected ? PIANO_ROLL.PITCH_POINT_RADIUS + 2 : PIANO_ROLL.PITCH_POINT_RADIUS - 1
      this.ctx.fillStyle = selected ? 'rgba(201, 66, 52, 0.24)' : 'rgba(95, 90, 83, 0.14)'
      this.ctx.strokeStyle = selected ? PIANO_ROLL.PITCH_POINT_ACTIVE_COLOR : 'rgba(95, 90, 83, 0.46)'
      this.ctx.lineWidth = selected ? 2 : 1
      this.ctx.beginPath()
      this.ctx.moveTo(x, y - size)
      this.ctx.lineTo(x + size, y)
      this.ctx.lineTo(x, y + size)
      this.ctx.lineTo(x - size, y)
      this.ctx.closePath()
      this.ctx.fill()
      this.ctx.stroke()
      return
    }

    const userPoint = point.source === 'user'
    this.ctx.fillStyle = selected
      ? PIANO_ROLL.PITCH_POINT_ACTIVE_COLOR
      : userPoint
        ? '#d37b36'
        : PIANO_ROLL.PITCH_POINT_COLOR
    this.ctx.strokeStyle = selected
      ? '#fff6ef'
      : userPoint
        ? 'rgba(104, 56, 19, 0.55)'
        : 'rgba(43, 40, 37, 0.35)'
    this.ctx.lineWidth = selected ? 2 : 1
    this.ctx.beginPath()
    this.ctx.arc(
      x,
      y,
      selected ? PIANO_ROLL.PITCH_POINT_RADIUS + 1 : userPoint ? PIANO_ROLL.PITCH_POINT_RADIUS : PIANO_ROLL.PITCH_POINT_RADIUS - 1,
      0,
      Math.PI * 2,
    )
    this.ctx.fill()
    this.ctx.stroke()
  }

  // 在 PITD 稀疏点之间线性插值，返回 cents 偏差
  _interpolateDev(xs, ys, tick) {
    if (xs.length === 0) return 0
    if (tick <= xs[0]) return ys[0]
    if (tick >= xs[xs.length - 1]) return ys[ys.length - 1]
    // 二分找到左边界
    let lo = 0, hi = xs.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (xs[mid] <= tick) lo = mid
      else hi = mid
    }
    // 线性插值
    const t = (tick - xs[lo]) / (xs[hi] - xs[lo])
    return ys[lo] + t * (ys[hi] - ys[lo])
  }

  // 二分查找：找到 curve 中第一个 tick >= targetTick 的索引
  _bisect(curve, targetTick) {
    let lo = 0, hi = curve.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (curve[mid].tick < targetTick) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  _drawMarquee() {
    const drag = noteSelection.getMarqueeRect()
    if (!drag) return
    const x = Math.min(drag.x1, drag.x2)
    const y = Math.min(drag.y1, drag.y2)
    const w = Math.abs(drag.x2 - drag.x1)
    const h = Math.abs(drag.y2 - drag.y1)
    this.ctx.fillStyle = 'rgba(59, 139, 136, 0.16)'
    this.ctx.fillRect(x, y, w, h)
    this.ctx.strokeStyle = 'rgba(59, 139, 136, 0.58)'
    this.ctx.strokeRect(x, y, w, h)
  }

  _getPhraseColor(phrase) {
    const status = phraseRenderStateStore.getStatus(phrase.index)
    if (status === PHRASE_STATUS.AVAILABLE) return PIANO_ROLL.NOTE_COLOR_AVAILABLE
    if (status === PHRASE_STATUS.RENDERING) return PIANO_ROLL.NOTE_COLOR_RENDERING
    if (status === PHRASE_STATUS.EXPIRED) return PIANO_ROLL.NOTE_COLOR_EXPIRED
    return PIANO_ROLL.NOTE_COLOR_PENDING
  }

  _listenEvents() {
    for (const eventName of [
      EVENTS.RENDER_COMPLETE,
      EVENTS.CACHE_INVALIDATED,
      EVENTS.CACHE_UPDATED,
      EVENTS.RENDER_PRIORITIZE,
      EVENTS.PITCH_LOADED,
      EVENTS.PITCH_CHANGED,
      EVENTS.PITCH_EDITOR_MODE_CHANGED,
    ]) {
      eventBus.on(eventName, () => this.requestDraw())
    }
    eventBus.on(EVENTS.CACHE_MISS, () => {
      this.requestDraw()
    })
  }

  _darkenColor(hexColor) {
    const ratio = 1 - PIANO_ROLL.NOTE_BORDER_DARKEN_RATIO
    const hex = hexColor.replace('#', '')
    const rgb = hex.match(/.{2}/g).map((channel) => Math.round(parseInt(channel, 16) * ratio))
    return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
}

export default new PianoRollNotes()
