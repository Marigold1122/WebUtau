import { createHorizontalDragAutoScroller } from '../../shared/horizontalDragAutoScroll.js'

function ensureElement(parent, className) {
  let element = parent?.querySelector(`.${className}`)
  if (element) return element
  element = document.createElement('div')
  element.className = className
  parent?.appendChild(element)
  return element
}

function setTransformX(element, x) {
  if (!element) return
  element.style.transform = `translateX(${x}px)`
}

export class TrackTimelinePlayheadView {
  constructor(options = {}) {
    this.logger = options.logger || null
    this.getViewportElement = typeof options.getViewportElement === 'function'
      ? options.getViewportElement
      : null
    this.onSeekRequested = typeof options.onSeekRequested === 'function'
      ? options.onSeekRequested
      : null
    this.axis = null
    this.time = 0
    this.rulerHead = null
    this.timelineLine = null
    this.lastRenderedX = null
    this.lastTraceAtMs = 0
    this.isDragging = false
    this.dragClientX = null
    this.dragTimelineX = 0
    this.dragScroller = createHorizontalDragAutoScroller({
      getViewportRect: () => this.getViewportElement?.()?.getBoundingClientRect?.() || null,
      getScrollLeft: () => this.getViewportElement?.()?.scrollLeft || 0,
      setScrollLeft: (nextScrollLeft) => {
        const viewport = this.getViewportElement?.()
        if (viewport) viewport.scrollLeft = nextScrollLeft
      },
      getMaxScrollLeft: () => {
        const viewport = this.getViewportElement?.()
        if (!viewport) return 0
        return Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      },
      onScroll: () => {
        this._previewDragAtClientX(this.dragClientX)
      },
    })
    this._handleMouseMove = this._handleMouseMove.bind(this)
    this._handleMouseUp = this._handleMouseUp.bind(this)
  }

  syncContainers({ rulerInner, timelineContent }) {
    this.rulerHead = ensureElement(rulerInner, 'timeline-playhead-head')
    this.timelineLine = ensureElement(timelineContent, 'timeline-playhead-line')
    this._bindDragTarget(this.rulerHead)
    this._bindDragTarget(this.timelineLine)
    this._syncVisibility()
    this._syncPosition()
  }

  setAxis(axis) {
    this.axis = axis || null
    this.lastRenderedX = null
    this._syncVisibility()
    this._syncPosition()
  }

  setTime(time, options = {}) {
    const { allowDuringDrag = false } = options
    if (this.isDragging && !allowDuringDrag) return
    this.time = Number.isFinite(time) ? Math.max(0, time) : 0
    this._syncPosition()
  }

  isDraggingPlayhead() {
    return this.isDragging
  }

  _bindDragTarget(element) {
    if (!element || element.dataset.dragBound === 'true') return
    element.dataset.dragBound = 'true'
    element.addEventListener('mousedown', (event) => this._handleMouseDown(event))
  }

  _handleMouseDown(event) {
    if (event.button !== 0 || !this.axis) return
    const viewport = this.getViewportElement?.()
    if (!viewport) return
    event.preventDefault()
    event.stopPropagation()
    this.isDragging = true
    this.dragClientX = event.clientX
    this.dragScroller.start(event.clientX)
    this._previewDragAtClientX(event.clientX)
    document.addEventListener('mousemove', this._handleMouseMove)
    document.addEventListener('mouseup', this._handleMouseUp)
  }

  _handleMouseMove(event) {
    if (!this.isDragging) return
    this.dragClientX = event.clientX
    this.dragScroller.update(event.clientX)
    this._previewDragAtClientX(event.clientX)
  }

  _handleMouseUp() {
    if (!this.isDragging) return
    const commitTimelineX = this.dragTimelineX
    this.isDragging = false
    this.dragClientX = null
    this.dragScroller.stop()
    document.removeEventListener('mousemove', this._handleMouseMove)
    document.removeEventListener('mouseup', this._handleMouseUp)
    this.onSeekRequested?.(commitTimelineX)
  }

  _previewDragAtClientX(clientX) {
    const viewport = this.getViewportElement?.()
    if (!viewport || !this.axis || !Number.isFinite(clientX)) return
    const rect = viewport.getBoundingClientRect()
    const leadingInset = this._getLeadingInset()
    const clampedX = Math.max(leadingInset, Math.min(clientX - rect.left, viewport.clientWidth))
    const timelineX = Math.max(0, clampedX + viewport.scrollLeft - leadingInset)
    this.dragTimelineX = timelineX
    this.setTime(this.axis.xToTime(timelineX), { allowDuringDrag: true })
  }

  _getLeadingInset() {
    const rawValue = getComputedStyle(document.documentElement).getPropertyValue('--track-header-width')
    const parsedValue = Number.parseFloat(rawValue)
    return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 240
  }

  _syncVisibility() {
    const hidden = !this.axis
    if (this.rulerHead) this.rulerHead.hidden = hidden
    if (this.timelineLine) this.timelineLine.hidden = hidden
  }

  _syncPosition() {
    if (!this.axis) return
    const x = this.axis.timeToX(this.time)
    if (this.lastRenderedX != null && Math.abs(this.lastRenderedX - x) < 0.01) return
    this.lastRenderedX = x
    setTransformX(this.rulerHead, x)
    setTransformX(this.timelineLine, x)
    const now = performance.now()
    if (this.logger?.debug && now - this.lastTraceAtMs >= 200) {
      this.lastTraceAtMs = now
      this.logger.debug('playhead', '轨道播放头位置同步', {
        time: this.time,
        x,
      })
    }
  }
}
