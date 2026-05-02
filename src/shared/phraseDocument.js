import { clampNonNegative, createNoteDocument as createBaseNoteDocument } from './noteDocument.js'

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function buildPhraseText(notes, fallbackText) {
  if (typeof fallbackText === 'string' && fallbackText.length > 0) return fallbackText
  return notes.map((note) => note.lyric).join('')
}

function computePhraseHash(phrase, notes, text) {
  if (typeof phrase?.inputHash === 'string' && phrase.inputHash.length > 0) {
    return phrase.inputHash
  }
  if (notes.length === 0) {
    return `${normalizeNumber(phrase?.startTime).toFixed(3)}-${normalizeNumber(phrase?.endTime).toFixed(3)}-${text}`
  }
  const first = notes[0]
  const last = notes[notes.length - 1]
  const startTime = normalizeNumber(first.time)
  const endTime = normalizeNumber(last.time) + normalizeNumber(last.duration)
  return `${startTime.toFixed(3)}-${endTime.toFixed(3)}-${text}`
}

export function createNoteDocument(note = {}) {
  return createBaseNoteDocument(note)
}

export function createPhraseDocument(phrase = {}, phraseIndex = 0) {
  const notes = Array.isArray(phrase.notes) ? phrase.notes.map(createNoteDocument) : []
  const text = buildPhraseText(notes, phrase.text)
  const knownKeys = new Set(['index', 'startTime', 'endTime', 'text', 'notes', 'inputHash', 'baseInputHash'])

  const extra = {}
  for (const [key, value] of Object.entries(phrase)) {
    if (!knownKeys.has(key)) {
      extra[key] = value
    }
  }

  return {
    index: Number.isInteger(phrase.index) ? phrase.index : phraseIndex,
    startTime: clampNonNegative(phrase.startTime),
    endTime: Math.max(clampNonNegative(phrase.startTime), clampNonNegative(phrase.endTime)),
    text,
    notes,
    inputHash: computePhraseHash(phrase, notes, text),
    ...extra,
  }
}

export function createPhraseDocuments(phrases = []) {
  if (!Array.isArray(phrases)) return []
  return phrases.map((phrase, index) => createPhraseDocument(phrase, index))
}
