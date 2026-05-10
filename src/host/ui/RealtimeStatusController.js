/**
 * 底部 status bar 右侧的"实时上下文"控制器。
 *
 * 字段（自左到右）：
 *   - 项目：projectName
 *   - BPM：当前 tempo（变速曲取播放头处 bpm）
 *   - 播放头：bar.beat.tickInBeat · mm:ss.mmm
 *   - 编辑器：mode（note/pitch/lyric）+ 当前轨道名
 *
 * 设计要点：
 *   - 所有字段都用预先创建的 `<span>` 元素，update 时只动 textContent，避免 reflow 惊雷
 *   - 播放头每帧（throttled 50ms by upstream）调用一次 setPlayhead，性能敏感——
 *     bar-beat 用 createBarBeatFormatter 预算 segments，每帧 O(log N) 查找 + 字符串拼接
 *   - 项目 / BPM / 编辑器变化只在 render() 走一次，不需高频
 *
 * 不直接订阅 store / event bus —— 由 ShellLayoutView 显式调用 setX，方便单测
 */

import { createBarBeatFormatter, formatTimecode } from '../../shared/formatPlayheadPosition.js'
import { formatSpan, midiToNoteName } from '../../shared/selectionSummary.js'
import { t } from '../../i18n/index.js'

// "selection" 字段在没选中时**自动隐藏**——靠 .is-hidden class 控制 display
const ITEM_KEYS = ['project', 'bpm', 'playhead', 'editor', 'selection']

export class RealtimeStatusController {
  constructor(rootEl) {
    this._root = rootEl || null
    this._items = new Map()
    /** @type {(timeSec: number) => string} */
    this._formatBarBeat = createBarBeatFormatter({ tempoData: null, ppq: 480 })
    this._lastPlayheadTime = -1
    this._currentTempoData = null
    this._currentPpq = 480
    this._build()
  }

  _build() {
    if (!this._root) return
    this._root.innerHTML = ''
    ITEM_KEYS.forEach((key, index) => {
      const item = document.createElement('span')
      item.className = 'status-bar-context-item'
      item.dataset.field = key
      const label = document.createElement('span')
      label.className = 'status-bar-context-item-label'
      const value = document.createElement('span')
      value.className = 'status-bar-context-item-value'
      item.append(label, value)
      this._root.appendChild(item)
      // 字段间用 · 分隔——视觉节奏感强于纯空格
      let divider = null
      if (index < ITEM_KEYS.length - 1) {
        divider = document.createElement('span')
        divider.className = 'status-bar-context-item-divider'
        divider.textContent = '·'
        this._root.appendChild(divider)
      }
      this._items.set(key, { item, label, value, divider })
    })
    // selection 字段默认隐藏（无选区时不占位）；其前的 divider 也跟着隐藏
    this._setFieldHidden('selection', true)
    // 初始化所有 label 文案（i18n keys 都在 hostStatus.context.*）
    this._refreshLabels()
  }

  _setFieldHidden(key, hidden) {
    const refs = this._items.get(key)
    if (!refs) return
    if (refs.item) refs.item.classList.toggle('is-hidden', hidden)
    // 隐藏 selection 字段时，把它**前面**的那个 divider 也藏掉，避免出现"… · "结尾
    // 找到上一个字段的 divider（即 selection 字段的"前置分隔符"）
    if (key === 'selection') {
      const editorRefs = this._items.get('editor')
      if (editorRefs?.divider) editorRefs.divider.classList.toggle('is-hidden', hidden)
    }
  }

  _refreshLabels() {
    const refs = (key) => this._items.get(key)
    if (refs('project')) refs('project').label.textContent = t('hostStatus.context.project_label')
    if (refs('bpm')) refs('bpm').label.textContent = t('hostStatus.context.bpm_label')
    if (refs('playhead')) refs('playhead').label.textContent = t('hostStatus.context.playhead_label')
    if (refs('editor')) refs('editor').label.textContent = t('hostStatus.context.editor_label')
    if (refs('selection')) refs('selection').label.textContent = t('hostStatus.context.selection_label')
  }

  /** i18n 切换语言后重新填 label */
  refreshLocale() {
    this._refreshLabels()
    // editor / selection 字段 value 都含 i18n 文案，强制重渲一次
    if (this._lastEditorPayload) this.setEditor(this._lastEditorPayload)
    if (this._lastSelectionSummary !== undefined) this.setSelection(this._lastSelectionSummary)
  }

