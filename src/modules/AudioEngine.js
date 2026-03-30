import eventBus from '../core/EventBus.js'
import { EVENTS, PLAYHEAD_STATE, RENDER_PRIORITY } from '../config/constants.js'
import renderCache from './RenderCache.js'
import renderScheduler from './RenderScheduler.js'
import playheadController from './PlayheadController.js'

const SCHEDULER_INTERVAL = 25
const LOOKAHEAD = 0.1
const M = '[播放引擎]'

class AudioEngine {
  constructor() {
    this.audioContext = null
    this.phrases = []
    this._playing = false
    this._buffering = false
    this._bufferingPhraseIndex = null
    this._seekPosition = 0
    this._playStartContextTime = 0
    this._playStartSongTime = 0
    this._scheduledSources = new Map()
    this._schedulerTimer = null
    this._uiRafId = null

    eventBus.on(EVENTS.CACHE_UPDATED, ({ phraseIndex } = {}) => {
      this._handlePhraseCacheReady(phraseIndex)
    })
  }

  async _ensureContext() {
    if (!this.audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      this.audioContext = new Ctx()
      console.log(`${M} 创建音频上下文 | 采样率=${this.audioContext.sampleRate}`)
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
  }

  isPlaying() {
    return this._playing
  }

  isBuffering() {
    return this._buffering
  }

  getSongTime() {
    if (!this._playing) return this._seekPosition
    if (this._buffering) return this._seekPosition
    return this._playStartSongTime + (this.audioContext.currentTime - this._playStartContextTime)
  }

  async play() {
    if (this._playing) return
    await this._ensureContext()

    this._playing = true
    this._buffering = false
    this._bufferingPhraseIndex = null
    this._playStartContextTime = this.audioContext.currentTime
    this._playStartSongTime = this._seekPosition

    console.log(`▶ ${M} 开始播放 | 从=${this._seekPosition.toFixed(3)}s`)

    this._startScheduler()
    this._startUILoop()
    playheadController.setState(PLAYHEAD_STATE.PLAYING)
    eventBus.emit(EVENTS.TRANSPORT_PLAY, { time: this._seekPosition })
  }

  pause() {
    if (!this._playing) return
    const pos = this.getSongTime()
    console.log(`▶ ${M} 暂停 | 位置=${pos.toFixed(3)}s`)

    this._seekPosition = pos
    this._playing = false
    this._buffering = false
    this._bufferingPhraseIndex = null
    this._stopAllSources()
    this._stopScheduler()
    this._stopUILoop()
    playheadController.setState(PLAYHEAD_STATE.STOPPED)
    eventBus.emit(EVENTS.TRANSPORT_PAUSE, { time: this._seekPosition })
  }

  seek(time) {
    const newPos = Math.max(0, time)
    console.log(`▶ ${M} 跳转 | ${this._seekPosition.toFixed(3)}s → ${newPos.toFixed(3)}s, 播放中=${this._playing}`)

    this._seekPosition = newPos

    if (this._playing) {
      this._stopAllSources()
      this._buffering = false
      this._bufferingPhraseIndex = null
      this._playStartContextTime = this.audioContext.currentTime
      this._playStartSongTime = newPos
      playheadController.setState(PLAYHEAD_STATE.PLAYING)
    }

    playheadController.setPosition(newPos)
    eventBus.emit(EVENTS.TRANSPORT_SEEK_UPDATE, { time: newPos, playing: this._playing })
  }

  cancelPhrases(indices) {
    for (const idx of indices) {
      const info = this._scheduledSources.get(idx)
      if (info) {
        try {
          info.source.stop()
          info.source.disconnect()
        } catch (e) {}
        this._scheduledSources.delete(idx)
        console.log(`${M} 取消已调度 | 第${idx}句`)
      }
    }
  }

  updatePhrases(phrases, keepPosition) {
    const oldCount = this.phrases.length
    this.phrases = phrases
    console.log(`${M} 更新句子 | ${oldCount} → ${phrases.length}, 保持位置=${keepPosition}`)

    if (this._playing) {
      const pos = keepPosition ? this.getSongTime() : 0
      this._stopAllSources()
      this._buffering = false
      this._bufferingPhraseIndex = null
      this._playStartContextTime = this.audioContext.currentTime
      this._playStartSongTime = pos
      this._seekPosition = pos
    } else if (!keepPosition) {
      this._seekPosition = 0
      playheadController.setPosition(0)
    }
  }

  // --- 调度循环 ---

  _startScheduler() {
    this._stopScheduler()
    this._schedulerTick()
  }

  _stopScheduler() {
    if (this._schedulerTimer !== null) {
      clearTimeout(this._schedulerTimer)
      this._schedulerTimer = null
    }
  }

  _schedulerTick() {
    if (!this._playing) return

    const songTime = this.getSongTime()
    const windowEnd = songTime + LOOKAHEAD

    // 清理已播放完的 source
    for (const [idx, info] of this._scheduledSources) {
      if (info.endTime <= songTime) {
        this._scheduledSources.delete(idx)
      }
    }

    // 歌曲结束检测
    if (this.phrases.length > 0) {
      const lastPhrase = this.phrases[this.phrases.length - 1]
      const lastEnd = this._getPhraseEndSec(lastPhrase)
      if (songTime > lastEnd) {
        console.log(`${M} 歌曲播放完毕 | ${songTime.toFixed(3)}s > ${lastEnd.toFixed(3)}s`)
        this.pause()
        return
      }
    }

    // 遍历窗口内的 phrases
    let blocked = false
    for (let i = 0; i < this.phrases.length; i++) {
      const phrase = this.phrases[i]
      const phraseStart = this._getPhraseStartSec(phrase, i)
      const phraseEnd = this._getPhraseEndSec(phrase, i)

      if (phraseEnd <= songTime) continue
      if (phraseStart > windowEnd) break

      if (this._scheduledSources.has(i)) continue

      if (renderCache.isValid(i, phrase.inputHash)) {
        this._schedulePhrase(i, phraseStart, phraseEnd)
      } else {
        this._enterBuffering(i)
        blocked = true
        break
      }
    }

    if (this._buffering && !blocked) {
      this._exitBuffering()
    }

    this._schedulerTimer = setTimeout(() => this._schedulerTick(), SCHEDULER_INTERVAL)
  }

  _enterBuffering(phraseIndex) {
    if (this._buffering && this._bufferingPhraseIndex === phraseIndex) return
    this._seekPosition = this.getSongTime()
    this._buffering = true
    this._bufferingPhraseIndex = phraseIndex
    playheadController.setState(PLAYHEAD_STATE.WAITING)
    renderScheduler.enqueue(phraseIndex, RENDER_PRIORITY.URGENT)
    console.log(`${M} 等待缓存 | 第${phraseIndex}句, 播放头=${this._seekPosition.toFixed(3)}s`)
  }

  _exitBuffering() {
    console.log(`${M} 缓存就绪 → 恢复播放 | 从=${this._seekPosition.toFixed(3)}s`)
    this._buffering = false
    this._bufferingPhraseIndex = null
    this._playStartContextTime = this.audioContext.currentTime
    this._playStartSongTime = this._seekPosition
    playheadController.setState(PLAYHEAD_STATE.PLAYING)
  }

  _handlePhraseCacheReady(phraseIndex) {
    if (!this._playing || !this._buffering) return
    if (!Number.isInteger(phraseIndex)) return
    if (phraseIndex !== this._bufferingPhraseIndex) return
    console.log(`${M} 等待句缓存已就绪 | 第${phraseIndex}句 → 立即尝试恢复播放`)
    this._stopScheduler()
    this._schedulerTick()
  }

  // --- 单句调度 ---

  _schedulePhrase(phraseIndex, phraseStartSec, phraseEndSec) {
    const entry = renderCache.get(phraseIndex)
    if (!entry || !entry.audioBuffer) return

    const songTime = this.getSongTime()
    if (phraseEndSec <= songTime) return

    const delayFromNow = phraseStartSec - songTime
    const contextNow = this.audioContext.currentTime
    const source = this.audioContext.createBufferSource()
    source.buffer = entry.audioBuffer
    source.connect(this.audioContext.destination)

    if (delayFromNow >= 0) {
      source.start(contextNow + delayFromNow)
    } else {
      const offset = -delayFromNow
      if (offset >= entry.audioBuffer.duration) return
      source.start(contextNow, offset)
    }

    source.onended = () => {
      source.disconnect()
      this._scheduledSources.delete(phraseIndex)
    }

    this._scheduledSources.set(phraseIndex, {
      source,
      startTime: phraseStartSec,
      endTime: phraseEndSec,
    })
  }

  _getPhraseStartSec(phrase, index) {
    const timeInfo = renderCache.getTimeInfo(index)
    return timeInfo ? timeInfo.startMs / 1000 : phrase.startTime
  }

  _getPhraseEndSec(phrase, index) {
    const timeInfo = renderCache.getTimeInfo(index)
    if (timeInfo) return (timeInfo.startMs + timeInfo.durationMs) / 1000
    return phrase.endTime
  }

  // --- 音频源管理 ---

  _stopAllSources() {
    const count = this._scheduledSources.size
    for (const [, info] of this._scheduledSources) {
      try {
        info.source.onended = null
        info.source.stop()
        info.source.disconnect()
      } catch (e) {}
    }
    this._scheduledSources.clear()
    if (count > 0) console.log(`${M} 停止全部 | ${count}个音频源`)
  }

  // --- UI 更新循环 ---

  _startUILoop() {
    this._stopUILoop()
    const loop = () => {
      if (!this._playing) return
      const songTime = this.getSongTime()
      playheadController.setPosition(songTime)
      eventBus.emit(EVENTS.TRANSPORT_TICK, { time: songTime })
      this._uiRafId = requestAnimationFrame(loop)
    }
    this._uiRafId = requestAnimationFrame(loop)
  }

  _stopUILoop() {
    if (this._uiRafId !== null) {
      cancelAnimationFrame(this._uiRafId)
      this._uiRafId = null
    }
  }
}

export default new AudioEngine()
