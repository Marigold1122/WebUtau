import { PIANO_ROLL } from '../config/constants.js'
import { PLAYHEAD_FOLLOW_MODES, computeFollowScrollLeft, normalizePlayheadFollowMode } from '../shared/playheadFollowMode.js'
import { createTimelineAxis } from '../shared/timelineAxis.js'
import { createTempoDocument } from '../shared/tempoDocument.js'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

class PianoRollViewport {
  constructor() {
    this.scrollX = 0
    this.scrollY = 0
    this.canvasWidth = 0
    this.canvasHeight = 0
    this.tempoData = null
    this.axis = null
    this.beatVersion = 0
    this.pixelsPerSecond = PIANO_ROLL.PIXELS_PER_SECOND
    this.playheadFollowMode = PLAYHEAD_FOLLOW_MODES.PUSH
  }

  timeToX(seconds) {
    return seconds * this.pixelsPerSecond - this.scrollX
  }

  xToTime(pixelX) {
    return (pixelX + this.scrollX) / this.pixelsPerSecond
  }

  durationToWidth(seconds) {
    return seconds * this.pixelsPerSecond
  }

  pitchToY(midiPitch) {
    return (PIANO_ROLL.PITCH_MAX - midiPitch) * PIANO_ROLL.KEY_HEIGHT - this.scrollY
  }

  yToPitchValue(pixelY) {
    return PIANO_ROLL.PITCH_MAX + 0.5 - ((pixelY + this.scrollY) / PIANO_ROLL.KEY_HEIGHT)
  }

  yToPitch(pixelY) {
    return PIANO_ROLL.PITCH_MAX - Math.floor((pixelY + this.scrollY) / PIANO_ROLL.KEY_HEIGHT)
  }

  zoomAtCursor(mouseX, wheelDelta) {
    const oldPps = this.pixelsPerSecond
    const factor = Math.pow(2, -wheelDelta * 0.002)
    const newPps = clamp(oldPps * factor, PIANO_ROLL.MIN_PPS, PIANO_ROLL.MAX_PPS)
    if (newPps === oldPps) return false

    const timeAtCursor = (this.scrollX + mouseX) / oldPps
    this.pixelsPerSecond = newPps
    this.scrollX = Math.max(0, timeAtCursor * newPps - mouseX)
    return true
  }

  scrollByX(deltaPixels) {
    this.scrollX = Math.max(0, this.scrollX + deltaPixels)
  }

  scrollByY(deltaPixels) {
    const maxY = (PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1) * PIANO_ROLL.KEY_HEIGHT - this.canvasHeight
    this.scrollY = clamp(this.scrollY + deltaPixels, 0, Math.max(0, maxY))
  }

  getVisibleTimeRange() {
    return { start: this.xToTime(0), end: this.xToTime(this.canvasWidth) }
  }

  getVisiblePitchRange() {
    return { high: this.yToPitch(0), low: this.yToPitch(this.canvasHeight) }
  }

  setSize(width, height) {
    this.canvasWidth = width
    this.canvasHeight = height
    this.scrollByY(0)
  }

  setTempoData(tempoData) {
    this.tempoData = createTempoDocument(tempoData)
    this.axis = createTimelineAxis({
      tempoData: this.tempoData,
      ppq: 480,
      totalTicks: 0,
    })
    this.beatVersion += 1
  }

  getBeatTimesInRange(startTime, endTime) {
    if (endTime < startTime) return []
    if (!this.axis) this.setTempoData(null)
    const startTick = this.axis.timeToTick(startTime)
    const endTick = this.axis.timeToTick(endTime)
    return this.axis.getRulerMarksInRange({
      startTick,
      endTick,
      subdivisionsPerBeat: 1,
    }).map((mark) => ({
      time: mark.time,
      isBeat: true,
      isBar: mark.isBar,
      barNumber: mark.barNumber,
      beatNumber: mark.beatNumber,
    }))
  }

  setPlayheadFollowMode(mode) {
    this.playheadFollowMode = normalizePlayheadFollowMode(mode)
    return this.playheadFollowMode
  }

  getPlayheadFollowMode() {
    return this.playheadFollowMode
  }

  syncPlaybackScroll(seconds) {
    const targetX = seconds * this.pixelsPerSecond
    this.scrollX = computeFollowScrollLeft({
      mode: this.playheadFollowMode,
      currentScrollLeft: this.scrollX,
      playheadX: targetX,
      viewportWidth: this.canvasWidth,
      contentWidth: Math.max(this.canvasWidth, targetX + this.canvasWidth),
      padding: PIANO_ROLL.AUTO_SCROLL_PADDING,
    })
  }
}

export default new PianoRollViewport()
