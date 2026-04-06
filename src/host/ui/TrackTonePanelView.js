import {
  createDefaultTrackGuitarToneConfig,
  normalizeTrackGuitarToneConfig,
  supportsTrackGuitarToneSource,
} from '../audio/insert/trackInsertCatalog.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { createFxKnobControl } from './reverb/reverbDockDom.js'
import {
  GUITAR_TONE_PANEL_MODULES,
  GUITAR_TONE_PRESETS,
} from './tone/tonePanelDefinitions.js'

function createEmptyState(title, text) {
  const root = document.createElement('section')
  root.className = 'panel-section tone-panel-empty'

  const heading = document.createElement('h2')
  heading.textContent = title

  const body = document.createElement('div')
  body.className = 'tone-panel-empty-body'
  body.textContent = text

  root.append(heading, body)
  return root
}

function createToneModule({ title, note = '', controls = [] } = {}) {
  const root = document.createElement('section')
  root.className = 'tone-module'

  const header = document.createElement('div')
  header.className = 'fx-header tone-module-header'
  header.textContent = title

  const body = document.createElement('div')
  body.className = 'tone-module-body'
  controls.forEach((control) => body.appendChild(control.root))

  root.append(header, body)
  if (note) {
    const noteNode = document.createElement('div')
    noteNode.className = 'tone-module-note'
    noteNode.textContent = note
    root.appendChild(noteNode)
  }

  return root
}

function createHeroSection(track) {
  const root = document.createElement('section')
  root.className = 'panel-section tone-panel-hero'

  const heading = document.createElement('h2')
  heading.textContent = '吉他音色'

  const title = document.createElement('div')
  title.className = 'tone-panel-track-name'
  title.textContent = track?.name || '当前轨道'

  const subtitle = document.createElement('div')
  subtitle.className = 'tone-panel-track-note'
  subtitle.textContent = 'Amp Sim 3 · 可在下面直接套用经典 clean / chime / crunch / J-rock 预设，然后继续微调旋钮。'

  root.append(heading, title, subtitle)
  return root
}

function createPresetSection({
  activePreset = null,
  onApply = null,
} = {}) {
  const root = document.createElement('section')
  root.className = 'panel-section tone-preset-section'

  const heading = document.createElement('h2')
  heading.textContent = '预设'

  const row = document.createElement('div')
  row.className = 'fx-screen-row tone-preset-row'

  const label = document.createElement('span')
  label.className = 'fx-screen-label'
  label.textContent = '风格'

  const select = document.createElement('select')
  select.className = 'fx-screen-select'

  const customOption = document.createElement('option')
  customOption.value = ''
  customOption.textContent = '自定义 / Manual'
  select.appendChild(customOption)

  GUITAR_TONE_PRESETS.forEach((preset) => {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.shortLabel || preset.name
    select.appendChild(option)
  })
  select.value = activePreset?.id || ''
  select.addEventListener('change', () => {
    if (!select.value) {
      onApply?.(null)
      return
    }
    onApply?.(select.value)
  })

  row.append(label, select)

  const desc = document.createElement('div')
  desc.className = 'tone-preset-description'
  desc.textContent = activePreset?.description || '这里的预设提供 Blackface / VOX / Plexi / Tele / God knows... 等多个吉他起点，应用后仍然可以继续手动微调。'

  const source = document.createElement('div')
  source.className = 'tone-preset-source'
  source.textContent = activePreset?.sourceSummary || '思路来自公开可考的演奏者 / 器材信息与常见风格音色区间，再映射到当前 Amp Sim 3 控件。'

  root.append(heading, row, desc, source)
  return root
}

export class TrackTonePanelView {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this.appliedPresetIds = new Map()
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {}

  render({ project = null, selectedTrack = null } = {}) {
    const panel = this.refs.inspectorTonePanel || this.refs.inspectorTabPanels?.tone
    if (!panel) return false

    panel.replaceChildren()
    panel.classList.add('tone-panel')

    if (!project) {
      panel.appendChild(createEmptyState('音色', '导入项目后，这里会显示吉他音色旋钮和可直接套用的预设。'))
      return false
    }

    if (!selectedTrack) {
      panel.appendChild(createEmptyState('音色', '先选中一条轨道，再调整对应的吉他音色。'))
      return false
    }

    if (isAudioTrack(selectedTrack) || !supportsTrackGuitarToneSource(selectedTrack.playbackState?.assignedSourceId)) {
      panel.appendChild(createEmptyState('音色', '当前仅对分配为吉他的 MIDI 轨开放这一组音色参数。'))
      return false
    }

    const guitarTone = normalizeTrackGuitarToneConfig(selectedTrack.playbackState?.guitarTone)
    const activePresetId = this.appliedPresetIds.get(selectedTrack.id) || ''
    const activePreset = GUITAR_TONE_PRESETS.find((preset) => preset.id === activePresetId) || null
    const fragment = document.createDocumentFragment()
    fragment.appendChild(createHeroSection(selectedTrack))
    fragment.appendChild(createPresetSection({
      activePreset,
      onApply: (presetId) => {
        if (!presetId) {
          this.appliedPresetIds.delete(selectedTrack.id)
          return
        }
        const preset = GUITAR_TONE_PRESETS.find((entry) => entry.id === presetId)
        if (!preset) return
        this.appliedPresetIds.set(selectedTrack.id, preset.id)
        const presetConfig = normalizeTrackGuitarToneConfig({
          ...createDefaultTrackGuitarToneConfig(),
          ...(preset.patch || {}),
        })
        this.handlers.onTrackGuitarToneChanged?.(selectedTrack.id, presetConfig, { commit: true })
      },
    }))

    GUITAR_TONE_PANEL_MODULES.forEach((moduleDefinition) => {
      const controls = moduleDefinition.controls.map((controlDefinition) => createFxKnobControl({
        label: controlDefinition.label,
        min: controlDefinition.min,
        max: controlDefinition.max,
        step: controlDefinition.step,
        tone: controlDefinition.tone,
        value: guitarTone[controlDefinition.key],
        format: controlDefinition.format,
        onInput: (nextValue) => {
          this.appliedPresetIds.delete(selectedTrack.id)
          this.handlers.onTrackGuitarToneChanged?.(
            selectedTrack.id,
            { [controlDefinition.key]: nextValue },
            { commit: false },
          )
        },
        onCommit: (nextValue) => {
          this.appliedPresetIds.delete(selectedTrack.id)
          this.handlers.onTrackGuitarToneChanged?.(
            selectedTrack.id,
            { [controlDefinition.key]: nextValue },
            { commit: true },
          )
        },
      }))

      fragment.appendChild(createToneModule({
        title: moduleDefinition.title,
        note: moduleDefinition.note,
        controls,
      }))
    })

    panel.appendChild(fragment)
    return true
  }
}