  // ── 设置项目 ─────────────────────────────────────
  /**
   * @param {{ name: string, tempoData: object|null, ppq: number }} project
   */
  setProject(project = {}) {
    const refs = this._items.get('project')
    if (refs) {
      const display = (typeof project?.name === 'string' && project.name.trim())
        ? project.name.trim()
        : t('hostStatus.context.project_untitled')
      if (refs.value.textContent !== display) refs.value.textContent = display
    }
    // BPM：变速曲下取首段值（播放头处的 bpm 由 setPlayhead 阶段细化）
    const tempos = Array.isArray(project?.tempoData?.tempos) ? project.tempoData.tempos : []
    const baseBpm = Number.isFinite(tempos[0]?.bpm) ? Math.round(tempos[0].bpm) : 120
    const bpmRefs = this._items.get('bpm')
    if (bpmRefs && bpmRefs.value.textContent !== String(baseBpm)) {
      bpmRefs.value.textContent = String(baseBpm)
    }
    // 缓存 tempoData / ppq——给 createBarBeatFormatter 重建用
    if (project?.tempoData !== this._currentTempoData || project?.ppq !== this._currentPpq) {
      this._currentTempoData = project?.tempoData || null
      this._currentPpq = project?.ppq || 480
      this._formatBarBeat = createBarBeatFormatter({
        tempoData: this._currentTempoData,
        ppq: this._currentPpq,
      })
      // tempoData 变了就需要重算 playhead 文本
      this._lastPlayheadTime = -1
      if (this._lastPlayheadTimeValue != null) this.setPlayhead(this._lastPlayheadTimeValue)
    }
  }

  // ── 设置播放头 ───────────────────────────────────
  /** @param {number} timeSec */
  setPlayhead(timeSec) {
    this._lastPlayheadTimeValue = timeSec
    const refs = this._items.get('playhead')
    if (!refs) return
    // 同一秒内没变就不更新——50ms throttle 已够频繁，再判一次就纯省 DOM
    if (Math.abs(timeSec - this._lastPlayheadTime) < 0.001) return
    this._lastPlayheadTime = timeSec
    const barBeat = this._formatBarBeat(timeSec)
    const timecode = formatTimecode(timeSec)
    const text = `${barBeat} · ${timecode}`
    if (refs.value.textContent !== text) refs.value.textContent = text
  }

  // ── 设置编辑器上下文 ─────────────────────────────
  /**
   * @param {{ mode: 'note'|'pitch'|'lyric'|null, trackName: string|null }} payload
   */
  setEditor(payload = {}) {
    this._lastEditorPayload = payload
    const refs = this._items.get('editor')
    if (!refs) return
    const mode = payload?.mode || null
    const trackName = (typeof payload?.trackName === 'string' && payload.trackName.trim())
      ? payload.trackName.trim()
      : null
    let text
    if (!mode && !trackName) {
      text = t('hostStatus.context.editor_idle')
    } else if (!mode) {
      text = trackName
    } else {
      const modeText = t(`hostStatus.context.editor_mode_${mode}`)
      text = trackName ? `${modeText} · ${trackName}` : modeText
    }
    if (refs.value.textContent !== text) refs.value.textContent = text
  }

  // ── 设置选区摘要 ─────────────────────────────────
  /**
   * @param {{ count: number, midiLow: number, midiHigh: number, spanSec: number } | null} summary
   *   null 表示无选区（隐藏字段）；非 null 时格式化为 "5 音符 · C4–G4 · 2.34s"
   */
  setSelection(summary) {
    this._lastSelectionSummary = summary || null
    const refs = this._items.get('selection')
    if (!refs) return
    if (!summary || summary.count <= 0) {
      this._setFieldHidden('selection', true)
      return
    }
    const countLabel = t('hostStatus.context.selection_count', { count: summary.count })
    const lowName = midiToNoteName(summary.midiLow)
    const highName = midiToNoteName(summary.midiHigh)
    const pitchPart = (summary.midiLow === summary.midiHigh)
      ? lowName
      : `${lowName}–${highName}`  // en dash 不是连字符——视觉更专业
    const spanPart = formatSpan(summary.spanSec)
    const text = `${countLabel} · ${pitchPart} · ${spanPart}`
    if (refs.value.textContent !== text) refs.value.textContent = text
    this._setFieldHidden('selection', false)
  }

  destroy() {
    this._items.clear()
    if (this._root) this._root.innerHTML = ''
    this._root = null
  }
}
