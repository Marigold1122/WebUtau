const DEFAULT_DURATION_MS = 4800

function normalizeMessage(message) {
  return typeof message === 'string' ? message.trim() : ''
}

export class PlaybackToastView {
  constructor(root = document.body) {
    this.root = root
    this.region = null
    this.toast = null
    this.messageNode = null
    this.hideTimer = 0
    this.activeToastId = null
    this._handleClose = () => this.hide()
  }

  init() {
    if (this.region || !this.root) return
    this.region = document.createElement('div')
    this.region.className = 'playback-toast-region'
    this.root.appendChild(this.region)
  }

  show(message, {
    durationMs = DEFAULT_DURATION_MS,
    tone = 'warning',
    size = 'normal',
    toastId = null,
  } = {}) {
    const text = normalizeMessage(message)
    if (!text) return
    this.init()
    this._ensureToast()
    this.messageNode.textContent = text
    this.activeToastId = toastId || null
    this.toast.dataset.tone = tone
    this.toast.dataset.size = size
    this.toast.setAttribute('aria-hidden', 'false')
    this.toast.classList.add('visible')
    this._armAutoHide(durationMs)
  }

  hide(toastId = null) {
    if (toastId && toastId !== this.activeToastId) return
    this._clearHideTimer()
    if (!this.toast) return
    this.activeToastId = null
    this.toast.classList.remove('visible')
    this.toast.setAttribute('aria-hidden', 'true')
  }

  _ensureToast() {
    if (this.toast || !this.region) return

    const toast = document.createElement('div')
    toast.className = 'playback-toast'
    toast.setAttribute('role', 'status')
    toast.setAttribute('aria-live', 'polite')
    toast.setAttribute('aria-hidden', 'true')

    const message = document.createElement('div')
    message.className = 'playback-toast-message'

    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'playback-toast-close'
    closeButton.setAttribute('aria-label', '关闭提示')
    closeButton.textContent = '×'
    closeButton.addEventListener('click', this._handleClose)

    toast.append(message, closeButton)
    this.region.appendChild(toast)

    this.toast = toast
    this.messageNode = message
  }

  _armAutoHide(durationMs) {
    this._clearHideTimer()
    if (!Number.isFinite(durationMs) || durationMs <= 0) return
    this.hideTimer = window.setTimeout(() => this.hide(), durationMs)
  }

  _clearHideTimer() {
    if (!this.hideTimer) return
    window.clearTimeout(this.hideTimer)
    this.hideTimer = 0
  }
}
