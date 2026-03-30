import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'
import audioEngine from './AudioEngine.js'
import { isKeyboardShortcutTargetEditable } from '../shared/isKeyboardShortcutTargetEditable.js'

const M = '[播放控制]'

class TransportControl {
  constructor() {
    this.localInputEnabled = true
  }

  init() {
    document.addEventListener('keydown', (event) => {
      if (event.code !== 'Space') return
      if (!this.localInputEnabled) return
      if (isKeyboardShortcutTargetEditable(event.target)) return
      event.preventDefault()
      this.togglePlayback('用户')
    })

    const btnPlay = document.getElementById('btn-play')
    if (btnPlay) {
      btnPlay.addEventListener('click', () => {
        if (!this.localInputEnabled) return
        this.togglePlayback('用户')
      })
    }

    eventBus.on(EVENTS.TRANSPORT_SEEK, ({ time }) => {
      console.log(`▶ [用户] 拖动播放头 | 目标=${time.toFixed(3)}s`)
      audioEngine.seek(time)
    })

    eventBus.on(EVENTS.PHRASES_REBUILT, ({ phrases }) => {
      console.log(`${M} ← PHRASES_REBUILT | ${phrases.length}句 → 更新(保持位置)`)
      audioEngine.updatePhrases(phrases, true)
    })

    eventBus.on(EVENTS.PHRASES_EDITED, ({ phrases }) => {
      console.log(`${M} ← PHRASES_EDITED | ${phrases.length}句 → 更新(保持位置)`)
      audioEngine.updatePhrases(phrases, true)
    })

    eventBus.on(EVENTS.JOB_FAILED, () => {
      console.log(`${M} ← JOB_FAILED → 暂停`)
      audioEngine.pause()
    })

    console.log(`${M} 初始化完成`)
  }

  setLocalInputEnabled(enabled) {
    this.localInputEnabled = Boolean(enabled)
  }

  togglePlayback(source = '程序') {
    if (audioEngine.isPlaying()) {
      console.log(`▶ [${source}] 按下暂停 | 播放头=${audioEngine.getSongTime().toFixed(3)}s`)
      audioEngine.pause()
      return
    }
    console.log(`▶ [${source}] 按下播放 | 播放头=${audioEngine.getSongTime().toFixed(3)}s`)
    audioEngine.play()
  }

  resetForNewTrack(phrases) {
    console.log(`${M} 新轨道 | ${phrases.length}句 → 重置`)
    audioEngine.pause()
    audioEngine.updatePhrases(phrases, false)
    audioEngine.seek(0)
  }
}

export default new TransportControl()
