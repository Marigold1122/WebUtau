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
    this.axis = null
    this.time = 0
    this.rulerHead = null
    this.timelineLine = null
    this.lastRenderedX = null
    this.lastTraceAtMs = 0
  }

  syncContainers({ rulerInner, timelineContent }) {
    this.rulerHead = ensureElement(rulerInner, 'timeline-playhead-head')
    this.timelineLine = ensureElement(timelineContent, 'timeline-playhead-line')
    this._syncVisibility()
    this._syncPosition()
  }

  setAxis(axis) {
    this.axis = axis || null
    this.lastRenderedX = null
    this._syncVisibility()
    this._syncPosition()
  }

  setTime(time) {
    this.time = Number.isFinite(time) ? Math.max(0, time) : 0
    this._syncPosition()
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
