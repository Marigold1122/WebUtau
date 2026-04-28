import { markReverbProbe } from '../../audio/reverb/ReverbDebugProbe.js'
import { t } from '../../../i18n/index.js'
import {
  formatReverbPresetOption,
  formatReverbSelectLabel,
  formatReverbStyleOption,
} from './reverbDockI18n.js'

function clampRange(value, min, max, fallback = min) {
  const safeValue = Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, safeValue))
}

function createLabeledSelectRow(labelText) {
  const row = document.createElement('div')
  row.className = 'fx-screen-row'

  const label = document.createElement('span')
  label.className = 'fx-screen-label'
  label.textContent = labelText

  const select = document.createElement('select')
  select.className = 'fx-screen-select'

  row.append(label, select)
  return { row, select }
}

function normalizePresetTag(tag, fallback = 'all') {
  if (typeof tag === 'string' && tag.trim()) return tag.trim()
  return fallback
}

function listFilteredPresets(presets = [], tag = 'all') {
  const normalizedTag = normalizePresetTag(tag, 'all')
  if (normalizedTag === 'all') return [...presets]
  return (Array.isArray(presets) ? presets : []).filter((preset) => {
    const tags = Array.isArray(preset?.tags) ? preset.tags : []
    return tags.includes(normalizedTag)
  })
}

export function createPlaceholderModule() {
  const root = document.createElement('div')
  root.className = 'fx-module fx-module--placeholder'
  root.textContent = 'Select a track and press FX to bring its reverb module into the rack.'
  return root
}

export function createReverbDockModule({
  title,
  powered = true,
  onTogglePower = null,
  controls = [],
  footer = null,
  note = '',
  scopeBadge = null, // { text, tone } —— 顶栏 pill，标明该模块作用范围（全局 / 单轨 / 工程默认）
} = {}) {
  const root = document.createElement('div')
  root.className = 'fx-module'

  const header = document.createElement('div')
  header.className = 'fx-header'

  const titleWrap = document.createElement('span')
  titleWrap.className = 'fx-header-title'

  if (scopeBadge && typeof scopeBadge.text === 'string' && scopeBadge.text) {
    const badge = document.createElement('span')
    badge.className = `fx-scope-badge fx-scope-badge--${scopeBadge.tone || 'neutral'}`
    badge.textContent = scopeBadge.text
    titleWrap.appendChild(badge)
  }

  const titleNode = document.createElement('span')
  titleNode.className = 'fx-header-title-text'
  titleNode.textContent = title
  titleWrap.appendChild(titleNode)

  const powerButton = document.createElement('button')
  powerButton.type = 'button'
  powerButton.className = `fx-power${powered ? '' : ' is-off'}`
  powerButton.title = powered ? 'Disable reverb' : 'Enable reverb'
  powerButton.setAttribute('aria-pressed', String(powered))
  powerButton.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onTogglePower?.()
  })

  header.append(titleWrap, powerButton)

  const body = document.createElement('div')
  body.className = 'fx-body'
  controls.forEach((control) => body.appendChild(control.root))

  root.append(header, body)
  if (footer) root.appendChild(footer)

  if (note) {
    const noteNode = document.createElement('div')
    noteNode.className = 'fx-module-note'
    noteNode.textContent = note
    root.appendChild(noteNode)
  }

  return root
}

export function createPresetControl({
  presets = [],
  presetTags = [],
  selectedPresetId = '',
  selectedTag = 'all',
  onChange = null,
  onTagChange = null,
} = {}) {
  const root = document.createElement('div')
  const normalizedPresets = Array.isArray(presets) ? presets : []
  const normalizedTags = Array.isArray(presetTags) ? presetTags : []
  const hasTagFilter = normalizedTags.length > 1

  let currentTag = normalizePresetTag(selectedTag, normalizedTags[0]?.id || 'all')
  let currentPresetId = selectedPresetId || ''
  let suppressPresetChangeEvent = true

  const { row: presetRow, select: presetSelect } = createLabeledSelectRow(formatReverbSelectLabel('Preset'))
  let tagSelect = null

  const rebuildPresetOptions = ({ keepSelectedOutsideFilter = true } = {}) => {
    const filteredPresets = listFilteredPresets(normalizedPresets, currentTag)
    const selectedPreset = normalizedPresets.find((preset) => preset.id === currentPresetId) || null
    const entries = [...filteredPresets]
    if (
      keepSelectedOutsideFilter
      && selectedPreset
      && !entries.some((preset) => preset.id === selectedPreset.id)
    ) {
      entries.unshift(selectedPreset)
    }

    const previousPresetId = currentPresetId
    presetSelect.replaceChildren()
    entries.forEach((preset) => {
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = formatReverbPresetOption(preset.id, preset.name)
      presetSelect.appendChild(option)
    })

    presetSelect.disabled = entries.length === 0
    if (entries.length === 0) {
      currentPresetId = ''
      return { changedPreset: false, previousPresetId, nextPresetId: currentPresetId }
    }

    const availableSelected = entries.some((preset) => preset.id === currentPresetId)
    currentPresetId = availableSelected ? currentPresetId : entries[0].id
    presetSelect.value = currentPresetId
    return {
      changedPreset: previousPresetId !== currentPresetId,
      previousPresetId,
      nextPresetId: currentPresetId,
    }
  }

  if (hasTagFilter) {
    const { row: tagRow, select } = createLabeledSelectRow(formatReverbSelectLabel('Style'))
    tagSelect = select

    normalizedTags.forEach((tag) => {
      const option = document.createElement('option')
      option.value = tag.id
      option.textContent = formatReverbStyleOption(tag.id, tag.name || tag.id)
      tagSelect.appendChild(option)
    })
    tagSelect.value = currentTag
    tagSelect.addEventListener('change', () => {
      currentTag = normalizePresetTag(tagSelect.value, normalizedTags[0]?.id || 'all')
      const rebuildResult = rebuildPresetOptions({ keepSelectedOutsideFilter: false })
      // Persist style selection before preset callbacks, because preset selection can
      // trigger a re-render that reads the latest tag from view state.
      onTagChange?.(currentTag)
      if (
        rebuildResult?.changedPreset
        && !suppressPresetChangeEvent
        && rebuildResult.nextPresetId
      ) {
        onChange?.(rebuildResult.nextPresetId)
      }
    })
    root.appendChild(tagRow)
  }

  rebuildPresetOptions({
    keepSelectedOutsideFilter: currentTag === 'all',
  })
  suppressPresetChangeEvent = false
  presetSelect.addEventListener('change', () => {
    currentPresetId = presetSelect.value
    onChange?.(currentPresetId)
  })

  root.appendChild(presetRow)
  return root
}

