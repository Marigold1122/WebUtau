import eventBus from '../../core/EventBus.js'
import { EVENTS, PLAYHEAD_STATE } from '../../config/constants.js'
import playheadController from '../../modules/PlayheadController.js'

function normalizeTime(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export class EmbeddedPlaybackMirror {
  constructor() {
    this.playing = false
    this.currentTime = 0
    this.duration = 0
    this.frameId = null
    this.clockStartedAtMs = 0
    this.clockStartedSongTime = 0
    this.renderFrame = this.renderFrame.bind(this)
  }

  applyState(payload = {}) {
    const currentTime = normalizeTime(payload.currentTime)
    const playing = Boolean(payload.playing)
    const waiting = Boolean(payload.waiting)
    const duration = normalizeTime(payload.duration)
    this.stopClock()
    this.currentTime = currentTime
    this.duration = duration
    playheadController.setPosition(currentTime)

    if (waiting) {
      playheadController.setState(PLAYHEAD_STATE.WAITING)
      eventBus.emit(EVENTS.TRANSPORT_PAUSE, { time: currentTime })
    } else if (playing) {
      playheadController.setState(PLAYHEAD_STATE.PLAYING)
      eventBus.emit(EVENTS.TRANSPORT_PLAY, { time: currentTime })
    } else {
      playheadController.setState(PLAYHEAD_STATE.STOPPED)
      eventBus.emit(EVENTS.TRANSPORT_PAUSE, { time: currentTime })
      eventBus.emit(EVENTS.TRANSPORT_SEEK_UPDATE, { time: currentTime, playing: false })
    }

    this.playing = playing
  }

  applyTick(payload = {}) {
    if (!this.playing) return
    const currentTime = normalizeTime(payload.currentTime)
    this.currentTime = currentTime
    playheadController.setPosition(currentTime)
    eventBus.emit(EVENTS.TRANSPORT_TICK, { time: currentTime })
  }

  seekTo(time) {
    const currentTime = normalizeTime(time)
    this.currentTime = currentTime
    if (this.playing) {
      this.startClock(currentTime)
    }
    playheadController.setPosition(currentTime)
    eventBus.emit(EVENTS.TRANSPORT_SEEK_UPDATE, { time: currentTime, playing: this.playing })
  }

  reset() {
    this.stopClock()
    this.currentTime = 0
    this.duration = 0
    this.playing = false
    playheadController.setState(PLAYHEAD_STATE.STOPPED)
    playheadController.setPosition(0)
    eventBus.emit(EVENTS.TRANSPORT_SEEK_UPDATE, { time: 0, playing: false })
  }

  startClock(currentTime) {
    this.stopClock()
    this.currentTime = normalizeTime(currentTime)
    this.clockStartedAtMs = performance.now()
    this.clockStartedSongTime = this.currentTime
    playheadController.setPosition(this.currentTime)
    this.frameId = requestAnimationFrame(this.renderFrame)
  }

  stopClock() {
    if (this.frameId != null) {
      cancelAnimationFrame(this.frameId)
      this.frameId = null
    }
  }

  renderFrame() {
    this.frameId = null
    if (!this.playing) return
    const elapsed = (performance.now() - this.clockStartedAtMs) / 1000
    const unclampedTime = this.clockStartedSongTime + Math.max(0, elapsed)
    const currentTime = this.duration > 0 ? Math.min(unclampedTime, this.duration) : unclampedTime
    this.currentTime = currentTime
    playheadController.setPosition(currentTime)
    eventBus.emit(EVENTS.TRANSPORT_TICK, { time: currentTime })
    this.frameId = requestAnimationFrame(this.renderFrame)
  }
}
