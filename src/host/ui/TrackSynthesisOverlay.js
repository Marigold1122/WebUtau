function getRefs() {
  return {
    overlay: document.getElementById('track-synthesis-overlay'),
    title: document.getElementById('track-synthesis-title'),
    text: document.getElementById('track-synthesis-text'),
    fill: document.getElementById('track-synthesis-fill'),
  }
}

export class TrackSynthesisOverlay {
  constructor() {
    this.refs = getRefs()
  }

  show(trackName, text, options = {}) {
    this.refs.title.textContent = options.title || `${trackName} 正在预测音高`
    this.refs.text.textContent = text || '准备中...'
    const initialPercent = Number.isFinite(options.initialPercent) ? options.initialPercent : 8
    this.refs.fill.style.width = `${Math.max(0, Math.min(100, initialPercent))}%`
    this.refs.overlay.classList.add('is-open')
    document.body.classList.add('modal-open')
  }

  update(text, ratio = null) {
    if (text) this.refs.text.textContent = text
    if (Number.isFinite(ratio)) {
      const width = Math.max(8, Math.min(100, Math.round(ratio * 100)))
      this.refs.fill.style.width = `${width}%`
    }
  }

  hide() {
    this.refs.overlay.classList.remove('is-open')
    document.body.classList.remove('modal-open')
  }
}
