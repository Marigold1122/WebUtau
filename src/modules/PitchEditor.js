import eventBus from '../core/EventBus.js'
import phraseStore from '../core/PhraseStore.js'
import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import renderPriorityStrategy from './RenderPriorityStrategy.js'
import renderScheduler from './RenderScheduler.js'
import { EVENTS } from '../config/constants.js'
import { createVibratoDocument } from '../shared/noteDocument.js'

const MODE = {
  LYRIC: 'lyric',
  PITCH: 'pitch',
}

const PITCH_POINT_SHAPES = {
  IN_OUT: 'io',
  LINEAR: 'l',
  IN: 'i',
  OUT: 'o',
}

const PITCH_BOUNDARY_MODES = {
  GLIDE: 'glide',
  SNAP: 'snap',
  HOLD: 'hold',
}

const DEFAULT_SHAPE = PITCH_POINT_SHAPES.IN_OUT
const DEFAULT_BOUNDARY_MODE = PITCH_BOUNDARY_MODES.GLIDE
const PITCH_CENT_MIN = -1200
const PITCH_CENT_MAX = 1200
const NOTE_SIMPLIFY_EPSILON = 8
const NOTE_SIMPLIFY_MAX_POINTS = 10
const COMPILED_SIMPLIFY_EPSILON = 3
const EPSILON = 0.001
const SUPPORT_POINT_MIN_RAW_SAMPLES = 5
const SUPPORT_POINT_MIN_GAP_TICK = 20
const SUPPORT_POINT_MAX_EXTRA = 4
const HOLD_BOUNDARY_RATIO = 0.18
const HOLD_BOUNDARY_MAX_TICK = 40
const HISTORY_LIMIT = 100
const DEFAULT_PORTAMENTO = Object.freeze({
  start: -40,
  length: 80,
})
const DEFAULT_VIBRATO = Object.freeze({
  length: 75,
  period: 175,
  depth: 25,
  in: 10,
  out: 10,
  shift: 0,
  drift: 0,
  volLink: 0,
})
const DISABLED_VIBRATO = Object.freeze({
  ...DEFAULT_VIBRATO,
  length: 0,
})

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function clonePoint(point) {
  return {
    id: point.id,
    relTick: point.relTick,
    cent: point.cent,
    shape: point.shape,
    kind: point.kind,
    source: point.source,
  }
}

function cloneControl(control) {
  return {
    noteKey: control.noteKey,
    phraseIndex: control.phraseIndex,
    noteIndex: control.noteIndex,
    startTick: control.startTick,
    endTick: control.endTick,
    durationTick: control.durationTick,
    midi: control.midi,
    startTime: control.startTime,
    endTime: control.endTime,
    boundaryMode: control.boundaryMode,
    startReferenceCent: control.startReferenceCent,
    endReferenceCent: control.endReferenceCent,
    referenceSamples: Array.isArray(control.referenceSamples)
      ? control.referenceSamples.map((sample) => ({
        relTick: sample.relTick,
        cent: sample.cent,
      }))
      : [],
    points: control.points.map(clonePoint),
  }
}

function arePointsEquivalent(left, right) {
  return left.id === right.id
    && left.relTick === right.relTick
    && left.cent === right.cent
    && left.shape === right.shape
    && left.kind === right.kind
    && (left.source || null) === (right.source || null)
}

function areControlsEquivalent(left, right) {
  if (!left || !right) return false
  if (left.noteKey !== right.noteKey) return false
  if (left.startTick !== right.startTick || left.endTick !== right.endTick) return false
  if ((left.boundaryMode || DEFAULT_BOUNDARY_MODE) !== (right.boundaryMode || DEFAULT_BOUNDARY_MODE)) return false
  if ((left.startReferenceCent || 0) !== (right.startReferenceCent || 0)) return false
  if ((left.endReferenceCent || 0) !== (right.endReferenceCent || 0)) return false
  if (left.midi !== right.midi || left.points.length !== right.points.length) return false
  for (let index = 0; index < left.points.length; index += 1) {
    if (!arePointsEquivalent(left.points[index], right.points[index])) return false
  }
  return true
}

function compareControlsByTime(left, right) {
  if (left.startTick !== right.startTick) return left.startTick - right.startTick
  if (left.endTick !== right.endTick) return left.endTick - right.endTick
  if (left.midi !== right.midi) return left.midi - right.midi
  if (left.phraseIndex !== right.phraseIndex) return left.phraseIndex - right.phraseIndex
  return left.noteIndex - right.noteIndex
}

function dedupeSortedPoints(points) {
  const deduped = []
  for (const point of points) {
    if (deduped.length > 0 && deduped[deduped.length - 1].tick === point.tick) {
      deduped[deduped.length - 1] = point
    } else {
      deduped.push(point)
    }
  }
  return deduped
}

function createNormalizedVibrato(vibrato, { enabled = false } = {}) {
  const base = enabled ? DEFAULT_VIBRATO : DISABLED_VIBRATO
  return createVibratoDocument({
    ...base,
    ...(vibrato || {}),
  }) || { ...base }
}

function cloneVibrato(vibrato) {
  return vibrato ? { ...vibrato } : null
}

function buildVibratoSignature(vibrato) {
  const normalized = createNormalizedVibrato(vibrato)
  return [
    normalized.length,
    normalized.period,
    normalized.depth,
    normalized.in,
    normalized.out,
    normalized.shift,
    normalized.drift,
    normalized.volLink,
  ].join(':')
}

function resolveSharedValue(values = [], transform = (value) => value) {
  if (!Array.isArray(values) || values.length === 0) return null
  const first = transform(values[0])
  return values.every((value) => transform(value) === first) ? first : null
}

class PitchEditor {
  constructor() {
    this._mode = MODE.LYRIC
    this._selectedPointId = null
    this._selectedSegmentId = null
    this._previewVersion = 0
    this._commitQueue = Promise.resolve()
    this._serverPitchData = null
    this._originalPitchData = null
    this._originalJobId = null
    this._serverNoteControls = []
    this._serverNoteMetaByKey = new Map()
    this._noteControls = []
    this._originalNoteControls = []
    this._noteKeyByRef = new WeakMap()
    this._nextPointId = 1
    this._pendingServerSync = null
    this._selectionEventKey = ''
    this._undoStack = []
    this._bindEvents()
  }

  _bindEvents() {
    eventBus.on(EVENTS.JOB_SUBMITTED, () => {
      this._mode = MODE.LYRIC
      this._selectedPointId = null
      this._selectedSegmentId = null
      this._previewVersion = 0
      this._serverPitchData = null
      this._originalPitchData = null
      this._originalJobId = null
      this._serverNoteControls = []
      this._serverNoteMetaByKey = new Map()
      this._noteControls = []
      this._originalNoteControls = []
      this._noteKeyByRef = new WeakMap()
      this._pendingServerSync = null
      this._selectionEventKey = ''
      this._undoStack = []
      this._emitSelectionChanged()
      eventBus.emit(EVENTS.PITCH_EDITOR_MODE_CHANGED, { mode: this._mode })
    })

    eventBus.on(EVENTS.PITCH_LOADED, ({ pitchData } = {}) => {
      const cloned = this._clonePitchData(pitchData)
      const jobId = phraseStore.getJobId()
      this._serverPitchData = cloned

      let controls
      const pendingSync = this._pendingServerSync
      if (pendingSync?.jobId === jobId) {
        controls = this._cloneNoteControls(pendingSync.controls)
        this._selectedPointId = pendingSync.selectedPointId || null
        this._selectedSegmentId = pendingSync.selectedSegmentId || null
        this._pendingServerSync = null
      } else {
        controls = this._buildNoteControlsFromPitchData(cloned)
        this._selectedPointId = null
        this._selectedSegmentId = null
      }

      this._noteControls = controls
      this._rebuildNoteKeyMap(controls)
      this._serverNoteControls = this._cloneNoteControls(controls)
      this._serverNoteMetaByKey = this._captureNoteMetaByKey(controls)

      if (jobId !== this._originalJobId || this._originalPitchData == null) {
        this._originalPitchData = this._clonePitchData(cloned)
        this._originalNoteControls = this._cloneNoteControls(controls)
        this._originalJobId = jobId
      }

      this._ensureSelectionStillExists()
      this._ensureSegmentSelectionStillExists()
      this._emitSelectionChanged()
    })
  }

  canEdit() {
    const pitchData = phraseStore.getPitchData()
    return phraseStore.getJobId() != null
      && phraseStore.getPhrases().length > 0
      && Array.isArray(pitchData?.pitchCurve)
      && pitchData.pitchCurve.length > 0
  }

  getMode() {
    return this._mode
  }

  isEnabled() {
    return this._mode === MODE.PITCH
  }

  setMode(mode) {
    const nextMode = mode === MODE.PITCH ? MODE.PITCH : MODE.LYRIC
    if (nextMode === MODE.PITCH && !this.canEdit()) return false
    if (this._mode === nextMode) return true
    this._mode = nextMode
    if (nextMode === MODE.LYRIC) this._selectedPointId = null
    eventBus.emit(EVENTS.PITCH_EDITOR_MODE_CHANGED, { mode: this._mode })
    return true
  }

  toggleMode() {
    return this.setMode(this.isEnabled() ? MODE.LYRIC : MODE.PITCH)
  }

  hasOriginalPitch() {
    return this._originalNoteControls.length > 0
  }

  canUndo() {
    return this._undoStack.length > 0
  }

  resetHistory() {
    this._undoStack = []
  }

  async undo() {
    if (!this.canEdit() || !this.canUndo()) return false
    const snapshot = this._undoStack.pop()
    if (!snapshot?.pitchData) return false
    const rollbackSnapshot = this._captureCommittedSnapshot()
    try {
      this._previewHistorySnapshot(snapshot)
      await this._applyHistorySnapshot(snapshot, { reason: 'undo' })
      return true
    } catch (error) {
      if (rollbackSnapshot?.pitchData) {
        this._previewHistorySnapshot(rollbackSnapshot)
      }
      this._pushUndoSnapshot(snapshot)
      throw error
    }
  }

  getSelectedPointId() {
    return this._selectedPointId
  }

  getSelectedSegmentId() {
    return this._selectedSegmentId
  }

  hasSelectedPoint() {
    return typeof this._selectedPointId === 'string'
  }

  hasSelectedSegment() {
    return typeof this._selectedSegmentId === 'string'
  }

  selectPoint(pointId) {
    this._selectedPointId = this._findDisplayPoint(pointId) ? pointId : null
    this._selectedSegmentId = this._resolveOutgoingSegmentId(this._selectedPointId)
    this._emitSelectionChanged()
    return this._selectedPointId
  }

  selectSegment(segmentId) {
    this._selectedPointId = null
    this._selectedSegmentId = this._findDisplaySegment(segmentId) ? segmentId : null
    this._emitSelectionChanged()
    return this._selectedSegmentId
  }

  clearSelection() {
    this._selectedPointId = null
    this._selectedSegmentId = null
    this._emitSelectionChanged()
  }

