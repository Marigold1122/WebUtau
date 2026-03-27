function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function normalizeLyric(value) {
  return typeof value === 'string' && value.length > 0 ? value : 'a'
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
  return {
    time: normalizeNumber(note.time),
    duration: Math.max(0, normalizeNumber(note.duration)),
    midi: Math.round(normalizeNumber(note.midi, 60)),
    velocity: normalizeNumber(note.velocity, 0.8),
    lyric: normalizeLyric(note.lyric),
  }
}

export function createPhraseDocument(phrase = {}, phraseIndex = 0) {
  const notes = Array.isArray(phrase.notes) ? phrase.notes.map(createNoteDocument) : []
  const text = buildPhraseText(notes, phrase.text)

  return {
    index: Number.isInteger(phrase.index) ? phrase.index : phraseIndex,
    startTime: normalizeNumber(phrase.startTime),
    endTime: normalizeNumber(phrase.endTime),
    text,
    notes,
    inputHash: computePhraseHash(phrase, notes, text),
  }
}

export function createPhraseDocuments(phrases = []) {
  if (!Array.isArray(phrases)) return []
  return phrases.map((phrase, index) => createPhraseDocument(phrase, index))
}
