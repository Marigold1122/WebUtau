import { ONBOARDING_SCREENS, TOTAL_STEPS } from './onboardingSteps.js'
import { hasCompleted, markCompleted, findTrackRowByBranch, resolveBody } from './onboardingUtils.js'
import { applyPopoverPosition, applySpotlight } from './onboardingLayout.js'
import { installAdvanceListener } from './onboardingAdvance.js'

const TARGET_RETRY_INTERVAL_MS = 300
const TARGET_RETRY_MAX = 20
const FRAME_RECT_THROTTLE_MS = 80

export class OnboardingController {
  constructor() {
    this._mounted = false
    this._index = 0
    this._branch = null
    this._screens = ONBOARDING_SCREENS
    this._root = null
    this._spotlight = null
    this._popover = null
    this._bodyEl = null
    this._progressDots = null
    this._prevBtn = null
    this._nextBtn = null
    this._skipBtn = null
    this._activeCleanup = []
    this._targetRetryTimer = null
    this._targetRetryCount = 0
    this._rectTimer = null
    this._lastRectUpdateAt = 0
    this._currentTarget = null
    this._onResize = () => this._scheduleRectUpdate()
    this._userDragged = false
    this._dragOffset = null
    this._onPopoverMouseDown = null
    this._onDocumentMouseMove = null
    this._onDocumentMouseUp = null
  }

