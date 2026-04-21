import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import playheadController from '../modules/PlayheadController.js'
import inputController from './PianoRollInputController.js'
import noteSelection from './NoteSelection.js'
import viewport from './PianoRollViewport.js'
import grid from './PianoRollGrid.js'
import notes from './PianoRollNotes.js'
import pitchEditor, { PITCH_EDITOR_MODE } from '../modules/PitchEditor.js'
import noteEditPopover from './NoteEditPopover.js'
import pitchShapePopover from './PitchShapePopover.js'
import inlinePopover from './InlinePopover.js'

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
    noteEditPopover.activate(this.noteCanvas)
    pitchShapePopover.activate(this.noteCanvas)
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

    // 模式切换（歌词 / 音高）
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

    // 恢复按钮（只剩两个；原本的线形/连接/滑音/颤音已迁移到内联浮窗）
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

    this.btnLyricMode.classList.toggle('active', !pitchMode)
    this.btnPitchMode.classList.toggle('active', pitchMode)
    this.btnPitchMode.disabled = !canPitchEdit
    this.btnResetPitchSelection.disabled = !(canPitchEdit && hasOriginalPitch && hasSelection)
    this.btnResetPitchAll.disabled = !(canPitchEdit && hasOriginalPitch)

    if (!hasSelection) {
      this.editorHint.textContent = pitchMode
        ? '点线段 / 节点可编辑曲线形状'
        : '双击音符可编辑歌词'
    } else if (pitchMode) {
      this.editorHint.textContent = '点节点改曲线；所选音符浮窗可调滑音、颤音、起始连接'
    } else {
      this.editorHint.textContent = '双击音符编辑歌词；音符浮窗可调滑音、颤音、音准'
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
    this._notifyViewportChanged()
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
        this._notifyViewportChanged()
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
    this._notifyViewportChanged()
  }

  _notifyViewportChanged() {
    // canvas 滚动 / 缩放不是真 DOM scroll 事件，InlinePopover 的全局 scroll
    // 监听抓不到。这里主动让它重新定位。
    inlinePopover.requestReposition('pitch-shape')
    inlinePopover.requestReposition('note-edit')
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
