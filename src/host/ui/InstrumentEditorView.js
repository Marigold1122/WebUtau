import { PIANO_ROLL } from '../../config/constants.js'
import { createHorizontalDragAutoScroller } from '../../shared/horizontalDragAutoScroll.js'
import { computeFollowScrollLeft, normalizePlayheadFollowMode } from '../../shared/playheadFollowMode.js'
import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { getTrackColorById } from './tracks/trackColorPalette.js'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const DEFAULT_BEAT_WIDTH = 40
const DEFAULT_PPQ = 480
const DEFAULT_TIME_SIGNATURE = [4, 4]
const MIN_VIEW_BARS = 64
const SNAP_DIVISION = 4
const VIEWPORT_TAIL_BARS = 8
const VIEWPORT_HORIZONTAL_CHUNK_BEATS = 12
const VIEWPORT_VERTICAL_CHUNK_ROWS = 8
const PLAYHEAD_HITBOX_WIDTH = 16

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function clampMidi(value, fallback = 60) {
  const midi = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(PIANO_ROLL.PITCH_MIN, Math.min(PIANO_ROLL.PITCH_MAX, midi))
}

function clampVelocity(value, fallback = 0.8) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function normalizePpq(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_PPQ
}

function getBaseTimeSignature(tempoData = null) {
  const signature = tempoData?.timeSignatures?.[0]?.timeSignature
  if (!Array.isArray(signature) || signature.length < 2) return DEFAULT_TIME_SIGNATURE
  const beatsPerBar = Number.isFinite(signature[0]) && signature[0] > 0 ? Math.round(signature[0]) : DEFAULT_TIME_SIGNATURE[0]
  const beatUnit = Number.isFinite(signature[1]) && signature[1] > 0 ? Math.round(signature[1]) : DEFAULT_TIME_SIGNATURE[1]
  return [beatsPerBar, beatUnit]
}

function getDefaultSnapTicks(ppq) {
  return Math.max(1, Math.round(normalizePpq(ppq) / SNAP_DIVISION))
}

function formatMidiLabel(midi) {
  const normalized = clampMidi(midi)
  return `${NOTE_NAMES[normalized % 12]}${Math.floor(normalized / 12) - 1}`
}

function buildNoteSignature(notes = []) {
  return (Array.isArray(notes) ? notes : [])
    .map((note) => [
      Math.round(clampNonNegative(note.tick)),
      Math.max(1, Math.round(clampNonNegative(note.durationTicks, 1))),
      clampMidi(note.midi),
      clampVelocity(note.velocity).toFixed(3),
    ].join(':'))
    .join('|')
}

function sortNotes(notes = []) {
  return [...notes].sort((left, right) => {
    if (left.tick !== right.tick) return left.tick - right.tick
    if (left.midi !== right.midi) return left.midi - right.midi
    return left.durationTicks - right.durationTicks
  })
}

function cloneNote(note = {}) {
  return {
    time: clampNonNegative(note.time),
    duration: Math.max(0.05, clampNonNegative(note.duration, 0.05)),
    tick: Math.round(clampNonNegative(note.tick)),
    durationTicks: Math.max(1, Math.round(clampNonNegative(note.durationTicks, 1))),
    midi: clampMidi(note.midi),
    velocity: clampVelocity(note.velocity),
  }
}

function computeTotalTicks(track = null, notes = [], ppq = DEFAULT_PPQ, viewportWidth = 0, tempoData = null) {
  const safePpq = normalizePpq(ppq)
  const [beatsPerBar, beatUnit] = getBaseTimeSignature(tempoData)
  const beatTicks = Math.max(1, safePpq * (4 / beatUnit))
  const tailTicks = VIEWPORT_TAIL_BARS * beatsPerBar * beatTicks
  const minVisibleTicks = MIN_VIEW_BARS * beatsPerBar * beatTicks
  const maxFromNotes = (Array.isArray(notes) ? notes : []).reduce((maxValue, note) => {
    return Math.max(maxValue, Math.round(clampNonNegative(note.tick) + Math.max(1, note.durationTicks || 1)))
  }, 0)
  const visibleBeats = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.ceil(viewportWidth / DEFAULT_BEAT_WIDTH) + (VIEWPORT_TAIL_BARS * beatsPerBar)
    : 0
  return Math.max(
    minVisibleTicks,
    visibleBeats * beatTicks,
    Math.round(clampNonNegative(track?.durationTicks)),
    maxFromNotes + tailTicks,
  )
}

function createDraftNote(note = {}, id) {
  return {
    ...cloneNote(note),
    id,
  }
}

function exportDraftNote(note = {}) {
  return cloneNote(note)
}

function isBlackKey(midi) {
  return PIANO_ROLL.BLACK_KEY_PITCHES.includes(clampMidi(midi) % 12)
}

function darkenHexColor(hexColor, ratio = PIANO_ROLL.NOTE_BORDER_DARKEN_RATIO) {
  const safeHex = typeof hexColor === 'string' ? hexColor.replace('#', '') : ''
  if (!/^[0-9a-fA-F]{6}$/.test(safeHex)) return '#2f706d'
  const multiplier = Math.max(0, 1 - ratio)
  const channels = safeHex.match(/.{2}/g) || []
  return `#${channels
    .map((channel) => Math.round(Number.parseInt(channel, 16) * multiplier).toString(16).padStart(2, '0'))
    .join('')}`
}

function hexToRgba(hexColor, alpha, fallback = 'rgba(59, 139, 136, 0.18)') {
  const safeHex = typeof hexColor === 'string' ? hexColor.replace('#', '') : ''
  if (!/^[0-9a-fA-F]{6}$/.test(safeHex)) return fallback
  const channels = safeHex.match(/.{2}/g) || []
  const [red, green, blue] = channels.map((channel) => Number.parseInt(channel, 16))
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function createToolIcon(name) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('instrument-editor-tool-icon')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('stroke-width', '1.4')

  if (name === 'eraser') {
    path.setAttribute('d', 'M4.2 9.8 8.8 5.2c.5-.5 1.2-.5 1.7 0l2.3 2.3c.5.5.5 1.2 0 1.7L8.5 13.5H5.2L3.3 11.6c-.5-.5-.5-1.3 0-1.8Z')
  } else {
    path.setAttribute('d', 'm3.5 12.5 1.8-.4 6.5-6.6-1.4-1.4-6.6 6.5-.3 1.9Zm6.3-8 1.4-1.4 1.4 1.4-1.4 1.4-1.4-1.4Z')
  }

  svg.appendChild(path)
  return svg
}

