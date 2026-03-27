class ContextMenu {
  constructor() {
    this._el = null
    this._backdrop = null
    this._onClose = null
  }

  show(x, y, container, items, onClose) {
    this.hide()

    this._onClose = onClose

    this._backdrop = document.createElement('div')
    this._backdrop.className = 'context-menu-backdrop'
    this._backdrop.addEventListener('pointerdown', () => this.hide())
    this._backdrop.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.hide()
    })

    this._el = document.createElement('div')
    this._el.className = 'context-menu'
    this._el.style.left = `${x}px`
    this._el.style.top = `${y}px`
    // 菜单内部事件不冒泡到底层 canvas — 标准弹出层隔离
    this._el.addEventListener('mousedown', (e) => e.stopPropagation())
    this._el.addEventListener('pointerdown', (e) => e.stopPropagation())

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'context-menu-item'
      row.textContent = item.label
      row.addEventListener('click', () => {
        console.log(`[右键菜单] 用户点击菜单项: "${item.label}"`)
        this.hide()
        item.action()
      })
      this._el.appendChild(row)
    }

    container.appendChild(this._backdrop)
    container.appendChild(this._el)
  }

  hide() {
    if (this._backdrop) {
      this._backdrop.remove()
      this._backdrop = null
    }
    if (this._el) {
      this._el.remove()
      this._el = null
    }
    if (this._onClose) {
      const cb = this._onClose
      this._onClose = null
      cb()
    }
  }

  isVisible() {
    return this._el !== null
  }
}

export default new ContextMenu()