  captureControlState() {
    return this._cloneNoteControls(this._noteControls)
  }

  getDisplayPoints(controls = this._noteControls, options = {}) {
    const includeAnchors = options.includeAnchors === true
    const points = []
    for (const control of controls) {
      const renderablePoints = includeAnchors
        ? this._getRenderableControlPoints(control, controls)
        : control.points
      for (let index = 0; index < renderablePoints.length; index += 1) {
        const point = renderablePoints[index]
        if (!includeAnchors && point.kind !== 'normal') continue
        const tick = control.startTick + point.relTick
        points.push({
          id: point.id,
          noteKey: control.noteKey,
          phraseIndex: control.phraseIndex,
          noteIndex: control.noteIndex,
          tick,
          time: this.getTimeForTick(tick),
          pitch: control.midi + point.cent / 100,
          relTick: point.relTick,
          cent: point.cent,
          shape: point.shape,
          kind: point.kind,
          source: point.source || (point.kind === 'normal' ? 'auto' : 'structural'),
          virtual: point.virtual === true,
          canDelete: point.kind === 'normal',
          canChangeShape: point.kind === 'normal' && point.virtual !== true && index < renderablePoints.length - 1,
        })
      }
    }
    return points
  }

  getDisplaySegments(controls = this._noteControls) {
    const segments = []
    for (const control of controls) {
      const renderablePoints = this._getRenderableControlPoints(control, controls)
      for (let index = 0; index < renderablePoints.length - 1; index += 1) {
        const start = renderablePoints[index]
        const end = renderablePoints[index + 1]
        const startTick = control.startTick + start.relTick
        const endTick = control.startTick + end.relTick
        if (endTick <= startTick) continue
        segments.push({
          id: this._buildSegmentId(control.noteKey, start.id, end.id),
          noteKey: control.noteKey,
          phraseIndex: control.phraseIndex,
          noteIndex: control.noteIndex,
          startPointId: start.id,
          endPointId: end.id,
          startTick,
          endTick,
          startTime: this.getTimeForTick(startTick),
          endTime: this.getTimeForTick(endTick),
          startPitch: control.midi + start.cent / 100,
          endPitch: control.midi + end.cent / 100,
          shape: start.shape || DEFAULT_SHAPE,
          boundaryMode: control.boundaryMode || DEFAULT_BOUNDARY_MODE,
          canChangeShape: start.kind === 'normal' && start.virtual !== true,
          startKind: start.kind,
          startSource: start.source || (start.kind === 'normal' ? 'auto' : 'structural'),
        })
      }
    }
    return segments
  }

  getTickForTime(timeSeconds, pitchData = phraseStore.getPitchData()) {
    const bpm = phraseStore.getBpm() || 120
    const midiPpq = Number.isFinite(pitchData?.midiPpq) ? pitchData.midiPpq : 480
    return Math.round((Math.max(0, timeSeconds) * bpm * midiPpq) / 60)
  }

  getTimeForTick(tick, pitchData = phraseStore.getPitchData()) {
    const bpm = phraseStore.getBpm() || 120
    const midiPpq = Number.isFinite(pitchData?.midiPpq) ? pitchData.midiPpq : 480
    return tick * 60 / (bpm * midiPpq)
  }

  getTickRangeForNoteEntries(noteEntries = []) {
    if (!Array.isArray(noteEntries) || noteEntries.length === 0) return null
    let minTick = Infinity
    let maxTick = -Infinity
    for (const entry of noteEntries) {
      const note = entry?.note
      if (!note) continue
      const startTick = this.getTickForTime(note.time)
      const endTick = this.getTickForTime(note.time + note.duration)
      minTick = Math.min(minTick, startTick)
      maxTick = Math.max(maxTick, endTick)
    }
    if (!Number.isFinite(minTick) || !Number.isFinite(maxTick)) return null
    return {
      startTick: minTick,
      endTick: maxTick,
    }
  }

  snapTick(rawTick, pitchData = phraseStore.getPitchData()) {
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    return Math.max(0, Math.round(rawTick / step) * step)
  }

  canDeletePoint(pointId) {
    const point = this._findDisplayPoint(pointId)
    return point?.canDelete === true
  }

  canChangeShape(pointId) {
    const point = this._findDisplayPoint(pointId)
    return point?.canChangeShape === true
  }

  getSelectedSegment() {
    return this._findDisplaySegment(this._selectedSegmentId)
  }

  getSelectedSegmentShape() {
    return this.getSelectedSegment()?.shape || null
  }

  async setSelectedSegmentShape(shape) {
    const segment = this.getSelectedSegment()
    if (!segment || !segment.canChangeShape) return null
    return this.setPointShape(segment.startPointId, shape)
  }

  getBoundaryModeForNoteEntries(noteEntries = []) {
    const noteKeys = noteEntries
      .map((entry) => this._noteKeyByRef.get(entry?.note))
      .filter(Boolean)
    if (noteKeys.length === 0) return null
    const modes = noteKeys
      .map((noteKey) => this._noteControls.find((control) => control.noteKey === noteKey)?.boundaryMode)
      .filter(Boolean)
    if (modes.length === 0) return null
    return modes.every((mode) => mode === modes[0]) ? modes[0] : null
  }

  async setBoundaryModeForNoteEntries(noteEntries = [], mode) {
    if (!Object.values(PITCH_BOUNDARY_MODES).includes(mode)) return null
    const noteKeys = new Set(noteEntries
      .map((entry) => this._noteKeyByRef.get(entry?.note))
      .filter(Boolean))
    if (noteKeys.size === 0) return null

    const nextControls = this._cloneNoteControls(this._noteControls)
    let changed = false
    for (const control of nextControls) {
      if (!noteKeys.has(control.noteKey) || control.boundaryMode === mode) continue
      control.boundaryMode = mode
      changed = true
    }
    if (!changed) return null

    this.previewControlState(nextControls, {})
    return this.commitPreview(`boundary-mode:${mode}`)
  }

  getTuningStateForNoteEntries(noteEntries = []) {
    const entries = this._collectControlsForNoteEntries(noteEntries)
    if (entries.length === 0) {
      return {
        count: 0,
        value: null,
        mixed: false,
      }
    }
    const tunings = entries.map(({ note }) => (Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0))
    const value = resolveSharedValue(tunings, (candidate) => candidate)
    return {
      count: entries.length,
      value,
      mixed: value == null,
    }
  }

  async setTuningForNoteEntries(noteEntries = [], value) {
    if (!Number.isFinite(value)) return null
    return this._applyNoteMutationsForNoteEntries(noteEntries, () => ({
      tuning: clamp(Math.round(value), -100, 100),
    }), 'tuning')
  }

  getPortamentoStateForNoteEntries(noteEntries = []) {
    const entries = this._collectControlsForNoteEntries(noteEntries)
    if (entries.length === 0) {
      return {
        count: 0,
        simple: false,
        mixed: false,
        values: {
          start: null,
          length: null,
        },
      }
    }

    const portamentos = entries.map(({ control }) => this._extractPortamentoFromControl(control))
    const simple = portamentos.every(Boolean)
    const starts = simple ? portamentos.map((value) => Math.round(value.start)) : []
    const lengths = simple ? portamentos.map((value) => Math.round(value.length)) : []
    const start = simple ? resolveSharedValue(starts, (candidate) => candidate) : null
    const length = simple ? resolveSharedValue(lengths, (candidate) => candidate) : null

    return {
      count: entries.length,
      simple,
      mixed: !simple || start == null || length == null,
      values: {
        start,
        length,
      },
    }
  }

  async setPortamentoForNoteEntries(noteEntries = [], updates = {}) {
    const noteKeys = new Set((Array.isArray(noteEntries) ? noteEntries : [])
      .map((entry) => this._noteKeyByRef.get(entry?.note))
      .filter(Boolean))
    if (noteKeys.size === 0) return null

    const nextControls = this._cloneNoteControls(this._noteControls)
    let changed = false

    for (const control of nextControls) {
      if (!noteKeys.has(control.noteKey)) continue
      const current = this._extractPortamentoFromControl(control) || DEFAULT_PORTAMENTO
      const nextStart = Number.isFinite(updates?.start)
        ? clamp(Math.round(updates.start), -200, 200)
        : current.start
      const nextLength = Number.isFinite(updates?.length)
        ? clamp(Math.round(updates.length), 2, 320)
        : current.length
      if (!this._applyPortamentoToControl(control, {
        start: nextStart,
        length: nextLength,
      })) {
        continue
      }
      changed = true
    }

    if (!changed) return null
    this.previewControlState(nextControls, {})
    return this.commitPreview('portamento')
  }

  getVibratoStateForNoteEntries(noteEntries = []) {
    const entries = this._collectControlsForNoteEntries(noteEntries)
    if (entries.length === 0) {
      return {
        count: 0,
        enabled: false,
        mixed: false,
        values: {
          length: null,
          period: null,
          depth: null,
          in: null,
          out: null,
          shift: null,
          drift: null,
          volLink: null,
        },
      }
    }

    const vibratos = entries.map(({ note }) => createNormalizedVibrato(note?.vibrato))
    const enabledStates = vibratos.map((vibrato) => vibrato.length > 0)
    const enabled = enabledStates.every(Boolean)
      ? true
      : enabledStates.every((value) => !value)
        ? false
        : null
    const resolveSharedValue = (field) => vibratos.every((vibrato) => vibrato[field] === vibratos[0][field])
      ? vibratos[0][field]
      : null

    return {
      count: entries.length,
      enabled,
      mixed: enabled === null,
      values: {
        length: resolveSharedValue('length'),
        period: resolveSharedValue('period'),
        depth: resolveSharedValue('depth'),
        in: resolveSharedValue('in'),
        out: resolveSharedValue('out'),
        shift: resolveSharedValue('shift'),
        drift: resolveSharedValue('drift'),
        volLink: resolveSharedValue('volLink'),
      },
    }
  }

  async setVibratoEnabledForNoteEntries(noteEntries = [], enabled) {
    return this._applyNoteMutationsForNoteEntries(noteEntries, ({ note }) => {
      const nextVibrato = createNormalizedVibrato(note?.vibrato, { enabled })
      nextVibrato.length = enabled
        ? Math.max(1, nextVibrato.length || DEFAULT_VIBRATO.length)
        : 0
      return { vibrato: nextVibrato }
    }, enabled ? 'vibrato-enable' : 'vibrato-disable')
  }

  async setVibratoValueForNoteEntries(noteEntries = [], field, value) {
    if (!['length', 'period', 'depth', 'in', 'out', 'shift', 'drift', 'volLink'].includes(field) || !Number.isFinite(value)) return null
    return this.setVibratoValuesForNoteEntries(noteEntries, { [field]: value })
  }

