class LyricDialog {
  constructor() {
    this._el = null
    this._onConfirm = null
    this._onCancel = null
  }

  show(currentLyrics, container, { onConfirm, onCancel }) {
    console.log(`[歌词对话框] show 被调用 | 歌词="${currentLyrics}", container=${container?.className}`)
    this.hide()

    this._onConfirm = onConfirm
    this._onCancel = onCancel

    this._el = document.createElement('div')
    this._el.className = 'lyric-dialog'
    // 对话框内部事件不冒泡到底层 canvas — 标准弹出层隔离
    this._el.addEventListener('mousedown', (e) => e.stopPropagation())
    this._el.addEventListener('pointerdown', (e) => e.stopPropagation())

    const title = document.createElement('div')
    title.className = 'lyric-dialog-title'
    title.textContent = '编辑歌词（空格分隔）'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'lyric-dialog-input'
    input.value = currentLyrics

    const hint = document.createElement('div')
    hint.className = 'lyric-dialog-hint'
    hint.textContent = '每个音符一个字/词，用空格分隔'

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        const value = input.value
        this.hide()
        if (onConfirm) onConfirm(value)
      }
      if (e.key === 'Escape') {
        this.hide()
        if (onCancel) onCancel()
      }
    })

    this._el.appendChild(title)
    this._el.appendChild(input)
    this._el.appendChild(hint)
    container.appendChild(this._el)
    input.focus()
    input.select()
  }

  hide() {
    if (this._el) {
      this._el.remove()
      this._el = null
    }
    this._onConfirm = null
    this._onCancel = null
  }

  isVisible() {
    return this._el !== null
  }
}

export default new LyricDialog()
