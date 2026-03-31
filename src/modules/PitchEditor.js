import eventBus from '../core/EventBus.js'
import phraseStore from '../core/PhraseStore.js'
import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import renderPriorityStrategy from './RenderPriorityStrategy.js'
import renderScheduler from './RenderScheduler.js'
import { EVENTS } from '../config/constants.js'

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
      this._serverNoteControls = this._cloneNoteControls(controls)

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
    const compiledDeviation = this._mergeCompiledDeviationWithServer(this._noteControls, currentPitchData)
    const payload = compiledDeviation.map((point) => ({ tick: point.tick, cent: point.cent }))
    const historySnapshot = this._captureCommittedSnapshot()
    if (
      historySnapshot?.pitchData
      && this._buildPitchPayloadSignature(payload) !== this._buildPitchSnapshotSignature(historySnapshot.pitchData)
    ) {
      this._pushUndoSnapshot(historySnapshot)
    }
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

  _buildControlForNote(noteEntry, pitchData) {
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
        this._pushCompiledPoint(
          compiled,
          control.startTick + sample.relTick,
          sample.cent + delta,
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

    const deviation = this._mergeCompiledDeviationWithServer(controls, current)
    current.pitchDeviation = {
      xs: deviation.map((point) => point.tick),
      ys: deviation.map((point) => point.cent),
    }
    return current
  }

  _mergeCompiledDeviationWithServer(controls, pitchData) {
    const baselineControls = this._serverNoteControls
    if (!Array.isArray(baselineControls) || baselineControls.length === 0) {
      return this._buildCompiledDeviation(controls, pitchData)
    }

    const baselinePoints = this._normalizeDeviationPoints(
      (pitchData?.pitchDeviation?.xs || []).map((tick, index) => ({
        tick,
        cent: pitchData?.pitchDeviation?.ys?.[index] || 0,
      })),
    )
    if (baselinePoints.length === 0) {
      return this._buildCompiledDeviation(controls, pitchData)
    }

    const baselineMap = new Map(baselineControls.map((control) => [control.noteKey, control]))
    const changedControls = controls.filter((control) => {
      const baseline = baselineMap.get(control.noteKey)
      return !areControlsEquivalent(control, baseline)
    })

    if (changedControls.length === 0) {
      return baselinePoints
    }

    const ranges = changedControls.map((control) => ({
      startTick: control.startTick,
      endTick: control.endTick,
    }))
    const merged = baselinePoints.filter((point) => (
      !ranges.some((range) => point.tick >= range.startTick && point.tick <= range.endTick)
    ))

    for (const control of changedControls) {
      const compiled = this._compileNoteDeviation(control, pitchData, controls)
      for (const point of compiled) {
        merged.push(point)
      }
    }

    return this._normalizeDeviationPoints(merged)
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
    const nextSignature = this._buildPitchSnapshotSignature(normalized.pitchData)
    const lastSignature = this._undoStack.length > 0
      ? this._buildPitchSnapshotSignature(this._undoStack[this._undoStack.length - 1].pitchData)
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
    const payload = (pitchData.pitchDeviation?.xs || []).map((tick, index) => ({
      tick,
      cent: pitchData.pitchDeviation?.ys?.[index] || 0,
    }))
    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')
    return this._applyPitchDeviationPayload({
      jobId,
      payload,
      controls: this._cloneNoteControls(snapshot.noteControls),
      selectedPointId: snapshot.selectedPointId || null,
      selectedSegmentId: snapshot.selectedSegmentId || null,
      currentPitchData: this._serverPitchData || phraseStore.getPitchData(),
      reason,
    })
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