export class InstrumentEditorView {
  constructor(root, handlers = {}) {
    this.root = root
    this.handlers = handlers
    this.noteSeed = 0
    this.noteDurationCeiling = 1
    this.axisRevision = 0
    this.notesRevision = 0
    this.playheadRenderedX = null
    this.viewportRenderFrame = 0
    this.viewportRenderForce = false
    this.viewportRenderState = {
      rulerKey: '',
      gridKey: '',
      notesKey: '',
    }
    this.visibleMarksCache = {
      key: '',
      marks: [],
    }
    this.playheadFollowMode = normalizePlayheadFollowMode(null)
    this.isPlayheadDragging = false
    this.playheadDragClientX = null
    this.playheadDragScroller = null
    this.state = {
      trackId: null,
      trackName: '',
      ppq: DEFAULT_PPQ,
      tempoData: null,
      axis: null,
      notes: [],
      dirty: false,
      recording: false,
      playbackActive: false,
      tool: 'brush',
      currentTime: 0,
      baseDurationTicks: 0,
      loadedSignature: '',
      sourcePreviewNotesRef: null,
      drawDraft: null,
      hoverPreview: null,
      erasing: false,
      trackColor: getTrackColorById(null, []),
      trackBorderColor: darkenHexColor(getTrackColorById(null, [])),
    }
    this.refs = {}
    this._handlePointerMove = this._handlePointerMove.bind(this)
    this._handlePointerUp = this._handlePointerUp.bind(this)
    this._handleViewportMouseMove = this._handleViewportMouseMove.bind(this)
    this._handleViewportMouseLeave = this._handleViewportMouseLeave.bind(this)
    this._handleGridScroll = this._handleGridScroll.bind(this)
    this._handleRulerClick = this._handleRulerClick.bind(this)
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    if (!this.root) return
    this.root.classList.add('instrument-editor-root')
    this._buildDom()
    this._initPlayheadDrag()
    this._renderKeyboard()
    this._applyTrackColor()
    this._renderTrackState()
    this.setVisible(false)
    window.addEventListener('mousemove', this._handlePointerMove)
    window.addEventListener('mouseup', this._handlePointerUp)
  }

  setVisible(visible) {
    if (!this.root) return
    this.root.hidden = !visible
  }

  setTrack(track, project = null) {
    if (!this.root) return
    const nextTrackId = track?.id || null
    if (!nextTrackId) {
      this.clear()
      return
    }

    const previewNotes = Array.isArray(track.previewNotes) ? track.previewNotes : []
    const ppq = normalizePpq(project?.ppq)
    const isTrackChanged = nextTrackId !== this.state.trackId
    const previousPpq = this.state.ppq
    const previousTempoData = this.state.tempoData
    const previousTrackColor = this.state.trackColor
    const previousTrackBorderColor = this.state.trackBorderColor
    const nextTempoData = project?.tempoData || null
    const nextTrackColor = getTrackColorById(nextTrackId, project?.tracks || [])
    const nextTrackBorderColor = darkenHexColor(nextTrackColor)
    const nextBaseDurationTicks = Math.round(clampNonNegative(track?.durationTicks))
    const sourceReferenceChanged = previewNotes !== this.state.sourcePreviewNotesRef
    const nextSignature = (isTrackChanged || sourceReferenceChanged)
      ? buildNoteSignature(previewNotes)
      : this.state.loadedSignature
    const shouldHydrateNotes = isTrackChanged || (!this.state.dirty && nextSignature !== this.state.loadedSignature)
    const candidateNotes = shouldHydrateNotes
      ? sortNotes(previewNotes.map((note) => createDraftNote(note, this._nextNoteId())))
      : this.state.notes

    this.state.trackId = nextTrackId
    this.state.trackName = track.name || '未命名轨道'
    this.state.ppq = ppq
    this.state.tempoData = nextTempoData
    this.state.baseDurationTicks = nextBaseDurationTicks
    this.state.trackColor = nextTrackColor
    this.state.trackBorderColor = nextTrackBorderColor

    if (shouldHydrateNotes) {
      this.state.notes = candidateNotes
      this.state.loadedSignature = nextSignature
      this.state.sourcePreviewNotesRef = previewNotes
      this.state.dirty = false
      this._touchNotes()
    }
    if (isTrackChanged) {
      this.state.drawDraft = null
      this.state.hoverPreview = null
      this.state.erasing = false
    }
    this.setVisible(true)
    const viewportWidth = this.refs.gridViewport?.clientWidth || this.refs.gridViewport?.getBoundingClientRect?.().width || 0
    const nextTotalTicks = computeTotalTicks(
      { durationTicks: nextBaseDurationTicks },
      candidateNotes,
      ppq,
      viewportWidth,
      nextTempoData,
    )
    const shouldRebuildAxis = !this.state.axis
      || isTrackChanged
      || previousPpq !== ppq
      || previousTempoData !== nextTempoData
      || this.state.axis.totalTicks !== nextTotalTicks
    const colorChanged = previousTrackColor !== nextTrackColor || previousTrackBorderColor !== nextTrackBorderColor
    if (shouldRebuildAxis) {
      this._rebuildAxis(nextTotalTicks)
    }
    if (colorChanged) {
      this._applyTrackColor()
    }
    if (!shouldRebuildAxis && !shouldHydrateNotes && !isTrackChanged) {
      this._renderControls()
      this._renderPlayhead()
      return
    }
    this._renderMutableState({
      axisChanged: shouldRebuildAxis,
      notesChanged: shouldHydrateNotes || isTrackChanged,
    })
    if (isTrackChanged) {
      if (this.state.playbackActive) {
        this._syncPlaybackFollow()
      } else {
        this._scrollToTrackNotes()
      }
    }
    requestAnimationFrame(() => this._syncAxisExtentToViewport())
  }

  clear() {
    this.isPlayheadDragging = false
    this.playheadDragClientX = null
    this.playheadDragScroller?.stop?.()
    if (this.viewportRenderFrame) {
      cancelAnimationFrame(this.viewportRenderFrame)
      this.viewportRenderFrame = 0
      this.viewportRenderForce = false
    }
    this.state.trackId = null
    this.state.trackName = ''
    this.state.axis = null
    this.playheadRenderedX = null
    this.state.notes = []
    this.state.baseDurationTicks = 0
    this.state.loadedSignature = ''
    this.state.sourcePreviewNotesRef = null
    this.state.dirty = false
    this.state.recording = false
    this.state.playbackActive = false
    this.state.drawDraft = null
    this.state.hoverPreview = null
    this.state.erasing = false
    this.state.trackColor = getTrackColorById(null, [])
    this.state.trackBorderColor = darkenHexColor(this.state.trackColor)
    this._invalidateAxisRenderState()
    this._touchNotes()
    this._applyTrackColor()
    this._renderTrackState()
    this._hideGhostNote()
    this._hideHoverGuide()
    this.setVisible(false)
  }

