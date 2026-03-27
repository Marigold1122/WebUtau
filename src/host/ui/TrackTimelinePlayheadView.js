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
  element.style.transform = `translateX(${Math.round(x)}px)`
}

export class TrackTimelinePlayheadView {
  constructor(options = {}) {
    this.logger = options.logger || null
    this.axis = null
    this.time = 0
    this.rulerHead = null
    this.timelineLine = null
    this.lastRoundedX = null
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
    this.lastRoundedX = null
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
    const x = Math.round(this.axis.timeToX(this.time))
    if (this.lastRoundedX === x) return
    this.lastRoundedX = x
    setTransformX(this.rulerHead, x)
    setTransformX(this.timelineLine, x)
    const now = performance.now()
    if (this.logger?.info && now - this.lastTraceAtMs >= 200) {
      this.lastTraceAtMs = now
      this.logger.info('轨道播放头位置同步', {
        time: this.time,
        x,
      })
    }
  }
}
