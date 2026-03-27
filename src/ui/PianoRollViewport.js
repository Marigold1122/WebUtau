import { PIANO_ROLL } from '../config/constants.js'
import { createTempoDocument } from '../shared/tempoDocument.js'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

class PianoRollViewport {
  constructor() {
    this.scrollX = 0
    this.scrollY = 0
    this.canvasWidth = 0
    this.canvasHeight = 0
    this.tempoData = null
    this.pixelsPerSecond = PIANO_ROLL.PIXELS_PER_SECOND
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
  }

  getBeatTimesInRange(startTime, endTime) {
    if (endTime < startTime) return []
    if (!this.tempoData) this.setTempoData(null)
    const beats = []
    const tempos = this.tempoData.tempos
    const timeSignatures = this.tempoData.timeSignatures
    const epsilon = 0.000001
    let time = 0
    let tempoIndex = 0
    let signatureIndex = 0
    let barNumber = 1
    let beatNumber = 1
    while (time <= endTime + epsilon) {
      while (tempoIndex + 1 < tempos.length && tempos[tempoIndex + 1].time <= time + epsilon) tempoIndex += 1
      while (signatureIndex + 1 < timeSignatures.length && timeSignatures[signatureIndex + 1].time <= time + epsilon) {
        signatureIndex += 1
        if (time > epsilon && beatNumber !== 1) barNumber += 1
        beatNumber = 1
      }
      if (time >= startTime - epsilon) beats.push({ time, isBeat: true, isBar: beatNumber === 1, barNumber, beatNumber })
      const [beatsPerBar, beatUnit] = timeSignatures[signatureIndex].timeSignature
      const beatInterval = (60 / tempos[tempoIndex].bpm) * (4 / beatUnit)
      const nextTempoTime = tempos[tempoIndex + 1]?.time ?? Infinity
      const nextSignatureTime = timeSignatures[signatureIndex + 1]?.time ?? Infinity
      const nextChangeTime = Math.min(nextTempoTime, nextSignatureTime)
      time = nextChangeTime > time + epsilon && nextChangeTime < time + beatInterval ? nextChangeTime : time + beatInterval
      if (beatNumber >= beatsPerBar) {
        barNumber += 1
        beatNumber = 1
      } else beatNumber += 1
    }
    return beats.filter((beat) => beat.time <= endTime + epsilon)
  }

  ensureTimeVisible(seconds) {
    const targetX = seconds * this.pixelsPerSecond
    if (targetX < this.scrollX) this.scrollX = Math.max(0, targetX - PIANO_ROLL.AUTO_SCROLL_PADDING)
    if (targetX > this.scrollX + this.canvasWidth) this.scrollX = Math.max(0, targetX - this.canvasWidth + PIANO_ROLL.AUTO_SCROLL_PADDING)
  }
}

export default new PianoRollViewport()
