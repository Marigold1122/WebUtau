import viewport from './PianoRollViewport.js'

class NoteSelection {
  constructor() {
    this._selected = new Map()
    this._marqueeRect = null
  }

  startMarquee(x, y) {
    this._marqueeRect = { x1: x, y1: y, x2: x, y2: y }
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
  }

  cancelMarquee() {
    this._marqueeRect = null
  }

  selectNote(note, phrase) {
    this._selected.set(note, phrase)
  }

  replaceWithNote(note, phrase) {
    this._selected.clear()
    this._selected.set(note, phrase)
  }

  clear() {
    this._selected.clear()
    this._marqueeRect = null
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

  _normalize(r) {
    return {
      x1: Math.min(r.x1, r.x2),
      y1: Math.min(r.y1, r.y2),
      x2: Math.max(r.x1, r.x2),
      y2: Math.max(r.y1, r.y2),
    }
  }
}

export default new NoteSelection()
