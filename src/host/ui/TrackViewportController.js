import { computeFollowScrollLeft, normalizePlayheadFollowMode } from '../../shared/playheadFollowMode.js'

export class TrackViewportController {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this.playheadFollowMode = normalizePlayheadFollowMode(null)
    this._handleViewportScroll = this._handleViewportScroll.bind(this)
    this._handleWheel = this._handleWheel.bind(this)
    this._handleRulerPointerDown = this._handleRulerPointerDown.bind(this)
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    this.refs.trackViewport?.addEventListener('scroll', this._handleViewportScroll)
    this.refs.trackViewport?.addEventListener('wheel', this._handleWheel, { passive: false })
    this.refs.trackRuler?.addEventListener('wheel', this._handleWheel, { passive: false })
    this.refs.trackRuler?.addEventListener('pointerdown', this._handleRulerPointerDown)
    this.syncRulerOffset()
  }

  syncRulerOffset() {
    if (!this.refs.trackRulerInner) return
    this.refs.trackRulerInner.style.transform = `translateX(${-this.getScrollLeft()}px)`
  }

  getScrollLeft() {
    return this.refs.trackViewport?.scrollLeft || 0
  }

  setPlayheadFollowMode(mode) {
    this.playheadFollowMode = normalizePlayheadFollowMode(mode)
    return this.playheadFollowMode
  }

  syncPlaybackFollow(playheadTimelineX) {
    const viewport = this.refs.trackViewport
    if (!viewport || !Number.isFinite(playheadTimelineX)) return false
    const headerWidth = this._getTrackHeaderWidth()
    const playheadContentX = headerWidth + playheadTimelineX
    const nextScrollLeft = computeFollowScrollLeft({
      mode: this.playheadFollowMode,
      currentScrollLeft: viewport.scrollLeft,
      playheadX: playheadContentX,
      viewportWidth: viewport.clientWidth || 0,
      contentWidth: viewport.scrollWidth || 0,
      leadingInset: headerWidth,
    })
    if (Math.abs(nextScrollLeft - viewport.scrollLeft) < 0.5) return false
    viewport.scrollLeft = nextScrollLeft
    return true
  }

  _handleViewportScroll() {
    this.syncRulerOffset()
  }

  _getTrackHeaderWidth() {
    const rawValue = getComputedStyle(document.documentElement).getPropertyValue('--track-header-width')
    const parsedValue = Number.parseFloat(rawValue)
    return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 240
  }

  _handleWheel(event) {
    const viewport = this.refs.trackViewport
    if (!viewport) return

    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : (event.shiftKey ? event.deltaY : 0)
    if (!horizontalDelta) return

    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    if (maxScrollLeft <= 0) return

    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, viewport.scrollLeft + horizontalDelta))
    if (nextScrollLeft === viewport.scrollLeft) return

    event.preventDefault()
    viewport.scrollLeft = nextScrollLeft
  }

  _handleRulerPointerDown(event) {
    if (event.button !== 0 || !this.refs.trackRuler) return
    const rect = this.refs.trackRuler.getBoundingClientRect()
    const timelineX = event.clientX - rect.left + this.getScrollLeft()
    this.handlers.onTransportSeek?.(timelineX)
  }
}