  setPlaybackTime(time, options = {}) {
    const { allowDuringDrag = false } = options
    if (this.isPlayheadDragging && !allowDuringDrag) return
    this.state.currentTime = clampNonNegative(time)
    this._renderPlayhead()
    if (this.state.playbackActive && !this.isPlayheadDragging) this._syncPlaybackFollow()
  }

  setRecording(active) {
    this.state.recording = Boolean(active)
    this._renderControls()
  }

  setPlaybackActive(active) {
    this.state.playbackActive = Boolean(active)
    this._renderControls()
    if (this.state.playbackActive) this._syncPlaybackFollow()
  }

  setPlayheadFollowMode(mode) {
    this.playheadFollowMode = normalizePlayheadFollowMode(mode)
    if (this.state.playbackActive) this._syncPlaybackFollow()
    return this.playheadFollowMode
  }

  setTool(tool) {
    if (tool !== 'brush' && tool !== 'eraser') return
    this.state.tool = tool
    if (tool === 'eraser') {
      this.state.drawDraft = null
      this.state.hoverPreview = null
      this.state.erasing = false
      this._hideGhostNote()
      this._hideHoverGuide()
    }
    this._renderControls()
  }

  appendRecordedNote(note) {
    if (!this.state.trackId) return false
    this.state.notes = sortNotes([...this.state.notes, createDraftNote(note, this._nextNoteId())])
    this._touchNotes()
    this.state.dirty = true
    this._renderMutableState({
      axisChanged: this._ensureAxisForDraftNotes(),
      notesChanged: true,
    })
    return true
  }

  markSaved() {
    this.state.dirty = false
    this.state.loadedSignature = buildNoteSignature(this.state.notes)
    this._renderControls()
    this._setMetaText('已保存')
  }

  isDirty() {
    return Boolean(this.state.dirty)
  }

  isRecording() {
    return Boolean(this.state.recording)
  }

  getState() {
    return {
      trackId: this.state.trackId,
      dirty: this.state.dirty,
      recording: this.state.recording,
      tool: this.state.tool,
      notes: this.state.notes.map(exportDraftNote),
    }
  }

