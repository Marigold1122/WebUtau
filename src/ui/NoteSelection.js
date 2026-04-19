import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'
import viewport from './PianoRollViewport.js'

class NoteSelection {
  constructor() {
    this._selected = new Map()
    this._marqueeRect = null
    this._bindEvents()
  }

  startMarquee(x, y) {
    this._marqueeRect = { x1: x, y1: y, x2: x, y2: y }
    this._emitChange()
  }

  updateMarquee(x, y) {
    if (this._marqueeRect) {
      this._marqueeRect.x2 = x
      this._marqueeRect.y2 = y
    }
  }

  commitMarquee(phrases, vp) {
    if (!this._marqueeRect) return
    const r = this._normalize(this._marqueeRect)
    const tStart = vp.xToTime(r.x1)
    const tEnd = vp.xToTime(r.x2)
    const pHigh = vp.yToPitch(r.y1)
    const pLow = vp.yToPitch(r.y2)

    this._selected.clear()
    for (const phrase of phrases) {
      for (const note of phrase.notes) {
        if (note.time + note.duration >= tStart && note.time <= tEnd && note.midi >= pLow && note.midi <= pHigh) {
          this._selected.set(note, phrase)
        }
      }
    }
    this._marqueeRect = null
    this._emitChange()
  }

  cancelMarquee() {
    this._marqueeRect = null
    this._emitChange()
  }

  selectNote(note, phrase) {
    this._selected.set(note, phrase)
    this._emitChange()
  }

  replaceWithNote(note, phrase) {
    this._selected.clear()
    this._selected.set(note, phrase)
    this._emitChange()
  }

  clear() {
    this._selected.clear()
    this._marqueeRect = null
    this._emitChange()
  }

  isSelected(note) {
    return this._selected.has(note)
  }

  getSelected() {
    const result = []
    for (const [note, phrase] of this._selected) {
      result.push({ note, phrase })
    }
    return result.sort((a, b) => a.note.time - b.note.time)
  }

  count() {
    return this._selected.size
  }

  getMarqueeRect() {
    return this._marqueeRect
  }

  getAffectedPhraseIndices() {
    const indices = new Set()
    for (const phrase of this._selected.values()) {
      indices.add(phrase.index)
    }
    return [...indices]
  }

  _bindEvents() {
    const remap = ({ phrases } = {}) => this._remapSelection(phrases)
    eventBus.on(EVENTS.TRACK_SELECTED, remap)
    eventBus.on(EVENTS.PHRASES_REBUILT, remap)
    eventBus.on(EVENTS.PHRASES_EDITED, remap)
  }

  _captureSelectionSnapshot() {
    const snapshot = []
    for (const [note, phrase] of this._selected) {
      const noteIndex = Array.isArray(phrase?.notes) ? phrase.notes.indexOf(note) : -1
      snapshot.push({
        phraseIndex: Number.isInteger(phrase?.index) ? phrase.index : null,
        noteIndex,
        tick: Number.isFinite(note?.tick) ? Math.round(note.tick) : null,
        durationTicks: Number.isFinite(note?.durationTicks) ? Math.max(1, Math.round(note.durationTicks)) : null,
        midi: Number.isFinite(note?.midi) ? Math.round(note.midi) : null,
        time: Number.isFinite(note?.time) ? note.time : null,
        duration: Number.isFinite(note?.duration) ? note.duration : null,
      })
    }
    return snapshot
  }

  _matchesSelectionSnapshot(note, snapshot) {
    if (!note || !snapshot) return false
    if (snapshot.tick != null && snapshot.durationTicks != null && snapshot.midi != null) {
      return Math.round(note?.tick || -1) === snapshot.tick
        && Math.max(1, Math.round(note?.durationTicks || 0)) === snapshot.durationTicks
        && Math.round(note?.midi || -1) === snapshot.midi
    }
    return Number.isFinite(snapshot.time)
      && Number.isFinite(snapshot.duration)
      && Math.abs((note?.time || 0) - snapshot.time) < 0.0001
      && Math.abs((note?.duration || 0) - snapshot.duration) < 0.0001
      && Math.round(note?.midi || -1) === snapshot.midi
  }

  _remapSelection(phrases = []) {
    if (this._selected.size === 0 || !Array.isArray(phrases) || phrases.length === 0) return

    const snapshot = this._captureSelectionSnapshot()
    if (snapshot.length === 0) return

    const phraseByIndex = new Map(phrases.map((phrase) => [phrase?.index, phrase]))
    const nextSelected = new Map()

    for (const entry of snapshot) {
      const phrase = phraseByIndex.get(entry.phraseIndex)
      if (!phrase) continue

      let note = Number.isInteger(entry.noteIndex) && entry.noteIndex >= 0
        ? phrase?.notes?.[entry.noteIndex] || null
        : null
      if (!this._matchesSelectionSnapshot(note, entry)) {
        note = (Array.isArray(phrase?.notes) ? phrase.notes : [])
          .find((candidate) => this._matchesSelectionSnapshot(candidate, entry)) || null
      }
      if (note) {
        nextSelected.set(note, phrase)
      }
    }

    const changed = nextSelected.size !== this._selected.size
      || [...nextSelected.keys()].some((note) => !this._selected.has(note))
    if (!changed) return

    this._selected = nextSelected
    this._emitChange()
  }

  _normalize(r) {
    return {
      x1: Math.min(r.x1, r.x2),
      y1: Math.min(r.y1, r.y2),
      x2: Math.max(r.x1, r.x2),
      y2: Math.max(r.y1, r.y2),
    }
  }

  _emitChange() {
    eventBus.emit(EVENTS.NOTE_SELECTION_CHANGED, {
      count: this._selected.size,
      hasMarquee: this._marqueeRect != null,
    })
  }
}

export default new NoteSelection()
