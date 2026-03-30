import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import playheadController from '../modules/PlayheadController.js'
import inputController from './PianoRollInputController.js'
import noteSelection from './NoteSelection.js'
import viewport from './PianoRollViewport.js'
import grid from './PianoRollGrid.js'
import notes from './PianoRollNotes.js'
import pitchEditor, { PITCH_EDITOR_MODE, PITCH_POINT_SHAPES, PITCH_BOUNDARY_MODES } from '../modules/PitchEditor.js'

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
    this.btnResetPitchSelection = null
    this.btnResetPitchAll = null
    this.shapeButtons = new Map()
    this.boundaryButtons = new Map()
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
    this.canvasWrapper.addEventListener('wheel', (event) => this._onWheel(event))
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
    this.btnLyricMode.addEventListener('click', () => {
      pitchEditor.setMode(PITCH_EDITOR_MODE.LYRIC)
      this._updateEditorToolbar()
      notes.requestDraw()
    })

    this.btnPitchMode = document.createElement('button')
    this.btnPitchMode.type = 'button'
    this.btnPitchMode.className = 'piano-roll-editor-btn'
    this.btnPitchMode.textContent = '音高'
    this.btnPitchMode.addEventListener('click', () => {
      if (!pitchEditor.setMode(PITCH_EDITOR_MODE.PITCH)) return
      this._updateEditorToolbar()
      notes.requestDraw()
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
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setSelectedSegmentShape(shape)
        } catch (error) {
          console.error('[PianoRoll] 设置音高段形失败:', error)
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
      button.addEventListener('click', async () => {
        try {
          await pitchEditor.setBoundaryModeForNoteEntries(noteSelection.getSelected(), mode)
        } catch (error) {
          console.error('[PianoRoll] 设置起始连接失败:', error)
        }
      })
      this.boundaryButtons.set(mode, button)
      boundaryGroup.appendChild(button)
    }

    this.btnResetPitchSelection = document.createElement('button')
    this.btnResetPitchSelection.type = 'button'
    this.btnResetPitchSelection.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchSelection.textContent = '恢复所选'
    this.btnResetPitchSelection.addEventListener('click', async () => {
      const range = pitchEditor.getTickRangeForNoteEntries(noteSelection.getSelected())
      if (!range) return
      try {
        await pitchEditor.restoreRange(range.startTick, range.endTick)
      } catch (error) {
        console.error('[PianoRoll] 恢复所选音高失败:', error)
      }
    })

    this.btnResetPitchAll = document.createElement('button')
    this.btnResetPitchAll.type = 'button'
    this.btnResetPitchAll.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnResetPitchAll.textContent = '恢复全部'
    this.btnResetPitchAll.addEventListener('click', async () => {
      try {
        await pitchEditor.restoreAll()
      } catch (error) {
        console.error('[PianoRoll] 恢复全部音高失败:', error)
      }
    })

    this.editorHint = document.createElement('div')
    this.editorHint.className = 'piano-roll-editor-hint'

    this.editorToolbar.append(
      modeGroup,
      shapeGroup,
      boundaryGroup,
      this.btnResetPitchSelection,
      this.btnResetPitchAll,
      this.editorHint,
    )
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

    this.btnLyricMode.classList.toggle('active', !pitchMode)
    this.btnPitchMode.classList.toggle('active', pitchMode)
    this.btnPitchMode.disabled = !canPitchEdit
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
    this.editorHint.textContent = pitchMode
      ? '点线段改形，所选音符可切换起始连接'
      : '双击音符编辑歌词'
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

  _resize() {
    if (!this.container) return
    const canvasWidth = Math.max(0, this.container.clientWidth - PIANO_ROLL.KEYBOARD_WIDTH)
    const canvasHeight = this.container.clientHeight
    const noteAreaHeight = Math.max(0, canvasHeight - PIANO_ROLL.TIME_RULER_HEIGHT)
    const totalHeight = (PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1) * PIANO_ROLL.KEY_HEIGHT
    this.keyboardCanvas.width = PIANO_ROLL.KEYBOARD_WIDTH
    this.keyboardCanvas.height = noteAreaHeight
    this.keyboardCanvas.style.marginTop = `${PIANO_ROLL.TIME_RULER_HEIGHT}px`
    this.timeRulerCanvas.width = canvasWidth
    this.timeRulerCanvas.height = PIANO_ROLL.TIME_RULER_HEIGHT
    this.gridCanvas.width = canvasWidth
    this.gridCanvas.height = noteAreaHeight
    this.noteCanvas.width = canvasWidth
    this.noteCanvas.height = noteAreaHeight
    viewport.setSize(canvasWidth, noteAreaHeight)
    if (!this.isInitialized) viewport.scrollY = Math.max(0, totalHeight - noteAreaHeight)
    if (!this.isInitialized) return
    grid.draw()
    notes.draw()
    playheadController.setPosition(playheadController.getPosition())
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
    if (event.shiftKey) viewport.scrollByY(event.deltaY)
    else viewport.scrollByX(event.deltaY)
    grid.draw()
    notes.draw()
    playheadController.setPosition(playheadController.getPosition())
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
    eventBus.on(EVENTS.PITCH_EDITOR_MODE_CHANGED, () => this._updateEditorToolbar())
    eventBus.on(EVENTS.PITCH_EDITOR_SELECTION_CHANGED, () => this._updateEditorToolbar())

    eventBus.on(EVENTS.TRANSPORT_TICK, ({ time }) => {
      const previousScrollX = viewport.scrollX
      viewport.ensureTimeVisible(time)
      if (previousScrollX === viewport.scrollX) return
      grid.draw()
      notes.draw()
    })
  }
}

export default new PianoRoll()