  _createTransportButton(kind, title, onClick, className = '') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `instrument-editor-transport-btn instrument-editor-transport-btn--${kind}${className ? ` ${className}` : ''}`
    button.title = title
    button.setAttribute('aria-label', title)
    const glyph = document.createElement('span')
    glyph.className = `instrument-editor-transport-glyph instrument-editor-transport-glyph--${kind}`
    button.appendChild(glyph)
    button.addEventListener('click', onClick)
    return button
  }

  _buildDom() {
    const toolbar = document.createElement('div')
    toolbar.className = 'instrument-editor-toolbar'

    const transport = document.createElement('div')
    transport.className = 'instrument-editor-transport'

    const stepPrevButton = this._createTransportButton(
      'prev',
      '后退一小节',
      () => this.handlers.onInstrumentEditorTransportStep?.(-1),
    )
    const playButton = this._createTransportButton(
      'play',
      '播放',
      () => this.handlers.onInstrumentEditorPlay?.(),
    )
    const stepNextButton = this._createTransportButton(
      'next',
      '前进一小节',
      () => this.handlers.onInstrumentEditorTransportStep?.(1),
    )
    const recordButton = this._createTransportButton(
      'record',
      '开始 MIDI 录制',
      () => this.handlers.onInstrumentEditorRecordStart?.(),
      'is-record',
    )
    const stopRecordButton = this._createTransportButton(
      'stop',
      '停止 MIDI 录制',
      () => this.handlers.onInstrumentEditorRecordStop?.(),
    )
    transport.append(stepPrevButton, playButton, stepNextButton, recordButton, stopRecordButton)

    const tools = document.createElement('div')
    tools.className = 'instrument-editor-tools'

    const brushButton = document.createElement('button')
    brushButton.type = 'button'
    brushButton.className = 'instrument-editor-tool'
    brushButton.setAttribute('aria-label', '画笔')
    brushButton.title = '画笔'
    brushButton.appendChild(createToolIcon('brush'))
    brushButton.addEventListener('click', () => {
      this.setTool('brush')
      this.handlers.onInstrumentEditorToolChanged?.('brush')
    })

    const eraserButton = document.createElement('button')
    eraserButton.type = 'button'
    eraserButton.className = 'instrument-editor-tool'
    eraserButton.setAttribute('aria-label', '橡皮')
    eraserButton.title = '橡皮'
    eraserButton.appendChild(createToolIcon('eraser'))
    eraserButton.addEventListener('click', () => {
      this.setTool('eraser')
      this.handlers.onInstrumentEditorToolChanged?.('eraser')
    })

    tools.append(brushButton, eraserButton)

    const actions = document.createElement('div')
    actions.className = 'instrument-editor-actions'

    const saveButton = document.createElement('button')
    saveButton.type = 'button'
    saveButton.className = 'panel-action-btn'
    saveButton.textContent = '保存'
    saveButton.addEventListener('click', () => this.handlers.onInstrumentEditorSave?.())

    actions.append(saveButton)

    const meta = document.createElement('div')
    meta.className = 'instrument-editor-meta'

    const snap = document.createElement('span')
    snap.className = 'instrument-editor-meta-chip'
    snap.textContent = 'SNAP 1/16'

    const status = document.createElement('span')
    status.className = 'instrument-editor-meta-chip'
    status.textContent = '未保存'

    meta.append(snap, status)
    toolbar.append(transport, tools, actions, meta)

    const stage = document.createElement('div')
    stage.className = 'instrument-editor-stage'

    const corner = document.createElement('div')
    corner.className = 'instrument-editor-corner'
    corner.textContent = 'ROLL'

    const rulerViewport = document.createElement('div')
    rulerViewport.className = 'instrument-editor-ruler-viewport'

    const rulerContent = document.createElement('div')
    rulerContent.className = 'instrument-editor-ruler-content'
    rulerContent.addEventListener('click', this._handleRulerClick)
    rulerViewport.appendChild(rulerContent)

    const keyboardViewport = document.createElement('div')
    keyboardViewport.className = 'instrument-editor-keyboard-viewport'

    const keyboardContent = document.createElement('div')
    keyboardContent.className = 'instrument-editor-keyboard-content'
    keyboardViewport.appendChild(keyboardContent)

    const gridViewport = document.createElement('div')
    gridViewport.className = 'instrument-editor-grid-viewport'
    gridViewport.addEventListener('scroll', this._handleGridScroll)
    gridViewport.addEventListener('mousedown', (event) => this._handlePointerDown(event))
    gridViewport.addEventListener('mousemove', this._handleViewportMouseMove)
    gridViewport.addEventListener('mouseleave', this._handleViewportMouseLeave)

    const gridContent = document.createElement('div')
    gridContent.className = 'instrument-editor-grid-content'

    const gridMarks = document.createElement('div')
    gridMarks.className = 'instrument-editor-grid-marks'

    const hoverBand = document.createElement('div')
    hoverBand.className = 'instrument-editor-hover-band'
    hoverBand.hidden = true

    const notesLayer = document.createElement('div')
    notesLayer.className = 'instrument-editor-notes-layer'

    const ghostNote = document.createElement('div')
    ghostNote.className = 'instrument-editor-note instrument-editor-note--ghost'
    ghostNote.hidden = true

    const keyboardGuide = document.createElement('div')
    keyboardGuide.className = 'instrument-editor-key-hover-guide'
    keyboardGuide.hidden = true
    keyboardContent.appendChild(keyboardGuide)

    const playheadHead = document.createElement('div')
    playheadHead.className = 'instrument-editor-playhead-head'
    playheadHead.style.width = `${PLAYHEAD_HITBOX_WIDTH}px`
    playheadHead.style.marginLeft = `${PLAYHEAD_HITBOX_WIDTH / -2}px`
    playheadHead.style.pointerEvents = 'auto'
    playheadHead.style.touchAction = 'none'

    const playheadLine = document.createElement('div')
    playheadLine.className = 'instrument-editor-playhead-line'
    playheadLine.style.width = `${PLAYHEAD_HITBOX_WIDTH}px`
    playheadLine.style.marginLeft = `${PLAYHEAD_HITBOX_WIDTH / -2}px`
    playheadLine.style.pointerEvents = 'auto'
    playheadLine.style.touchAction = 'none'

    rulerContent.appendChild(playheadHead)
    gridContent.append(gridMarks, hoverBand, notesLayer, ghostNote, playheadLine)
    gridViewport.appendChild(gridContent)
    stage.append(corner, rulerViewport, keyboardViewport, gridViewport)

    this.root.replaceChildren(toolbar, stage)
    this.refs = {
      toolbar,
      transport,
      stepPrevButton,
      playButton,
      stepNextButton,
      brushButton,
      eraserButton,
      recordButton,
      stopRecordButton,
      saveButton,
      metaStatus: status,
      rulerContent,
      keyboardContent,
      gridViewport,
      gridContent,
      gridMarks,
      hoverBand,
      keyboardGuide,
      notesLayer,
      ghostNote,
      playheadHead,
      playheadLine,
    }
  }

  _initPlayheadDrag() {
    this.playheadDragScroller = createHorizontalDragAutoScroller({
      getViewportRect: () => this.refs.gridViewport?.getBoundingClientRect?.() || null,
      getScrollLeft: () => this.refs.gridViewport?.scrollLeft || 0,
      setScrollLeft: (nextScrollLeft) => {
        if (this.refs.gridViewport) this.refs.gridViewport.scrollLeft = nextScrollLeft
      },
      getMaxScrollLeft: () => {
        const viewport = this.refs.gridViewport
        if (!viewport) return 0
        return Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      },
      onScroll: () => {
        this._syncScroll()
        this._scheduleViewportRender()
        this._previewPlayheadDrag(this.playheadDragClientX)
      },
    })
    this.refs.playheadHead?.addEventListener('mousedown', (event) => this._handlePlayheadPointerDown(event))
    this.refs.playheadLine?.addEventListener('mousedown', (event) => this._handlePlayheadPointerDown(event))
  }

  _renderKeyboard() {
    if (!this.refs.keyboardContent) return
    this.refs.keyboardContent.innerHTML = ''
    for (let midi = PIANO_ROLL.PITCH_MAX; midi >= PIANO_ROLL.PITCH_MIN; midi -= 1) {
      const row = document.createElement('div')
      row.className = `instrument-editor-key-row${isBlackKey(midi) ? ' is-black' : ''}`
      row.style.height = `${PIANO_ROLL.KEY_HEIGHT}px`

      const label = document.createElement('span')
      label.textContent = formatMidiLabel(midi)
      row.appendChild(label)
      this.refs.keyboardContent.appendChild(row)
    }
    if (this.refs.keyboardGuide) {
      this.refs.keyboardContent.appendChild(this.refs.keyboardGuide)
    }
  }

  _renderTrackState() {
    this._renderControls()
    this._renderRuler(true)
    this._renderGrid(true)
    this._renderNotes(true)
    this._renderPlayhead()
    this._renderHoverGuide()
  }

  _renderMutableState({ axisChanged = false, notesChanged = false } = {}) {
    this._renderControls()
    if (axisChanged) {
      this._renderRuler(true)
      this._renderGrid(true)
    }
    if (axisChanged || notesChanged) {
      this._renderNotes(true)
    }
    this._renderPlayhead()
    this._renderGhostNote()
    this._renderHoverGuide()
  }

  _renderControls() {
    if (!this.refs.toolbar) return
    this.refs.brushButton.classList.toggle('active', this.state.tool === 'brush')
    this.refs.eraserButton.classList.toggle('active', this.state.tool === 'eraser')
    this.refs.playButton.classList.toggle('is-playing', this.state.playbackActive)
    this.refs.playButton.title = this.state.playbackActive ? '暂停' : '播放'
    this.refs.playButton.setAttribute('aria-label', this.refs.playButton.title)
    if (this.refs.gridViewport) {
      this.refs.gridViewport.dataset.tool = this.state.tool
    }
    this.refs.recordButton.disabled = this.state.recording
    this.refs.recordButton.classList.toggle('is-recording', this.state.recording)
    this.refs.stopRecordButton.disabled = !this.state.recording
    this.refs.saveButton.disabled = !this.state.dirty && !this.state.recording
    this._setMetaText(this.state.recording ? '录制中' : (this.state.dirty ? '未保存更改' : '已保存'))
  }

  _renderRuler(force = false) {
    const axis = this.state.axis
    if (!this.refs.rulerContent) return
    this.refs.rulerContent.style.width = `${axis?.timelineWidth || 0}px`
    if (!axis) {
      this.viewportRenderState.rulerKey = ''
      this.refs.rulerContent.replaceChildren(...(this.refs.playheadHead ? [this.refs.playheadHead] : []))
      return
    }

    const renderWindow = this._getViewportRenderWindow()
    const renderKey = `${this.axisRevision}:${renderWindow.horizontalKey}`
    if (!force && this.viewportRenderState.rulerKey === renderKey) return

    this.viewportRenderState.rulerKey = renderKey
    const fragment = document.createDocumentFragment()
    this._getVisibleRulerMarks(renderWindow).forEach((mark) => {
      const line = document.createElement('span')
      line.className = `instrument-editor-ruler-line is-${mark.kind}`
      line.style.left = `${Math.round(mark.x)}px`
      fragment.appendChild(line)

      if (!mark.isBar) return
      const label = document.createElement('span')
      label.className = 'instrument-editor-ruler-label'
      label.style.left = `${Math.round(mark.x) + 4}px`
      label.textContent = String(mark.barNumber)
      fragment.appendChild(label)
    })

    const metaMinX = renderWindow.startX - 96
    const metaMaxX = renderWindow.endX + 220
    const appendMetaMarkers = (points, className, formatter) => {
      points.forEach((point, index) => {
        const pointTick = Number.isFinite(point?.ticks) ? point.ticks : 0
        if (index === 0 && pointTick === 0) return
        const x = Math.round(axis.tickToX(pointTick))
        if (x < metaMinX || x > metaMaxX) return
        const label = document.createElement('span')
        label.className = className
        label.style.left = `${x + 6}px`
        label.textContent = formatter(point)
        fragment.appendChild(label)
      })
    }

    appendMetaMarkers(axis.timeSignaturePoints, 'instrument-editor-ruler-meta-marker is-signature', (point) => {
      return Array.isArray(point.timeSignature) ? point.timeSignature.join('/') : '4/4'
    })
    appendMetaMarkers(axis.tempoPoints, 'instrument-editor-ruler-meta-marker is-tempo', (point) => {
      return `${Math.round(point.bpm)} BPM`
    })
    appendMetaMarkers(this.state.tempoData?.keySignatures || [], 'instrument-editor-ruler-meta-marker is-key', (point) => {
      return `${point.key}${point.scale === 'minor' ? 'm' : ''}`
    })

    this.refs.rulerContent.replaceChildren(fragment, ...(this.refs.playheadHead ? [this.refs.playheadHead] : []))
  }

  _renderGrid(force = false) {
    const axis = this.state.axis
    if (!this.refs.gridContent || !this.refs.gridMarks) return
    const pitchRows = PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1
    const height = pitchRows * PIANO_ROLL.KEY_HEIGHT
    const beatUnit = this.state.tempoData?.timeSignatures?.[0]?.timeSignature?.[1] || DEFAULT_TIME_SIGNATURE[1]
    const beatsPerBar = this.state.tempoData?.timeSignatures?.[0]?.timeSignature?.[0] || DEFAULT_TIME_SIGNATURE[0]
    const beatWidth = axis ? axis.beatWidth * (4 / beatUnit) : DEFAULT_BEAT_WIDTH
    const barWidth = beatWidth * beatsPerBar

    this.refs.gridContent.style.height = `${height}px`
    this.refs.gridContent.style.width = `${axis?.timelineWidth || 0}px`
    this.refs.gridContent.style.setProperty('--instrument-row-height', `${PIANO_ROLL.KEY_HEIGHT}px`)
    this.refs.gridContent.style.setProperty('--instrument-beat-width', `${beatWidth}px`)
    this.refs.gridContent.style.setProperty('--instrument-bar-width', `${barWidth}px`)

    if (!axis) {
      this.viewportRenderState.gridKey = ''
      this.refs.gridMarks.replaceChildren()
      return
    }

    const renderWindow = this._getViewportRenderWindow()
    const renderKey = `${this.axisRevision}:${renderWindow.horizontalKey}`
    if (!force && this.viewportRenderState.gridKey === renderKey) return

    this.viewportRenderState.gridKey = renderKey
    const fragment = document.createDocumentFragment()
    this._getVisibleRulerMarks(renderWindow).forEach((mark) => {
      const line = document.createElement('span')
      line.className = `instrument-editor-grid-line is-${mark.kind}`
      line.style.left = `${Math.round(mark.x)}px`
      fragment.appendChild(line)
    })
    this.refs.gridMarks.replaceChildren(fragment)
  }

  _renderNotes(force = false) {
    if (!this.refs.notesLayer) return
    if (!this.state.axis) {
      this.viewportRenderState.notesKey = ''
      this.refs.notesLayer.replaceChildren()
      return
    }

    const renderWindow = this._getViewportRenderWindow()
    const renderKey = `${this.axisRevision}:${this.notesRevision}:${renderWindow.horizontalKey}:${renderWindow.verticalKey}`
    if (!force && this.viewportRenderState.notesKey === renderKey) return

    this.viewportRenderState.notesKey = renderKey
    const fragment = document.createDocumentFragment()

    this._getVisibleNotes(renderWindow).forEach((note) => {
      const noteElement = document.createElement('button')
      noteElement.type = 'button'
      noteElement.className = 'instrument-editor-note'
      noteElement.dataset.noteId = note.id
      const width = Math.max(8, Math.round(this.state.axis.tickToX(note.durationTicks) - 2))
      noteElement.style.left = `${Math.round(this.state.axis.tickToX(note.tick))}px`
      noteElement.style.width = `${width}px`
      noteElement.style.top = `${(PIANO_ROLL.PITCH_MAX - note.midi) * PIANO_ROLL.KEY_HEIGHT + 1}px`
      noteElement.style.height = `${PIANO_ROLL.KEY_HEIGHT - 2}px`
      noteElement.title = `${formatMidiLabel(note.midi)} | ${note.durationTicks} ticks`
      noteElement.textContent = width > 18 ? formatMidiLabel(note.midi) : ''
      fragment.appendChild(noteElement)
    })
    this.refs.notesLayer.replaceChildren(fragment)
  }

  _renderPlayhead() {
    if ((!this.refs.playheadHead && !this.refs.playheadLine) || !this.state.axis) return
    const x = this.state.axis.timeToX(this.state.currentTime)
    if (this.playheadRenderedX != null && Math.abs(this.playheadRenderedX - x) < 0.01) return
    this.playheadRenderedX = x
    if (this.refs.playheadHead) this.refs.playheadHead.style.transform = `translateX(${x}px)`
    if (this.refs.playheadLine) this.refs.playheadLine.style.transform = `translateX(${x}px)`
  }

  _handlePlayheadPointerDown(event) {
    if (event.button !== 0 || !this.state.axis) return
    event.preventDefault()
    event.stopPropagation()
    this.isPlayheadDragging = true
    this.playheadDragClientX = event.clientX
    this.playheadDragScroller?.start(event.clientX)
    this._previewPlayheadDrag(event.clientX)
  }

  _previewPlayheadDrag(clientX) {
    const viewport = this.refs.gridViewport
    if (!viewport || !this.state.axis || !Number.isFinite(clientX)) return
    const rect = viewport.getBoundingClientRect()
    const clampedX = Math.max(0, Math.min(clientX - rect.left, viewport.clientWidth))
    const nextTime = this.state.axis.xToTime(clampedX + viewport.scrollLeft)
    this.setPlaybackTime(nextTime, { allowDuringDrag: true })
  }

  _syncPlaybackFollow() {
    const viewport = this.refs.gridViewport
    if (!viewport || !this.state.axis) return false
    const playheadX = this.state.axis.timeToX(this.state.currentTime)
    const nextScrollLeft = computeFollowScrollLeft({
      mode: this.playheadFollowMode,
      currentScrollLeft: viewport.scrollLeft,
      playheadX,
      viewportWidth: viewport.clientWidth || 0,
      contentWidth: this.state.axis.timelineWidth,
      padding: 40,
    })
    if (Math.abs(nextScrollLeft - viewport.scrollLeft) < 0.5) return false
    viewport.scrollLeft = nextScrollLeft
    this._syncScroll()
    this._scheduleViewportRender()
    return true
  }

  _scrollToTrackNotes() {
    if (!this.refs.gridViewport || this.state.notes.length === 0) {
      if (this.refs.gridViewport) {
        this.refs.gridViewport.scrollLeft = 0
        this.refs.gridViewport.scrollTop = 0
      }
      this._syncScroll()
      return
    }
    const firstNote = this.state.notes[0]
    const topPitchOffset = (PIANO_ROLL.PITCH_MAX - firstNote.midi) * PIANO_ROLL.KEY_HEIGHT
    this.refs.gridViewport.scrollLeft = Math.max(0, this.state.axis.tickToX(firstNote.tick) - 40)
    this.refs.gridViewport.scrollTop = Math.max(0, topPitchOffset - 120)
    this._syncScroll()
  }

  _syncScroll() {
    if (!this.refs.gridViewport || !this.refs.keyboardContent || !this.refs.rulerContent) return
    this.refs.keyboardContent.style.transform = `translateY(${-this.refs.gridViewport.scrollTop}px)`
    this.refs.rulerContent.style.transform = `translateX(${-this.refs.gridViewport.scrollLeft}px)`
  }

  _handleGridScroll() {
    this._syncScroll()
    this._scheduleViewportRender()
  }

  _handleRulerClick(event) {
    const axis = this.state.axis
    const viewport = this.refs.gridViewport
    if (!axis || !viewport) return
    const viewportRect = viewport.getBoundingClientRect()
    const x = event.clientX - viewportRect.left + viewport.scrollLeft
    this.handlers.onInstrumentEditorSeek?.(axis.xToTime(x))
  }

  _handlePointerDown(event) {
    if (event.button !== 0 || !this.state.axis) return
    const pos = this._getLocalPointerPosition(event)
    if (!pos) return
    if (this.state.tool === 'eraser') {
      this.state.drawDraft = null
      this.state.hoverPreview = null
      this.state.erasing = true
      this._hideGhostNote()
      this._hideHoverGuide()
      this._eraseNoteAt(pos)
      return
    }

    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    const snappedTick = this._snapTick(this.state.axis.xToTick(pos.x))
    this.state.drawDraft = {
      midi: this._yToMidi(pos.y),
      startTick: snappedTick,
      endTick: snappedTick + snapTicks,
    }
    this._renderGhostNote()
    this._renderHoverGuide()
  }

  _handlePointerMove(event) {
    if (this.isPlayheadDragging) {
      this.playheadDragClientX = event.clientX
      this.playheadDragScroller?.update(event.clientX)
      this._previewPlayheadDrag(event.clientX)
      return
    }
    if (!this.state.axis) return
    if (this.state.erasing) {
      const pos = this._getLocalPointerPosition(event)
      if (pos) this._eraseNoteAt(pos)
      return
    }
    if (!this.state.drawDraft) return
    const pos = this._getLocalPointerPosition(event)
    if (!pos) return
    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    const nextTick = this._snapTick(this.state.axis.xToTick(pos.x))
    this.state.drawDraft.endTick = nextTick === this.state.drawDraft.startTick
      ? nextTick + snapTicks
      : nextTick
    this.state.drawDraft.midi = this._yToMidi(pos.y)
    this._renderGhostNote()
    this._renderHoverGuide()
  }

  _handlePointerUp() {
    if (this.isPlayheadDragging) {
      this.isPlayheadDragging = false
      this.playheadDragScroller?.stop()
      this.playheadDragClientX = null
      this.handlers.onInstrumentEditorSeek?.(this.state.currentTime)
      return
    }
    if (this.state.erasing) {
      this.state.erasing = false
      this._hideGhostNote()
      this._hideHoverGuide()
      return
    }
    if (!this.state.drawDraft || !this.state.axis) return
    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    const startTick = Math.min(this.state.drawDraft.startTick, this.state.drawDraft.endTick)
    const endTick = Math.max(this.state.drawDraft.startTick, this.state.drawDraft.endTick)
    const durationTicks = Math.max(snapTicks, endTick - startTick)
    this._insertDraftNote({
      time: this.state.axis.tickToTime(startTick),
      duration: Math.max(0.05, this.state.axis.tickToTime(startTick + durationTicks) - this.state.axis.tickToTime(startTick)),
      tick: startTick,
      durationTicks,
      midi: this.state.drawDraft.midi,
      velocity: 0.8,
    })
    this.state.drawDraft = null
    this._hideGhostNote()
    this._renderHoverGuide()
  }

  _handleViewportMouseMove(event) {
    if (!this.state.axis || this.state.tool !== 'brush' || this.state.drawDraft || this.state.erasing) return
    const pos = this._getLocalPointerPosition(event)
    if (!pos) {
      this._hideHoverGuide()
      return
    }
    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    const snappedTick = this._snapTick(this.state.axis.xToTick(pos.x))
    this.state.hoverPreview = {
      midi: this._yToMidi(pos.y),
      startTick: snappedTick,
      endTick: snappedTick + snapTicks,
    }
    this._renderHoverGuide()
  }

  _handleViewportMouseLeave() {
    if (this.state.drawDraft) return
    this.state.hoverPreview = null
    this._hideHoverGuide()
  }

  _hideGhostNote() {
    if (!this.refs.ghostNote) return
    this.refs.ghostNote.hidden = true
    this.refs.ghostNote.textContent = ''
    this.refs.ghostNote.style.left = ''
    this.refs.ghostNote.style.top = ''
    this.refs.ghostNote.style.width = ''
    this.refs.ghostNote.style.height = ''
  }

  _getGuidePreview() {
    return this.state.drawDraft || this.state.hoverPreview || null
  }

  _hideHoverGuide() {
    if (this.refs.hoverBand) {
      this.refs.hoverBand.hidden = true
      this.refs.hoverBand.style.left = ''
      this.refs.hoverBand.style.top = ''
      this.refs.hoverBand.style.width = ''
      this.refs.hoverBand.style.height = ''
    }
    if (this.refs.keyboardGuide) {
      this.refs.keyboardGuide.hidden = true
      this.refs.keyboardGuide.style.top = ''
      this.refs.keyboardGuide.style.height = ''
    }
  }

  _renderHoverGuide() {
    const preview = this._getGuidePreview()
    if (!this.state.axis || this.state.tool !== 'brush' || !preview) {
      this._hideHoverGuide()
      return
    }

    const top = (PIANO_ROLL.PITCH_MAX - preview.midi) * PIANO_ROLL.KEY_HEIGHT + 1
    const height = PIANO_ROLL.KEY_HEIGHT - 2

    if (this.refs.hoverBand) {
      this.refs.hoverBand.hidden = false
      this.refs.hoverBand.style.left = '0px'
      this.refs.hoverBand.style.top = `${top}px`
      this.refs.hoverBand.style.width = `${Math.max(0, Math.round(this.state.axis.timelineWidth))}px`
      this.refs.hoverBand.style.height = `${height}px`
    }

    if (this.refs.keyboardGuide) {
      this.refs.keyboardGuide.hidden = false
      this.refs.keyboardGuide.style.top = `${top}px`
      this.refs.keyboardGuide.style.height = `${height}px`
    }
  }

  _renderGhostNote() {
    if (!this.refs.ghostNote || !this.state.axis || !this.state.drawDraft) {
      this._hideGhostNote()
      return
    }
    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    const startTick = Math.min(this.state.drawDraft.startTick, this.state.drawDraft.endTick)
    const endTick = Math.max(this.state.drawDraft.startTick, this.state.drawDraft.endTick)
    const durationTicks = Math.max(snapTicks, endTick - startTick)
    const width = Math.max(8, Math.round(this.state.axis.tickToX(durationTicks) - 2))
    this.refs.ghostNote.hidden = false
    this.refs.ghostNote.style.left = `${Math.round(this.state.axis.tickToX(startTick))}px`
    this.refs.ghostNote.style.width = `${width}px`
    this.refs.ghostNote.style.top = `${(PIANO_ROLL.PITCH_MAX - this.state.drawDraft.midi) * PIANO_ROLL.KEY_HEIGHT + 1}px`
    this.refs.ghostNote.style.height = `${PIANO_ROLL.KEY_HEIGHT - 2}px`
    this.refs.ghostNote.textContent = width > 18 ? formatMidiLabel(this.state.drawDraft.midi) : ''
  }

  _eraseNoteAt(pos) {
    const noteIndex = this._findNoteIndexAt(pos)
    if (noteIndex < 0) return
    this.state.notes.splice(noteIndex, 1)
    this._touchNotes()
    this.state.dirty = true
    this._renderMutableState({ notesChanged: true })
  }

  _findNoteIndexAt(pos) {
    const tick = this.state.axis.xToTick(pos.x)
    const midi = this._yToMidi(pos.y)
    for (let index = this.state.notes.length - 1; index >= 0; index -= 1) {
      const note = this.state.notes[index]
      const noteEnd = note.tick + note.durationTicks
      if (note.midi !== midi) continue
      if (tick >= note.tick && tick <= noteEnd) return index
    }
    return -1
  }

  _insertDraftNote(note) {
    const draftNote = createDraftNote(note, this._nextNoteId())
    const duplicate = this.state.notes.some((current) => {
      return current.tick === draftNote.tick
        && current.durationTicks === draftNote.durationTicks
        && current.midi === draftNote.midi
    })
    if (duplicate) return
    this.state.notes = sortNotes([...this.state.notes, draftNote])
    this._touchNotes()
    this.state.dirty = true
    this._renderMutableState({
      axisChanged: this._ensureAxisForDraftNotes(),
      notesChanged: true,
    })
  }

  _getLocalPointerPosition(event) {
    const viewport = this.refs.gridViewport
    if (!viewport) return null
    const rect = viewport.getBoundingClientRect()
    const insideHorizontally = event.clientX >= rect.left && event.clientX <= rect.right
    const insideVertically = event.clientY >= rect.top && event.clientY <= rect.bottom
    if (!insideHorizontally || !insideVertically) return null
    return {
      x: event.clientX - rect.left + viewport.scrollLeft,
      y: event.clientY - rect.top + viewport.scrollTop,
    }
  }

  _yToMidi(y) {
    const rowIndex = Math.floor(clampNonNegative(y) / PIANO_ROLL.KEY_HEIGHT)
    return clampMidi(PIANO_ROLL.PITCH_MAX - rowIndex)
  }

  _snapTick(tick) {
    const snapTicks = getDefaultSnapTicks(this.state.ppq)
    return Math.max(0, Math.round(Math.round(clampNonNegative(tick) / snapTicks) * snapTicks))
  }

  _setMetaText(text) {
    if (!this.refs.metaStatus) return
    this.refs.metaStatus.textContent = text || ''
  }

  _applyTrackColor() {
    if (!this.root) return
    this.root.style.setProperty('--instrument-note-fill', this.state.trackColor)
    this.root.style.setProperty('--instrument-note-border', this.state.trackBorderColor)
    this.root.style.setProperty('--instrument-guide-fill', hexToRgba(this.state.trackColor, 0.18))
    this.root.style.setProperty('--instrument-guide-border', hexToRgba(this.state.trackColor, 0.42))
    this.root.style.setProperty('--instrument-guide-key-fill', hexToRgba(this.state.trackColor, 0.14))
  }

  _rebuildAxis(totalTicks = null) {
    this.state.axis = createTimelineAxis({
      tempoData: this.state.tempoData,
      ppq: this.state.ppq,
      beatWidth: DEFAULT_BEAT_WIDTH,
      totalTicks: Number.isFinite(totalTicks)
        ? Math.max(0, Math.round(totalTicks))
        : computeTotalTicks({ durationTicks: this.state.baseDurationTicks }, this.state.notes, this.state.ppq, 0, this.state.tempoData),
    })
    this._invalidateAxisRenderState()
  }

  _ensureAxisForDraftNotes() {
    const nextTotalTicks = computeTotalTicks(
      { durationTicks: this.state.baseDurationTicks },
      this.state.notes,
      this.state.ppq,
      0,
      this.state.tempoData,
    )
    if (this.state.axis && nextTotalTicks <= this.state.axis.totalTicks) {
      return false
    }
    this._rebuildAxis(nextTotalTicks)
    return true
  }

  _syncAxisExtentToViewport() {
    if (!this.state.axis || !this.refs.gridViewport) return false
    const viewportWidth = this.refs.gridViewport.clientWidth || this.refs.gridViewport.getBoundingClientRect?.().width || 0
    const nextTotalTicks = computeTotalTicks(
      { durationTicks: this.state.baseDurationTicks },
      this.state.notes,
      this.state.ppq,
      viewportWidth,
      this.state.tempoData,
    )
    if (nextTotalTicks <= this.state.axis.totalTicks) return false
    this._rebuildAxis(nextTotalTicks)
    this._renderMutableState({ axisChanged: true, notesChanged: false })
    return true
  }

  _scheduleViewportRender(force = false) {
    this.viewportRenderForce = this.viewportRenderForce || force
    if (this.viewportRenderFrame) return
    this.viewportRenderFrame = requestAnimationFrame(() => {
      this.viewportRenderFrame = 0
      const shouldForce = this.viewportRenderForce
      this.viewportRenderForce = false
      this._renderRuler(shouldForce)
      this._renderGrid(shouldForce)
      this._renderNotes(shouldForce)
    })
  }

  _getViewportRenderWindow() {
    const axis = this.state.axis
    if (!axis) return null

    const viewport = this.refs.gridViewport
    if (!viewport) {
      return {
        startX: 0,
        endX: axis.timelineWidth,
        startTick: 0,
        endTick: axis.totalTicks,
        highMidi: PIANO_ROLL.PITCH_MAX,
        lowMidi: PIANO_ROLL.PITCH_MIN,
        horizontalKey: 'full',
        verticalKey: 'full',
      }
    }

    const viewportWidth = viewport.clientWidth || viewport.getBoundingClientRect?.().width || 0
    const viewportHeight = viewport.clientHeight || viewport.getBoundingClientRect?.().height || 0
    const horizontalChunkPx = Math.max(DEFAULT_BEAT_WIDTH * VIEWPORT_HORIZONTAL_CHUNK_BEATS, viewportWidth || 0)
    const verticalChunkPx = Math.max(PIANO_ROLL.KEY_HEIGHT * VIEWPORT_VERTICAL_CHUNK_ROWS, viewportHeight || 0)
    const startChunk = Math.max(0, Math.floor(viewport.scrollLeft / horizontalChunkPx) - 1)
    const endChunk = Math.floor((viewport.scrollLeft + viewportWidth) / horizontalChunkPx) + 1
    const topChunk = Math.max(0, Math.floor(viewport.scrollTop / verticalChunkPx) - 1)
    const bottomChunk = Math.floor((viewport.scrollTop + viewportHeight) / verticalChunkPx) + 1
    const pitchRows = PIANO_ROLL.PITCH_MAX - PIANO_ROLL.PITCH_MIN + 1
    const totalHeight = pitchRows * PIANO_ROLL.KEY_HEIGHT
    const startX = startChunk * horizontalChunkPx
    const endX = Math.max(startX, Math.min(axis.timelineWidth, (endChunk + 1) * horizontalChunkPx))
    const startY = topChunk * verticalChunkPx
    const endY = Math.max(startY, Math.min(totalHeight, (bottomChunk + 1) * verticalChunkPx))
    const midiStart = this._yToMidi(startY)
    const midiEnd = this._yToMidi(endY)

    return {
      startX,
      endX,
      startTick: axis.xToTick(startX),
      endTick: axis.xToTick(endX),
      highMidi: Math.max(midiStart, midiEnd),
      lowMidi: Math.min(midiStart, midiEnd),
      horizontalKey: `${startChunk}:${endChunk}`,
      verticalKey: `${topChunk}:${bottomChunk}`,
    }
  }

  _getVisibleRulerMarks(renderWindow) {
    const cacheKey = `${this.axisRevision}:${renderWindow.horizontalKey}`
    if (this.visibleMarksCache.key !== cacheKey) {
      this.visibleMarksCache = {
        key: cacheKey,
        marks: this.state.axis?.getRulerMarksInRange({
          startTick: renderWindow.startTick,
          endTick: renderWindow.endTick,
          subdivisionsPerBeat: SNAP_DIVISION,
        }) || [],
      }
    }
    return this.visibleMarksCache.marks
  }

  _getVisibleNotes(renderWindow) {
    const notes = []
    const startIndex = this._findNoteInsertionIndexByTick(
      Math.max(0, renderWindow.startTick - this.noteDurationCeiling),
    )

    for (let index = startIndex; index < this.state.notes.length; index += 1) {
      const note = this.state.notes[index]
      if (note.tick > renderWindow.endTick) break
      const noteEndTick = note.tick + note.durationTicks
      if (noteEndTick < renderWindow.startTick) continue
      if (note.midi < renderWindow.lowMidi || note.midi > renderWindow.highMidi) continue
      notes.push(note)
    }

    return notes
  }

  _findNoteInsertionIndexByTick(targetTick) {
    let low = 0
    let high = this.state.notes.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.state.notes[mid].tick < targetTick) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  _touchNotes() {
    this.noteDurationCeiling = this.state.notes.reduce((maxDuration, note) => {
      return Math.max(maxDuration, Math.max(1, Math.round(clampNonNegative(note?.durationTicks, 1))))
    }, 1)
    this.notesRevision += 1
    this.viewportRenderState.notesKey = ''
  }

  _invalidateAxisRenderState() {
    this.axisRevision += 1
    this.visibleMarksCache = {
      key: '',
      marks: [],
    }
    this.viewportRenderState.rulerKey = ''
    this.viewportRenderState.gridKey = ''
    this.viewportRenderState.notesKey = ''
  }

  _nextNoteId() {
    this.noteSeed += 1
    return `instrument-note-${this.noteSeed}`
  }
}