  async setVibratoValuesForNoteEntries(noteEntries = [], values = {}) {
    const fields = Object.entries(values || {})
      .filter(([field, value]) => ['length', 'period', 'depth', 'in', 'out', 'shift', 'drift', 'volLink'].includes(field) && Number.isFinite(value))
    if (fields.length === 0) return null
    return this._applyNoteMutationsForNoteEntries(noteEntries, ({ note }) => {
      const current = createNormalizedVibrato(note?.vibrato, { enabled: true })
      fields.forEach(([field, value]) => {
        current[field] = Number(value)
      })
      const nextVibrato = createNormalizedVibrato(current, { enabled: current.length > 0 })
      return { vibrato: nextVibrato }
    }, `vibrato-${fields.map(([field]) => field).join('-')}`)
  }

  async addPointForNote(noteRef, timeSeconds, midiPitch) {
    const noteKey = this._noteKeyByRef.get(noteRef)
    if (!noteKey) return null

    const nextControls = this._cloneNoteControls(this._noteControls)
    const control = nextControls.find((entry) => entry.noteKey === noteKey)
    if (!control) return null

    const point = this._buildPointForControl(control, timeSeconds, midiPitch)
    const inserted = this._insertPointIntoControl(control, point)
    if (!inserted) return null

    this.previewControlState(nextControls, { selectedPointId: point.id })
    return this.commitPreview('add-point')
  }

  async deletePoint(pointId) {
    const nextControls = this._cloneNoteControls(this._noteControls)
    const pointRef = this._findPointRef(pointId, nextControls)
    if (!pointRef || pointRef.point.kind !== 'normal') return null

    pointRef.control.points.splice(pointRef.pointIndex, 1)
    this.previewControlState(nextControls, { selectedPointId: null, selectedSegmentId: null })
    return this.commitPreview('delete-point')
  }

  async deleteSelectedPoint() {
    if (!this.hasSelectedPoint()) return null
    return this.deletePoint(this._selectedPointId)
  }

  async setPointShape(pointId, shape) {
    if (!Object.values(PITCH_POINT_SHAPES).includes(shape)) return null

    const nextControls = this._cloneNoteControls(this._noteControls)
    const pointRef = this._findPointRef(pointId, nextControls)
    if (!pointRef || pointRef.pointIndex >= pointRef.control.points.length - 1) return null

    pointRef.point.shape = shape
    pointRef.point.source = 'user'
    this.previewControlState(nextControls, {
      selectedPointId: pointId,
      selectedSegmentId: this._resolveOutgoingSegmentId(pointId, nextControls),
    })
    return this.commitPreview('change-shape')
  }

  buildMovedState(baseControls, pointId, timeSeconds, midiPitch, pitchData = phraseStore.getPitchData()) {
    const nextControls = this._cloneNoteControls(baseControls)
    const pointRef = this._findPointRef(pointId, nextControls)
    if (!pointRef) {
      return { controls: nextControls, selectedPointId: null }
    }

    const { control, point, pointIndex } = pointRef
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const absoluteTick = this._clampTickToCurve(this.getTickForTime(timeSeconds, pitchData), pitchData)
    const minRel = point.kind === 'normal' && pointIndex > 0
      ? control.points[pointIndex - 1].relTick + step
      : point.kind === 'anchor-end'
        ? control.durationTick
        : 0
    const maxRel = point.kind === 'normal' && pointIndex < control.points.length - 1
      ? control.points[pointIndex + 1].relTick - step
      : point.kind === 'anchor-start'
        ? 0
        : control.durationTick
    const nextRelTick = point.kind === 'normal'
      ? clamp(Math.round(absoluteTick - control.startTick), Math.min(minRel, maxRel), Math.max(minRel, maxRel))
      : point.kind === 'anchor-start'
        ? 0
        : control.durationTick
    point.relTick = nextRelTick
    point.cent = clamp(Math.round((midiPitch - control.midi) * 100), PITCH_CENT_MIN, PITCH_CENT_MAX)
    if (point.kind === 'normal') point.source = 'user'

    return {
      controls: nextControls,
      selectedPointId: point.id,
      selectedSegmentId: this._resolveOutgoingSegmentId(point.id, nextControls),
    }
  }

  previewControlState(controls, options = {}) {
    this._noteControls = controls
    this._previewVersion += 1
    if (options.selectedPointId !== undefined) {
      this._selectedPointId = this._findDisplayPoint(options.selectedPointId, controls)
        ? options.selectedPointId
        : null
    } else {
      this._ensureSelectionStillExists()
    }
    if (options.selectedSegmentId !== undefined) {
      this._selectedSegmentId = this._findDisplaySegment(options.selectedSegmentId, controls)
        ? options.selectedSegmentId
        : this._resolveOutgoingSegmentId(this._selectedPointId, controls)
    } else {
      this._ensureSegmentSelectionStillExists()
    }
    this._emitSelectionChanged()

    const nextData = this._buildPitchDataFromControls(controls)
    phraseStore.previewPitchData(nextData)
    return nextData
  }

  async restoreRange(startTick, endTick) {
    if (!this.hasOriginalPitch()) return null
    const left = Math.min(startTick, endTick)
    const right = Math.max(startTick, endTick)
    const originalMap = new Map(this._originalNoteControls.map((control) => [control.noteKey, control]))
    const nextControls = this._noteControls.map((control) => {
      if (control.endTick < left || control.startTick > right) {
        return cloneControl(control)
      }
      return cloneControl(originalMap.get(control.noteKey) || control)
    })
    this.previewControlState(nextControls, { selectedPointId: null })
    return this.commitPreview('restore-range')
  }

  async restoreAll() {
    if (!this.hasOriginalPitch()) return null
    this.previewControlState(this._cloneNoteControls(this._originalNoteControls), { selectedPointId: null })
    return this.commitPreview('restore-all')
  }

  async commitPreview(reason = 'pitch-edit') {
    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')

    const currentPitchData = this._serverPitchData || phraseStore.getPitchData()
    const historySnapshot = this._captureCommittedSnapshot()
    if (historySnapshot?.noteControls && this._buildControlSignature(this._noteControls) !== this._buildControlSignature(historySnapshot.noteControls)) {
      this._pushUndoSnapshot(historySnapshot)
    }

    // 分流：纯 pitch 节点编辑（拖点 / 加点 / 删点 / 改形状）走 PITD 路径，
    // 只把 compiled deviation 写入后端的 PITD 曲线，note.pitch.data 保持不变。
    // 这样不会覆盖 DiffSinger 预测的精细 base curve，用户的微调呈现为"对该段
    // 自然曲线的小偏差"，符合局部编辑的直觉。
    //
    // 需要走 noteParams 的场景（会覆盖 note.pitch.data 重建 base）：
    //   - boundary-mode:*    结构性变 snapFirst / pitch.data 起手段
    //   - portamento         改 pitch.data 整体形态（2 点直线模式）
    //   - restore-range / restore-all  回到原始 pitch 形态，必须重建 pitch.data
    const kind = String(reason || '').split(':')[0]
    const pitchOnlyReasons = new Set([
      'pitch-edit', 'move-point', 'add-point', 'delete-point', 'change-shape',
    ])
    if (pitchOnlyReasons.has(kind)) {
      const compiled = this._buildCompiledDeviation(this._noteControls, currentPitchData)
      const payload = compiled.map((point) => ({ tick: point.tick, cent: point.cent }))
      return this._applyPitchDeviationPayload({
        jobId,
        payload,
        controls: this._cloneNoteControls(this._noteControls),
        selectedPointId: this._selectedPointId,
        selectedSegmentId: this._selectedSegmentId,
        currentPitchData,
        reason,
      })
    }

    const notePayload = this._buildNoteParamPayloadFromControls(this._noteControls)
    return this._applyNoteParamsPayload({
      jobId,
      notePayload,
      controls: this._cloneNoteControls(this._noteControls),
      selectedPointId: this._selectedPointId,
      selectedSegmentId: this._selectedSegmentId,
      currentPitchData,
      reason,
    })
  }

  getBasePitchAtTick(tick, pitchData = phraseStore.getPitchData()) {
    const curve = Array.isArray(pitchData?.pitchCurve) ? pitchData.pitchCurve : []
    if (curve.length === 0) return 60
    if (tick <= curve[0].tick) return curve[0].pitch
    if (tick >= curve[curve.length - 1].tick) return curve[curve.length - 1].pitch

    let lo = 0
    let hi = curve.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (curve[mid].tick <= tick) lo = mid
      else hi = mid
    }

