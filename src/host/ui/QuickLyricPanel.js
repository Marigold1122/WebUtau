/**
 * 快速填词浮窗 —— 允许用户一次性编辑整轨歌词。
 *
 * 打开时，从 voice runtime snapshot 中提取当前歌词，按分句换行展示。
 * 用户编辑后点击「解析」：去除所有空白，按字拆分，校验数量是否与音符数一致；
 * 若一致则重新按分句换行排列，方便用户二次检查；「保存」按钮变为可用。
 * 点击「保存」后，将歌词变更构造成 lyric-edit 数组，交由外部回调提交。
 *
 * AI 协作填词：toggle 开启后展开 AI 区——用户输入主题/风格 → 后端调 LLM →
 * 返回符合音节数的歌词 → 自动填入文本框（用户仍可二次编辑后再保存）
 */
import { extractMusicStructure } from '../ai/extractMusicStructure.js'
import { LyricAIClient } from '../ai/LyricAIClient.js'
import {
  clearUserApiConfig,
  getStorageKindLabel,
  getUserApiConfig,
  hasUserApiKey,
  setUserApiConfig,
} from '../ai/lyricApiKeyStore.js'
import { DAILY_LIMIT_DEFAULT, getQuotaSnapshot } from '../ai/lyricUsageQuota.js'
import { openLyricAIKeyDialog } from './LyricAIKeyDialog.js'
import { t } from '../../i18n/index.js'

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
    this._languageCode = null

    // AI 协作填词相关
    this._aiSection = null
    this._aiToggle = null
    this._aiQuotaEl = null
    this._aiThemeInput = null
    this._aiStyleInput = null
    this._aiBtnGenerate = null
    this._aiBtnConfig = null
    this._aiClient = new LyricAIClient()
    this._aiBusy = false
    this._aiAbortController = null
  }

  /** 打开面板并填充当前歌词。anchor 决定初次弹出的位置，后续可由用户拖动 */
  open(snapshot, container, { onSave, onClose, languageCode, anchor }) {
    this.close()
    this._snapshot = snapshot
    this._onSave = onSave
    this._languageCode = languageCode || null
    this._parsedLyrics = null
    this._build(container, onClose)
    this._applyInitialPosition(anchor)
    this._installDrag()
    this._fillCurrentLyrics()
  }

  close() {
    this._uninstallDrag()
    // 取消正在飞的 AI 请求——避免回包后写到已经摘掉的 DOM 上
    if (this._aiAbortController) {
      try { this._aiAbortController.abort() } catch (_e) {}
      this._aiAbortController = null
    }
    this._aiBusy = false
    if (this._el) {
      this._el.remove()
      this._el = null
    }
    this._header = null
    this._snapshot = null
    this._parsedLyrics = null
    this._onSave = null
    // 清理 AI 区 refs——不让下一个 await 回调写到悬空 DOM
    this._aiSection = null
    this._aiToggle = null
    this._aiQuotaEl = null
    this._aiThemeInput = null
    this._aiStyleInput = null
    this._aiBtnGenerate = null
    this._aiBtnConfig = null
  }

  isOpen() {
    return this._el !== null
  }

  // ── 内部 ──────────────────────────────────────────

  _build(_container, onClose) {
    const el = document.createElement('div')
    el.className = 'quick-lyric-panel'
    el.dataset.tour = 'quick-lyric-panel'
    el.addEventListener('mousedown', (e) => e.stopPropagation())
    el.addEventListener('pointerdown', (e) => e.stopPropagation())

    // 标题栏
    const header = document.createElement('div')
    header.className = 'quick-lyric-header'
    this._header = header
    const title = document.createElement('span')
    title.className = 'quick-lyric-title'
    title.textContent = t('quickLyric.title')
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
    this._textarea.placeholder = t('quickLyric.placeholder')
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
    this._btnParse.textContent = t('quickLyric.parse')
    this._btnParse.addEventListener('click', () => this._handleParse())
    this._btnSave = document.createElement('button')
    this._btnSave.type = 'button'
    this._btnSave.className = 'modal-btn primary'
    this._btnSave.dataset.tour = 'quick-lyric-save'
    this._btnSave.textContent = t('quickLyric.save')
    this._btnSave.disabled = true
    this._btnSave.addEventListener('click', () => this._handleSave())
    actions.append(this._btnFix, this._btnParse, this._btnSave)

    // AI 协作填词区——默认折叠，toggle 打开后展开
    const aiSection = this._buildAISection()

    el.append(header, this._textarea, this._statusEl, aiSection, actions)
    // 使用 position: fixed，挂到 body 避免被编辑面板的 overflow:hidden 裁剪
    document.body.appendChild(el)
    this._el = el
    this._textarea.focus()
  }

  // 构造 AI 协作填词子面板：toggle + 主题输入 + 风格输入 + 配额显示 + 生成按钮
  _buildAISection() {
    const wrap = document.createElement('div')
    wrap.className = 'quick-lyric-ai'

    // toggle 行
    const toggleRow = document.createElement('label')
    toggleRow.className = 'quick-lyric-ai-toggle'
    const toggleInput = document.createElement('input')
    toggleInput.type = 'checkbox'
    toggleInput.className = 'quick-lyric-ai-toggle-input'
    const toggleText = document.createElement('span')
    toggleText.className = 'quick-lyric-ai-toggle-text'
    toggleText.innerHTML = `<span class="quick-lyric-ai-icon" aria-hidden="true">✨</span> ${t('quickLyric.ai.enable')}`
    toggleRow.append(toggleInput, toggleText)
    this._aiToggle = toggleInput
    toggleInput.addEventListener('change', () => {
      const open = toggleInput.checked
      body.hidden = !open
      wrap.classList.toggle('is-open', open)
      if (open) this._refreshAIQuota()
    })
    wrap.appendChild(toggleRow)

    // 展开后的内容区（默认隐藏）
    const body = document.createElement('div')
    body.className = 'quick-lyric-ai-body'
    body.hidden = true

    const themeLabel = document.createElement('div')
    themeLabel.className = 'quick-lyric-ai-label'
    themeLabel.textContent = t('quickLyric.ai.theme_label')
    const themeInput = document.createElement('textarea')
    themeInput.className = 'quick-lyric-ai-theme'
    themeInput.placeholder = t('quickLyric.ai.theme_placeholder')
    themeInput.rows = 2
    themeInput.addEventListener('keydown', (e) => e.stopPropagation())
    this._aiThemeInput = themeInput

    const styleLabel = document.createElement('div')
    styleLabel.className = 'quick-lyric-ai-label'
    styleLabel.textContent = t('quickLyric.ai.style_label')
    const styleInput = document.createElement('input')
    styleInput.type = 'text'
    styleInput.className = 'quick-lyric-ai-style'
    styleInput.placeholder = t('quickLyric.ai.style_placeholder')
    styleInput.addEventListener('keydown', (e) => e.stopPropagation())
    this._aiStyleInput = styleInput

    // 第三行：配额 + 配置链接 + 生成按钮
    const footer = document.createElement('div')
    footer.className = 'quick-lyric-ai-footer'
    const quotaEl = document.createElement('span')
    quotaEl.className = 'quick-lyric-ai-quota'
    this._aiQuotaEl = quotaEl
    const btnConfig = document.createElement('button')
    btnConfig.type = 'button'
    btnConfig.className = 'quick-lyric-ai-config-btn'
    btnConfig.textContent = t('quickLyric.ai.btn_config')
    btnConfig.addEventListener('click', (event) => {
      event.preventDefault()
      this._openAPIKeyDialog()
    })
    this._aiBtnConfig = btnConfig
    const btnGenerate = document.createElement('button')
    btnGenerate.type = 'button'
    btnGenerate.className = 'quick-lyric-ai-generate modal-btn primary'
    btnGenerate.textContent = t('quickLyric.ai.btn_generate')
    btnGenerate.addEventListener('click', () => this._handleAIGenerate())
    this._aiBtnGenerate = btnGenerate
    footer.append(quotaEl, btnConfig, btnGenerate)

    body.append(themeLabel, themeInput, styleLabel, styleInput, footer)
    wrap.appendChild(body)
    this._aiSection = wrap
    return wrap
  }

  async _refreshAIQuota() {
    if (!this._aiQuotaEl) return
    // 异步：检查用户是否有自带 key（要解密 localStorage）
    const userKeyPresent = await hasUserApiKey().catch(() => false)
    // 解密期间面板可能已经关闭——避免写到悬空 ref
    if (!this._aiQuotaEl) return
    if (userKeyPresent) {
      const where = getStorageKindLabel() === 'desktop-keychain'
        ? t('quickLyric.ai.store_keychain')
        : t('quickLyric.ai.store_browser')
      this._aiQuotaEl.textContent = t('quickLyric.ai.quota_using_user_key', { store: where })
      this._aiQuotaEl.classList.add('is-unlimited')
      return
    }
    this._aiQuotaEl.classList.remove('is-unlimited')
    const q = getQuotaSnapshot()
    if (q.remaining > 0) {
      this._aiQuotaEl.textContent = t('quickLyric.ai.quota_remaining', { remaining: q.remaining, limit: q.limit })
      this._aiQuotaEl.classList.toggle('is-low', q.remaining <= 1)
    } else {
      this._aiQuotaEl.textContent = t('quickLyric.ai.quota_exhausted', { limit: q.limit })
      this._aiQuotaEl.classList.add('is-low')
    }
  }

  async _handleAIGenerate() {
    if (this._aiBusy) return
    if (!this._snapshot) {
      this._setStatus(t('quickLyric.ai.pick_track_first'), 'error')
      return
    }
    const theme = this._aiThemeInput?.value?.trim()
    if (!theme) {
      this._aiThemeInput?.focus()
      this._setStatus(t('quickLyric.ai.need_theme'), 'error')
      return
    }
    const style = this._aiStyleInput?.value?.trim() || ''

    this._aiBusy = true
    this._aiBtnGenerate.disabled = true
    this._aiBtnGenerate.textContent = t('quickLyric.ai.btn_generating')
    this._setStatus(t('quickLyric.ai.generating_status'), 'info')

    this._aiAbortController = new AbortController()
    const musicStructure = extractMusicStructure(this._snapshot)
    const result = await this._aiClient.generate({
      musicStructure,
      theme,
      style,
      signal: this._aiAbortController.signal,
    })

    // await 期间用户可能已关掉面板，DOM ref 都是悬空的——直接退
    if (!this._el || !this._textarea) return

    this._aiBusy = false
    this._aiAbortController = null
    if (this._aiBtnGenerate) {
      this._aiBtnGenerate.disabled = false
      this._aiBtnGenerate.textContent = t('quickLyric.ai.btn_generate')
    }
    this._refreshAIQuota()

    if (!result.ok) {
      this._setStatus(this._formatAIError(result), 'error')
      return
    }

    // 把生成出来的字按句换行填进文本框——用户还可手改后点解析 / 保存
    const lines = result.phrases.map((p) => p.lyric.join(''))
    this._textarea.value = lines.join('\n')
    this._parsedLyrics = null
    this._btnSave.disabled = true
    this._hideFix()
    this._setStatus(t('quickLyric.ai.ai_done', { count: result.flatChars.length }), 'success')
  }

  _formatAIError(result) {
    const reason = result?.reason
    if (reason === 'quota-exceeded') return t('quickLyric.ai.err.quota_exceeded')
    if (reason === 'invalid-key') return t('quickLyric.ai.err.invalid_key')
    if (reason === 'network-error') return t('quickLyric.ai.err.network', { detail: result.error || t('quickLyric.ai.err.retry_later') })
    if (reason === 'cors-blocked') return result.message || t('quickLyric.ai.err.cors')
    if (reason === 'invalid-user-key') return t('quickLyric.ai.err.invalid_user_key')
    if (reason === 'user-key-forbidden') return t('quickLyric.ai.err.user_key_forbidden')
    if (reason === 'user-key-rate-limited') return t('quickLyric.ai.err.user_key_rate_limited')
    if (reason === 'missing-user-key') return t('quickLyric.ai.err.missing_user_key')
    if (reason === 'missing-user-baseurl') return t('quickLyric.ai.err.missing_user_baseurl')
    if (reason === 'missing-user-model') return t('quickLyric.ai.err.missing_user_model')
    if (reason === 'parse-failed') {
      const sub = result.parseReason
      if (sub === 'syllable-mismatch') {
        return t('quickLyric.ai.err.syllable_mismatch', {
          phrase: result.details?.phraseIndex,
          expected: result.details?.expected,
          actual: result.details?.actual,
        })
      }
      if (sub === 'phrase-count-mismatch') {
        return t('quickLyric.ai.err.phrase_count_mismatch', {
          expected: result.details?.expected,
          actual: result.details?.actual,
        })
      }
      return t('quickLyric.ai.err.parse_failed', { sub })
    }
    if (typeof reason === 'string' && reason.startsWith('http-')) {
      return t('quickLyric.ai.err.http', { code: reason, message: result.message || t('quickLyric.ai.err.retry_later') })
    }
    return t('quickLyric.ai.err.generic', { message: result?.message || t('quickLyric.ai.err.generate_failed') })
  }

  // 用自定义模态弹窗替代 window.prompt/confirm——后者在 Tauri webview 里
  // 被静默拦截（点了没反应），自定义模态两端表现一致 + 单弹窗收齐 3 字段 +
  // 厂商预设 chip 一键填 baseUrl + model
  async _openAPIKeyDialog() {
    const isDesktop = getStorageKindLabel() === 'desktop-keychain'
    const cur = await getUserApiConfig().catch(() => ({ apiKey: '', baseUrl: '', model: '' }))
    const result = await openLyricAIKeyDialog({ initial: cur, isDesktop })

    if (result.action === 'cancel') {
      this._setStatus(t('quickLyric.ai.cfg_canceled'), 'info')
      return
    }
    if (result.action === 'clear') {
      clearUserApiConfig()
      await this._refreshAIQuota()
      this._setStatus(t('quickLyric.ai.cfg_cleared', { limit: DAILY_LIMIT_DEFAULT }), 'info')
      return
    }
    if (result.action === 'save' && result.config) {
      try {
        await setUserApiConfig(result.config)
      } catch (error) {
        this._setStatus(t('quickLyric.ai.cfg_save_failed', { message: error?.message || t('quickLyric.ai.cfg_storage_error') }), 'error')
        return
      }
      await this._refreshAIQuota()
      this._setStatus(
        isDesktop
          ? t('quickLyric.ai.cfg_saved_keychain')
          : t('quickLyric.ai.cfg_saved_browser'),
        'success',
      )
    }
  }

  /** 根据传入的锚点（通常是轨道列表区域）计算初始位置：x 贴右 12px，y 贴锚点顶部 36px */
  _applyInitialPosition(anchor) {
    if (!this._el) return
    const rect = anchor?.getBoundingClientRect?.()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = this._el.offsetWidth || 280
    const h = this._el.offsetHeight || 320
    const rightEdge = rect ? rect.right : vw
    const topEdge = rect ? rect.top : 0
    const left = Math.max(8, Math.min(vw - w - 8, rightEdge - 12 - w))
    const top = Math.max(8, Math.min(vh - h - 8, topEdge + 36))
    this._el.style.left = `${Math.round(left)}px`
    this._el.style.top = `${Math.round(top)}px`
  }

  /** 允许用户通过拖动标题栏移动浮窗；点击关闭按钮时不触发拖动 */
  _installDrag() {
    if (!this._header || !this._el) return
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0
    this._onHeaderDown = (event) => {
      if (event.button !== 0) return
      if (event.target?.closest?.('.quick-lyric-close')) return
      const rect = this._el.getBoundingClientRect()
      startX = event.clientX
      startY = event.clientY
      startLeft = rect.left
      startTop = rect.top
      this._el.classList.add('quick-lyric-panel--dragging')
      document.addEventListener('mousemove', this._onDocMove)
      document.addEventListener('mouseup', this._onDocUp)
      event.preventDefault()
    }
    this._onDocMove = (event) => {
      if (!this._el) return
      const w = this._el.offsetWidth
      const h = this._el.offsetHeight
      const nextLeft = Math.max(0, Math.min(window.innerWidth - w, startLeft + (event.clientX - startX)))
      const nextTop = Math.max(0, Math.min(window.innerHeight - h, startTop + (event.clientY - startY)))
      this._el.style.left = `${nextLeft}px`
      this._el.style.top = `${nextTop}px`
    }
    this._onDocUp = () => {
      this._el?.classList.remove('quick-lyric-panel--dragging')
      document.removeEventListener('mousemove', this._onDocMove)
      document.removeEventListener('mouseup', this._onDocUp)
    }
    this._header.addEventListener('mousedown', this._onHeaderDown)
  }

  _uninstallDrag() {
    if (this._header && this._onHeaderDown) {
      this._header.removeEventListener('mousedown', this._onHeaderDown)
    }
    if (this._onDocMove) document.removeEventListener('mousemove', this._onDocMove)
    if (this._onDocUp) document.removeEventListener('mouseup', this._onDocUp)
    this._onHeaderDown = null
    this._onDocMove = null
    this._onDocUp = null
  }

  /** 从 snapshot 提取当前歌词，按分句换行 */
  _fillCurrentLyrics() {
    const phrases = this._snapshot?.phrases || []
    const lines = phrases.map((phrase) =>
      (phrase.notes || []).map((n) => n.lyric || 'a').join(''),
    )
    this._textarea.value = lines.join('\n')
    const totalNotes = phrases.reduce((sum, p) => sum + (p.notes?.length || 0), 0)
    this._setStatus(t('quickLyric.note_count', { count: totalNotes }), 'info')
  }

  /** 解析用户输入：去空白 → (日语时汉字→假名) → 按字拆 → 验数量 → 重排分句换行 */
  async _handleParse() {
    const phrases = this._snapshot?.phrases || []
    const noteCounts = phrases.map((p) => (p.notes?.length || 0))
    const totalNotes = noteCounts.reduce((a, b) => a + b, 0)

    // 去除所有空白字符
    let raw = this._textarea.value.replace(/\s/g, '')

    // 日语时自动将汉字转换为假名
    if (this._isJapanese() && /[\u4e00-\u9fff]/.test(raw)) {
      this._setStatus(t('quickLyric.converting_kanji'), 'info')
      this._btnParse.disabled = true
      try {
        const { convertKanjiToKana } = await import('../util/kanjiToKana.js')
        raw = await convertKanjiToKana(raw)
        raw = raw.replace(/\s/g, '')
      } catch (error) {
        this._setStatus(t('quickLyric.convert_failed', { message: error?.message || t('quickLyric.unknown_error') }), 'error')
        this._btnParse.disabled = false
        return
      }
      this._btnParse.disabled = false
    }

    // 日语按拍（モーラ）拆分：拗音小假名（ゃゅょ等）与前一假名合为一个音符单位，
    // 使拍数与音符数对齐，避免独立小假名触发后端音素化器重分句。
    // 其他语言仍按字符拆分。
    let chars
    if (this._isJapanese()) {
      const { splitMorae } = await import('../util/kanjiToKana.js')
      chars = splitMorae(raw)
    } else {
      chars = [...raw] // 支持 Unicode 代理对
    }
    if (chars.length === 0) {
      this._setStatus(t('quickLyric.empty'), 'error')
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
      this._setStatus(t('quickLyric.char_count_mismatch', { actual: chars.length, expected: totalNotes }), 'error')
      this._parsedLyrics = null
      this._btnSave.disabled = true
      if (chars.length < totalNotes) {
        this._showFix(t('quickLyric.fix_pad'), chars, totalNotes, noteCounts)
      } else {
        this._showFix(t('quickLyric.fix_trim'), chars, totalNotes, noteCounts)
      }
      return
    }
    this._hideFix()

    this._parsedLyrics = chars
    this._setStatus(t('quickLyric.parse_ok', { chars: chars.length, phrases: phrases.length }), 'success')
    this._btnSave.disabled = false
  }

  /** 构建 lyric edits 并提交 */
  async _handleSave() {
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
      this._setStatus(t('quickLyric.no_change'), 'info')
      return
    }

    this._btnSave.disabled = true
    this._setStatus(t('quickLyric.saving', { count: edits.length }), 'info')

    try {
      await this._onSave?.(edits)
    } catch (error) {
      this._setStatus(t('quickLyric.save_failed', { message: error?.message || t('quickLyric.unknown_error') }), 'error')
      this._btnSave.disabled = false
      return
    }

    // 保存成功后同步 snapshot，使后续编辑的 diff 基准为最新状态
    charIndex = 0
    for (const phrase of phrases) {
      for (const note of (phrase.notes || [])) {
        note.lyric = this._parsedLyrics[charIndex] || 'a'
        charIndex++
      }
    }
    this._setStatus(t('quickLyric.saved', { count: edits.length }), 'success')
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

  _isJapanese() {
    return this._languageCode?.toUpperCase() === 'JA'
  }

  _setStatus(text, type = '') {
    if (!this._statusEl) return
    this._statusEl.textContent = text
    this._statusEl.className = 'quick-lyric-status'
    if (type) this._statusEl.classList.add(`quick-lyric-status--${type}`)
  }
}
