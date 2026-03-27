import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'

class PrepareOverlay {
  constructor() {
    this._overlay = null
    this._shown = false
  }

  init() {
    eventBus.on(EVENTS.JOB_SUBMITTED, () => this.show())
    eventBus.on(EVENTS.PHRASES_REBUILT, () => this.hide())
    eventBus.on(EVENTS.JOB_FAILED, () => this.hide())
  }

  show() {
    if (this._shown) return
    this._shown = true

    this._overlay = document.createElement('div')
    this._overlay.className = 'prepare-overlay'
    this._overlay.innerHTML = `
      <div class="prepare-overlay-content">
        <div class="prepare-spinner"></div>
        <div class="prepare-text">正在分析音高和音素...</div>
      </div>
    `
    document.body.appendChild(this._overlay)
  }

  hide() {
    if (!this._shown) return
    this._shown = false
    if (this._overlay) {
      this._overlay.remove()
      this._overlay = null
    }
  }
}

export default new PrepareOverlay()
