import eventBus from '../core/EventBus.js'
import { EVENTS, PLAYHEAD_STATE } from '../config/constants.js'
import { createHorizontalDragAutoScroller } from '../shared/horizontalDragAutoScroll.js'
import viewport from '../ui/PianoRollViewport.js'

const STATE_CLASSES = ['playhead--playing', 'playhead--waiting', 'playhead--stopped']
const PLAYHEAD_HITBOX_WIDTH = 16

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
    this.lastDragClientX = null
    this.onViewportScrolled = null
    this.dragAutoScroller = null
  }

  init(playheadElement, options = {}) {
    this.element = playheadElement
    this.containerElement = playheadElement.parentElement
    this.renderedX = null
    this._applyHitboxStyles()
    this.onViewportScrolled = typeof options.onViewportScrolled === 'function'
      ? options.onViewportScrolled
      : null
    this.dragAutoScroller = createHorizontalDragAutoScroller({
      getViewportRect: () => this.containerElement?.getBoundingClientRect?.() || null,
      getScrollLeft: () => viewport.scrollX,
      setScrollLeft: (nextScrollLeft) => {
        viewport.scrollX = Math.max(0, nextScrollLeft)
      },
      onScroll: () => {
        this.onViewportScrolled?.()
        this._previewDragAtClientX(this.lastDragClientX)
      },
    })
    this._setupDrag()
    this.setPosition(this.position)
    this.setState(this.state)
    console.log('[PlayheadController] 已初始化')
  }

  _applyHitboxStyles() {
    if (!this.element) return
    this.element.style.width = `${PLAYHEAD_HITBOX_WIDTH}px`
    this.element.style.marginLeft = `${PLAYHEAD_HITBOX_WIDTH / -2}px`
    this.element.style.pointerEvents = 'auto'
    this.element.style.touchAction = 'none'
  }

  _setupDrag() {
    this.element.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      this.isDragging = true
      this.lastDragClientX = event.clientX
      this.dragAutoScroller?.start(event.clientX)
      this._previewDragAtClientX(event.clientX)
    })

    document.addEventListener('mousemove', (event) => {
      if (!this.isDragging || !this.containerElement) return
      this.lastDragClientX = event.clientX
      this.dragAutoScroller?.update(event.clientX)
      this._previewDragAtClientX(event.clientX)
    })

    document.addEventListener('mouseup', () => {
      if (!this.isDragging) return
      this.isDragging = false
      this.lastDragClientX = null
      this.dragAutoScroller?.stop()
      eventBus.emit(EVENTS.TRANSPORT_SEEK, { time: this.position })
    })
  }

  _previewDragAtClientX(clientX) {
    if (!this.containerElement || !Number.isFinite(clientX)) return
    const rect = this.containerElement.getBoundingClientRect()
    const offsetX = clientX - rect.left
    const clampedX = Math.max(0, Math.min(offsetX, this.containerElement.clientWidth))
    this.setPosition(viewport.xToTime(clampedX), { allowDuringDrag: true })
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

  isDraggingPlayhead() {
    return this.isDragging
  }
}

export default new PlayheadController()