  autoStart() {
    if (hasCompleted()) return this
    if (typeof document === 'undefined') return this
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.start(), { once: true })
    } else {
      Promise.resolve().then(() => this.start())
    }
    return this
  }

  start({ force = false } = {}) {
    if (this._mounted) return
    if (!force && hasCompleted()) return
    this._index = 0
    this._branch = null
    this._mount()
    this._render()
  }

  skipAll() { this._finish() }

  next() {
    if (this._index >= this._screens.length - 1) {
      this._finish()
      return
    }
    this._index += 1
    this._render()
  }

  prev() {
    if (this._index <= 0) return
    this._index -= 1
    this._render()
  }

  _finish() {
    markCompleted()
    this._unmount()
  }

  _mount() {
    this._root = document.createElement('div')
    this._root.className = 'wu-onboarding'
    this._root.innerHTML = `
      <div class="wu-onboarding__backdrop"></div>
      <div class="wu-onboarding__spotlight"></div>
      <div class="wu-onboarding__popover">
        <button type="button" class="wu-onboarding__skip" data-action="skip" aria-label="跳过所有">跳过所有</button>
        <div class="wu-onboarding__body"></div>
        <div class="wu-onboarding__footer">
          <div class="wu-onboarding__dots"></div>
          <div class="wu-onboarding__nav">
            <button type="button" class="wu-onboarding__btn wu-onboarding__btn--ghost" data-action="prev">上一步</button>
            <button type="button" class="wu-onboarding__btn wu-onboarding__btn--primary" data-action="next">下一步</button>
          </div>
        </div>
      </div>
    `
    document.body.appendChild(this._root)

    this._spotlight = this._root.querySelector('.wu-onboarding__spotlight')
    this._popover = this._root.querySelector('.wu-onboarding__popover')
    this._bodyEl = this._popover.querySelector('.wu-onboarding__body')
    this._progressDots = this._popover.querySelector('.wu-onboarding__dots')
    this._skipBtn = this._popover.querySelector('[data-action="skip"]')
    this._prevBtn = this._popover.querySelector('[data-action="prev"]')
    this._nextBtn = this._popover.querySelector('[data-action="next"]')

    this._skipBtn.addEventListener('click', () => this.skipAll())
    this._prevBtn.addEventListener('click', () => this.prev())
    this._nextBtn.addEventListener('click', () => this.next())

    this._installDrag()
    window.addEventListener('resize', this._onResize)
    window.addEventListener('scroll', this._onResize, true)
    this._mounted = true
  }

  _installDrag() {
    this._onPopoverMouseDown = (event) => {
      if (event.button !== 0) return
      if (event.target?.closest?.('button, a, input, textarea, select')) return
      const rect = this._popover.getBoundingClientRect()
      this._dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      this._popover.classList.add('wu-onboarding__popover--dragging')
      event.preventDefault()
    }
    this._onDocumentMouseMove = (event) => {
      if (!this._dragOffset || !this._popover) return
      const w = this._popover.offsetWidth
      const h = this._popover.offsetHeight
      const left = Math.max(0, Math.min(window.innerWidth - w, event.clientX - this._dragOffset.x))
      const top = Math.max(0, Math.min(window.innerHeight - h, event.clientY - this._dragOffset.y))
      this._popover.style.left = `${left}px`
      this._popover.style.top = `${top}px`
      this._userDragged = true
    }
    this._onDocumentMouseUp = () => {
      if (!this._dragOffset) return
      this._dragOffset = null
      this._popover?.classList.remove('wu-onboarding__popover--dragging')
    }
    this._popover.addEventListener('mousedown', this._onPopoverMouseDown)
    document.addEventListener('mousemove', this._onDocumentMouseMove)
    document.addEventListener('mouseup', this._onDocumentMouseUp)
  }

  _uninstallDrag() {
    if (this._popover && this._onPopoverMouseDown) {
      this._popover.removeEventListener('mousedown', this._onPopoverMouseDown)
    }
    if (this._onDocumentMouseMove) document.removeEventListener('mousemove', this._onDocumentMouseMove)
    if (this._onDocumentMouseUp) document.removeEventListener('mouseup', this._onDocumentMouseUp)
    this._dragOffset = null
  }

  _unmount() {
    if (!this._mounted) return
    this._teardownActive()
    this._uninstallDrag()
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('scroll', this._onResize, true)
    if (this._rectTimer) {
      cancelAnimationFrame(this._rectTimer)
      this._rectTimer = null
    }
    this._root?.remove()
    this._root = null
    this._spotlight = null
    this._popover = null
    this._bodyEl = null
    this._progressDots = null
    this._prevBtn = null
    this._nextBtn = null
    this._skipBtn = null
    this._currentTarget = null
    this._mounted = false
  }

  _render() {
    this._teardownActive()
    const screen = this._screens[this._index]
    if (!screen) { this._finish(); return }

    this._bodyEl.innerHTML = resolveBody(screen.body, this._branch)
    this._renderProgress(screen.stepNum)

    this._prevBtn.disabled = this._index === 0
    this._nextBtn.textContent = screen.isLast ? '完成' : '下一步'
    this._popover.classList.toggle('wu-onboarding__popover--glow', screen.highlight === 'self')

    this._userDragged = false
    this._resolveTargetAndLayout(screen)

    const cleanup = installAdvanceListener(screen, {
      onAdvance: () => this.next(),
      onBranchCaptured: (branch) => { this._branch = branch },
    })
    if (cleanup) this._activeCleanup.push(cleanup)
  }

  _renderProgress(currentStepNum) {
    if (!this._progressDots) return
    this._progressDots.innerHTML = ''
    for (let i = 1; i <= TOTAL_STEPS; i += 1) {
      const dot = document.createElement('span')
      dot.className = 'wu-onboarding__dot'
      if (i < currentStepNum) dot.classList.add('wu-onboarding__dot--done')
      if (i === currentStepNum) dot.classList.add('wu-onboarding__dot--current')
      this._progressDots.appendChild(dot)
    }
  }

  _resolveTargetAndLayout(screen) {
    this._currentTarget = null
    this._clearTargetRetry()

    const attempt = () => {
      const target = this._queryTarget(screen)
      if (target) {
        this._currentTarget = target
        this._layout(screen, target)
        return
      }
      this._layout(screen, null)
      if (screen.highlight && screen.highlight !== 'self') {
        this._targetRetryCount += 1
        if (this._targetRetryCount < TARGET_RETRY_MAX) {
          this._targetRetryTimer = window.setTimeout(attempt, TARGET_RETRY_INTERVAL_MS)
        }
      }
    }
    this._targetRetryCount = 0
    attempt()
  }

  _queryTarget(screen) {
    const hl = screen.highlight
    if (!hl || hl === 'self') return null
    if (hl.selector) return document.querySelector(hl.selector)
    if (hl.byTrackName) return findTrackRowByBranch(this._branch)
    return null
  }

  _layout(screen, target) {
    applySpotlight(this._spotlight, target)
    if (!this._userDragged) applyPopoverPosition(this._popover)
  }

  _scheduleRectUpdate() {
    const now = performance.now()
    if (now - this._lastRectUpdateAt < FRAME_RECT_THROTTLE_MS) return
    this._lastRectUpdateAt = now
    if (this._rectTimer) cancelAnimationFrame(this._rectTimer)
    this._rectTimer = requestAnimationFrame(() => {
      this._rectTimer = null
      const screen = this._screens[this._index]
      if (!screen) return
      const target = this._currentTarget || this._queryTarget(screen)
      this._currentTarget = target
      this._layout(screen, target)
    })
  }

  _clearTargetRetry() {
    if (this._targetRetryTimer) {
      window.clearTimeout(this._targetRetryTimer)
      this._targetRetryTimer = null
    }
  }

  _teardownActive() {
    this._clearTargetRetry()
    while (this._activeCleanup.length) {
      const fn = this._activeCleanup.pop()
      try { fn() } catch { /* 忽略清理期异常，避免中断后续清理 */ }
    }
  }
}
