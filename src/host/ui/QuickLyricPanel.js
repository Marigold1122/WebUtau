/**
 * 快速填词浮窗 —— 允许用户一次性编辑整轨歌词。
 *
 * 打开时，从 voice runtime snapshot 中提取当前歌词，按分句换行展示。
 * 用户编辑后点击「解析」：去除所有空白，按字拆分，校验数量是否与音符数一致；
 * 若一致则重新按分句换行排列，方便用户二次检查；「保存」按钮变为可用。
 * 点击「保存」后，将歌词变更构造成 lyric-edit 数组，交由外部回调提交。
 */

export class QuickLyricPanel {
  constructor() {
    this._el = null
    this._textarea = null
    this._statusEl = null
    this._btnParse = null
    this._btnSave = null
    this._btnClose = null

    /** @type {{ phrases: Array, bpm: number } | null} */
    this._snapshot = null
    /** @type {string[] | null} 解析成功后的歌词数组（每字一项） */
    this._parsedLyrics = null
    /** @type {((edits: Array) => void) | null} */
    this._onSave = null
    this._btnFix = null
  }

  /** 打开面板并填充当前歌词 */
  open(snapshot, container, { onSave, onClose }) {
    this.close()
    this._snapshot = snapshot
    this._onSave = onSave
    this._parsedLyrics = null
    this._build(container, onClose)
    this._fillCurrentLyrics()
  }

  close() {
    if (this._el) {
      this._el.remove()
      this._el = null
    }
    this._snapshot = null
    this._parsedLyrics = null
    this._onSave = null
  }

  isOpen() {
    return this._el !== null
  }

  // ── 内部 ──────────────────────────────────────────

  _build(container, onClose) {
    const el = document.createElement('div')
    el.className = 'quick-lyric-panel'
    el.addEventListener('mousedown', (e) => e.stopPropagation())
    el.addEventListener('pointerdown', (e) => e.stopPropagation())

    // 标题栏
    const header = document.createElement('div')
    header.className = 'quick-lyric-header'
    const title = document.createElement('span')
    title.className = 'quick-lyric-title'
    title.textContent = '快速填词'
    this._btnClose = document.createElement('button')
    this._btnClose.type = 'button'
    this._btnClose.className = 'quick-lyric-close'
    this._btnClose.textContent = '×'
    this._btnClose.addEventListener('click', () => { this.close(); onClose?.() })
    header.append(title, this._btnClose)

    // 文本框
    this._textarea = document.createElement('textarea')
    this._textarea.className = 'quick-lyric-textarea'
    this._textarea.spellcheck = false
    this._textarea.placeholder = '在此编辑歌词，一个字对应一个音符…'
    this._textarea.addEventListener('input', () => {
      // 内容变动后，重置解析状态
      this._parsedLyrics = null
      this._btnSave.disabled = true
      this._hideFix()
      this._setStatus('')
    })
    this._textarea.addEventListener('keydown', (e) => e.stopPropagation())

    // 状态
    this._statusEl = document.createElement('div')
    this._statusEl.className = 'quick-lyric-status'

    // 按钮
    const actions = document.createElement('div')
    actions.className = 'quick-lyric-actions'
    this._btnFix = document.createElement('button')
    this._btnFix.type = 'button'
    this._btnFix.className = 'modal-btn secondary'
    this._btnFix.hidden = true
    this._btnFix.addEventListener('click', () => this._handleFix())
    this._btnParse = document.createElement('button')
    this._btnParse.type = 'button'
    this._btnParse.className = 'modal-btn secondary'
    this._btnParse.textContent = '解析'
    this._btnParse.addEventListener('click', () => this._handleParse())
    this._btnSave = document.createElement('button')
    this._btnSave.type = 'button'
    this._btnSave.className = 'modal-btn primary'
    this._btnSave.textContent = '保存'
    this._btnSave.disabled = true
    this._btnSave.addEventListener('click', () => this._handleSave())
    actions.append(this._btnFix, this._btnParse, this._btnSave)

    el.append(header, this._textarea, this._statusEl, actions)
    container.appendChild(el)
    this._el = el
    this._textarea.focus()
  }

  /** 从 snapshot 提取当前歌词，按分句换行 */
  _fillCurrentLyrics() {
    const phrases = this._snapshot?.phrases || []
    const lines = phrases.map((phrase) =>
      (phrase.notes || []).map((n) => n.lyric || 'a').join(''),
    )
    this._textarea.value = lines.join('\n')
    const totalNotes = phrases.reduce((sum, p) => sum + (p.notes?.length || 0), 0)
    this._setStatus(`共 ${totalNotes} 个音符`, 'info')
  }