export function createFxKnobControl({
  label,
  min,
  max,
  step,
  tone = 'blue',
  value,
  format = (nextValue) => String(nextValue),
  onInput = null,
  onCommit = null,
  disabled = false,
} = {}) {
  const root = document.createElement('div')
  root.className = 'param-group'

  const labelNode = document.createElement('span')
  labelNode.className = 'param-label'
  labelNode.textContent = label

  const knob = document.createElement('div')
  knob.className = `knob-large ${tone}${disabled ? ' is-disabled' : ''}`

  const inner = document.createElement('div')
  inner.className = 'knob-large-inner'

  const pointer = document.createElement('div')
  pointer.className = 'knob-large-pointer'
  inner.appendChild(pointer)
  knob.appendChild(inner)

  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'knob-hitbox'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.disabled = Boolean(disabled)
  knob.appendChild(input)

  const valueNode = document.createElement('div')
  valueNode.className = 'param-value'
  valueNode.title = t('onboardingUI.knob_input_tip')

  let currentValue = clampRange(value, min, max, min)

  const syncValue = (nextValue) => {
    const normalizedValue = clampRange(nextValue, min, max, min)
    currentValue = normalizedValue
    const ratio = max > min ? (normalizedValue - min) / (max - min) : 0
    input.value = String(normalizedValue)
    knob.style.setProperty('--knob-sweep', `${Math.round(ratio * 270)}deg`)
    knob.style.setProperty('--knob-angle', `${-135 + (ratio * 270)}deg`)
    valueNode.textContent = format(normalizedValue)
  }

  syncValue(currentValue)

  input.addEventListener('input', () => {
    const nextValue = Number.parseFloat(input.value)
    markReverbProbe('knobInputEvents')
    syncValue(nextValue)
    onInput?.(nextValue)
  })

  input.addEventListener('change', () => {
    const nextValue = Number.parseFloat(input.value)
    syncValue(nextValue)
    onCommit?.(nextValue)
  })

  // 单击 value 显示框 → 切到文本编辑态精确输入。Enter 提交、Escape 取消、blur 默认提交
  const beginNumericEdit = () => {
    if (disabled) return
    if (root.classList.contains('editing')) return
    root.classList.add('editing')

    const editInput = document.createElement('input')
    editInput.type = 'text'
    editInput.inputMode = 'decimal'
    editInput.className = 'param-value-input'
    editInput.value = String(currentValue)

    const previousText = valueNode.textContent
    valueNode.textContent = ''
    valueNode.appendChild(editInput)
    requestAnimationFrame(() => {
      editInput.focus()
      editInput.select()
    })

    let finished = false
    const finish = (cancel) => {
      if (finished) return
      finished = true
      root.classList.remove('editing')
      if (editInput.parentNode) editInput.parentNode.removeChild(editInput)
      if (cancel) {
        valueNode.textContent = previousText
        return
      }
      const numeric = Number.parseFloat(editInput.value)
      if (!Number.isFinite(numeric)) {
        valueNode.textContent = previousText
        return
      }
      const clamped = clampRange(numeric, min, max, min)
      syncValue(clamped)
      onCommit?.(clamped)
    }

    editInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
      } else {
        // 阻断空格 / S / M 等全局快捷键，避免输入数字时误触播放等
        event.stopPropagation()
      }
    })
    editInput.addEventListener('blur', () => finish(false))
    editInput.addEventListener('pointerdown', (event) => event.stopPropagation())
    editInput.addEventListener('click', (event) => event.stopPropagation())
  }
  valueNode.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    beginNumericEdit()
  })

  root.append(labelNode, knob, valueNode)
  return {
    root,
    input,
    syncValue,
  }
}
