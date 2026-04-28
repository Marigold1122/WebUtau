// NoteEditPopover 的 DOM 构建：扁平多行布局，所有字段一次全展开，无折叠。
// 顺序：起始连接 · 滑音 · 音准 · 颤音（开关 + 预设 + 所有字段）
// 字段标签用完整词（起点 / 时长 / 周期 / 深度 / 淡入 / 淡出 / 相位 / 漂移 / 音量联动）。

import {
  PORTAMENTO_PRESETS,
  VIBRATO_PRESETS,
  BOUNDARY_META,
  PORTAMENTO_FIELDS,
  TUNING_FIELD,
  VIBRATO_BASIC_FIELDS,
  VIBRATO_ADVANCED_FIELDS,
  resolveSharedPresetId,
} from './noteEditPopoverPresets.js'
import { t } from '../i18n/index.js'

export function createNoteEditPopoverView(handlers = {}) {
  const refs = {
    countBadge: null,
    boundaryButtons: new Map(),
    portamentoPreset: null,
    portamentoInputs: new Map(),
    tuningInput: null,
    vibratoPreset: null,
    vibratoBasicInputs: new Map(),
    vibratoAdvancedInputs: new Map(),
  }
  let suspendSync = false

  const root = document.createElement('div')
  root.className = 'note-edit-popover'

  // 所有 commit 都走这个壳：触发期间暂停 sync（防止上一帧的旧状态回写覆盖用户输入），
  // commit 完成后主动请求一次 sync 拿到 clamp 后的真实值。
  const commit = (work) => {
    suspendSync = true
    Promise.resolve(work()).finally(() => {
      suspendSync = false
      handlers.requestSync?.()
    })
  }

  // ---------- 头部：计数 ----------
  const headerRow = document.createElement('div')
  headerRow.className = 'note-edit-popover-row note-edit-popover-header'
  const count = document.createElement('span')
  count.className = 'inline-popover-count'
  count.dataset.role = 'count'
  count.textContent = '0'
  refs.countBadge = count
  headerRow.appendChild(count)

  // 起始连接（头部右侧）
  const boundaryGroup = document.createElement('div')
  boundaryGroup.className = 'inline-popover-btn-group'
  const boundaryLabel = document.createElement('span')
  boundaryLabel.className = 'inline-popover-subheader'
  boundaryLabel.textContent = t('noteEdit.onset')
  headerRow.appendChild(boundaryLabel)
  for (const { mode, label } of BOUNDARY_META) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'inline-popover-btn inline-popover-btn--compact'
    btn.textContent = label
    btn.addEventListener('pointerdown', (event) => event.preventDefault())
    btn.addEventListener('click', () => handlers.onBoundaryMode?.(mode))
    refs.boundaryButtons.set(mode, btn)
    boundaryGroup.appendChild(btn)
  }
  headerRow.appendChild(boundaryGroup)
  root.appendChild(headerRow)

  // ---------- 滑音 ----------
  const portamentoRow = sectionRow(t('noteEdit.pitchbend'))
  refs.portamentoPreset = select(PORTAMENTO_PRESETS, (value) =>
    commit(() => handlers.onPortamentoPreset?.(value)), t('noteEdit.pitchbend_preset'))
  portamentoRow.appendChild(refs.portamentoPreset)
  for (const { field: name, min, max, label } of PORTAMENTO_FIELDS) {
    const input = number(min, max, (value) =>
      commit(() => handlers.onPortamentoField?.(name, value)))
    refs.portamentoInputs.set(name, input)
    portamentoRow.appendChild(fieldWrap(label, input))
  }
  refs.tuningInput = number(TUNING_FIELD.min, TUNING_FIELD.max, (value) =>
    commit(() => handlers.onTuning?.(value)))
  portamentoRow.appendChild(fieldWrap(TUNING_FIELD.label, refs.tuningInput))
  root.appendChild(portamentoRow)

  // ---------- 颤音预设（空选项 = 关闭） ----------
  const vibratoHeadRow = sectionRow(t('noteEdit.vibrato'))
  refs.vibratoPreset = select(VIBRATO_PRESETS, (value) =>
    commit(() => handlers.onVibratoPreset?.(value)), t('noteEdit.vibrato_preset'))
  vibratoHeadRow.appendChild(refs.vibratoPreset)
  root.appendChild(vibratoHeadRow)

  // ---------- 颤音基本参数 ----------
  const vibratoBasicRow = document.createElement('div')
  vibratoBasicRow.className = 'note-edit-popover-row note-edit-popover-row--indent'
  for (const { field: name, label, min, max } of VIBRATO_BASIC_FIELDS) {
    const input = number(min, max, (value) =>
      commit(() => handlers.onVibratoField?.(name, value)))
    refs.vibratoBasicInputs.set(name, input)
    vibratoBasicRow.appendChild(fieldWrap(label, input))
  }
  root.appendChild(vibratoBasicRow)

  // ---------- 颤音高级参数（全展开，不折叠） ----------
  const vibratoAdvancedRow = document.createElement('div')
  vibratoAdvancedRow.className = 'note-edit-popover-row note-edit-popover-row--indent'
  for (const { field: name, label, min, max } of VIBRATO_ADVANCED_FIELDS) {
    const input = number(min, max, (value) =>
      commit(() => handlers.onVibratoField?.(name, value)))
    refs.vibratoAdvancedInputs.set(name, input)
    vibratoAdvancedRow.appendChild(fieldWrap(label, input))
  }
  root.appendChild(vibratoAdvancedRow)

  return { root, refs, sync, isSyncSuspended: () => suspendSync }

  // ---------- 同步 ----------

  function sync(state) {
    const { count: selectCount, pitchMode, noteScope, portamento, tuning, vibrato, boundaryMode } = state
    refs.countBadge.textContent = String(selectCount)

    for (const [mode, btn] of refs.boundaryButtons.entries()) {
      btn.disabled = !(pitchMode && noteScope)
      btn.classList.toggle('is-active', pitchMode && boundaryMode === mode)
    }

    refs.portamentoPreset.disabled = !noteScope
    refs.portamentoPreset.value = noteScope && !portamento.mixed
      ? resolveSharedPresetId(PORTAMENTO_PRESETS, portamento.values, ['start', 'length'])
      : ''
    for (const [name, input] of refs.portamentoInputs.entries()) {
      writeInput(input, portamento.values[name], !noteScope)
    }
    writeInput(refs.tuningInput, tuning.value, !noteScope)

    const vibratoOn = vibrato.enabled === true
    // 颤音预设始终可选：选具体预设 → 启用并应用；选空选项 → 关闭
    refs.vibratoPreset.disabled = !noteScope
    refs.vibratoPreset.value = noteScope && vibratoOn
      ? resolveSharedPresetId(VIBRATO_PRESETS, vibrato.values, ['length', 'period', 'depth', 'in', 'out', 'shift', 'drift', 'volLink'])
      : ''
    for (const [name, input] of refs.vibratoBasicInputs.entries()) {
      writeInput(input, vibrato.values[name], !(noteScope && vibratoOn))
    }
    for (const [name, input] of refs.vibratoAdvancedInputs.entries()) {
      writeInput(input, vibrato.values[name], !(noteScope && vibratoOn))
    }
  }

  // ---------- helpers ----------

  function sectionRow(title) {
    const el = document.createElement('div')
    el.className = 'note-edit-popover-row'
    const label = document.createElement('span')
    label.className = 'inline-popover-subheader'
    label.textContent = title
    el.appendChild(label)
    return el
  }

  function fieldWrap(labelText, control) {
    const label = document.createElement('label')
    label.className = 'inline-popover-field'
    const text = document.createElement('span')
    text.className = 'inline-popover-field-label'
    text.textContent = labelText
    label.append(text, control)
    return label
  }

  function number(min, max, onCommit) {
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'inline-popover-number-input'
    input.min = String(min)
    input.max = String(max)
    input.step = '1'
    input.placeholder = '-'
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      }
    })
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value)) {
        handlers.requestSync?.()
        return
      }
      onCommit(value)
    })
    return input
  }

  function select(presets, onCommit, title = '') {
    const el = document.createElement('select')
    el.className = 'inline-popover-select'
    if (title) el.title = title
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('noteEdit.preset')
    el.appendChild(empty)
    for (const preset of presets) {
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = preset.label
      el.appendChild(option)
    }
    el.addEventListener('change', () => onCommit(el.value))
    return el
  }

  function writeInput(input, value, disabled) {
    if (!input) return
    input.disabled = Boolean(disabled)
    if (document.activeElement === input) return
    input.value = value == null ? '' : String(value)
    input.placeholder = value == null ? '-' : ''
  }
}
