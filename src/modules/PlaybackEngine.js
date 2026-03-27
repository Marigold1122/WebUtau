import { PLAYHEAD_STATE } from '../config/constants.js'

class PlaybackEngine {
  constructor() {
    this.state = PLAYHEAD_STATE.STOPPED
    this.currentTime = 0
    this.audioContext = null
    this.currentBuffer = null
    this.sourceNode = null
    this.startedAt = 0
    this.pausedAt = 0
  }

  async _ensureContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      this.audioContext = new AudioContextClass()
    }
    if (this.audioContext.state === 'suspended') await this.audioContext.resume()
    return this.audioContext
  }

  _clearSource() {
    if (!this.sourceNode) return
    this.sourceNode.onended = null
    this.sourceNode.stop()
    this.sourceNode.disconnect()
    this.sourceNode = null
  }

  _startPlayback(offset) {
    const { audioContext, currentBuffer } = this
    this._clearSource()
    this.sourceNode = audioContext.createBufferSource()
    this.sourceNode.buffer = currentBuffer
    this.sourceNode.connect(audioContext.destination)
    this.startedAt = audioContext.currentTime - offset
    this.pausedAt = 0
    this.currentTime = offset
    const sourceNode = this.sourceNode
    sourceNode.onended = () => {
      sourceNode.disconnect()
      if (this.sourceNode === sourceNode) this.sourceNode = null
      if (this.state !== PLAYHEAD_STATE.PLAYING) return
      this.state = PLAYHEAD_STATE.STOPPED
      this.currentTime = 0
      this.startedAt = 0
    }
    sourceNode.start(0, offset)
  }

  setBuffer(audioBuffer) {
    this.currentBuffer = audioBuffer
    this.currentTime = 0
    this.pausedAt = 0
    this.startedAt = 0
  }

  async loadFromUrl(url) {
    const audioContext = await this._ensureContext()
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    this.setBuffer(audioBuffer)
    return audioBuffer
  }

  async play(fromTime) {
    if (!this.currentBuffer) {
      console.warn('没有音频可播放，请先调用 setBuffer 或 loadFromUrl')
      return
    }
    await this._ensureContext()
    const baseTime = Number.isFinite(fromTime) ? fromTime : this.pausedAt > 0 ? this.pausedAt : 0
    const offset = Math.max(0, Math.min(baseTime, this.currentBuffer.duration))
    this.state = PLAYHEAD_STATE.PLAYING
    this._startPlayback(offset)
  }

  playImmediate(fromTime) {
    if (!this.currentBuffer) return
    this._ensureContext()
    if (!this.audioContext) return
    const offset = Math.max(0, Math.min(fromTime, this.currentBuffer.duration))
    this.state = PLAYHEAD_STATE.PLAYING
    this._startPlayback(offset)
  }

  pause() {
    if (this.state !== PLAYHEAD_STATE.PLAYING || !this.audioContext) return
    this.pausedAt = Math.min(this.audioContext.currentTime - this.startedAt, this.getDuration())
    this.currentTime = this.pausedAt
    this._clearSource()
    this.state = PLAYHEAD_STATE.STOPPED
  }

  stop() {
    this._clearSource()
    this.state = PLAYHEAD_STATE.STOPPED
    this.currentTime = 0
    this.pausedAt = 0
    this.startedAt = 0
  }

  async seekTo(time) {
    if (!this.currentBuffer) return
    const clampedTime = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, this.currentBuffer.duration))
    if (this.state === PLAYHEAD_STATE.PLAYING) this._startPlayback(clampedTime)
    else {
      this.pausedAt = clampedTime
      this.currentTime = clampedTime
    }
  }

  getDuration() {
    return this.currentBuffer ? this.currentBuffer.duration : 0
  }

  getCurrentTime() {
    return this.currentTime
  }

  getState() {
    return this.state
  }
}

export default new PlaybackEngine()
