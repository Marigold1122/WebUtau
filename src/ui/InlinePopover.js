// 通用内联浮窗：锚定到"所选对象"的某个角附近（默认右下）。
//
// 和常见 tooltip 不同：
//   - 位置用"角"而不是"边" —— 默认 anchor 右下角外侧、向右下展开
//   - 视口不够时按 corner 顺序翻转：bottom-right → bottom-left → top-right → top-left
//   - 跨 iframe：如果本模块在 iframe 里加载，浮窗 DOM 挂到主窗口 document，
//     anchor 给出的 rect（iframe 内坐标）会加上 iframe 在主窗口的偏移
//   - modeless，不拦外部点击；Esc 关掉栈顶一个

const BODY_CLASS = 'inline-popover-active'
const ANCHOR_GAP = 8     // anchor 与浮窗之间的留白
const VIEWPORT_MARGIN = 8

const instances = new Map()
let idCounter = 0

function resolveHost() {
  try {
    const parentWin = window.parent
    const frameEl = window.frameElement
    if (parentWin && parentWin !== window && parentWin.document && frameEl) {
      return { win: parentWin, doc: parentWin.document, frameEl }
    }
  } catch {
    // 跨源：降级
  }
  return { win: window, doc: document, frameEl: null }
}

const host = resolveHost()

let keyHandlerAttached = false
let scrollHandlerAttached = false

function scheduleRepositionAll() {
  for (const inst of instances.values()) inst._scheduleReposition()
}

function onKeyDown(event) {
  if (event.key !== 'Escape') return
  const arr = [...instances.values()]
  const last = arr[arr.length - 1]
  if (last) {
    event.stopPropagation()
    last.close('esc')
  }
}

function onScrollOrResize() { scheduleRepositionAll() }

function attachGlobalHandlers() {
  if (!keyHandlerAttached) {
    host.win.addEventListener('keydown', onKeyDown, true)
    if (host.win !== window) window.addEventListener('keydown', onKeyDown, true)
    keyHandlerAttached = true
  }
  if (!scrollHandlerAttached) {
    host.win.addEventListener('resize', onScrollOrResize, { passive: true })
    host.win.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true })
    if (host.win !== window) {
      window.addEventListener('resize', onScrollOrResize, { passive: true })
      window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true })
    }
    scrollHandlerAttached = true
  }
}

function detachGlobalHandlersIfIdle() {
  if (instances.size > 0) return
  if (keyHandlerAttached) {
    host.win.removeEventListener('keydown', onKeyDown, true)
    if (host.win !== window) window.removeEventListener('keydown', onKeyDown, true)
    keyHandlerAttached = false
  }
  if (scrollHandlerAttached) {
    host.win.removeEventListener('resize', onScrollOrResize)
    host.win.removeEventListener('scroll', onScrollOrResize, { capture: true })
    if (host.win !== window) {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, { capture: true })
    }
    scrollHandlerAttached = false
  }
  host.doc.body?.classList.remove(BODY_CLASS)
}

function frameOffset() {
  if (!host.frameEl) return { left: 0, top: 0 }
  try {
    const r = host.frameEl.getBoundingClientRect()
    return { left: r.left || 0, top: r.top || 0 }
  } catch {
    return { left: 0, top: 0 }
  }
}

class PopoverInstance {
  constructor({ id, anchor, content, onClose, className }) {
    this.id = id
    this._anchor = anchor
    this._onClose = onClose
    this._className = className
    this._root = null
    this._contentHost = null
    this._closing = false
    this._repositionFrame = 0
    this._build(content)
  }

  _build(content) {
    this._root = host.doc.createElement('div')
    this._root.className = 'inline-popover'
    if (this._className) this._root.className += ` ${this._className}`
    this._root.setAttribute('role', 'dialog')
    this._root.tabIndex = -1

    this._contentHost = host.doc.createElement('div')
    this._contentHost.className = 'inline-popover-content'

    const adopted = host.doc === content.ownerDocument
      ? content
      : host.doc.adoptNode(content)
    this._contentHost.appendChild(adopted)

    this._root.appendChild(this._contentHost)
    host.doc.body.appendChild(this._root)
    host.doc.body.classList.add(BODY_CLASS)

    this._reposition()
  }

  setContent(nextContent) {
    if (!this._contentHost) return
    const adopted = host.doc === nextContent.ownerDocument
      ? nextContent
      : host.doc.adoptNode(nextContent)
    this._contentHost.replaceChildren(adopted)
    this._scheduleReposition()
  }

  updateAnchor(anchor) {
    if (!this._root) return
    this._anchor = anchor
    this._scheduleReposition()
  }

  isOpen() {
    return Boolean(this._root) && !this._closing
  }

  close(reason) {
    if (!this._root || this._closing) return
    this._closing = true
    const root = this._root
    root.classList.add('is-closing')

    let done = false
    const finalize = () => {
      if (done) return
      done = true
      root.removeEventListener('animationend', finalize)
      root.removeEventListener('transitionend', finalize)
      if (root.parentNode) root.parentNode.removeChild(root)
      instances.delete(this.id)
      detachGlobalHandlersIfIdle()
    }
    root.addEventListener('transitionend', finalize)
    root.addEventListener('animationend', finalize)
    setTimeout(finalize, 200)

    const cb = this._onClose
    if (cb) {
      try { cb(reason) } catch (error) { console.error('[InlinePopover] onClose 异常:', error) }
    }
  }

