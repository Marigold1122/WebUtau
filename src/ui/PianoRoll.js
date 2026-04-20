import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import playheadController from '../modules/PlayheadController.js'
import inputController from './PianoRollInputController.js'
import noteSelection from './NoteSelection.js'
import viewport from './PianoRollViewport.js'
import grid from './PianoRollGrid.js'
import notes from './PianoRollNotes.js'
import pitchEditor, { PITCH_EDITOR_MODE, PITCH_POINT_SHAPES, PITCH_BOUNDARY_MODES } from '../modules/PitchEditor.js'

const PORTAMENTO_PRESETS = Object.freeze([
  { id: 'standard', label: 'Standard', start: -40, length: 80 },
  { id: 'fast', label: 'Fast', start: -25, length: 50 },
  { id: 'slow', label: 'Slow', start: -60, length: 120 },
  { id: 'snap', label: 'Snap', start: -1, length: 2 },
])

const VIBRATO_PRESETS = Object.freeze([
  { id: 'standard', label: 'Standard', values: { length: 75, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-default', label: 'UTAU Default', values: { length: 65, period: 180, depth: 35, in: 20, out: 20, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-strong', label: 'UTAU Strong', values: { length: 65, period: 210, depth: 55, in: 25, out: 25, shift: 0, drift: 0, volLink: 0 } },
  { id: 'utau-weak', label: 'UTAU Weak', values: { length: 65, period: 165, depth: 20, in: 25, out: 25, shift: 0, drift: 0, volLink: 0 } },
])

class PianoRoll {
  constructor() {
    this.container = null
    this.canvasWrapper = null
    this.timeRulerCanvas = null
    this.gridCanvas = null
    this.noteCanvas = null
    this.keyboardCanvas = null
    this.editorToolbarHost = null
    this.editorToolbar = null
    this.editorHint = null
    this.btnLyricMode = null
    this.btnPitchMode = null
    this.btnVibratoToggle = null
    this.btnResetPitchSelection = null
    this.btnResetPitchAll = null
    this.tuningInput = null
    this.portamentoPresetSelect = null
    this.vibratoPresetSelect = null
    this.shapeButtons = new Map()
    this.boundaryButtons = new Map()
    this.portamentoInputs = new Map()
    this.vibratoInputs = new Map()
    this.isInitialized = false
  }

  init(containerElement) {
    if (this.isInitialized || !containerElement) return
    this.container = containerElement
    const playheadElement = document.getElementById('playhead')
    this.keyboardCanvas = document.createElement('canvas')
    this.keyboardCanvas.className = 'piano-roll-keyboard'
    this.timeRulerCanvas = document.createElement('canvas')
    this.timeRulerCanvas.className = 'piano-roll-time-ruler'
    this.gridCanvas = document.createElement('canvas')
    this.gridCanvas.className = 'piano-roll-grid'
    this.noteCanvas = document.createElement('canvas')
    this.noteCanvas.className = 'piano-roll-notes'
    this.canvasWrapper = document.createElement('div')
    this.canvasWrapper.className = 'piano-roll-canvas-wrapper'
    this.canvasWrapper.tabIndex = -1
    this.container.replaceChildren()
    this.canvasWrapper.append(this.timeRulerCanvas, this.gridCanvas, this.noteCanvas)
    if (playheadElement) this.canvasWrapper.appendChild(playheadElement)
    this.container.append(this.keyboardCanvas, this.canvasWrapper)
    this._buildEditorToolbar()
    this._mountEditorToolbar()
    this._resize()
    grid.init(this.gridCanvas, this.keyboardCanvas, this.timeRulerCanvas)
    notes.init(this.noteCanvas)
    this._listenEvents()
    window.addEventListener('resize', () => this._resize())
    this.canvasWrapper.addEventListener('wheel', (event) => this._onWheel(event), { passive: false })
    this.timeRulerCanvas.addEventListener('click', (event) => this._onTimeRulerClick(event))
    inputController.bindTo(this.canvasWrapper, this.noteCanvas)
    grid.draw()
    this._updateEditorToolbar()
    this.isInitialized = true
    console.log('[PianoRoll] 已初始化')
  }

  _buildEditorToolbar() {
    if (this.editorToolbar) return

    this.editorToolbar = document.createElement('div')
    this.editorToolbar.className = 'piano-roll-editor-toolbar'
    this.editorToolbar.addEventListener('mousedown', (event) => event.stopPropagation())
    this.editorToolbar.addEventListener('pointerdown', (event) => event.stopPropagation())

    const modeGroup = document.createElement('div')
    modeGroup.className = 'piano-roll-editor-mode-group'

    this.btnLyricMode = document.createElement('button')
    this.btnLyricMode.type = 'button'
    this.btnLyricMode.className = 'piano-roll-editor-btn'
    this.btnLyricMode.textContent = '歌词'
    this._wireToolbarButton(this.btnLyricMode)
    this.btnLyricMode.addEventListener('click', () => {
      pitchEditor.setMode(PITCH_EDITOR_MODE.LYRIC)
      this._updateEditorToolbar()
      notes.requestDraw()
      this._restoreEditorFocus()
    })

    this.btnPitchMode = document.createElement('button')
    this.btnPitchMode.type = 'button'
    this.btnPitchMode.className = 'piano-roll-editor-btn'
    this.btnPitchMode.textContent = '音高'
    this._wireToolbarButton(this.btnPitchMode)
    this.btnPitchMode.addEventListener('click', () => {
      if (!pitchEditor.setMode(PITCH_EDITOR_MODE.PITCH)) return
      this._updateEditorToolbar()
      notes.requestDraw()
      this._restoreEditorFocus()
    })

    modeGroup.append(this.btnLyricMode, this.btnPitchMode)

    const shapeGroup = document.createElement('div')
    shapeGroup.className = 'piano-roll-editor-control-group'
    for (const [shape, label] of [
      [PITCH_POINT_SHAPES.IN_OUT, '平滑'],
      [PITCH_POINT_SHAPES.LINEAR, '直线'],
      [PITCH_POINT_SHAPES.IN, '缓入'],
      [PITCH_POINT_SHAPES.OUT, '缓出'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
      button.textContent = label
      this._wireToolbarButton(button)
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setSelectedSegmentShape(shape)
        } catch (error) {
          console.error('[PianoRoll] 设置音高段形失败:', error)
        } finally {
          this._restoreEditorFocus()
        }
      })
      this.shapeButtons.set(shape, button)
      shapeGroup.appendChild(button)
    }

    const boundaryGroup = document.createElement('div')
    boundaryGroup.className = 'piano-roll-editor-control-group'
    for (const [mode, label] of [
      [PITCH_BOUNDARY_MODES.SNAP, '吸附'],
      [PITCH_BOUNDARY_MODES.GLIDE, '滑入'],
      [PITCH_BOUNDARY_MODES.HOLD, '保持'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
      button.textContent = label
      this._wireToolbarButton(button)
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setBoundaryModeForNoteEntries(noteSelection.getSelected(), mode)
        } catch (error) {
          console.error('[PianoRoll] 设置起始连接失败:', error)
        } finally {
          this._restoreEditorFocus()
        }
      })
      this.boundaryButtons.set(mode, button)
      boundaryGroup.appendChild(button)
    }

    const vibratoGroup = document.createElement('div')
    vibratoGroup.className = 'piano-roll-editor-control-group piano-roll-editor-vibrato-group'

    this.btnVibratoToggle = document.createElement('button')
    this.btnVibratoToggle.type = 'button'
    this.btnVibratoToggle.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
    this.btnVibratoToggle.textContent = '\u98a4\u97f3'
    this._wireToolbarButton(this.btnVibratoToggle)
    this.btnVibratoToggle.addEventListener('click', async () => {
      try {
        const state = pitchEditor.getVibratoStateForNoteEntries(noteSelection.getSelected())
        await pitchEditor.setVibratoEnabledForNoteEntries(noteSelection.getSelected(), state.enabled !== true)
      } catch (error) {
        console.error('[PianoRoll] \u8bbe\u7f6e\u98a4\u97f3\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })
    vibratoGroup.appendChild(this.btnVibratoToggle)

    for (const [field, label, min, max] of [
      ['length', '\u957f', 0, 100],
      ['period', '\u5468', 5, 500],
      ['depth', '\u6df1', 5, 200],
    ]) {
      const wrapper = document.createElement('label')
      wrapper.className = 'piano-roll-editor-number'

      const text = document.createElement('span')
      text.className = 'piano-roll-editor-number-label'
      text.textContent = label

      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'piano-roll-editor-number-input'
      input.min = String(min)
      input.max = String(max)
      input.step = '1'
      input.placeholder = '-'
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          input.blur()
        }
      })
      input.addEventListener('change', async () => {
        const value = Number(input.value)
        if (!Number.isFinite(value)) {
          this._updateEditorToolbar()
          return
        }
        // 故意不在这里 _restoreEditorFocus()：
        //   number input 是连续微调场景（长/周/深），每次 change 后把焦点抢到
        //   canvas 会让用户 Tab/方向键等无法在 input 间穿梭，且重渲染期间 canvas
        //   重绘/选中重映射会干扰视觉。让焦点跟随浏览器自然逻辑：
        //     - Enter → input 主动 blur，焦点到 body
        //     - 点其他 input → 焦点转移到新 input
        //     - 点 canvas → canvas 本身会获得焦点
        try {
          await pitchEditor.setVibratoValueForNoteEntries(noteSelection.getSelected(), field, value)
        } catch (error) {
          console.error(`[PianoRoll] \u8bbe\u7f6e\u98a4\u97f3\u53c2\u6570\u5931\u8d25 ${field}:`, error)
        }
      })

      wrapper.append(text, input)
      this.vibratoInputs.set(field, input)
      vibratoGroup.appendChild(wrapper)
    }

    this.btnResetPitchSelection = document.createElement('button')
    this.btnResetPitchSelection.type = 'button'
    this.btnResetPitchSelection.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchSelection.textContent = '恢复所选'
    this._wireToolbarButton(this.btnResetPitchSelection)
    this.btnResetPitchSelection.addEventListener('click', async () => {
      const range = pitchEditor.getTickRangeForNoteEntries(noteSelection.getSelected())
      if (!range) return
      try {
        await pitchEditor.restoreRange(range.startTick, range.endTick)
      } catch (error) {
        console.error('[PianoRoll] 恢复所选音高失败:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })

    this.btnResetPitchAll = document.createElement('button')
    this.btnResetPitchAll.type = 'button'
    this.btnResetPitchAll.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchAll.textContent = '恢复全部'
    this._wireToolbarButton(this.btnResetPitchAll)
    this.btnResetPitchAll.addEventListener('click', async () => {
      try {
        await pitchEditor.restoreAll()
      } catch (error) {
        console.error('[PianoRoll] 恢复全部音高失败:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })

    this.editorHint = document.createElement('div')
    this.editorHint.className = 'piano-roll-editor-hint'

    this.editorToolbar.append(
      modeGroup,
      shapeGroup,
      boundaryGroup,
      vibratoGroup,
      this.btnResetPitchSelection,
      this.btnResetPitchAll,
      this.editorHint,
    )
  }

  _buildEditorToolbar() {
    if (this.editorToolbar) return

    this.editorToolbar = document.createElement('div')
    this.editorToolbar.className = 'piano-roll-editor-toolbar'
    this.editorToolbar.addEventListener('mousedown', (event) => event.stopPropagation())
    this.editorToolbar.addEventListener('pointerdown', (event) => event.stopPropagation())

    const modeGroup = document.createElement('div')
    modeGroup.className = 'piano-roll-editor-mode-group'

    this.btnLyricMode = document.createElement('button')
    this.btnLyricMode.type = 'button'
    this.btnLyricMode.className = 'piano-roll-editor-btn'
    this.btnLyricMode.textContent = '\u6b4c\u8bcd'
    this._wireToolbarButton(this.btnLyricMode)
    this.btnLyricMode.addEventListener('click', () => {
      pitchEditor.setMode(PITCH_EDITOR_MODE.LYRIC)
      this._updateEditorToolbar()
      notes.requestDraw()
      this._restoreEditorFocus()
    })

    this.btnPitchMode = document.createElement('button')
    this.btnPitchMode.type = 'button'
    this.btnPitchMode.className = 'piano-roll-editor-btn'
    this.btnPitchMode.textContent = '\u97f3\u9ad8'
    this._wireToolbarButton(this.btnPitchMode)
    this.btnPitchMode.addEventListener('click', () => {
      if (!pitchEditor.setMode(PITCH_EDITOR_MODE.PITCH)) return
      this._updateEditorToolbar()
      notes.requestDraw()
      this._restoreEditorFocus()
    })
    modeGroup.append(this.btnLyricMode, this.btnPitchMode)

    const shapeGroup = document.createElement('div')
    shapeGroup.className = 'piano-roll-editor-control-group piano-roll-editor-property-group'
    shapeGroup.appendChild(this._createPropertyTitle('\u7ebf'))
    for (const [shape, label] of [
      [PITCH_POINT_SHAPES.IN_OUT, '\u5e73\u6ed1'],
      [PITCH_POINT_SHAPES.LINEAR, '\u76f4\u7ebf'],
      [PITCH_POINT_SHAPES.IN, '\u7f13\u5165'],
      [PITCH_POINT_SHAPES.OUT, '\u7f13\u51fa'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
      button.textContent = label
      this._wireToolbarButton(button)
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setSelectedSegmentShape(shape)
        } catch (error) {
          console.error('[PianoRoll] \u8bbe\u7f6e\u97f3\u9ad8\u6bb5\u5f62\u5931\u8d25:', error)
        } finally {
          this._restoreEditorFocus()
        }
      })
      this.shapeButtons.set(shape, button)
      shapeGroup.appendChild(button)
    }

    const boundaryGroup = document.createElement('div')
    boundaryGroup.className = 'piano-roll-editor-control-group piano-roll-editor-property-group'
    boundaryGroup.appendChild(this._createPropertyTitle('\u8fde'))
    for (const [mode, label] of [
      [PITCH_BOUNDARY_MODES.SNAP, '\u5438\u9644'],
      [PITCH_BOUNDARY_MODES.GLIDE, '\u6ed1\u5165'],
      [PITCH_BOUNDARY_MODES.HOLD, '\u4fdd\u6301'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
      button.textContent = label
      this._wireToolbarButton(button)
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setBoundaryModeForNoteEntries(noteSelection.getSelected(), mode)
        } catch (error) {
          console.error('[PianoRoll] \u8bbe\u7f6e\u8d77\u70b9\u8fde\u63a5\u5931\u8d25:', error)
        } finally {
          this._restoreEditorFocus()
        }
      })
      this.boundaryButtons.set(mode, button)
      boundaryGroup.appendChild(button)
    }

    const pitchGroup = document.createElement('div')
    pitchGroup.className = 'piano-roll-editor-control-group piano-roll-editor-property-group piano-roll-editor-note-group'
    pitchGroup.appendChild(this._createPropertyTitle('\u6ed1\u97f3'))

    this.portamentoPresetSelect = this._createSelectControl(PORTAMENTO_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
    })), async (value) => {
      const preset = PORTAMENTO_PRESETS.find((candidate) => candidate.id === value)
      if (!preset) {
        this._updateEditorToolbar()
        return
      }
      try {
        await pitchEditor.setPortamentoForNoteEntries(noteSelection.getSelected(), preset)
      } catch (error) {
        console.error('[PianoRoll] \u5e94\u7528\u6ed1\u97f3\u9884\u8bbe\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })
    pitchGroup.appendChild(this._createToolbarField('\u9884', this.portamentoPresetSelect, 'select'))

    this.tuningInput = this._createNumberControl(-100, 100, async (value) => {
      await pitchEditor.setTuningForNoteEntries(noteSelection.getSelected(), value)
    }, 'tuning')
    pitchGroup.appendChild(this._createToolbarField('\u8c03', this.tuningInput))

    const portamentoStartInput = this._createNumberControl(-200, 200, async (value) => {
      await pitchEditor.setPortamentoForNoteEntries(noteSelection.getSelected(), { start: value })
    }, 'start')
    this.portamentoInputs.set('start', portamentoStartInput)
    pitchGroup.appendChild(this._createToolbarField('\u8d77', portamentoStartInput))

    const portamentoLengthInput = this._createNumberControl(2, 320, async (value) => {
      await pitchEditor.setPortamentoForNoteEntries(noteSelection.getSelected(), { length: value })
    }, 'length')
    this.portamentoInputs.set('length', portamentoLengthInput)
    pitchGroup.appendChild(this._createToolbarField('\u957f', portamentoLengthInput))

    const vibratoGroup = document.createElement('div')
    vibratoGroup.className = 'piano-roll-editor-control-group piano-roll-editor-property-group piano-roll-editor-vibrato-group'
    vibratoGroup.appendChild(this._createPropertyTitle('\u98a4\u97f3'))

    this.vibratoPresetSelect = this._createSelectControl(VIBRATO_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
    })), async (value) => {
      const preset = VIBRATO_PRESETS.find((candidate) => candidate.id === value)
      if (!preset) {
        this._updateEditorToolbar()
        return
      }
      try {
        await pitchEditor.setVibratoValuesForNoteEntries(noteSelection.getSelected(), preset.values)
      } catch (error) {
        console.error('[PianoRoll] \u5e94\u7528\u98a4\u97f3\u9884\u8bbe\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })
    vibratoGroup.appendChild(this._createToolbarField('\u9884', this.vibratoPresetSelect, 'select'))

    this.btnVibratoToggle = document.createElement('button')
    this.btnVibratoToggle.type = 'button'
    this.btnVibratoToggle.className = 'piano-roll-editor-btn piano-roll-editor-btn--compact'
    this.btnVibratoToggle.textContent = '\u5f00\u5173'
    this._wireToolbarButton(this.btnVibratoToggle)
    this.btnVibratoToggle.addEventListener('click', async () => {
      try {
        const state = pitchEditor.getVibratoStateForNoteEntries(noteSelection.getSelected())
        await pitchEditor.setVibratoEnabledForNoteEntries(noteSelection.getSelected(), state.enabled !== true)
      } catch (error) {
        console.error('[PianoRoll] \u8bbe\u7f6e\u98a4\u97f3\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })
    vibratoGroup.appendChild(this.btnVibratoToggle)

    for (const [field, label, min, max] of [
      ['length', '\u957f', 0, 100],
      ['period', '\u5468', 5, 500],
      ['depth', '\u6df1', 5, 200],
      ['in', '\u5165', 0, 100],
      ['out', '\u51fa', 0, 100],
      ['shift', '\u76f8', 0, 100],
      ['drift', '\u6f02', -100, 100],
      ['volLink', '\u8054', -100, 100],
    ]) {
      const input = this._createNumberControl(min, max, async (value) => {
        await pitchEditor.setVibratoValueForNoteEntries(noteSelection.getSelected(), field, value)
      }, field)
      this.vibratoInputs.set(field, input)
      vibratoGroup.appendChild(this._createToolbarField(label, input))
    }

    this.btnResetPitchSelection = document.createElement('button')
    this.btnResetPitchSelection.type = 'button'
    this.btnResetPitchSelection.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchSelection.textContent = '\u6062\u590d\u6240\u9009'
    this._wireToolbarButton(this.btnResetPitchSelection)
    this.btnResetPitchSelection.addEventListener('click', async () => {
      const range = pitchEditor.getTickRangeForNoteEntries(noteSelection.getSelected())
      if (!range) return
      try {
        await pitchEditor.restoreRange(range.startTick, range.endTick)
      } catch (error) {
        console.error('[PianoRoll] \u6062\u590d\u6240\u9009\u97f3\u9ad8\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })

    this.btnResetPitchAll = document.createElement('button')
    this.btnResetPitchAll.type = 'button'
    this.btnResetPitchAll.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchAll.textContent = '\u6062\u590d\u5168\u90e8'
    this._wireToolbarButton(this.btnResetPitchAll)
    this.btnResetPitchAll.addEventListener('click', async () => {
      try {
        await pitchEditor.restoreAll()
      } catch (error) {
        console.error('[PianoRoll] \u6062\u590d\u5168\u90e8\u97f3\u9ad8\u5931\u8d25:', error)
      } finally {
        this._restoreEditorFocus()
      }
    })

    this.editorHint = document.createElement('div')
    this.editorHint.className = 'piano-roll-editor-hint'

    this.editorToolbar.append(
      modeGroup,
      shapeGroup,
      boundaryGroup,
      pitchGroup,
      vibratoGroup,
      this.btnResetPitchSelection,
      this.btnResetPitchAll,
      this.editorHint,
    )
  }

  _createPropertyTitle(text) {
    const title = document.createElement('span')
    title.className = 'piano-roll-editor-property-title'
    title.textContent = text
    return title
  }

  _createToolbarField(label, control, type = 'number') {
    const wrapper = document.createElement('label')
    wrapper.className = 'piano-roll-editor-number'

    const text = document.createElement('span')
    text.className = 'piano-roll-editor-number-label'
    text.textContent = label

    wrapper.append(text, control)
    if (type === 'select') {
      wrapper.classList.add('piano-roll-editor-number--select')
    }
    return wrapper
  }

  _createNumberControl(min, max, onCommit, fieldName = 'value') {
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'piano-roll-editor-number-input'
    input.min = String(min)
    input.max = String(max)
    input.step = '1'
    input.placeholder = '-'
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      }
    })
    input.addEventListener('change', async () => {
      const value = Number(input.value)
      if (!Number.isFinite(value)) {
        this._updateEditorToolbar()
        return
      }
      try {
        await onCommit(value)
      } catch (error) {
        console.error(`[PianoRoll] \u8bbe\u7f6e\u97f3\u7b26\u53c2\u6570\u5931\u8d25 ${fieldName}:`, error)
      } finally {
        this._restoreEditorFocus()
      }
    })
    return input
  }

  _createSelectControl(options = [], onCommit) {
    const select = document.createElement('select')
    select.className = 'piano-roll-editor-select'
    const emptyOption = document.createElement('option')
    emptyOption.value = ''
    emptyOption.textContent = '-'
    select.appendChild(emptyOption)
    options.forEach((option) => {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      select.appendChild(el)
    })
    select.addEventListener('change', async () => {
      try {
        await onCommit(select.value)
      } finally {
        if (!select.value) this._restoreEditorFocus()
      }
    })
    return select
  }

  _resolvePresetSelection(presets, values = {}, fields = []) {
    const preset = presets.find((candidate) => fields.every((field) => Number(candidate?.values?.[field] ?? candidate?.[field]) === Number(values?.[field])))
    return preset?.id || ''
  }

  _setNumberInputValue(input, value, disabled) {
    if (!input) return
    input.disabled = disabled
    input.value = value == null ? '' : String(value)
    input.placeholder = value == null ? '-' : ''
  }

  _getEditorToolbarHost() {
    try {
      if (window.parent && window.parent !== window) {
        const host = window.parent.document.getElementById('editor-runtime-tools')
        if (host) return host
      }
    } catch (error) {
      console.warn('[PianoRoll] 无法访问宿主工具栏区域，回退到浮动工具栏:', error)
    }
    return this.container
  }

  _mountEditorToolbar() {
    if (!this.editorToolbar) return
    const host = this._getEditorToolbarHost()
    if (!host) return
    this.editorToolbarHost = host
    host.appendChild(this.editorToolbar)
    const useHeaderLayout = host !== this.container
    this.editorToolbar.classList.toggle('piano-roll-editor-toolbar--header', useHeaderLayout)
    this.editorToolbar.classList.toggle('piano-roll-editor-toolbar--floating', !useHeaderLayout)
  }

  _updateEditorToolbar() {
    if (!this.editorToolbar) return
    const canPitchEdit = pitchEditor.canEdit()
    const pitchMode = pitchEditor.getMode() === PITCH_EDITOR_MODE.PITCH
    const hasOriginalPitch = pitchEditor.hasOriginalPitch()
    const hasSelection = noteSelection.count() > 0
    const selectedShape = pitchEditor.getSelectedSegmentShape()
    const selectedBoundaryMode = pitchEditor.getBoundaryModeForNoteEntries(noteSelection.getSelected())
    const vibratoState = pitchEditor.getVibratoStateForNoteEntries(noteSelection.getSelected())

    this.btnLyricMode.classList.toggle('active', !pitchMode)
    this.btnPitchMode.classList.toggle('active', pitchMode)
    this.btnPitchMode.disabled = !canPitchEdit
    this.btnVibratoToggle.disabled = !(canPitchEdit && pitchMode && hasSelection)
    this.btnVibratoToggle.classList.toggle('active', pitchMode && vibratoState.enabled === true)
    this.btnResetPitchSelection.disabled = !(canPitchEdit && hasOriginalPitch && hasSelection)
    this.btnResetPitchAll.disabled = !(canPitchEdit && hasOriginalPitch)
    for (const [shape, button] of this.shapeButtons.entries()) {
      button.disabled = !(canPitchEdit && pitchMode && pitchEditor.hasSelectedSegment())
      button.classList.toggle('active', pitchMode && selectedShape === shape)
    }
    for (const [mode, button] of this.boundaryButtons.entries()) {
      button.disabled = !(canPitchEdit && pitchMode && hasSelection)
      button.classList.toggle('active', pitchMode && selectedBoundaryMode === mode)
    }
    for (const [field, input] of this.vibratoInputs.entries()) {
      input.disabled = !(canPitchEdit && pitchMode && hasSelection && vibratoState.enabled === true)
      input.value = vibratoState.values[field] == null ? '' : String(vibratoState.values[field])
      input.placeholder = vibratoState.mixed ? '-' : ''
    }
    this.editorHint.textContent = pitchMode
      ? '点线段改形，所选音符可切换起始连接'
      : '双击音符编辑歌词'
  }

  _updateEditorToolbar() {
    if (!this.editorToolbar) return
    const selectedEntries = noteSelection.getSelected()
    const canPitchEdit = pitchEditor.canEdit()
    const pitchMode = pitchEditor.getMode() === PITCH_EDITOR_MODE.PITCH
    const hasOriginalPitch = pitchEditor.hasOriginalPitch()
    const hasSelection = selectedEntries.length > 0
    const notePropertyEnabled = canPitchEdit && hasSelection
    const selectedShape = pitchEditor.getSelectedSegmentShape()
    const selectedBoundaryMode = pitchEditor.getBoundaryModeForNoteEntries(selectedEntries)
    const tuningState = pitchEditor.getTuningStateForNoteEntries(selectedEntries)
    const portamentoState = pitchEditor.getPortamentoStateForNoteEntries(selectedEntries)
    const vibratoState = pitchEditor.getVibratoStateForNoteEntries(selectedEntries)

    this.btnLyricMode.classList.toggle('active', !pitchMode)
    this.btnPitchMode.classList.toggle('active', pitchMode)
    this.btnPitchMode.disabled = !canPitchEdit
    this.btnVibratoToggle.disabled = !notePropertyEnabled
    this.btnVibratoToggle.classList.toggle('active', notePropertyEnabled && vibratoState.enabled === true)
    this.btnResetPitchSelection.disabled = !(canPitchEdit && hasOriginalPitch && hasSelection)
    this.btnResetPitchAll.disabled = !(canPitchEdit && hasOriginalPitch)

    for (const [shape, button] of this.shapeButtons.entries()) {
      button.disabled = !(canPitchEdit && pitchMode && pitchEditor.hasSelectedSegment())
      button.classList.toggle('active', pitchMode && selectedShape === shape)
    }
    for (const [mode, button] of this.boundaryButtons.entries()) {
      button.disabled = !(canPitchEdit && pitchMode && hasSelection)
      button.classList.toggle('active', pitchMode && selectedBoundaryMode === mode)
    }

    this._setNumberInputValue(this.tuningInput, tuningState.value, !notePropertyEnabled)
    for (const [field, input] of this.portamentoInputs.entries()) {
      this._setNumberInputValue(input, portamentoState.values[field], !notePropertyEnabled)
    }
    if (this.portamentoPresetSelect) {
      this.portamentoPresetSelect.disabled = !notePropertyEnabled
      this.portamentoPresetSelect.value = notePropertyEnabled && !portamentoState.mixed
        ? this._resolvePresetSelection(PORTAMENTO_PRESETS, portamentoState.values, ['start', 'length'])
        : ''
    }
    if (this.vibratoPresetSelect) {
      this.vibratoPresetSelect.disabled = !notePropertyEnabled
      this.vibratoPresetSelect.value = notePropertyEnabled
        ? this._resolvePresetSelection(VIBRATO_PRESETS, vibratoState.values, ['length', 'period', 'depth', 'in', 'out', 'shift', 'drift', 'volLink'])
        : ''
    }
    for (const [field, input] of this.vibratoInputs.entries()) {
      this._setNumberInputValue(input, vibratoState.values[field], !(notePropertyEnabled && vibratoState.enabled === true))
    }

    if (!hasSelection) {
      this.editorHint.textContent = '\u9009\u62e9\u97f3\u7b26\u540e\u53ef\u8c03\u6574\u6ed1\u97f3\u3001\u98a4\u97f3\u548c\u97f3\u51c6'
    } else if (pitchMode) {
      this.editorHint.textContent = '\u62d6\u70b9\u6539\u7ebf\uff0c\u4e5f\u53ef\u76f4\u63a5\u5728\u5de5\u5177\u680f\u91cc\u8c03\u6ed1\u97f3\u4e0e\u98a4\u97f3'
    } else {
      this.editorHint.textContent = '\u53cc\u51fb\u97f3\u7b26\u53ef\u7f16\u8f91\u6b4c\u8bcd\uff0c\u5c5e\u6027\u533a\u4ecd\u53ef\u76f4\u63a5\u8c03\u6ed1\u97f3\u4e0e\u98a4\u97f3'
    }
  }

  setEditorMode(mode) {
    const nextMode = mode === PITCH_EDITOR_MODE.PITCH ? PITCH_EDITOR_MODE.PITCH : PITCH_EDITOR_MODE.LYRIC
    if (nextMode === PITCH_EDITOR_MODE.PITCH) {
      if (!pitchEditor.setMode(PITCH_EDITOR_MODE.PITCH)) return false
    } else {
      pitchEditor.setMode(PITCH_EDITOR_MODE.LYRIC)
    }
    this._updateEditorToolbar()
    notes.requestDraw()
    return true
  }

  setPlayheadFollowMode(mode) {
    viewport.setPlayheadFollowMode(mode)
  }

  refreshViewportAfterScroll() {
    grid.draw()
    notes.draw()
  }

  _resize() {
    if (!this.container) return
    const dpr = window.devicePixelRatio || 1
    const canvasWidth = Math.max(0, this.container.clientWidth - PIANO_ROLL.KEYBOARD_WIDTH)
    const canvasHeight = this.container.clientHeight
    const noteAreaHeight = Math.max(0, canvasHeight - PIANO_ROLL.TIME_RULER_HEIGHT)
    const totalHeight = (PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1) * PIANO_ROLL.KEY_HEIGHT
    this._scaleCanvas(this.keyboardCanvas, PIANO_ROLL.KEYBOARD_WIDTH, noteAreaHeight, dpr)
    this.keyboardCanvas.style.marginTop = `${PIANO_ROLL.TIME_RULER_HEIGHT}px`
    this._scaleCanvas(this.timeRulerCanvas, canvasWidth, PIANO_ROLL.TIME_RULER_HEIGHT, dpr)
    this._scaleCanvas(this.gridCanvas, canvasWidth, noteAreaHeight, dpr)
    this._scaleCanvas(this.noteCanvas, canvasWidth, noteAreaHeight, dpr)
    viewport.setSize(canvasWidth, noteAreaHeight)
    if (!this.isInitialized) viewport.scrollY = Math.max(0, totalHeight - noteAreaHeight)
    if (!this.isInitialized) return
    grid.draw()
    notes.draw()
    playheadController.setPosition(playheadController.getPosition())
  }

  _scaleCanvas(canvas, cssWidth, cssHeight, dpr) {
    canvas.width = cssWidth * dpr
    canvas.height = cssHeight * dpr
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
  }

  _onWheel(event) {
    event.preventDefault()
    if (event.ctrlKey) {
      if (noteSelection.getMarqueeRect()) return
      const rect = this.noteCanvas.getBoundingClientRect()
      const mouseX = event.clientX - rect.left
      if (viewport.zoomAtCursor(mouseX, event.deltaY)) {
        grid.draw()
        notes.draw()
        playheadController.setPosition(playheadController.getPosition())
      }
      return
    }
    const { horizontalDelta, verticalDelta } = this._resolveWheelScrollDeltas(event)
    if (event.shiftKey) {
      if (!verticalDelta) return
      viewport.scrollByY(verticalDelta)
    } else {
      if (!horizontalDelta) return
      viewport.scrollByX(horizontalDelta)
    }
    grid.draw()
    notes.draw()
    playheadController.setPosition(playheadController.getPosition())
  }

  _resolveWheelScrollDeltas(event) {
    const absX = Math.abs(event.deltaX)
    const absY = Math.abs(event.deltaY)

    // Some browsers on macOS rewrite Shift+wheel into horizontal deltas.
    // Preserve the app shortcut semantics: Shift means vertical piano-roll scroll.
    const horizontalDelta = absX > absY ? event.deltaX : event.deltaY
    const verticalDelta = absY >= absX
      ? event.deltaY
      : event.deltaX

    return { horizontalDelta, verticalDelta }
  }

  _wireToolbarButton(button) {
    if (!button) return
    button.tabIndex = -1
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('pointerdown', (event) => event.preventDefault())
  }

  _restoreEditorFocus() {
    this.canvasWrapper?.focus?.({ preventScroll: true })
  }

  _onTimeRulerClick(event) {
    const rect = this.timeRulerCanvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const time = Math.max(0, viewport.xToTime(x))
    playheadController.setPosition(time)
    eventBus.emit(EVENTS.TRANSPORT_SEEK, { time })
  }

  _listenEvents() {
    eventBus.on(EVENTS.TRACK_SELECTED, ({ phrases, tempoData }) => {
      viewport.setTempoData(tempoData)
      if (phrases.length > 0 && phrases[0].notes.length > 0) {
        const firstNote = phrases[0].notes[0]
        const maxY = Math.max(0, (PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1) * PIANO_ROLL.KEY_HEIGHT - viewport.canvasHeight)
        const centeredY = (PIANO_ROLL.PITCH_MAX - firstNote.midi) * PIANO_ROLL.KEY_HEIGHT - viewport.canvasHeight / 2 + PIANO_ROLL.KEY_HEIGHT / 2
        viewport.scrollX = Math.max(0, firstNote.time * viewport.pixelsPerSecond - PIANO_ROLL.AUTO_SCROLL_PADDING)
        viewport.scrollY = Math.max(0, Math.min(centeredY, maxY))
      }
      grid.draw()
      notes.setPhrases(phrases)
      playheadController.setPosition(playheadController.getPosition())
      this._updateEditorToolbar()
    })

    eventBus.on(EVENTS.PHRASES_REBUILT, ({ phrases }) => {
      notes.setPhrases(phrases)
      grid.draw()
      playheadController.setPosition(playheadController.getPosition())
      this._updateEditorToolbar()
    })

    eventBus.on(EVENTS.PHRASES_EDITED, ({ phrases }) => {
      notes.setPhrases(phrases)
      grid.draw()
      playheadController.setPosition(playheadController.getPosition())
      this._updateEditorToolbar()
    })

    eventBus.on(EVENTS.NOTE_SELECTION_CHANGED, () => this._updateEditorToolbar())
    eventBus.on(EVENTS.PITCH_LOADED, () => this._updateEditorToolbar())
    eventBus.on(EVENTS.PITCH_CHANGED, () => this._updateEditorToolbar())
    eventBus.on(EVENTS.PITCH_EDITOR_MODE_CHANGED, () => this._updateEditorToolbar())
    eventBus.on(EVENTS.PITCH_EDITOR_SELECTION_CHANGED, () => this._updateEditorToolbar())

    eventBus.on(EVENTS.TRANSPORT_TICK, ({ time }) => {
      if (playheadController.isDraggingPlayhead?.()) return
      const previousScrollX = viewport.scrollX
      viewport.syncPlaybackScroll(time)
      if (previousScrollX === viewport.scrollX) return
      grid.draw()
      notes.draw()
      playheadController.setPosition(time)
    })
  }
}

export default new PianoRoll()
