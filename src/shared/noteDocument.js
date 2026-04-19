const DEFAULT_LYRIC = 'a'
const DEFAULT_VELOCITY = 0.8
const DEFAULT_VIBRATO = {
  length: 0,
  period: 175,
  depth: 25,
  in: 10,
  out: 10,
  shift: 0,
  drift: 0,
  volLink: 0,
}

export function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

export function clampMidi(value, fallback = 60) {
  const midi = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(0, Math.min(127, midi))
}

export function clampVelocity(value, fallback = DEFAULT_VELOCITY) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function clampRange(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeLyric(value) {
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_LYRIC
}

function normalizePitchShape(shape) {
  return shape === 'l' || shape === 'i' || shape === 'o' ? shape : 'io'
}

function hasPitchDocument(value) {
  return Boolean(value) && (
    Array.isArray(value?.data)
    || typeof value?.snapFirst === 'boolean'
  )
}

function hasVibratoDocument(value) {
  return Boolean(value) && (
    Number.isFinite(value?.length)
    || Number.isFinite(value?.period)
    || Number.isFinite(value?.depth)
    || Number.isFinite(value?.in)
    || Number.isFinite(value?.out)
    || Number.isFinite(value?.shift)
    || Number.isFinite(value?.drift)
    || Number.isFinite(value?.volLink)
  )
}

export function createPitchPointDocument(point = {}) {
  return {
    x: Number.isFinite(point?.x) ? point.x : 0,
    y: Number.isFinite(point?.y) ? point.y : 0,
    shape: normalizePitchShape(point?.shape),
  }
}

export function createPitchDocument(pitch = null) {
  if (!hasPitchDocument(pitch)) return null
  return {
    snapFirst: pitch?.snapFirst !== false,
    data: Array.isArray(pitch?.data) ? pitch.data.map(createPitchPointDocument) : [],
  }
}

export function createVibratoDocument(vibrato = null) {
  if (!hasVibratoDocument(vibrato)) return null
  const fadeIn = clampRange(vibrato?.in, 0, 100, DEFAULT_VIBRATO.in)
  const fadeOut = clampRange(vibrato?.out, 0, 100, DEFAULT_VIBRATO.out)
  return {
    length: clampRange(vibrato?.length, 0, 100, DEFAULT_VIBRATO.length),
    period: clampRange(vibrato?.period, 5, 500, DEFAULT_VIBRATO.period),
    depth: clampRange(vibrato?.depth, 5, 200, DEFAULT_VIBRATO.depth),
    in: Math.min(fadeIn, 100 - fadeOut),
    out: Math.min(fadeOut, 100 - fadeIn),
    shift: clampRange(vibrato?.shift, 0, 100, DEFAULT_VIBRATO.shift),
    drift: clampRange(vibrato?.drift, -100, 100, DEFAULT_VIBRATO.drift),
    volLink: clampRange(vibrato?.volLink, -100, 100, DEFAULT_VIBRATO.volLink),
  }
}

export function createNoteDocument(note = {}) {
  const document = {
    time: clampNonNegative(note?.time),
    duration: Math.max(0.05, clampNonNegative(note?.duration, 0.05)),
    midi: clampMidi(note?.midi, 60),
    velocity: clampVelocity(note?.velocity, DEFAULT_VELOCITY),
    lyric: normalizeLyric(note?.lyric),
    tuning: Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0,
  }

  if (Number.isFinite(note?.tick)) {
    document.tick = Math.round(clampNonNegative(note.tick))
  }
  if (Number.isFinite(note?.durationTicks)) {
    document.durationTicks = Math.max(1, Math.round(clampNonNegative(note.durationTicks, 1)))
  }

  const pitch = createPitchDocument(note?.pitch)
  if (pitch) document.pitch = pitch

  const vibrato = createVibratoDocument(note?.vibrato)
  if (vibrato) document.vibrato = vibrato

  return document
}

export function createPreviewNoteDocument(note = {}) {
  const document = createNoteDocument(note)
  return {
    ...document,
    tick: Math.round(clampNonNegative(note?.tick)),
    durationTicks: Math.max(1, Math.round(clampNonNegative(note?.durationTicks, 1))),
  }
}

export function buildNoteDocumentSignature(note = {}) {
  const pitch = Array.isArray(note?.pitch?.data)
    ? note.pitch.data.map((point) => `${point?.x ?? 0}:${point?.y ?? 0}:${point?.shape || 'io'}`).join(',')
    : ''
  const vibrato = note?.vibrato
    ? [
      note.vibrato.length ?? '',
      note.vibrato.period ?? '',
      note.vibrato.depth ?? '',
      note.vibrato.in ?? '',
      note.vibrato.out ?? '',
      note.vibrato.shift ?? '',
      note.vibrato.drift ?? '',
      note.vibrato.volLink ?? '',
    ].join(':')
    : ''
  return [
    Math.round(clampNonNegative(note?.tick)),
    Math.max(1, Math.round(clampNonNegative(note?.durationTicks, 1))),
    clampMidi(note?.midi),
    clampVelocity(note?.velocity).toFixed(3),
    note?.lyric || DEFAULT_LYRIC,
    Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0,
    note?.pitch?.snapFirst === false ? '0' : '1',
    pitch,
    vibrato,
  ].join('|')
}