  _forceFinalize() {
    if (!this._root) return
    if (this._root.parentNode) this._root.parentNode.removeChild(this._root)
    instances.delete(this.id)
    detachGlobalHandlersIfIdle()
  }

  _scheduleReposition() {
    if (this._repositionFrame) return
    this._repositionFrame = host.win.requestAnimationFrame(() => {
      this._repositionFrame = 0
      this._reposition()
    })
  }

  _resolveAnchorRect() {
    const anchor = typeof this._anchor === 'function' ? this._anchor() : this._anchor
    if (!anchor) return null
    const raw = typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : rectFromLoose(anchor)
    if (!raw) return null
    const offset = frameOffset()
    return {
      left: raw.left + offset.left,
      top: raw.top + offset.top,
      right: raw.right + offset.left,
      bottom: raw.bottom + offset.top,
      width: raw.width,
      height: raw.height,
    }
  }

  _reposition() {
    if (!this._root) return
    const rect = this._resolveAnchorRect()
    if (!rect) {
      this._root.style.visibility = 'hidden'
      return
    }
    this._root.style.visibility = ''

    const vw = host.win.innerWidth
    const vh = host.win.innerHeight
    const popRect = this._root.getBoundingClientRect()
    const pw = popRect.width || this._root.offsetWidth
    const ph = popRect.height || this._root.offsetHeight

    // 尝试 4 个角（优先右下），挑第一个放得下的
    const corners = [
      // bottom-right: 浮窗左上角 = anchor 右下 + gap
      { id: 'bottom-right', left: rect.right + ANCHOR_GAP, top: rect.bottom + ANCHOR_GAP },
      { id: 'bottom-left', left: rect.left - pw - ANCHOR_GAP, top: rect.bottom + ANCHOR_GAP },
      { id: 'top-right', left: rect.right + ANCHOR_GAP, top: rect.top - ph - ANCHOR_GAP },
      { id: 'top-left', left: rect.left - pw - ANCHOR_GAP, top: rect.top - ph - ANCHOR_GAP },
    ]

    let chosen = null
    for (const candidate of corners) {
      if (candidate.left >= VIEWPORT_MARGIN
        && candidate.top >= VIEWPORT_MARGIN
        && candidate.left + pw <= vw - VIEWPORT_MARGIN
        && candidate.top + ph <= vh - VIEWPORT_MARGIN) {
        chosen = candidate
        break
      }
    }

    // 所有角都放不下 → 用右下角候选再夹到视口内
    if (!chosen) {
      chosen = corners[0]
    }
    const left = Math.max(VIEWPORT_MARGIN, Math.min(chosen.left, vw - pw - VIEWPORT_MARGIN))
    const top = Math.max(VIEWPORT_MARGIN, Math.min(chosen.top, vh - ph - VIEWPORT_MARGIN))

    this._root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
    this._root.dataset.corner = chosen.id
  }
}

function rectFromLoose(anchor) {
  if (Number.isFinite(anchor.left) && Number.isFinite(anchor.top)) {
    return {
      left: anchor.left,
      top: anchor.top,
      right: anchor.right ?? anchor.left + (anchor.width || 0),
      bottom: anchor.bottom ?? anchor.top + (anchor.height || 0),
      width: anchor.width || 0,
      height: anchor.height || 0,
    }
  }
  if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    const w = anchor.width || 0
    const h = anchor.height || 0
    return {
      left: anchor.x, top: anchor.y,
      right: anchor.x + w, bottom: anchor.y + h,
      width: w, height: h,
    }
  }
  return null
}

const api = {
  open({ id = null, anchor, content, onClose = null, className = '' } = {}) {
    if (!anchor || !(content instanceof Element)) {
      throw new Error('InlinePopover.open 需要 anchor 和 content')
    }
    const key = id == null ? Symbol(`popover-${++idCounter}`) : id
    const existing = instances.get(key)
    if (existing && existing.isOpen()) {
      existing.setContent(content)
      existing.updateAnchor(anchor)
      return existing
    }
    if (existing) {
      try { existing._forceFinalize() } catch {}
    }
    attachGlobalHandlers()
    const inst = new PopoverInstance({ id: key, anchor, content, onClose, className })
    instances.set(key, inst)
    return inst
  },
  close(id) {
    if (id == null) return
    const inst = instances.get(id)
    if (inst) inst.close('api')
  },
  closeAll() {
    for (const inst of [...instances.values()]) inst.close('api')
  },
  isOpen(id) {
    if (id == null) return instances.size > 0
    const inst = instances.get(id)
    return Boolean(inst && inst.isOpen())
  },
  requestReposition(id) {
    const inst = instances.get(id)
    if (inst) inst._scheduleReposition()
  },
}

export default api