  /** 解析用户输入：去空白 → 按字拆 → 验数量 → 重排分句换行 */
  _handleParse() {
    const phrases = this._snapshot?.phrases || []
    const noteCounts = phrases.map((p) => (p.notes?.length || 0))
    const totalNotes = noteCounts.reduce((a, b) => a + b, 0)

    // 去除所有空白字符，按字拆分
    const raw = this._textarea.value.replace(/\s/g, '')
    const chars = [...raw] // 支持 Unicode 代理对
    if (chars.length === 0) {
      this._setStatus('歌词为空', 'error')
      return
    }
    // 无论是否匹配，都按分句换行重排，方便用户查看对齐效果
    const lines = []
    let offset = 0
    for (const count of noteCounts) {
      lines.push(chars.slice(offset, offset + count).join(''))
      offset += count
    }
    // 剩余超出部分追加到末行
    if (offset < chars.length) {
      lines.push(chars.slice(offset).join(''))
    }
    this._textarea.value = lines.join('\n')

    if (chars.length !== totalNotes) {
      this._setStatus(`字数不匹配：输入 ${chars.length} 字，需要 ${totalNotes} 字`, 'error')
      this._parsedLyrics = null
      this._btnSave.disabled = true
      if (chars.length < totalNotes) {
        this._showFix('补齐占位', chars, totalNotes, noteCounts)
      } else {
        this._showFix('截断多余', chars, totalNotes, noteCounts)
      }
      return
    }
    this._hideFix()

    this._parsedLyrics = chars
    this._setStatus(`解析成功：${chars.length} 字 / ${phrases.length} 句`, 'success')
    this._btnSave.disabled = false
  }

  /** 构建 lyric edits 并提交 */
  _handleSave() {
    if (!this._parsedLyrics || !this._snapshot) return
    const phrases = this._snapshot.phrases || []
    const bpm = this._snapshot.bpm || 120
    const edits = []
    let charIndex = 0
    for (const phrase of phrases) {
      for (const note of (phrase.notes || [])) {
        const newLyric = this._parsedLyrics[charIndex] || 'a'
        if (newLyric !== (note.lyric || 'a')) {
          edits.push({
            action: 'lyric',
            position: Math.round((note.time * 480 * bpm) / 60),
            duration: Math.round((note.duration * 480 * bpm) / 60),
            tone: note.midi,
            lyric: newLyric,
          })
        }
        charIndex++
      }
    }
    if (edits.length === 0) {
      this._setStatus('歌词没有变化', 'info')
      return
    }
    // 保存前同步 snapshot，使后续编辑的 diff 基准为最新状态
    charIndex = 0
    for (const phrase of phrases) {
      for (const note of (phrase.notes || [])) {
        note.lyric = this._parsedLyrics[charIndex] || 'a'
        charIndex++
      }
    }
    this._onSave?.(edits)
    this._setStatus(`已保存 ${edits.length} 处修改`, 'success')
    this._btnSave.disabled = true
    this._parsedLyrics = null
  }

  _showFix(label, chars, totalNotes, noteCounts) {
    this._fixData = { chars, totalNotes, noteCounts }
    this._btnFix.textContent = label
    this._btnFix.hidden = false
  }

  _hideFix() {
    this._btnFix.hidden = true
    this._fixData = null
  }

  _handleFix() {
    const { chars, totalNotes, noteCounts } = this._fixData || {}
    if (!chars || !totalNotes) return
    let fixed
    if (chars.length < totalNotes) {
      fixed = chars.concat(Array(totalNotes - chars.length).fill('a'))
    } else {
      fixed = chars.slice(0, totalNotes)
    }
    // 按分句换行写回
    const lines = []
    let offset = 0
    for (const count of noteCounts) {
      lines.push(fixed.slice(offset, offset + count).join(''))
      offset += count
    }
    this._textarea.value = lines.join('\n')
    this._hideFix()
    // 自动触发一次解析
    this._handleParse()
  }

  _setStatus(text, type = '') {
    if (!this._statusEl) return
    this._statusEl.textContent = text
    this._statusEl.className = 'quick-lyric-status'
    if (type) this._statusEl.classList.add(`quick-lyric-status--${type}`)
  }
}