    const left = curve[lo]
    const right = curve[hi]
    return this._interpolateLinear(left.tick, right.tick, left.pitch, right.pitch, tick)
  }

  getDeviationAtTick(tick, pitchData = phraseStore.getPitchData()) {
    const xs = Array.isArray(pitchData?.pitchDeviation?.xs) ? pitchData.pitchDeviation.xs : []
    const ys = Array.isArray(pitchData?.pitchDeviation?.ys) ? pitchData.pitchDeviation.ys : []
    if (xs.length === 0 || ys.length === 0) return 0
    if (tick <= xs[0]) return ys[0]
    if (tick >= xs[xs.length - 1]) return ys[ys.length - 1]

    let lo = 0
    let hi = xs.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (xs[mid] <= tick) lo = mid
      else hi = mid
    }
    return this._interpolateLinear(xs[lo], xs[hi], ys[lo], ys[hi], tick)
  }

  getFinalPitchAtTick(tick, pitchData = phraseStore.getPitchData()) {
    return this.getBasePitchAtTick(tick, pitchData) + this.getDeviationAtTick(tick, pitchData) / 100
  }

  _buildPointForControl(control, timeSeconds, midiPitch) {
    const pitchData = phraseStore.getPitchData()
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const absTick = this._clampTickToCurve(this.getTickForTime(timeSeconds, pitchData), pitchData)
    return {
      id: this._createPointId(),
      relTick: clamp(Math.round(absTick - control.startTick), step, Math.max(step, control.durationTick - step)),
      cent: clamp(Math.round((midiPitch - control.midi) * 100), PITCH_CENT_MIN, PITCH_CENT_MAX),
      shape: DEFAULT_SHAPE,
      kind: 'normal',
      source: 'user',
    }
  }

  _insertPointIntoControl(control, point) {
    const pitchData = phraseStore.getPitchData()
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const points = control.points
    let insertAt = points.findIndex((candidate) => candidate.relTick > point.relTick)
    if (insertAt === -1) insertAt = points.length - 1

    const previous = points[insertAt - 1]
    const next = points[insertAt]
    const minRel = previous ? previous.relTick + step : 0
    const maxRel = next ? next.relTick - step : control.durationTick
    if (maxRel < minRel) return false

    point.relTick = clamp(point.relTick, minRel, maxRel)
    if (points.some((candidate) => candidate.relTick === point.relTick)) return false

    points.splice(insertAt, 0, point)
    return true
  }

  _buildNoteControlsFromPitchData(pitchData) {
    const { noteEntries, noteKeyByRef } = this._buildNoteEntries(pitchData)
    this._noteKeyByRef = noteKeyByRef
    return noteEntries
      .map((entry) => this._buildControlForNote(entry, pitchData))
      .sort(compareControlsByTime)
  }

  _buildNoteEntries(pitchData = phraseStore.getPitchData()) {
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const noteEntries = []
    const noteKeyByRef = new WeakMap()

    for (const phrase of phraseStore.getPhrases()) {
      const notes = Array.isArray(phrase.notes) ? phrase.notes : []
      for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
        const note = notes[noteIndex]
        const rawStartTick = this.getTickForTime(note.time, pitchData)
        const rawEndTick = this.getTickForTime(note.time + note.duration, pitchData)
        const startTick = this._clampTickToCurve(Math.min(rawStartTick, rawEndTick), pitchData)
        const endTick = Math.max(startTick + step, this._clampTickToCurve(Math.max(rawStartTick, rawEndTick), pitchData))
        const entry = {
          noteKey: `${phrase.index}:${noteIndex}:${startTick}:${endTick - startTick}:${note.midi}`,
          phraseIndex: phrase.index,
          noteIndex,
          noteRef: note,
          startTick,
          endTick,
          durationTick: Math.max(step, endTick - startTick),
          midi: note.midi,
          startTime: note.time,
          endTime: note.time + note.duration,
        }
        noteEntries.push(entry)
        noteKeyByRef.set(note, entry.noteKey)
      }
    }

    return { noteEntries, noteKeyByRef }
  }

  _rebuildNoteKeyMap(controls = this._noteControls) {
    const noteKeyByRef = new WeakMap()
    const keyByLocation = new Map((Array.isArray(controls) ? controls : []).map((control) => [
      `${control.phraseIndex}:${control.noteIndex}`,
      control.noteKey,
    ]))
    for (const phrase of phraseStore.getPhrases()) {
      const notes = Array.isArray(phrase?.notes) ? phrase.notes : []
      for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
        const noteKey = keyByLocation.get(`${phrase.index}:${noteIndex}`)
        if (noteKey) {
          noteKeyByRef.set(notes[noteIndex], noteKey)
        }
      }
    }
    this._noteKeyByRef = noteKeyByRef
  }

  _buildControlForNote(noteEntry, pitchData) {
    const notePitch = noteEntry?.noteRef?.pitch
    if (Array.isArray(notePitch?.data) && notePitch.data.length > 0) {
      return this._buildControlFromNotePitch(noteEntry, pitchData)
    }
    const rawPoints = this._sampleNotePitch(noteEntry, pitchData)
    const simplified = this._simplifyNoteSamples(rawPoints)
    const startReferenceCent = clamp(Math.round(rawPoints[0]?.cent || 0), PITCH_CENT_MIN, PITCH_CENT_MAX)
    const endReferenceCent = clamp(
      Math.round(rawPoints[rawPoints.length - 1]?.cent || startReferenceCent),
      PITCH_CENT_MIN,
      PITCH_CENT_MAX,
    )

    return {
      noteKey: noteEntry.noteKey,
      phraseIndex: noteEntry.phraseIndex,
      noteIndex: noteEntry.noteIndex,
      startTick: noteEntry.startTick,
      endTick: noteEntry.endTick,
      durationTick: noteEntry.durationTick,
      midi: noteEntry.midi,
      startTime: noteEntry.startTime,
      endTime: noteEntry.endTime,
      boundaryMode: this._inferBoundaryMode(rawPoints),
      startReferenceCent,
      endReferenceCent,
      referenceSamples: rawPoints.map((point) => ({
        relTick: point.relTick,
        cent: clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX),
      })),
      points: simplified.map((point, index) => ({
        id: this._createPointId(),
        relTick: index === 0 ? 0 : index === simplified.length - 1 ? noteEntry.durationTick : point.relTick,
        cent: clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX),
        shape: point.shape || DEFAULT_SHAPE,
        kind: index === 0 ? 'anchor-start' : index === simplified.length - 1 ? 'anchor-end' : 'normal',
        source: index === 0 || index === simplified.length - 1 ? 'structural' : 'auto',
      })),
    }
  }

  _buildControlFromNotePitch(noteEntry, pitchData) {
    const rawPoints = this._sampleNotePitch(noteEntry, pitchData)
    const note = noteEntry?.noteRef || {}
    const tuning = Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0
    const noteDurationMs = Math.max(1, (noteEntry.endTime - noteEntry.startTime) * 1000)
    const mappedPoints = dedupeSortedPoints((Array.isArray(note?.pitch?.data) ? note.pitch.data : [])
      .map((point) => ({
        tick: Math.round((Number(point?.x || 0) / noteDurationMs) * noteEntry.durationTick),
        cent: clamp(Math.round(tuning + (Number(point?.y || 0) * 10)), PITCH_CENT_MIN, PITCH_CENT_MAX),
        shape: point?.shape || DEFAULT_SHAPE,
      }))
      .sort((left, right) => left.tick - right.tick))
      .map((point) => ({
        relTick: point.tick,
        cent: point.cent,
        shape: point.shape || DEFAULT_SHAPE,
      }))
    const points = mappedPoints.length > 0
      ? this._normalizeExplicitPitchPoints(mappedPoints, noteEntry.durationTick)
      : this._simplifyNoteSamples(rawPoints)
    const startReferenceCent = clamp(Math.round(points[0]?.cent ?? rawPoints[0]?.cent ?? 0), PITCH_CENT_MIN, PITCH_CENT_MAX)
    const endReferenceCent = clamp(
      Math.round(points[points.length - 1]?.cent ?? rawPoints[rawPoints.length - 1]?.cent ?? startReferenceCent),
      PITCH_CENT_MIN,
      PITCH_CENT_MAX,
    )

    return {
      noteKey: noteEntry.noteKey,
      phraseIndex: noteEntry.phraseIndex,
      noteIndex: noteEntry.noteIndex,
      startTick: noteEntry.startTick,
      endTick: noteEntry.endTick,
      durationTick: noteEntry.durationTick,
      midi: noteEntry.midi,
      startTime: noteEntry.startTime,
      endTime: noteEntry.endTime,
      boundaryMode: note?.pitch?.snapFirst === false ? PITCH_BOUNDARY_MODES.GLIDE : PITCH_BOUNDARY_MODES.SNAP,
      startReferenceCent,
      endReferenceCent,
      referenceSamples: rawPoints.map((point) => ({
        relTick: point.relTick,
        cent: clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX),
      })),
      points: points.map((point, index) => ({
        id: this._createPointId(),
        relTick: point.relTick,
        cent: clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX),
        shape: point.shape || DEFAULT_SHAPE,
        kind: index === 0 ? 'anchor-start' : index === points.length - 1 ? 'anchor-end' : 'normal',
        source: index === 0 || index === points.length - 1 ? 'structural' : 'user',
      })),
    }
  }

  _sampleNotePitch(noteEntry, pitchData) {
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const samples = []
    for (let tick = noteEntry.startTick; tick < noteEntry.endTick; tick += step) {
      samples.push({
        relTick: tick - noteEntry.startTick,
        cent: Math.round((this.getFinalPitchAtTick(tick, pitchData) - noteEntry.midi) * 100),
      })
    }
    samples.push({
      relTick: noteEntry.durationTick,
      cent: Math.round((this.getFinalPitchAtTick(noteEntry.endTick, pitchData) - noteEntry.midi) * 100),
    })
    return dedupeSortedPoints(samples.map((sample) => ({
      tick: sample.relTick,
      cent: sample.cent,
    }))).map((sample) => ({
      relTick: sample.tick,
      cent: sample.cent,
      shape: DEFAULT_SHAPE,
    }))
  }

  _simplifyNoteSamples(rawPoints) {
    const base = rawPoints.map((point) => ({
      relTick: point.relTick,
      cent: point.cent,
      shape: DEFAULT_SHAPE,
    }))
    if (base.length <= 2) {
      return this._ensureBoundaryPoints(base)
    }

    let epsilon = NOTE_SIMPLIFY_EPSILON
    let simplified = base
    while (epsilon <= 64) {
      simplified = this._simplifyShapePoints(base, epsilon)
      if (simplified.length <= NOTE_SIMPLIFY_MAX_POINTS) break
      epsilon += 4
    }
    simplified = this._mergeSupportPoints(base, simplified)
    return this._ensureBoundaryPoints(simplified)
  }

  _simplifyShapePoints(points, epsilon) {
    if (points.length <= 2) return points.map((point) => ({ ...point }))

    const recurse = (segment) => {
      if (segment.length <= 2) {
        return segment.map((point) => ({ ...point }))
      }

      const start = segment[0]
      const end = segment[segment.length - 1]
      const middle = segment[Math.floor(segment.length / 2)]
      const shape = this._determineShape(start, middle, end)

      let maxDistance = 0
      let splitIndex = 0
      for (let index = 1; index < segment.length - 1; index += 1) {
        const candidate = segment[index]
        const distance = Math.abs(
          candidate.cent - this._interpolateShape(start.relTick, end.relTick, start.cent, end.cent, candidate.relTick, shape),
        )
        if (distance > maxDistance) {
          maxDistance = distance
          splitIndex = index
        }
      }

      if (maxDistance > epsilon) {
        const left = recurse(segment.slice(0, splitIndex + 1))
        const right = recurse(segment.slice(splitIndex))
        return left.slice(0, -1).concat(right)
      }

      return [{
        relTick: start.relTick,
        cent: start.cent,
        shape,
      }]
    }

    const simplified = recurse(points)
    const last = { ...points[points.length - 1], shape: DEFAULT_SHAPE }
    if (simplified.length === 0 || simplified[simplified.length - 1].relTick !== last.relTick) {
      simplified.push(last)
    } else {
      simplified[simplified.length - 1].cent = last.cent
      simplified[simplified.length - 1].shape = DEFAULT_SHAPE
    }
    return simplified
  }

  _ensureBoundaryPoints(points) {
    if (points.length === 0) {
      return [
        { relTick: 0, cent: 0, shape: DEFAULT_SHAPE },
        { relTick: 5, cent: 0, shape: DEFAULT_SHAPE },
      ]
    }
    if (points.length === 1) {
      return [
        { ...points[0], relTick: 0 },
        { ...points[0], relTick: Math.max(5, points[0].relTick), shape: DEFAULT_SHAPE },
      ]
    }
    return points.map((point, index) => ({
      ...point,
      shape: index === points.length - 1 ? DEFAULT_SHAPE : point.shape || DEFAULT_SHAPE,
    }))
  }

  _normalizeExplicitPitchPoints(points, durationTick) {
    if (!Array.isArray(points) || points.length === 0) {
      return this._ensureBoundaryPoints([])
    }
    if (points.length === 1) {
      const single = {
        ...points[0],
        shape: points[0].shape || DEFAULT_SHAPE,
      }
      return [
        single,
        {
          ...single,
          relTick: single.relTick + Math.max(1, Math.round((durationTick || 1) / 8)),
          shape: DEFAULT_SHAPE,
        },
      ]
    }
    return points.map((point, index) => ({
      ...point,
      shape: index === points.length - 1 ? DEFAULT_SHAPE : point.shape || DEFAULT_SHAPE,
    }))
  }

  _inferBoundaryMode(rawPoints) {
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) return DEFAULT_BOUNDARY_MODE
    const startCent = rawPoints[0].cent || 0
    if (Math.abs(startCent) <= 15) return PITCH_BOUNDARY_MODES.SNAP

    const sampleCount = Math.min(rawPoints.length, 4)
    const early = rawPoints.slice(0, sampleCount).map((point) => point.cent)
    const earlyRange = Math.max(...early) - Math.min(...early)
    if (Math.abs(startCent) > 20 && earlyRange <= 12) {
      return PITCH_BOUNDARY_MODES.HOLD
    }
    return PITCH_BOUNDARY_MODES.GLIDE
  }

  _getRenderableControlPoints(control, controls = this._noteControls) {
    const points = control.points.map((point) => ({
      ...clonePoint(point),
      source: point.source || (point.kind === 'normal' ? 'auto' : 'structural'),
    }))
    if (points.length === 0) return points

    const startAnchor = points[0]
    const endAnchor = points[points.length - 1]
    startAnchor.cent = this._getBoundaryStartCent(control, controls)
    startAnchor.source = 'structural'
    endAnchor.cent = Number.isFinite(control.endReferenceCent) ? control.endReferenceCent : endAnchor.cent
    endAnchor.source = 'structural'

    if ((control.boundaryMode || DEFAULT_BOUNDARY_MODE) === PITCH_BOUNDARY_MODES.HOLD && points.length > 1) {
      const holdPoint = this._buildVirtualHoldPoint(control, points[1], startAnchor.cent)
      if (holdPoint) {
        points.splice(1, 0, holdPoint)
      }
    }
    return points
  }

  _getBoundaryStartCent(control, controls = this._noteControls) {
    const mode = control.boundaryMode || DEFAULT_BOUNDARY_MODE
    if (mode === PITCH_BOUNDARY_MODES.SNAP) return 0
    if (mode === PITCH_BOUNDARY_MODES.HOLD) {
      const previous = this._getPreviousControl(control, controls)
      if (previous && control.startTick - previous.endTick <= this.snapTick(HOLD_BOUNDARY_MAX_TICK)) {
        const previousEndCent = Number.isFinite(previous.endReferenceCent)
          ? previous.endReferenceCent
          : previous.points[previous.points.length - 1]?.cent || 0
        return clamp(
          Math.round(previous.midi * 100 + previousEndCent - control.midi * 100),
          PITCH_CENT_MIN,
          PITCH_CENT_MAX,
        )
      }
    }
    return Number.isFinite(control.startReferenceCent) ? control.startReferenceCent : (control.points[0]?.cent || 0)
  }

  _buildVirtualHoldPoint(control, firstEditablePoint, startCent) {
    const pitchData = phraseStore.getPitchData()
    const step = Number.isFinite(pitchData?.pitchStepTick) ? pitchData.pitchStepTick : 5
    const holdRelTick = clamp(
      Math.round((control.durationTick * HOLD_BOUNDARY_RATIO) / step) * step,
      step * 2,
      Math.max(step * 2, Math.min(control.durationTick - step, HOLD_BOUNDARY_MAX_TICK)),
    )
    if (!Number.isFinite(holdRelTick) || holdRelTick <= step) return null
    if (!firstEditablePoint || firstEditablePoint.relTick <= holdRelTick + step) return null
    return {
      id: `virtual-hold:${control.noteKey}`,
      relTick: holdRelTick,
      cent: startCent,
      shape: DEFAULT_SHAPE,
      kind: 'anchor-hold',
      source: 'structural',
      virtual: true,
    }
  }

  _getPreviousControl(control, controls = this._noteControls) {
    const ordered = Array.isArray(controls) ? controls : []
    const index = ordered.findIndex((candidate) => candidate.noteKey === control.noteKey)
    if (index <= 0) return null
    return ordered[index - 1] || null
  }

  _getReferenceSamples(control) {
    if (Array.isArray(control.referenceSamples) && control.referenceSamples.length > 0) {
      return control.referenceSamples
    }
    return control.points.map((point) => ({
      relTick: point.relTick,
      cent: point.cent,
    }))
  }

  _getReferenceCentAtRelTick(control, relTick) {
    const samples = this._getReferenceSamples(control)
    if (samples.length === 0) return 0
    if (relTick <= samples[0].relTick) return samples[0].cent
    if (relTick >= samples[samples.length - 1].relTick) return samples[samples.length - 1].cent

    let lo = 0
    let hi = samples.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (samples[mid].relTick <= relTick) lo = mid
      else hi = mid
    }
    return this._interpolateLinear(
      samples[lo].relTick,
      samples[hi].relTick,
      samples[lo].cent,
      samples[hi].cent,
      relTick,
    )
  }

  _mergeSupportPoints(rawPoints, simplifiedPoints) {
    const sorted = simplifiedPoints
      .map((point) => ({ ...point, shape: point.shape || DEFAULT_SHAPE }))
      .sort((left, right) => left.relTick - right.relTick)

    if (rawPoints.length < SUPPORT_POINT_MIN_RAW_SAMPLES) {
      return sorted
    }

    const existingTicks = new Set(sorted.map((point) => point.relTick))
    const supportCandidates = this._collectSupportSamples(rawPoints)
    let extras = 0

    for (const candidate of supportCandidates) {
      if (extras >= SUPPORT_POINT_MAX_EXTRA) break
      if (existingTicks.has(candidate.relTick)) continue

      const nearestGap = sorted.reduce((best, point) => (
        Math.min(best, Math.abs(point.relTick - candidate.relTick))
      ), Infinity)
      if (nearestGap < SUPPORT_POINT_MIN_GAP_TICK) continue

      sorted.push({
        relTick: candidate.relTick,
        cent: candidate.cent,
        shape: DEFAULT_SHAPE,
      })
      existingTicks.add(candidate.relTick)
      extras += 1
    }

    sorted.sort((left, right) => left.relTick - right.relTick)
    return sorted
  }

  _collectSupportSamples(rawPoints) {
    const candidates = []
    const fractions = rawPoints.length >= 9 ? [0.25, 0.5, 0.75] : [0.5]
    for (const fraction of fractions) {
      const sample = rawPoints[Math.round((rawPoints.length - 1) * fraction)]
      if (sample) candidates.push(sample)
    }

    const extrema = []
    for (let index = 1; index < rawPoints.length - 1; index += 1) {
      const previous = rawPoints[index - 1]
      const current = rawPoints[index]
      const next = rawPoints[index + 1]
      const prevDelta = current.cent - previous.cent
      const nextDelta = next.cent - current.cent
      if ((prevDelta > 0 && nextDelta < 0) || (prevDelta < 0 && nextDelta > 0)) {
        extrema.push({
          relTick: current.relTick,
          cent: current.cent,
          prominence: Math.max(Math.abs(prevDelta), Math.abs(nextDelta)),
        })
      }
    }

    extrema
      .sort((left, right) => right.prominence - left.prominence)
      .slice(0, 2)
      .forEach((point) => {
        candidates.push({
          relTick: point.relTick,
          cent: point.cent,
        })
      })

    return dedupeSortedPoints(candidates
      .map((point) => ({
        tick: point.relTick,
        cent: point.cent,
      }))
      .sort((left, right) => left.tick - right.tick))
      .map((point) => ({
        relTick: point.tick,
        cent: point.cent,
      }))
  }

  _determineShape(start, middle, end) {
    if (Math.abs(end.cent - start.cent) < EPSILON) {
      return PITCH_POINT_SHAPES.LINEAR
    }
    const ratio = (middle.cent - start.cent) / (end.cent - start.cent)
    if (ratio > 0.67) return PITCH_POINT_SHAPES.OUT
    if (ratio < 0.33) return PITCH_POINT_SHAPES.IN
    return PITCH_POINT_SHAPES.IN_OUT
  }

  _buildCompiledDeviation(controls, pitchData = phraseStore.getPitchData()) {
    const compiled = []
    for (const control of controls) {
      const notePoints = this._compileNoteDeviation(control, pitchData, controls)
      for (const point of notePoints) {
        compiled.push(point)
      }
    }
    return this._normalizeDeviationPoints(compiled)
  }

  _compileNoteDeviation(control, pitchData, controls = this._noteControls) {
    const compiled = []
    const points = this._getRenderableControlPoints(control, controls)
    const referenceSamples = this._getReferenceSamples(control)
    if (points.length < 2 || referenceSamples.length === 0) return compiled

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (end.relTick <= start.relTick) continue

      const startDelta = start.cent - this._getReferenceCentAtRelTick(control, start.relTick)
      const endDelta = end.cent - this._getReferenceCentAtRelTick(control, end.relTick)
      const segmentSamples = referenceSamples.filter((sample) => sample.relTick >= start.relTick && sample.relTick <= end.relTick)
      if (segmentSamples.length === 0) continue

      for (const sample of segmentSamples) {
        const delta = start.shape === PITCH_POINT_SHAPES.LINEAR
          ? this._interpolateLinear(start.relTick, end.relTick, startDelta, endDelta, sample.relTick)
          : this._interpolateShape(start.relTick, end.relTick, startDelta, endDelta, sample.relTick, start.shape)
        // 坐标系转换：sample.cent 是"相对 note.midi 的 cent 偏差"（UI 友好），
        // 但 PITD 的物理意义是"相对 pitchesBeforeDeviation 的 cent 偏差"。
        // 在 note 内部两者等价（pitchesBeforeDeviation ≈ note.midi * 100），
        // 但在 note 边界，pitchesBeforeDeviation 会从 A.midi*100 跳到 B.midi*100。
        // 如果直接发 sample.cent 作为 PITD，在 A 和 B 高度不同的边界处会错位
        // (B.midi - A.midi) * 100 cent，视觉上就是"所有有高度差的音符边缘被制造
        // 峰谷"。这里把 cent 转换到 base 坐标系：compiled = sample.cent - (base
        // 相对 note.midi 的 cent 偏移)，等价于"final - base"，即正确的 PITD 值。
        const absoluteTick = control.startTick + sample.relTick
        const basePitch = this.getBasePitchAtTick(absoluteTick, pitchData)
        const baseCentOffset = (basePitch - control.midi) * 100
        this._pushCompiledPoint(
          compiled,
          absoluteTick,
          sample.cent + delta - baseCentOffset,
        )
      }
    }

    return this._normalizeDeviationPoints(compiled)
  }

  _simplifyLinearDeviationPoints(points, epsilon) {
    if (points.length <= 2) return points

    const recurse = (segment) => {
      if (segment.length <= 2) return segment
      const start = segment[0]
      const end = segment[segment.length - 1]
      let maxDistance = 0
      let splitIndex = 0

      for (let index = 1; index < segment.length - 1; index += 1) {
        const candidate = segment[index]
        const distance = Math.abs(candidate.cent - this._interpolateLinear(start.tick, end.tick, start.cent, end.cent, candidate.tick))
        if (distance > maxDistance) {
          maxDistance = distance
          splitIndex = index
        }
      }

      if (maxDistance > epsilon) {
        const left = recurse(segment.slice(0, splitIndex + 1))
        const right = recurse(segment.slice(splitIndex))
        return left.slice(0, -1).concat(right)
      }

      return [start, end]
    }

    return dedupeSortedPoints(recurse(points))
  }

  _buildPitchDataFromControls(controls) {
    const current = this._clonePitchData(this._serverPitchData || phraseStore.getPitchData()) || {
      pitchCurve: [],
      pitchDeviation: { xs: [], ys: [] },
      midiPpq: 480,
      pitchStepTick: 5,
    }

    // Preview 直接走全量重算，和 commit 时 `_buildCompiledDeviation(all controls)`
    // 完全同语义，避免增量合并在相邻 note 边界（A.endTick == B.startTick）处
    // 归属不一致造成的"拖动时峰谷跳高、commit 后又恢复"的视觉跳动。
    // 代价：每个 preview tick 全量重算，N 个 note × ~100 sample ≈ 几 ms，可接受。
    const deviation = this._buildCompiledDeviation(controls, current)
    current.pitchDeviation = {
      xs: deviation.map((point) => point.tick),
      ys: deviation.map((point) => point.cent),
    }
    return current
  }

  _normalizeDeviationPoints(points) {
    const map = new Map()
    for (const point of points) {
      if (!Number.isFinite(point?.tick) || !Number.isFinite(point?.cent)) continue
      map.set(Math.round(point.tick), clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX))
    }
    return [...map.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([tick, cent]) => ({ tick, cent }))
  }

  _resolveNoteForControl(control, phrases = phraseStore.getPhrases()) {
    const phrase = (Array.isArray(phrases) ? phrases : []).find((entry) => entry?.index === control?.phraseIndex)
    if (!phrase) return null
    const notes = Array.isArray(phrase?.notes) ? phrase.notes : []
    return notes[control.noteIndex] || null
  }

  _buildNoteMetaForControl(control, phrases = phraseStore.getPhrases()) {
    const note = this._resolveNoteForControl(control, phrases)
    return {
      tuning: Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0,
      vibrato: createNormalizedVibrato(note?.vibrato),
    }
  }

  _captureNoteMetaByKey(controls = this._noteControls, phrases = phraseStore.getPhrases()) {
    return new Map((Array.isArray(controls) ? controls : []).map((control) => [
      control.noteKey,
      this._buildNoteMetaForControl(control, phrases),
    ]))
  }

  _extractPortamentoFromControl(control) {
    if (!control || !Array.isArray(control.points) || control.points.length !== 2) return null
    const [startPoint, endPoint] = control.points
    if (!startPoint || !endPoint) return null
    const start = this._convertRelTickToMilliseconds(control, startPoint.relTick)
    const end = this._convertRelTickToMilliseconds(control, endPoint.relTick)
    return {
      start: Math.round(start),
      length: Math.max(2, Math.round(end - start)),
    }
  }

  _applyPortamentoToControl(control, portamento = {}) {
    if (!control) return false
    const start = Number.isFinite(portamento?.start)
      ? clamp(Math.round(portamento.start), -200, 200)
      : DEFAULT_PORTAMENTO.start
    const length = Number.isFinite(portamento?.length)
      ? clamp(Math.round(portamento.length), 2, 320)
      : DEFAULT_PORTAMENTO.length
    const startRelTick = this._convertMillisecondsToRelTick(control, start)
    let endRelTick = this._convertMillisecondsToRelTick(control, start + length)
    if (endRelTick <= startRelTick) endRelTick = startRelTick + 1

    const nextPoints = [
      {
        id: this._createPointId(),
        relTick: startRelTick,
        cent: 0,
        shape: DEFAULT_SHAPE,
        kind: 'anchor-start',
        source: 'structural',
      },
      {
        id: this._createPointId(),
        relTick: endRelTick,
        cent: 0,
        shape: DEFAULT_SHAPE,
        kind: 'anchor-end',
        source: 'structural',
      },
    ]

    const unchanged = Array.isArray(control.points)
      && control.points.length === 2
      && control.points.every((point, index) => (
        point?.relTick === nextPoints[index].relTick
          && (point?.cent || 0) === nextPoints[index].cent
          && (point?.shape || DEFAULT_SHAPE) === nextPoints[index].shape
          && point?.kind === nextPoints[index].kind
      ))
      && (control.boundaryMode || DEFAULT_BOUNDARY_MODE) === PITCH_BOUNDARY_MODES.SNAP
      && (control.startReferenceCent || 0) === 0
      && (control.endReferenceCent || 0) === 0
    if (unchanged) return false

    control.points = nextPoints
    control.boundaryMode = PITCH_BOUNDARY_MODES.SNAP
    control.startReferenceCent = 0
    control.endReferenceCent = 0
    return true
  }

  _collectControlsForNoteEntries(noteEntries = []) {
    const noteKeys = new Set((Array.isArray(noteEntries) ? noteEntries : [])
      .map((entry) => this._noteKeyByRef.get(entry?.note))
      .filter(Boolean))
    if (noteKeys.size === 0) return []

    return this._noteControls
      .filter((control) => noteKeys.has(control.noteKey))
      .map((control) => ({
        control,
        note: this._resolveNoteForControl(control),
      }))
      .filter((entry) => Boolean(entry.note))
  }

  _captureNoteParamState(note) {
    return {
      tuning: Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0,
      vibrato: createNormalizedVibrato(note?.vibrato),
    }
  }

  _restoreNoteParamState(note, snapshot) {
    if (!note || !snapshot) return
    note.tuning = snapshot.tuning
    note.vibrato = cloneVibrato(snapshot.vibrato)
  }

  async _applyNoteMutationsForNoteEntries(noteEntries = [], updateNote, reason) {
    const selected = this._collectControlsForNoteEntries(noteEntries)
    if (selected.length === 0 || typeof updateNote !== 'function') return null

    const rollback = []
    const changedKeys = new Set()

    for (const entry of selected) {
      const snapshot = this._captureNoteParamState(entry.note)
      const nextState = updateNote(entry) || {}
      let changed = false

      if (Object.prototype.hasOwnProperty.call(nextState, 'tuning')) {
        const nextTuning = Number.isFinite(nextState.tuning) ? Math.round(nextState.tuning) : 0
        if ((entry.note?.tuning || 0) !== nextTuning) {
          entry.note.tuning = nextTuning
          changed = true
        }
      }

      if (Object.prototype.hasOwnProperty.call(nextState, 'vibrato')) {
        const nextVibrato = createNormalizedVibrato(nextState.vibrato, {
          enabled: Number(nextState?.vibrato?.length) > 0,
        })
        if (buildVibratoSignature(entry.note?.vibrato) !== buildVibratoSignature(nextVibrato)) {
          entry.note.vibrato = nextVibrato
          changed = true
        }
      }

      if (changed) {
        rollback.push({
          note: entry.note,
          snapshot,
        })
        changedKeys.add(entry.control.noteKey)
      }
    }

    if (changedKeys.size === 0) return null

    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })

    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')

    const notePayload = this._buildNoteParamPayloadFromControls(this._noteControls, { targetNoteKeys: changedKeys })
    if (notePayload.length === 0) {
      rollback.forEach(({ note, snapshot }) => this._restoreNoteParamState(note, snapshot))
      eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })
      return null
    }

    try {
      return await this._applyNoteParamsPayload({
        jobId,
        notePayload,
        controls: this._cloneNoteControls(this._noteControls),
        selectedPointId: this._selectedPointId,
        selectedSegmentId: this._selectedSegmentId,
        currentPitchData: this._serverPitchData || phraseStore.getPitchData(),
        reason,
      })
    } catch (error) {
      rollback.forEach(({ note, snapshot }) => this._restoreNoteParamState(note, snapshot))
      eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })
      throw error
    }
  }

  _buildControlSignature(controls = []) {
    return (Array.isArray(controls) ? controls : [])
      .map((control) => {
        const points = control.points
          .map((point) => `${point.relTick}:${point.cent}:${point.shape}:${point.kind}`)
          .join(',')
        return [
          control.noteKey,
          control.boundaryMode || DEFAULT_BOUNDARY_MODE,
          control.startReferenceCent || 0,
          control.endReferenceCent || 0,
          points,
        ].join('|')
      })
      .join('||')
  }

  _convertRelTickToMilliseconds(control, relTick) {
    const durationMs = Math.max(1, (control.endTime - control.startTime) * 1000)
    if (!Number.isFinite(control.durationTick) || control.durationTick <= 0) return 0
    return (Number(relTick || 0) / control.durationTick) * durationMs
  }

  _convertMillisecondsToRelTick(control, milliseconds) {
    const durationMs = Math.max(1, (control.endTime - control.startTime) * 1000)
    if (!Number.isFinite(control.durationTick) || control.durationTick <= 0) return 0
    return Math.round((Number(milliseconds || 0) / durationMs) * control.durationTick)
  }

  _buildPitchPayloadForControl(control, note, controls = this._noteControls) {
    const tuning = Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0
    const points = this._getRenderableControlPoints(control, controls)
      .map((point, index, list) => ({
        x: this._convertRelTickToMilliseconds(control, point.relTick),
        y: (clamp(Math.round(point.cent), PITCH_CENT_MIN, PITCH_CENT_MAX) - tuning) / 10,
        shape: index === list.length - 1 ? DEFAULT_SHAPE : (point.shape || DEFAULT_SHAPE),
      }))
    return {
      snapFirst: (control.boundaryMode || DEFAULT_BOUNDARY_MODE) === PITCH_BOUNDARY_MODES.SNAP,
      data: points,
    }
  }

  _buildNoteParamPayloadFromControls(controls = this._noteControls, options = {}) {
    const baselineMap = new Map(this._serverNoteControls.map((control) => [control.noteKey, control]))
    const targetNoteKeys = options?.targetNoteKeys instanceof Set
      ? options.targetNoteKeys
      : Array.isArray(options?.targetNoteKeys)
        ? new Set(options.targetNoteKeys)
        : null
    const payload = []
    for (const control of controls) {
      if (targetNoteKeys && !targetNoteKeys.has(control.noteKey)) continue
      const note = this._resolveNoteForControl(control)
      if (!note) continue

      const baselineMeta = this._serverNoteMetaByKey.get(control.noteKey) || {
        tuning: 0,
        vibrato: createNormalizedVibrato(null),
      }
      const tuning = Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0
      const vibrato = createNormalizedVibrato(note?.vibrato)
      const pitchChanged = !areControlsEquivalent(control, baselineMap.get(control.noteKey))
      const tuningChanged = tuning !== baselineMeta.tuning
      const vibratoChanged = buildVibratoSignature(vibrato) !== buildVibratoSignature(baselineMeta.vibrato)
      if (!pitchChanged && !tuningChanged && !vibratoChanged) continue

      const entry = {
        position: Number.isFinite(note?.tick) ? Math.max(0, Math.round(note.tick)) : control.startTick,
        duration: Number.isFinite(note?.durationTicks) ? Math.max(1, Math.round(note.durationTicks)) : Math.max(1, control.durationTick),
        tone: Number.isFinite(note?.midi) ? Math.round(note.midi) : control.midi,
        clearPitchDeviation: pitchChanged,
      }
      if (pitchChanged || tuningChanged) {
        entry.tuning = tuning
      }
      if (pitchChanged) {
        entry.pitch = this._buildPitchPayloadForControl(control, note, controls)
      }
      if (vibratoChanged) {
        entry.vibrato = {
          length: vibrato.length,
          period: vibrato.period,
          depth: vibrato.depth,
          in: vibrato.in,
          out: vibrato.out,
          shift: vibrato.shift,
          drift: vibrato.drift,
          volLink: vibrato.volLink,
        }
      }
      payload.push(entry)
    }
    return payload
  }

  _pushCompiledPoint(points, tick, cent) {
    const roundedTick = Math.round(tick)
    const nextPoint = {
      tick: roundedTick,
      cent: clamp(Math.round(cent), PITCH_CENT_MIN, PITCH_CENT_MAX),
    }
    if (points.length > 0 && points[points.length - 1].tick === roundedTick) {
      points[points.length - 1] = nextPoint
    } else {
      points.push(nextPoint)
    }
  }

  _interpolateShape(x0, x1, y0, y1, x, shape) {
    if (x1 - x0 < EPSILON) return y1
    const t = clamp((x - x0) / (x1 - x0), 0, 1)

    if (shape === PITCH_POINT_SHAPES.IN_OUT) {
      return y0 + (y1 - y0) * (1 - Math.cos(t * Math.PI)) / 2
    }
    if (shape === PITCH_POINT_SHAPES.IN) {
      return y0 + (y1 - y0) * (1 - Math.cos(t * Math.PI / 2))
    }
    if (shape === PITCH_POINT_SHAPES.OUT) {
      return y0 + (y1 - y0) * Math.sin(t * Math.PI / 2)
    }
    return this._interpolateLinear(x0, x1, y0, y1, x)
  }

  _interpolateLinear(x0, x1, y0, y1, x) {
    if (x1 - x0 < EPSILON) return y1
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
  }

  _getAffectedPhraseIndices(controls = this._noteControls) {
    const baselineMap = new Map(this._serverNoteControls.map((control) => [control.noteKey, control]))
    const changedRanges = controls
      .filter((control) => !areControlsEquivalent(control, baselineMap.get(control.noteKey)))
      .map((control) => ({
        startTick: control.startTick,
        endTick: control.endTick,
      }))

    if (changedRanges.length === 0) return []

    const affected = []
    for (const phrase of phraseStore.getPhrases()) {
      const phraseStartTick = this.getTickForTime(phrase.startTime)
      const phraseEndTick = this.getTickForTime(phrase.endTime)
      if (changedRanges.some((range) => range.endTick >= phraseStartTick && range.startTick <= phraseEndTick)) {
        affected.push(phrase.index)
      }
    }
    return [...new Set(affected)].sort((left, right) => left - right)
  }

  _getAffectedPhraseIndicesForNotePayload(notePayload = []) {
    if (!Array.isArray(notePayload) || notePayload.length === 0) return []
    const ranges = notePayload
      .map((note) => ({
        startTick: Number.isFinite(note?.position) ? Math.max(0, Math.round(note.position)) : 0,
        endTick: Number.isFinite(note?.position) && Number.isFinite(note?.duration)
          ? Math.max(0, Math.round(note.position + note.duration))
          : 0,
      }))
      .filter((range) => range.endTick >= range.startTick)
    if (ranges.length === 0) return []

    const affected = []
    for (const phrase of phraseStore.getPhrases()) {
      const phraseStartTick = this.getTickForTime(phrase.startTime)
      const phraseEndTick = this.getTickForTime(phrase.endTime)
      if (ranges.some((range) => range.endTick >= phraseStartTick && range.startTick <= phraseEndTick)) {
        affected.push(phrase.index)
      }
    }
    return [...new Set(affected)].sort((left, right) => left - right)
  }

  _buildRenderVersion(payload) {
    let hash = 2166136261
    for (const point of payload) {
      hash ^= Number.isFinite(point?.tick) ? Math.round(point.tick) : 0
      hash = Math.imul(hash, 16777619)
      hash ^= Number.isFinite(point?.cent) ? Math.round(point.cent) : 0
      hash = Math.imul(hash, 16777619)
    }
    return `${payload.length.toString(36)}-${(hash >>> 0).toString(36)}`
  }

  _prioritizeDirtyPhrase() {
    if (!audioEngine.isPlaying()) return
    const phraseIndex = renderPriorityStrategy.getNextPriority(audioEngine.getSongTime())
    if (!Number.isInteger(phraseIndex)) return
    renderScheduler.prioritize(phraseIndex)
  }

  _findPointRef(pointId, controls = this._noteControls) {
    for (const control of controls) {
      const pointIndex = control.points.findIndex((point) => point.id === pointId)
      if (pointIndex >= 0) {
        return {
          control,
          point: control.points[pointIndex],
          pointIndex,
        }
      }
    }
    return null
  }

  _findDisplayPoint(pointId, controls = this._noteControls) {
    return this.getDisplayPoints(controls, { includeAnchors: true }).find((point) => point.id === pointId) || null
  }

  _findDisplaySegment(segmentId, controls = this._noteControls) {
    if (!segmentId) return null
    return this.getDisplaySegments(controls).find((segment) => segment.id === segmentId) || null
  }

  _buildSegmentId(noteKey, startPointId, endPointId) {
    return `pitch-segment:${noteKey}:${startPointId}:${endPointId}`
  }

  _resolveOutgoingSegmentId(pointId, controls = this._noteControls) {
    if (!pointId) return null
    const segment = this.getDisplaySegments(controls).find((candidate) => candidate.startPointId === pointId)
    return segment?.id || null
  }

  _ensureSelectionStillExists() {
    if (!this.hasSelectedPoint()) return
    if (!this._findDisplayPoint(this._selectedPointId)) {
      this._selectedPointId = null
    }
  }

  _ensureSegmentSelectionStillExists() {
    if (!this.hasSelectedSegment()) {
      this._selectedSegmentId = this._resolveOutgoingSegmentId(this._selectedPointId)
      return
    }
    if (!this._findDisplaySegment(this._selectedSegmentId)) {
      this._selectedSegmentId = this._resolveOutgoingSegmentId(this._selectedPointId)
    }
  }

  _emitSelectionChanged() {
    const nextKey = `${this._selectedPointId || ''}|${this._selectedSegmentId || ''}`
    if (nextKey === this._selectionEventKey) return
    this._selectionEventKey = nextKey
    eventBus.emit(EVENTS.PITCH_EDITOR_SELECTION_CHANGED, {
      pointId: this._selectedPointId,
      segmentId: this._selectedSegmentId,
    })
  }

  _extractPitchDataFromResponse(response) {
    return {
      pitchCurve: Array.isArray(response?.pitchCurve) ? response.pitchCurve : [],
      pitchDeviation: {
        xs: Array.isArray(response?.pitchDeviation?.xs) ? response.pitchDeviation.xs : [],
        ys: Array.isArray(response?.pitchDeviation?.ys) ? response.pitchDeviation.ys : [],
      },
      midiPpq: Number.isFinite(response?.midiPpq) ? response.midiPpq : 480,
      pitchStepTick: Number.isFinite(response?.pitchStepTick) ? response.pitchStepTick : 5,
    }
  }

  _clonePitchData(pitchData) {
    if (!pitchData) return null
    return {
      pitchCurve: Array.isArray(pitchData.pitchCurve)
        ? pitchData.pitchCurve.map((point) => ({
          tick: Number.isFinite(point?.tick) ? Math.round(point.tick) : 0,
          pitch: Number.isFinite(point?.pitch) ? point.pitch : 0,
        }))
        : [],
      pitchDeviation: {
        xs: Array.isArray(pitchData.pitchDeviation?.xs)
          ? pitchData.pitchDeviation.xs.map((tick) => (Number.isFinite(tick) ? Math.round(tick) : 0))
          : [],
        ys: Array.isArray(pitchData.pitchDeviation?.ys)
          ? pitchData.pitchDeviation.ys.map((cent) => (Number.isFinite(cent) ? Math.round(cent) : 0))
          : [],
      },
      midiPpq: Number.isFinite(pitchData.midiPpq) ? Math.max(1, Math.round(pitchData.midiPpq)) : 480,
      pitchStepTick: Number.isFinite(pitchData.pitchStepTick) ? Math.max(1, Math.round(pitchData.pitchStepTick)) : 5,
    }
  }

  _cloneNoteControls(controls) {
    return Array.isArray(controls) ? controls.map(cloneControl) : []
  }

  _captureCommittedSnapshot() {
    const pitchData = this._clonePitchData(this._serverPitchData || phraseStore.getPitchData())
    if (!pitchData) return null
    return {
      pitchData,
      noteControls: this._cloneNoteControls(this._serverNoteControls.length > 0 ? this._serverNoteControls : this._noteControls),
      selectedPointId: this._selectedPointId,
      selectedSegmentId: this._selectedSegmentId,
    }
  }

  _pushUndoSnapshot(snapshot) {
    if (!snapshot?.pitchData) return
    const normalized = {
      pitchData: this._clonePitchData(snapshot.pitchData),
      noteControls: this._cloneNoteControls(snapshot.noteControls),
      selectedPointId: snapshot.selectedPointId || null,
      selectedSegmentId: snapshot.selectedSegmentId || null,
    }
    const nextSignature = this._buildControlSignature(normalized.noteControls)
    const lastSignature = this._undoStack.length > 0
      ? this._buildControlSignature(this._undoStack[this._undoStack.length - 1].noteControls)
      : null
    if (nextSignature === lastSignature) return
    this._undoStack.push(normalized)
    if (this._undoStack.length > HISTORY_LIMIT) {
      this._undoStack.splice(0, this._undoStack.length - HISTORY_LIMIT)
    }
  }

  _buildPitchSnapshotSignature(pitchData) {
    const xs = Array.isArray(pitchData?.pitchDeviation?.xs) ? pitchData.pitchDeviation.xs : []
    const ys = Array.isArray(pitchData?.pitchDeviation?.ys) ? pitchData.pitchDeviation.ys : []
    return `${xs.join(',')}|${ys.join(',')}`
  }

  _buildPitchPayloadSignature(payload) {
    if (!Array.isArray(payload)) return '|'
    return `${payload.map((point) => point?.tick ?? 0).join(',')}|${payload.map((point) => point?.cent ?? 0).join(',')}`
  }

  _previewHistorySnapshot(snapshot) {
    const pitchData = this._clonePitchData(snapshot?.pitchData)
    const controls = this._cloneNoteControls(snapshot?.noteControls)
    if (!pitchData) return false
    this._noteControls = controls
    this._previewVersion += 1
    this._selectedPointId = snapshot?.selectedPointId && this._findDisplayPoint(snapshot.selectedPointId, controls)
      ? snapshot.selectedPointId
      : null
    this._selectedSegmentId = snapshot?.selectedSegmentId && this._findDisplaySegment(snapshot.selectedSegmentId, controls)
      ? snapshot.selectedSegmentId
      : this._resolveOutgoingSegmentId(this._selectedPointId, controls)
    this._pendingServerSync = null
    this._emitSelectionChanged()
    phraseStore.previewPitchData(pitchData)
    return true
  }

  async _applyHistorySnapshot(snapshot, { reason = 'history-restore' } = {}) {
    const pitchData = this._clonePitchData(snapshot?.pitchData)
    if (!pitchData) return false
    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')
    return this._applyNoteParamsPayload({
      jobId,
      notePayload: this._buildNoteParamPayloadFromControls(snapshot.noteControls),
      controls: this._cloneNoteControls(snapshot.noteControls),
      selectedPointId: snapshot.selectedPointId || null,
      selectedSegmentId: snapshot.selectedSegmentId || null,
      currentPitchData: this._serverPitchData || phraseStore.getPitchData(),
      reason,
    })
  }

  _applyNoteParamsPayload({
    jobId,
    notePayload,
    controls,
    selectedPointId = null,
    selectedSegmentId = null,
    currentPitchData,
    reason = 'pitch-edit',
  }) {
    const requestVersion = this._previewVersion
    const optimisticAffected = this._getAffectedPhraseIndices(controls)
    const optimisticFromPayload = this._getAffectedPhraseIndicesForNotePayload(notePayload)
    const affectedSeed = [...new Set([...optimisticAffected, ...optimisticFromPayload])]
    if (affectedSeed.length === 0 || !Array.isArray(notePayload) || notePayload.length === 0) {
      return Promise.resolve({
        affectedIndices: [],
        phrases: [],
        pitchCurve: currentPitchData?.pitchCurve || [],
        pitchDeviation: currentPitchData?.pitchDeviation || { xs: [], ys: [] },
        midiPpq: currentPitchData?.midiPpq || 480,
        pitchStepTick: currentPitchData?.pitchStepTick || 5,
      })
    }

    const previewPitchData = this._buildPitchDataFromControls(controls)
    const renderVersion = this._buildRenderVersion((previewPitchData?.pitchDeviation?.xs || []).map((tick, index) => ({
      tick,
      cent: previewPitchData?.pitchDeviation?.ys?.[index] || 0,
    })))
    const phraseHashSnapshot = phraseStore.capturePhraseHashes(affectedSeed)
    const cacheSnapshot = renderCache.capture(affectedSeed)
    const interactiveEditToken = renderJobManager.beginInteractiveEdit(affectedSeed)

    phraseStore.applyPitchRenderVersion(affectedSeed, renderVersion)
    renderCache.clearIndices(affectedSeed)
    affectedSeed.forEach((phraseIndex) => {
      eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex })
    })
    audioEngine.cancelPhrases(affectedSeed)
    renderJobManager.incrementGeneration()
    this._prioritizeDirtyPhrase()

    const task = this._commitQueue.then(async () => {
      const response = await renderApi.applyNoteParams(jobId, notePayload)
      const nextPitchData = this._extractPitchDataFromResponse(response)
      const nextPhrases = Array.isArray(response?.phrases) ? response.phrases : []
      const serverAffected = Array.isArray(response?.affectedIndices)
        ? response.affectedIndices.filter((index) => Number.isInteger(index) && index >= 0)
        : []
      const affectedIndices = [...new Set(serverAffected.length > 0 ? serverAffected : optimisticAffected)]

      this._serverPitchData = this._clonePitchData(nextPitchData)

      if (requestVersion === this._previewVersion) {
        const restoredIndices = affectedSeed.filter((index) => !affectedIndices.includes(index))
        if (restoredIndices.length > 0) {
          phraseStore.restorePhraseHashes(phraseHashSnapshot.filter((entry) => restoredIndices.includes(entry.phraseIndex)))
          renderCache.restore(cacheSnapshot.filter((entry) => restoredIndices.includes(entry.phraseIndex)))
        }

        if (nextPhrases.length > 0) {
          phraseStore.rebuildFromEdit(nextPhrases)
        }
        if (affectedIndices.length > 0) {
          phraseStore.applyPitchRenderVersion(affectedIndices, renderVersion)
        }
      }

      if (affectedIndices.length > 0) {
        renderJobManager.restartForEdit(phraseStore.getPhrases().length)
        this._prioritizeDirtyPhrase()
      }
      renderJobManager.endInteractiveEdit(interactiveEditToken)

      if (requestVersion === this._previewVersion) {
        this._noteControls = this._cloneNoteControls(controls)
        this._selectedPointId = selectedPointId
        this._selectedSegmentId = selectedSegmentId
        this._serverNoteControls = this._cloneNoteControls(controls)
        this._serverNoteMetaByKey = this._captureNoteMetaByKey(controls)
        this._pendingServerSync = {
          jobId,
          controls: this._cloneNoteControls(controls),
          selectedPointId,
          selectedSegmentId,
        }
        phraseStore.setPitchData(nextPitchData)
      }

      return response
    }).catch((error) => {
      if (requestVersion === this._previewVersion) {
        phraseStore.restorePhraseHashes(phraseHashSnapshot)
        renderCache.restore(cacheSnapshot)
      }
      renderJobManager.endInteractiveEdit(interactiveEditToken)
      if (requestVersion === this._previewVersion && this._serverPitchData) {
        phraseStore.setPitchData(this._serverPitchData)
      }
      throw error
    })

    this._commitQueue = task.catch(() => {})
    return task
  }

  _applyPitchDeviationPayload({
    jobId,
    payload,
    controls,
    selectedPointId = null,
    selectedSegmentId = null,
    currentPitchData,
    reason = 'pitch-edit',
  }) {
    const requestVersion = this._previewVersion
    const optimisticAffected = this._getAffectedPhraseIndices(controls)
    if (optimisticAffected.length === 0) {
      console.log(`[音高编辑] 跳过空提交 ${reason} | 无受影响短语`)
      return Promise.resolve({
        affectedIndices: [],
        pitchCurve: currentPitchData?.pitchCurve || [],
        pitchDeviation: currentPitchData?.pitchDeviation || { xs: [], ys: [] },
        midiPpq: currentPitchData?.midiPpq || 480,
        pitchStepTick: currentPitchData?.pitchStepTick || 5,
      })
    }

    const renderVersion = this._buildRenderVersion(payload)
    const phraseHashSnapshot = phraseStore.capturePhraseHashes(optimisticAffected)
    const cacheSnapshot = renderCache.capture(optimisticAffected)
    const interactiveEditToken = renderJobManager.beginInteractiveEdit(optimisticAffected)

    phraseStore.applyPitchRenderVersion(optimisticAffected, renderVersion)
    renderCache.clearIndices(optimisticAffected)
    optimisticAffected.forEach((phraseIndex) => {
      eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex })
    })
    audioEngine.cancelPhrases(optimisticAffected)
    renderJobManager.incrementGeneration()
    this._prioritizeDirtyPhrase()

    console.log(
      `[音高编辑] → 提交 ${reason} | 点数=${payload.length}, 版本=${requestVersion}, 受影响=[${optimisticAffected.join(',')}]`,
    )

    const task = this._commitQueue.then(async () => {
      const response = await renderApi.applyPitchDeviation(jobId, payload)
      const nextPitchData = this._extractPitchDataFromResponse(response)
      const serverAffected = Array.isArray(response?.affectedIndices)
        ? response.affectedIndices.filter((index) => Number.isInteger(index) && index >= 0)
        : []
      const affectedIndices = [...new Set(serverAffected.length > 0
        ? serverAffected
        : optimisticAffected)]
      const isCurrentRequest = requestVersion === this._previewVersion

      this._serverPitchData = this._clonePitchData(nextPitchData)

      if (isCurrentRequest) {
        const restoredIndices = optimisticAffected.filter((index) => !affectedIndices.includes(index))
        if (restoredIndices.length > 0) {
          phraseStore.restorePhraseHashes(phraseHashSnapshot.filter((entry) => restoredIndices.includes(entry.phraseIndex)))
          renderCache.restore(cacheSnapshot.filter((entry) => restoredIndices.includes(entry.phraseIndex)))
        }

        const extraAffected = affectedIndices.filter((index) => !optimisticAffected.includes(index))
        if (extraAffected.length > 0) {
          phraseStore.applyPitchRenderVersion(extraAffected, renderVersion)
          renderCache.clearIndices(extraAffected)
          extraAffected.forEach((phraseIndex) => {
            eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex })
          })
          audioEngine.cancelPhrases(extraAffected)
        }
      }

      if (affectedIndices.length > 0) {
        renderJobManager.restartForEdit(phraseStore.getPhrases().length)
        this._prioritizeDirtyPhrase()
      }
      renderJobManager.endInteractiveEdit(interactiveEditToken)

      if (requestVersion === this._previewVersion) {
        this._noteControls = this._cloneNoteControls(controls)
        this._selectedPointId = selectedPointId
        this._selectedSegmentId = selectedSegmentId
        this._serverNoteControls = this._cloneNoteControls(controls)
        this._pendingServerSync = {
          jobId,
          controls: this._cloneNoteControls(controls),
          selectedPointId,
          selectedSegmentId,
        }
        phraseStore.setPitchData(nextPitchData)
      }

      console.log(`[音高编辑] ← 提交成功 ${reason} | 受影响短语=[${affectedIndices.join(',')}]`)
      return response
    }).catch((error) => {
      console.error(`[音高编辑] 提交失败 ${reason}`, error)
      if (requestVersion === this._previewVersion) {
        phraseStore.restorePhraseHashes(phraseHashSnapshot)
        renderCache.restore(cacheSnapshot)
      }
      renderJobManager.endInteractiveEdit(interactiveEditToken)
      if (requestVersion === this._previewVersion && this._serverPitchData) {
        phraseStore.setPitchData(this._serverPitchData)
      }
      throw error
    })

    this._commitQueue = task.catch(() => {})
    return task
  }

  _createPointId() {
    const id = `pitch-point-${this._nextPointId}`
    this._nextPointId += 1
    return id
  }

  _clampTickToCurve(tick, pitchData = phraseStore.getPitchData()) {
    const curve = Array.isArray(pitchData?.pitchCurve) ? pitchData.pitchCurve : []
    if (curve.length === 0) return Math.max(0, Math.round(tick))
    const minTick = Number.isFinite(curve[0]?.tick) ? Math.round(curve[0].tick) : 0
    const maxTick = Number.isFinite(curve[curve.length - 1]?.tick)
      ? Math.round(curve[curve.length - 1].tick)
      : minTick
    return clamp(Math.round(tick), minTick, Math.max(minTick, maxTick))
  }
}

export { MODE as PITCH_EDITOR_MODE, PITCH_POINT_SHAPES, PITCH_BOUNDARY_MODES }
export default new PitchEditor()
