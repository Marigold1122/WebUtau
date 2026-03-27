import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import playheadController from '../modules/PlayheadController.js'
import inputController from './PianoRollInputController.js'
import noteSelection from './NoteSelection.js'
import viewport from './PianoRollViewport.js'
import grid from './PianoRollGrid.js'
import notes from './PianoRollNotes.js'

class PianoRoll {
  constructor() {
    this.container = null
    this.canvasWrapper = null
    this.timeRulerCanvas = null
    this.gridCanvas = null
    this.noteCanvas = null
    this.keyboardCanvas = null
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
    this._resize()
    grid.init(this.gridCanvas, this.keyboardCanvas, this.timeRulerCanvas)
    notes.init(this.noteCanvas)
    this._listenEvents()
    window.addEventListener('resize', () => this._resize())
    this.canvasWrapper.addEventListener('wheel', (event) => this._onWheel(event))
    this.timeRulerCanvas.addEventListener('click', (event) => this._onTimeRulerClick(event))
    inputController.bindTo(this.canvasWrapper, this.noteCanvas)
    grid.draw()
    this.isInitialized = true
    console.log('[PianoRoll] 已初始化')
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
    })

    eventBus.on(EVENTS.PHRASES_REBUILT, ({ phrases }) => {
      notes.setPhrases(phrases)
      grid.draw()
      playheadController.setPosition(playheadController.getPosition())
    })

    eventBus.on(EVENTS.PHRASES_EDITED, ({ phrases }) => {
      notes.setPhrases(phrases)
      grid.draw()
      playheadController.setPosition(playheadController.getPosition())
    })

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
