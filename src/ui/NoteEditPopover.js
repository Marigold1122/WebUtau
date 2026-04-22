// 音符浮窗：选中音符时锚在所选音符联合包围盒的右下角。
//
// 互斥：当 pitchEditor 有选中 point / segment 时让位给 PitchShapePopover。

import inlinePopover from './InlinePopover.js'
import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import pitchEditor, { PITCH_EDITOR_MODE } from '../modules/PitchEditor.js'
import noteSelection from './NoteSelection.js'
import viewport from './PianoRollViewport.js'
import { createNoteEditPopoverView } from './NoteEditPopoverView.js'
import { PORTAMENTO_PRESETS, VIBRATO_PRESETS } from './noteEditPopoverPresets.js'

const POPOVER_ID = 'note-edit'

class NoteEditPopover {
  constructor() {
    this._handle = null
    this._view = null
    this._active = false
    this._canvas = null
  }

  /** PianoRoll.init 时调用一次 */
  activate(canvas) {
    this._canvas = canvas
    if (this._active) return
    this._active = true

    const onSelectionChanged = () => this.refresh()
    const onPitchSelection = () => this.refresh()
    const onPhrase = () => {
      this._syncFromState()
      if (this.isOpen()) inlinePopover.requestReposition(POPOVER_ID)
    }
    const onMode = () => this.refresh()
    const onTrackChanged = () => this.refresh()

    eventBus.on(EVENTS.NOTE_SELECTION_CHANGED, onSelectionChanged)
    eventBus.on(EVENTS.PITCH_EDITOR_SELECTION_CHANGED, onPitchSelection)
    eventBus.on(EVENTS.PITCH_CHANGED, onPhrase)
    eventBus.on(EVENTS.PHRASES_EDITED, onPhrase)
    eventBus.on(EVENTS.PITCH_EDITOR_MODE_CHANGED, onMode)
    eventBus.on(EVENTS.TRACK_SELECTED, onTrackChanged)
  }

  isOpen() {
    return Boolean(this._handle && this._handle.isOpen())
  }

  refresh() {
    const count = noteSelection.count()
    const hasPitchTarget = pitchEditor.hasSelectedPoint() || pitchEditor.hasSelectedSegment()

    if (count === 0 || hasPitchTarget) {
      if (this.isOpen()) this.close()
      return
    }
    if (this.isOpen()) {
      this._syncFromState()
      this._handle.updateAnchor(this._computeAnchor())
    } else {
      this._open()
    }
  }

  close() {
    if (this.isOpen()) this._handle.close()
  }

  _open() {
    const view = createNoteEditPopoverView({
      onClose: () => this.close(),
      onBoundaryMode: (mode) => this._apply(() =>
        pitchEditor.setBoundaryModeForNoteEntries(noteSelection.getSelected(), mode)),
      onPortamentoPreset: (value) => {
        const preset = PORTAMENTO_PRESETS.find((candidate) => candidate.id === value)
        if (!preset) return this._syncFromState()
        return pitchEditor.setPortamentoForNoteEntries(noteSelection.getSelected(), {
          start: preset.start,
          length: preset.length,
        })
      },
      onPortamentoField: (field, value) =>
        pitchEditor.setPortamentoForNoteEntries(noteSelection.getSelected(), { [field]: value }),
      onTuning: (value) =>
        pitchEditor.setTuningForNoteEntries(noteSelection.getSelected(), value),
      onVibratoPreset: (value) => {
        const preset = VIBRATO_PRESETS.find((candidate) => candidate.id === value)
        // 空预设 = 关闭颤音（把 length 置 0）；非空 = 应用该组参数（同时开启）
        if (!preset) {
          return pitchEditor.setVibratoEnabledForNoteEntries(noteSelection.getSelected(), false)
        }
        return pitchEditor.setVibratoValuesForNoteEntries(noteSelection.getSelected(), preset.values)
      },
      onVibratoField: (field, value) =>
        pitchEditor.setVibratoValueForNoteEntries(noteSelection.getSelected(), field, value),
      requestSync: () => this._syncFromState(),
    })
    this._view = view

    this._handle = inlinePopover.open({
      id: POPOVER_ID,
      anchor: this._computeAnchor(),
      content: view.root,
      className: 'inline-popover--note',
      onClose: () => this._handleClose(),
    })
    this._syncFromState()
  }

  _computeAnchor() {
    return () => {
      if (!this._canvas) return null
      const entries = noteSelection.getSelected()
      if (entries.length === 0) return null

      const canvasRect = this._canvas.getBoundingClientRect()
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const { note } of entries) {
        const x1 = viewport.timeToX(note.time)
        const x2 = viewport.timeToX(note.time + (note.duration || 0))
        const y = viewport.pitchToY(note.midi)
        if (x1 < minX) minX = x1
        if (x2 > maxX) maxX = x2
        if (y < minY) minY = y
        if (y + PIANO_ROLL.KEY_HEIGHT > maxY) maxY = y + PIANO_ROLL.KEY_HEIGHT
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxY)) return null

      // 夹到 canvas 可视区（滚出屏幕时沿 canvas 边沿）
      const cw = this._canvas.clientWidth
      const ch = this._canvas.clientHeight
      const left = Math.max(0, Math.min(minX, cw))
      const right = Math.max(0, Math.min(maxX, cw))
      const top = Math.max(0, Math.min(minY, ch))
      const bottom = Math.max(0, Math.min(maxY, ch))

      return {
        x: canvasRect.left + left,
        y: canvasRect.top + top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }
    }
  }

  async _apply(op) {
    try { await op() } catch (error) { console.error('[NoteEditPopover] 操作失败:', error) }
    this._syncFromState()
  }

  _syncFromState() {
    if (!this._view || this._view.isSyncSuspended()) return
    const selected = noteSelection.getSelected()
    const count = selected.length
    const pitchMode = pitchEditor.getMode() === PITCH_EDITOR_MODE.PITCH
    const noteScope = pitchEditor.canEdit() && count > 0
    this._view.sync({
      count,
      pitchMode,
      noteScope,
      boundaryMode: pitchEditor.getBoundaryModeForNoteEntries(selected),
      portamento: pitchEditor.getPortamentoStateForNoteEntries(selected),
      tuning: pitchEditor.getTuningStateForNoteEntries(selected),
      vibrato: pitchEditor.getVibratoStateForNoteEntries(selected),
    })
  }

  _handleClose() {
    this._view = null
    this._handle = null
  }
}

export default new NoteEditPopover()
