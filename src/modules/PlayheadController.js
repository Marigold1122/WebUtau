import eventBus from '../core/EventBus.js'
import { EVENTS, PLAYHEAD_STATE } from '../config/constants.js'
import viewport from '../ui/PianoRollViewport.js'

const STATE_CLASSES = ['playhead--playing', 'playhead--waiting', 'playhead--stopped']

function normalizeTime(time) {
  return Number.isFinite(time) ? Math.max(0, time) : 0
}

class PlayheadController {
  constructor() {
    this.state = PLAYHEAD_STATE.STOPPED
    this.position = 0
    this.element = null
    this.containerElement = null
    this.isDragging = false
    this.renderedX = null
  }

  init(playheadElement) {
    this.element = playheadElement
    this.containerElement = playheadElement.parentElement
    this.renderedX = null
    this._setupDrag()
    this.setPosition(this.position)
    this.setState(this.state)
    console.log('[PlayheadController] 已初始化')
  }

  _setupDrag() {
    this.element.addEventListener('mousedown', () => {
      this.isDragging = true
    })

    document.addEventListener('mousemove', (event) => {
      if (!this.isDragging || !this.containerElement) return
      const rect = this.containerElement.getBoundingClientRect()
      const offsetX = event.clientX - rect.left
      const clampedX = Math.max(0, Math.min(offsetX, this.containerElement.clientWidth))
      this.setPosition(viewport.xToTime(clampedX), { allowDuringDrag: true })
    })

    document.addEventListener('mouseup', () => {
      if (!this.isDragging) return
      this.isDragging = false
      eventBus.emit(EVENTS.TRANSPORT_SEEK, { time: this.position })
    })
  }

  setPosition(time, options = {}) {
    const { allowDuringDrag = false } = options
    if (this.isDragging && !allowDuringDrag) return
    this.position = normalizeTime(time)
    if (!this.element) return
    const nextX = viewport.timeToX(this.position)
    if (this.renderedX != null && Math.abs(this.renderedX - nextX) < 0.01) return
    this.renderedX = nextX
    this.element.style.transform = `translateX(${nextX}px)`
  }

  setState(newState) {
    this.state = newState
    if (!this.element) return
    this.element.classList.remove(...STATE_CLASSES)
    if (newState === PLAYHEAD_STATE.PLAYING) this.element.classList.add('playhead--playing')
    if (newState === PLAYHEAD_STATE.WAITING) this.element.classList.add('playhead--waiting')
    if (newState === PLAYHEAD_STATE.STOPPED) this.element.classList.add('playhead--stopped')
  }

  getPosition() {
    return this.position
  }

  getState() {
    return this.state
  }
}

export default new PlayheadController()
