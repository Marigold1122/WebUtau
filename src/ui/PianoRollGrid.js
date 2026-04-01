import { PIANO_ROLL } from '../config/constants.js'
import viewport from './PianoRollViewport.js'

class PianoRollGrid {
  constructor() {
    this.canvas = null
    this.ctx = null
    this.keyboardCanvas = null
    this.keyboardCtx = null
    this.timeRulerCanvas = null
    this.timeRulerCtx = null
    this.visibleBeatCacheKey = ''
    this.visibleBeatCache = []
  }

  init(gridCanvas, keyboardCanvas, timeRulerCanvas) {
    this.canvas = gridCanvas
    this.ctx = gridCanvas.getContext('2d')
    this.keyboardCanvas = keyboardCanvas
    this.keyboardCtx = keyboardCanvas.getContext('2d')
    this.timeRulerCanvas = timeRulerCanvas
    this.timeRulerCtx = timeRulerCanvas.getContext('2d')
  }

  draw() {
    if (!this.ctx || !this.keyboardCtx || !this.timeRulerCtx) return
    const beats = this._getVisibleBeats()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.keyboardCtx.clearRect(0, 0, this.keyboardCanvas.width, this.keyboardCanvas.height)
    this.timeRulerCtx.clearRect(0, 0, this.timeRulerCanvas.width, this.timeRulerCanvas.height)
    this._drawKeyRows()
    this._drawBeatLines(beats)
    this._drawKeyboard()
    this._drawTimeRuler(beats)
  }

  _drawKeyRows() {
    const visible = viewport.getVisiblePitchRange()
    const high = Math.min(PIANO_ROLL.PITCH_MAX, visible.high)
    const low = Math.max(PIANO_ROLL.PITCH_MIN, visible.low)
    for (let midiPitch = high; midiPitch >= low; midiPitch -= 1) {
      const y = viewport.pitchToY(midiPitch)
      this.ctx.fillStyle = this._isBlackKey(midiPitch) ? PIANO_ROLL.BLACK_KEY_COLOR : PIANO_ROLL.WHITE_KEY_COLOR
      this.ctx.fillRect(0, y, this.canvas.width, PIANO_ROLL.KEY_HEIGHT)
      if (!this._isC(midiPitch)) continue
      this.ctx.strokeStyle = PIANO_ROLL.BAR_LINE_COLOR
      this.ctx.beginPath()
      this.ctx.moveTo(0, y)
      this.ctx.lineTo(this.canvas.width, y)
      this.ctx.stroke()
    }
  }

  _drawBeatLines(beats = []) {
    for (const beat of beats) {
      const x = viewport.timeToX(beat.time)
      this.ctx.strokeStyle = beat.isBar ? PIANO_ROLL.BAR_LINE_COLOR : PIANO_ROLL.GRID_LINE_COLOR
      this.ctx.lineWidth = beat.isBar ? PIANO_ROLL.BAR_LINE_WIDTH : 1
      this.ctx.beginPath()
      this.ctx.moveTo(x, 0)
      this.ctx.lineTo(x, this.canvas.height)
      this.ctx.stroke()
    }
    this.ctx.lineWidth = 1
  }

  _drawTimeRuler(beats = []) {
    this.timeRulerCtx.fillStyle = PIANO_ROLL.TIME_RULER_BG
    this.timeRulerCtx.fillRect(0, 0, this.timeRulerCanvas.width, this.timeRulerCanvas.height)
    this.timeRulerCtx.strokeStyle = PIANO_ROLL.TIME_RULER_TICK_COLOR
    this.timeRulerCtx.fillStyle = PIANO_ROLL.TIME_RULER_TEXT_COLOR
    this.timeRulerCtx.font = PIANO_ROLL.TIME_RULER_FONT
    this.timeRulerCtx.textAlign = 'left'
    this.timeRulerCtx.textBaseline = 'top'
    let lastLabelRight = -Infinity
    for (const beat of beats) {
      const x = viewport.timeToX(beat.time)
      const top = beat.isBar ? 0 : PIANO_ROLL.TIME_RULER_HEIGHT * 0.5
      this.timeRulerCtx.lineWidth = beat.isBar ? PIANO_ROLL.BAR_LINE_WIDTH : 1
      this.timeRulerCtx.beginPath()
      this.timeRulerCtx.moveTo(x, top)
      this.timeRulerCtx.lineTo(x, this.timeRulerCanvas.height)
      this.timeRulerCtx.stroke()
      if (beat.isBar) {
        const text = String(beat.barNumber)
        const textX = x + 3
        const textWidth = this.timeRulerCtx.measureText(text).width
        if (textX > lastLabelRight + 6) {
          this.timeRulerCtx.fillText(text, textX, 2)
          lastLabelRight = textX + textWidth
        }
      }
    }
    this.timeRulerCtx.lineWidth = 1
  }

