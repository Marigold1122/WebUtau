/**
 * 快速填词浮窗 —— 编辑整轨歌词。
 *
 * 普通流程：
 *   - 打开时从 voice runtime snapshot 读出当前歌词，按后端 phrase 切分换行展示
 *   - 用户编辑文本后点「解析」校验：总字数 ≤ 总音符数即通过（不够补 '+' 延音）
 *   - 点「保存」按 backend phrases 顺序贪心分配字到 note，发 lyric edits
 *
 * AI 协作填词：
 *   - toggle 开启 AI 区
 *   - **必填官方歌词**：点「📖 官方歌词」弹小窗，把这首歌真实的歌词粘贴进来（每行一句）
 *     这是 AI 写词的"行结构"权威来源——后端 phrase 切分（按音符间隔）跟真实歌词行对不上，
 *     不让 AI 看真实结构、AI 就只能按错乱的 phrase 数瞎写
 *   - 输入主题/风格 → AI 按官方歌词的行结构（每行字数）写新词 → 自动填入文本框
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
import { flattenSnapshotNotes } from '../ai/syllableAdjustments.js'
import { openLyricAIKeyDialog } from './LyricAIKeyDialog.js'
import { openOfficialLyricsDialog } from './OfficialLyricsDialog.js'
import { t } from '../../i18n/index.js'

// 自然文本里的书写分隔符，不参与演唱。把它们当 lyric 发给后端，phonemizer
// 查表失败会用 SP 兜底并把那个 note 整个吞掉（partResult 不写入），破坏后端
// 的 lyric-only edit 校验。这里按字符拆完直接过滤掉。
const LYRIC_SEPARATOR_RE = /[\s.,!?;:'"()[\]{}<>，。！？、；：“”‘’（）《》【】…·・~～/\\\-‐‑‒–—―]/

// AI 候选轮播上限：参考 Synthesizer V Retakes 默认 5——再多用户也认不全；
// 超过这个数就丢最早那一版（FIFO）
const AI_CANDIDATES_LIMIT = 5

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
    /** @type {string[] | null} 解析成功后的 flat 字符数组 */
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
    this._aiBtnRetake = null
    this._aiBtnConfig = null
    this._aiClient = new LyricAIClient()
    this._aiBusy = false
    this._aiAbortController = null
    this._songName = null

    // 候选轮播：每次 AI 生成成功的结果存一份；点击切换不扣配额、点"再来一版"扣一次
    // 上限默认 5——参考 Synthesizer V Retakes 的体感，超过时丢最早那一版
    /** @type {Array<{ phrases: Array, flatChars: Array<string>, theme: string, style: string, textareaContent: string, officialKey: string, createdAt: number }>} */
    this._aiCandidates = []
    this._aiCurrentCandidateIdx = -1
    this._aiCandidatesStripEl = null

    // 官方歌词（前端持久化的真实歌词行结构，用于 AI 写词的 musicStructure）
    /** @type {string[]} */
    this._officialLyrics = []
    this._btnOfficialLyrics = null
    this._officialLyricsStatusEl = null
    this._aiHintEl = null
    /** @type {((lines: string[]) => void) | null} */
    this._onOfficialLyricsChanged = null
  }

  open(snapshot, container, {
    onSave, onClose, languageCode, anchor, songName,
    savedOfficialLyrics = null,
    onOfficialLyricsChanged = null,
  }) {
    this.close()
    this._snapshot = snapshot
    this._onSave = onSave
    this._languageCode = languageCode || null
    this._parsedLyrics = null
    this._songName = songName || null
    this._officialLyrics = Array.isArray(savedOfficialLyrics) ? savedOfficialLyrics.slice() : []
    this._onOfficialLyricsChanged = onOfficialLyricsChanged
    this._build(container, onClose)
    this._applyInitialPosition(anchor)
    this._installDrag()
    this._fillCurrentLyrics()
  }

  close() {
    this._uninstallDrag()
    // 取消正在飞的 AI 请求
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
    this._songName = null
    this._officialLyrics = []
    this._onOfficialLyricsChanged = null
    this._aiSection = null
    this._aiToggle = null
    this._aiQuotaEl = null
    this._aiThemeInput = null
    this._aiStyleInput = null
    this._aiBtnGenerate = null
    this._aiBtnRetake = null
    this._aiBtnConfig = null
    this._btnOfficialLyrics = null
    this._officialLyricsStatusEl = null
    this._aiHintEl = null
    // 候选轮播在面板生命周期内有效；关闭后清空（下次打开是全新会话）
    this._aiCandidates = []
    this._aiCurrentCandidateIdx = -1
    this._aiCandidatesStripEl = null
  }

  isOpen() { return this._el !== null }

  // ── 构造 DOM ──────────────────────────────────────

  _build(_container, onClose) {
    const el = document.createElement('div')
    el.className = 'quick-lyric-panel'
    el.dataset.tour = 'quick-lyric-panel'
    el.addEventListener('mousedown', (e) => e.stopPropagation())
    el.addEventListener('pointerdown', (e) => e.stopPropagation())

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

    this._textarea = document.createElement('textarea')
    this._textarea.className = 'quick-lyric-textarea'
    this._textarea.spellcheck = false
    this._textarea.placeholder = t('quickLyric.placeholder')
    this._textarea.addEventListener('input', () => {
      this._parsedLyrics = null
      this._btnSave.disabled = true
      this._hideFix()
      this._setStatus('')
      // 用户手动改了 textarea —— 当前不再对应任何候选，撤销高亮
      if (this._aiCurrentCandidateIdx !== -1) {
        this._aiCurrentCandidateIdx = -1
        this._renderCandidatesStrip()
      }
    })
    // 阻断字母键 / Space 等冒泡触发全局快捷键；但放行 ESC，让外层全局 ESC 调度能关掉本浮窗
    this._textarea.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation() })

    // AI 候选轮播条带——初始隐藏，第一次成功生成后再显示。点击切换不耗配额；
    // 末尾固定一个"再来一版"按钮，按它会再调一次 LLM（消耗一次配额）
    this._aiCandidatesStripEl = document.createElement('div')
    this._aiCandidatesStripEl.className = 'quick-lyric-ai-candidates'
    this._aiCandidatesStripEl.hidden = true

    this._statusEl = document.createElement('div')
    this._statusEl.className = 'quick-lyric-status'

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

    const aiSection = this._buildAISection()
    el.append(header, this._textarea, this._aiCandidatesStripEl, this._statusEl, aiSection, actions)
    document.body.appendChild(el)
    this._el = el
    this._textarea.focus()
  }

  // AI 协作填词子面板：toggle + 官方歌词 + 主题/风格 + 配额 + 生成
  _buildAISection() {
    const wrap = document.createElement('div')
    wrap.className = 'quick-lyric-ai'

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

    const body = document.createElement('div')
    body.className = 'quick-lyric-ai-body'
    body.hidden = true

    // 提示横幅 + 官方歌词按钮
    const hint = document.createElement('div')
    hint.className = 'quick-lyric-ai-hint'
    hint.innerHTML = `
      <span class="quick-lyric-ai-hint-icon" aria-hidden="true">⚠️</span>
      <span class="quick-lyric-ai-hint-text">${t('quickLyric.ai.official_lyrics_hint')}</span>
    `
    this._aiHintEl = hint

    const officialRow = document.createElement('div')
    officialRow.className = 'quick-lyric-ai-adjust-row'
    const btnOfficial = document.createElement('button')
    btnOfficial.type = 'button'
    btnOfficial.className = 'quick-lyric-ai-adjust-btn'
    btnOfficial.innerHTML = `<span aria-hidden="true">📖</span> ${t('quickLyric.ai.btn_official_lyrics')}`
    btnOfficial.addEventListener('click', () => this._handleOpenOfficialLyrics())
    this._btnOfficialLyrics = btnOfficial
    const officialStatus = document.createElement('span')
    officialStatus.className = 'quick-lyric-ai-adjust-status'
    this._officialLyricsStatusEl = officialStatus
    officialRow.append(btnOfficial, officialStatus)

    const themeLabel = document.createElement('div')
    themeLabel.className = 'quick-lyric-ai-label'
    themeLabel.textContent = t('quickLyric.ai.theme_label')
    const themeInput = document.createElement('textarea')
    themeInput.className = 'quick-lyric-ai-theme'
    themeInput.placeholder = t('quickLyric.ai.theme_placeholder')
    themeInput.rows = 2
    themeInput.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation() })
    this._aiThemeInput = themeInput

    const styleLabel = document.createElement('div')
    styleLabel.className = 'quick-lyric-ai-label'
    styleLabel.textContent = t('quickLyric.ai.style_label')
    const styleInput = document.createElement('input')
    styleInput.type = 'text'
    styleInput.className = 'quick-lyric-ai-style'
    styleInput.placeholder = t('quickLyric.ai.style_placeholder')
    styleInput.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation() })
    this._aiStyleInput = styleInput

    // 配额 + 配置 + 生成
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

    body.append(hint, officialRow, themeLabel, themeInput, styleLabel, styleInput, footer)
    wrap.appendChild(body)
    this._aiSection = wrap
    this._refreshOfficialLyricsStatus()
    return wrap
  }

  // ── 官方歌词 ──────────────────────────────────────

  async _handleOpenOfficialLyrics() {
    const result = await openOfficialLyricsDialog({
      initialLines: this._officialLyrics.slice(),
    })
    if (result.action !== 'save') return
    // 去掉前后空白行；保留行内空格（用户可能写"风雨里追赶 雾里分不清影踪"这种带空格的）
    const cleaned = result.lines.map((l) => l.replace(/^\s+|\s+$/g, ''))
    while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop()
    while (cleaned.length > 0 && cleaned[0] === '') cleaned.shift()
    const oldKey = this._computeOfficialLyricsKey()
    this._officialLyrics = cleaned
    const newKey = this._computeOfficialLyricsKey()
    this._onOfficialLyricsChanged?.(cleaned)
    this._refreshOfficialLyricsStatus()

    // 官方歌词的指纹变了 → 旧候选的"每行字数"模板对不上当前结构，作废
    if (oldKey !== newKey && this._aiCandidates.length > 0) {
      this._aiCandidates = []
      this._aiCurrentCandidateIdx = -1
      this._renderCandidatesStrip()
      this._setStatus(t('quickLyric.ai.candidates_cleared_on_official_change'), 'info')
      return
    }
    this._setStatus(t('quickLyric.ai.official_lyrics_saved'), 'success')
  }

  _refreshOfficialLyricsStatus() {
    if (!this._officialLyricsStatusEl) return
    const lines = this._officialLyrics || []
    const nonEmpty = lines.filter((l) => l.replace(/\s/g, '').length > 0)
    if (nonEmpty.length === 0) {
      this._officialLyricsStatusEl.textContent = t('quickLyric.ai.official_lyrics_pending')
      this._officialLyricsStatusEl.classList.remove('is-adjusted', 'is-over-limit')
      this._officialLyricsStatusEl.classList.add('is-pending')
    } else {
      const totalChars = nonEmpty.reduce((s, l) => s + [...l.replace(/\s/g, '')].length, 0)
      this._officialLyricsStatusEl.textContent = t('quickLyric.ai.official_lyrics_done', {
        lines: nonEmpty.length,
        chars: totalChars,
      })
      this._officialLyricsStatusEl.classList.remove('is-pending', 'is-over-limit')
      this._officialLyricsStatusEl.classList.add('is-adjusted')
    }
  }

  // ── AI 配额显示 ──────────────────────────────────

  async _refreshAIQuota() {
    if (!this._aiQuotaEl) return
    const userKeyPresent = await hasUserApiKey().catch(() => false)
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

  // ── AI 生成 ──────────────────────────────────────

  async _handleAIGenerate() {
    if (this._aiBusy) return
    if (!this._snapshot) {
      this._setStatus(t('quickLyric.ai.pick_track_first'), 'error')
      return
    }
    // 必须先填官方歌词——这是 AI 看到的"行结构"权威来源
    const officialNonEmpty = (this._officialLyrics || []).filter((l) => l.replace(/\s/g, '').length > 0)
    if (officialNonEmpty.length === 0) {
      this._setStatus(t('quickLyric.ai.official_lyrics_required'), 'error')
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
    this._setAIBusyUI(true)
    this._setStatus(t('quickLyric.ai.generating_status'), 'info')

    this._aiAbortController = new AbortController()
    // ★ AI 看到的结构 vs textarea 看到的结构是解耦的：
    //   - musicStructure 用官方歌词的"一句一行"结构 → 让 LLM 写出来的每句句意
    //     独立完整、严格匹配每行字数。后端的 aaaa 默认 phrase 切分是按音符间隔
    //     切的、跟自然句子边界对不上，不能用来约束 LLM
    //   - 拿到 result.flatChars 后再用**后端 phrase 切分**重新排列到 textarea
    //     （_layoutFlatCharsByBackendPhrases），跟默认 aaaa 状态的行视觉一致
    //   - 保存是按位置 1:1 灌字，跟 textarea 的行结构无关——所以两套切分各管
    //     各的、互不干扰
    const baseStructure = extractMusicStructure(this._snapshot)
    const musicStructure = this._buildMusicStructureFromOfficial(baseStructure, officialNonEmpty)
    const result = await this._aiClient.generate({
      musicStructure,
      theme,
      style,
      signal: this._aiAbortController.signal,
    })
    if (!this._el || !this._textarea) return

    this._aiBusy = false
    this._aiAbortController = null
    this._setAIBusyUI(false)
    this._refreshAIQuota()

    if (!result.ok) {
      this._setStatus(this._formatAIError(result), 'error')
      return
    }

    // AI 输出的 flatChars 重新按"后端 phrase 切分"排列到 textarea——
    // 视觉上跟默认 aaaa 状态完全一致（多少行、每行多少字），不再被官方歌词的
    // 行数干扰。AI 的"一句一行"约束只用于让 LLM 写出语义独立的句子，不参与渲染
    const textareaContent = this._layoutFlatCharsByBackendPhrases(result.flatChars)
    this._textarea.value = textareaContent
    this._parsedLyrics = null
    this._btnSave.disabled = true
    this._hideFix()

    // 入库：保留为可切换的候选；超过上限时丢最早一版
    const candidate = {
      phrases: result.phrases,
      flatChars: result.flatChars,
      theme,
      style,
      textareaContent,
      officialKey: this._computeOfficialLyricsKey(),
      createdAt: Date.now(),
    }
    this._aiCandidates.push(candidate)
    if (this._aiCandidates.length > AI_CANDIDATES_LIMIT) this._aiCandidates.shift()
    this._aiCurrentCandidateIdx = this._aiCandidates.length - 1
    this._renderCandidatesStrip()

    this._setStatus(t('quickLyric.ai.ai_done', { count: result.flatChars.length }), 'success')
  }

  // ── AI 候选轮播 ───────────────────────────────────

  _computeOfficialLyricsKey() {
    // 用"非空行的行字数 + 内容拼接"做指纹：行内空格不影响演唱单位，但为了
    // 切换提示准确，连同字面也参与签名——用户改字也算"结构变了"
    return (this._officialLyrics || [])
      .filter((l) => l.replace(/\s/g, '').length > 0)
      .map((l) => l.replace(/\s+/g, ''))
      .join('\n')
  }

  _renderCandidatesStrip() {
    const strip = this._aiCandidatesStripEl
    if (!strip) return
    strip.innerHTML = ''
    if (this._aiCandidates.length === 0) {
      strip.hidden = true
      this._aiBtnRetake = null
      return
    }
    strip.hidden = false
    const currentOfficialKey = this._computeOfficialLyricsKey()
    this._aiCandidates.forEach((cand, idx) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'quick-lyric-ai-candidate'
      if (idx === this._aiCurrentCandidateIdx) chip.classList.add('is-active')
      const isStale = cand.officialKey !== currentOfficialKey
      if (isStale) chip.classList.add('is-stale')
      const num = document.createElement('span')
      num.className = 'quick-lyric-ai-candidate-num'
      num.textContent = `#${idx + 1}`
      const preview = document.createElement('span')
      preview.className = 'quick-lyric-ai-candidate-preview'
      const firstLine = (cand.textareaContent.split('\n')[0] || '').slice(0, 6)
      preview.textContent = firstLine
      chip.title = isStale
        ? t('quickLyric.ai.candidate_stale')
        : t('quickLyric.ai.candidate_tooltip', { theme: cand.theme, style: cand.style || '—' })
      chip.append(num, preview)
      chip.addEventListener('click', () => this._switchToCandidate(idx))
      strip.appendChild(chip)
    })

    // 末尾"再来一版"：同 _handleAIGenerate 路径，会消耗一次配额。
    // 放在 strip 内是为了让"切换"和"再生"两类动作在同一条带上完成
    const btnRetake = document.createElement('button')
    btnRetake.type = 'button'
    btnRetake.className = 'quick-lyric-ai-retake'
    btnRetake.innerHTML = `<span aria-hidden="true">↻</span> ${t('quickLyric.ai.btn_retake')}`
    btnRetake.title = t('quickLyric.ai.retake_tooltip')
    btnRetake.disabled = this._aiBusy
    btnRetake.addEventListener('click', () => this._handleAIGenerate())
    this._aiBtnRetake = btnRetake
    strip.appendChild(btnRetake)
  }

  _switchToCandidate(idx) {
    if (idx < 0 || idx >= this._aiCandidates.length) return
    if (idx === this._aiCurrentCandidateIdx) return
    const cand = this._aiCandidates[idx]
    this._aiCurrentCandidateIdx = idx
    if (this._textarea) this._textarea.value = cand.textareaContent
    this._parsedLyrics = null
    if (this._btnSave) this._btnSave.disabled = true
    this._hideFix()
    this._setStatus(t('quickLyric.ai.candidates_switched', { idx: idx + 1 }), 'info')
    this._renderCandidatesStrip()
  }

  // 配合 generate / retake 两个入口，统一切换 busy 视觉
  _setAIBusyUI(busy) {
    if (this._aiBtnGenerate) {
      this._aiBtnGenerate.disabled = busy
      this._aiBtnGenerate.textContent = busy
        ? t('quickLyric.ai.btn_generating')
        : t('quickLyric.ai.btn_generate')
    }
    if (this._aiBtnRetake) this._aiBtnRetake.disabled = busy
  }

  // 把官方歌词的"一句一行"结构当成给 LLM 的 musicStructure：
  //   - 句数 = 官方歌词非空行数
  //   - 每句字数 = 该行去掉空白后的字符数
  // 这样 LLM 才有清晰的"每句多少字"硬约束，写出来的句意独立完整。
  // baseStructure 提供整体 bpm / pitch range / tempoLabel 等元信息——不直接用它的
  // phrases，因为后端 phrase 是按音符间隔切的、跟自然句子边界对不上
  _buildMusicStructureFromOfficial(baseStructure, officialLines) {
    const phrases = officialLines.map((line, i) => {
      const chars = [...line.replace(/\s/g, '')]
      return {
        index: i + 1,
        syllableCount: chars.length,
        // 没有真实的 per-line note 映射；rhythm 用占位（'短' x N），AI 不靠它写出歌词
        rhythm: new Array(chars.length).fill('短'),
        pitchLow: baseStructure?.pitchLow || null,
        pitchHigh: baseStructure?.pitchHigh || null,
        existingLyrics: null,
      }
    })
    return {
      totalNotes: phrases.reduce((s, p) => s + p.syllableCount, 0),
      phraseCount: phrases.length,
      bpm: baseStructure?.bpm ?? 120,
      tempoLabel: baseStructure?.tempoLabel ?? '中速',
      pitchLow: baseStructure?.pitchLow || null,
      pitchHigh: baseStructure?.pitchHigh || null,
      phrases,
    }
  }

  // 把 AI 返回的 flatChars 按"后端 phrase 切分"重新排列到 textarea。
  // 视觉上跟默认 aaaa 状态完全一致（多少句、每句多少字），便于用户对照。
  // 字数充裕时按 phrase 大小切；字数不够时尾部 phrase 行变短；字数过多时
  // 多出的字单独成尾行（后续 _handleParse 会爆 char_overflow 提醒用户）
  _layoutFlatCharsByBackendPhrases(flatChars) {
    const phraseSizes = (this._snapshot?.phrases || []).map((p) => (p.notes?.length || 0))
    const lines = []
    let cursor = 0
    for (const size of phraseSizes) {
      const slice = flatChars.slice(cursor, cursor + size)
      lines.push(slice.join(''))
      cursor += size
    }
    if (cursor < flatChars.length) {
      lines.push(flatChars.slice(cursor).join(''))
    }
    return lines.join('\n')
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

  // ── 位置 / 拖拽 ─────────────────────────────────────

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

  // ── textarea 填充 / 解析 / 保存 ──────────────────

  /** 从 snapshot 提取当前歌词，按后端 phrase 切分换行 */
  _fillCurrentLyrics() {
    const phrases = this._snapshot?.phrases || []
    const lines = phrases.map((phrase) =>
      (phrase.notes || []).map((n) => n.lyric || 'a').join(''),
    )
    this._textarea.value = lines.join('\n')
    const totalNotes = phrases.reduce((sum, p) => sum + (p.notes?.length || 0), 0)
    this._setStatus(t('quickLyric.note_count', { count: totalNotes }), 'info')
  }

  /** 解析用户输入：textarea 全部字符压成 flat 流，校验总字数 ≤ 总音符数。
   *  保存时按后端 phrase 顺序贪心切分到每段（chars < notes 时自动合音补 '+' 延音） */
  async _handleParse() {
    const flatNotes = flattenSnapshotNotes(this._snapshot?.phrases || [])
    const totalNotes = flatNotes.length

    let raw = this._textarea.value

    // 日语：汉字 → 假名
    if (this._isJapanese() && /[一-鿿]/.test(raw)) {
      this._setStatus(t('quickLyric.converting_kanji'), 'info')
      this._btnParse.disabled = true
      try {
        const { convertKanjiToKana } = await import('../util/kanjiToKana.js')
        raw = await convertKanjiToKana(raw)
      } catch (error) {
        this._setStatus(t('quickLyric.convert_failed', { message: error?.message || t('quickLyric.unknown_error') }), 'error')
        this._btnParse.disabled = false
        return
      }
      this._btnParse.disabled = false
      this._textarea.value = raw
    }

    const splitMoraeIfNeeded = this._isJapanese()
      ? (await import('../util/kanjiToKana.js')).splitMorae
      : null
    const flatChars = []
    for (const line of raw.split('\n')) {
      const lineRaw = line.replace(/\s/g, '')
      let chars
      if (splitMoraeIfNeeded) {
        chars = splitMoraeIfNeeded(lineRaw)
      } else {
        // 书写分隔符（连字符、标点）不是演唱单位：按字符发到后端时，
        // phonemizer 查表失败会走 wordFound=false 路径并 continue 掉
        // partResult[note.position]，那个 note 在新 phrase 集合里整个丢失，
        // SynthesisService.EnsureLyricEditPreservesStructure 报 missing notes>0。
        chars = [...lineRaw].filter((ch) => !LYRIC_SEPARATOR_RE.test(ch))
      }
      flatChars.push(...chars)
    }

    if (flatChars.length === 0) {
      this._setStatus(t('quickLyric.empty'), 'error')
      this._parsedLyrics = null
      this._btnSave.disabled = true
      this._hideFix()
      return
    }
    if (flatChars.length > totalNotes) {
      this._setStatus(
        t('quickLyric.char_overflow', { actual: flatChars.length, max: totalNotes }),
        'error',
      )
      this._parsedLyrics = null
      this._btnSave.disabled = true
      this._hideFix()
      return
    }
    this._hideFix()

    this._parsedLyrics = flatChars
    this._setStatus(
      t('quickLyric.parse_ok', { chars: flatChars.length, phrases: (this._snapshot?.phrases || []).length }),
      'success',
    )
    this._btnSave.disabled = false
  }

  /** 构建 lyric edits 并提交。
   *
   *  ★★★ 两套数据架构（保住后端 phrase 结构不变）★★★
   *  - 用户面（textarea）：自然格式，用户怎么写就怎么写——一行一句、不限行数
   *  - 后端面（edits）：把 textarea 拍平成的 flat 字符流 **严格 1:1** 顺序灌进
   *    后端切好的 phrase 里，每个 note 一个字、不引入任何延音 '+'
   *
   *  为什么不能用 '+'：
   *    OpenUtau ValidateFull 重新音素化后，'+' 把多个 note 合并成同一个音节，
   *    会改变 phrase 的音素结构，后端的 EnsureLyricEditPreservesStructure 就会
   *    判定 "phrases 66→56" 拒绝整次编辑。
   *
   *  字数不足总 note 数：尾部多出的 note 保留 'a'（默认），不报错——后端结构不变 */
  async _handleSave() {
    if (!this._parsedLyrics || !this._snapshot) return
    const flatNotes = flattenSnapshotNotes(this._snapshot.phrases || [])
    const bpm = this._snapshot.bpm || 120
    const edits = []
    const distributedByGlobal = new Map()
    // 严格按全局 note 顺序 1:1 取字——不分段、不延音、不合并
    flatNotes.forEach((_note, globalIdx) => {
      const ch = this._parsedLyrics[globalIdx]
      if (typeof ch === 'string' && ch.length > 0) {
        distributedByGlobal.set(globalIdx, ch)
      }
    })

    flatNotes.forEach((note, globalIdx) => {
      if (!note) return
      const newLyric = distributedByGlobal.get(globalIdx) ?? 'a'
      if (newLyric !== (note.lyric || 'a')) {
        edits.push({
          action: 'lyric',
          position: Math.round((note.time * 480 * bpm) / 60),
          duration: Math.round((note.duration * 480 * bpm) / 60),
          tone: note.midi,
          lyric: newLyric,
        })
      }
    })
    if (edits.length === 0) {
      this._setStatus(t('quickLyric.no_change'), 'info')
      return
    }

    this._btnSave.disabled = true
    this._setStatus(t('quickLyric.saving', { count: edits.length }), 'info')

    try {
      await this._onSave?.(edits)
    } catch (error) {
      const msg = String(error?.message || '')
      // 后端 job 被清理（idle 超时 / 服务器重启 / cleanup）—— 翻译成可操作的人话，
      // 而不是甩 "Job not found." 让用户摸不到头脑
      if (/job not found/i.test(msg)) {
        this._setStatus(t('quickLyric.save_failed_job_lost'), 'error')
      } else {
        this._setStatus(t('quickLyric.save_failed', { message: msg || t('quickLyric.unknown_error') }), 'error')
      }
      this._btnSave.disabled = false
      return
    }

    flatNotes.forEach((note, globalIdx) => {
      if (note) note.lyric = distributedByGlobal.get(globalIdx) ?? 'a'
    })
    this._setStatus(t('quickLyric.saved', { count: edits.length }), 'success')
    this._parsedLyrics = null
  }

  // ── 自动修复（字数不足时补 a / 多了时截断）──────

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
    const lines = []
    let offset = 0
    for (const count of noteCounts) {
      lines.push(fixed.slice(offset, offset + count).join(''))
      offset += count
    }
    this._textarea.value = lines.join('\n')
    this._hideFix()
    this._handleParse()
  }

  // ── 工具 ──────────────────────────────────────────

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
