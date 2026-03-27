export class MenubarTransportView {
  constructor(refs, handlers = {}, options = {}) {
    this.refs = refs
    this.handlers = handlers
    this.logger = options.logger || null
    this.playbackActive = false
  }

  init() {
    this.refs.btnTopPrev?.addEventListener('click', (event) => {
      this.logger?.info?.('顶部播放控制点击', {
        control: 'prev',
        targetId: event.currentTarget?.id || null,
        playbackActive: this.playbackActive,
      })
      this.handlers.onStep?.(-1)
    })
    this.refs.btnTopPlay?.addEventListener('click', (event) => {
      this.logger?.info?.('顶部播放控制点击', {
        control: 'play',
        targetId: event.currentTarget?.id || null,
        playbackActive: this.playbackActive,
      })
      this.handlers.onPlay?.()
    })
    this.refs.btnTopStop?.addEventListener('click', (event) => {
      this.logger?.info?.('顶部播放控制点击', {
        control: 'stop',
        targetId: event.currentTarget?.id || null,
        playbackActive: this.playbackActive,
      })
      this.handlers.onStop?.()
    })
    this.refs.btnTopRecord?.addEventListener('click', (event) => {
      this.logger?.info?.('顶部播放控制点击', {
        control: 'record',
        targetId: event.currentTarget?.id || null,
      })
      this.handlers.onRecord?.()
    })
    this.refs.btnTopNext?.addEventListener('click', (event) => {
      this.logger?.info?.('顶部播放控制点击', {
        control: 'next',
        targetId: event.currentTarget?.id || null,
        playbackActive: this.playbackActive,
      })
      this.handlers.onStep?.(1)
    })
    this.setPlaybackActive(false)
    this.setRecordingActive(false)
  }

  setPlaybackActive(active) {
    this.playbackActive = Boolean(active)
    const button = this.refs.btnTopPlay
    if (!button) return
    button.classList.toggle('is-playing', this.playbackActive)
    const title = this.playbackActive ? '暂停' : '播放'
    button.title = title
    button.setAttribute('aria-label', title)
  }

  setRecordingActive(active) {
    const button = this.refs.btnTopRecord
    if (!button) return
    button.classList.toggle('is-recording', Boolean(active))
    button.title = active ? '停止 MIDI 录制' : '开始 MIDI 录制'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-pressed', String(Boolean(active)))
  }

  setRecordingEnabled(enabled) {
    const button = this.refs.btnTopRecord
    if (!button) return
    button.disabled = !enabled
  }
}