  // 分层过滤：先保留所有间距够的小节线，再在小节线之间填拍线
  _filterByMinGap(beats, minGap) {
    if (beats.length === 0) return beats
    const result = []
    let lastX = -Infinity
    // 第一轮：小节线（优先保留）
    for (const beat of beats) {
      if (!beat.isBar) continue
      const x = viewport.timeToX(beat.time)
      if (x - lastX >= minGap || lastX === -Infinity) {
        result.push(beat)
        lastX = x
      }
    }
    // 第二轮：在已保留的线之间插入拍线
    const barSet = new Set(result.map(b => b.time))
    lastX = -Infinity
    const merged = []
    for (const beat of beats) {
      const x = viewport.timeToX(beat.time)
      if (barSet.has(beat.time)) {
        merged.push(beat)
        lastX = x
        continue
      }
      if (x - lastX >= minGap) {
        merged.push(beat)
        lastX = x
      }
    }
    return merged
  }

  _getVisibleBeats() {
    const visible = viewport.getVisibleTimeRange()
    const cacheKey = [
      viewport.beatVersion,
      viewport.pixelsPerSecond.toFixed(4),
      visible.start.toFixed(4),
      visible.end.toFixed(4),
    ].join(':')
    if (cacheKey === this.visibleBeatCacheKey) return this.visibleBeatCache

    const filtered = this._filterByMinGap(
      viewport.getBeatTimesInRange(visible.start, visible.end),
      PIANO_ROLL.GRID_MIN_GAP_PX,
    )
    this.visibleBeatCacheKey = cacheKey
    this.visibleBeatCache = filtered
    return filtered
  }

  _drawKeyboard() {
    const visible = viewport.getVisiblePitchRange()
    const high = Math.min(PIANO_ROLL.PITCH_MAX, visible.high)
    const low = Math.max(PIANO_ROLL.PITCH_MIN, visible.low)
    this.keyboardCtx.textAlign = 'center'
    this.keyboardCtx.textBaseline = 'middle'
    this.keyboardCtx.font = PIANO_ROLL.TIME_RULER_FONT
    for (let midiPitch = high; midiPitch >= low; midiPitch -= 1) {
      const y = viewport.pitchToY(midiPitch)
      this.keyboardCtx.fillStyle = PIANO_ROLL.WHITE_KEY_COLOR
      this.keyboardCtx.fillRect(0, y, this.keyboardCanvas.width, PIANO_ROLL.KEY_HEIGHT)
      if (this._isBlackKey(midiPitch)) {
        this.keyboardCtx.fillStyle = PIANO_ROLL.BLACK_KEY_COLOR
        this.keyboardCtx.fillRect(0, y, PIANO_ROLL.KEYBOARD_WIDTH * PIANO_ROLL.KEYBOARD_BLACK_WIDTH_RATIO, PIANO_ROLL.KEY_HEIGHT)
      } else {
        this.keyboardCtx.strokeStyle = PIANO_ROLL.KEY_BORDER_COLOR
        this.keyboardCtx.beginPath()
        this.keyboardCtx.moveTo(0, y + PIANO_ROLL.KEY_HEIGHT)
        this.keyboardCtx.lineTo(this.keyboardCanvas.width, y + PIANO_ROLL.KEY_HEIGHT)
        this.keyboardCtx.stroke()
      }
      if (!this._isC(midiPitch)) continue
      this.keyboardCtx.fillStyle = PIANO_ROLL.KEY_LABEL_COLOR
      this.keyboardCtx.fillText(this._getNoteName(midiPitch), PIANO_ROLL.KEYBOARD_WIDTH / 2, y + PIANO_ROLL.KEY_HEIGHT / 2)
    }
  }

  _isBlackKey(midiPitch) {
    return PIANO_ROLL.BLACK_KEY_PITCHES.includes(midiPitch % 12)
  }

  _isC(midiPitch) {
    return midiPitch % 12 === 0
  }

  _getNoteName(midiPitch) {
    return `C${Math.floor(midiPitch / 12) - 1}`
  }
}

export default new PianoRollGrid()
