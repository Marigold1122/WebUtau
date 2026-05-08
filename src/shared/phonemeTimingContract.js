export const PHONEME_TIMING_EDIT_TYPES = Object.freeze({
  OFFSET_TICK: 'offsetTick',
  PREUTTER_DELTA_MS: 'preutterDeltaMs',
  OVERLAP_DELTA_MS: 'overlapDeltaMs',
  RESET_OFFSET: 'resetOffset',
  RESET_PREUTTER: 'resetPreutter',
  RESET_OVERLAP: 'resetOverlap',
})

const EDIT_TYPE_BY_HIT_KIND = Object.freeze({
  position: PHONEME_TIMING_EDIT_TYPES.OFFSET_TICK,
  preutter: PHONEME_TIMING_EDIT_TYPES.PREUTTER_DELTA_MS,
  overlap: PHONEME_TIMING_EDIT_TYPES.OVERLAP_DELTA_MS,
})

const RESET_TYPE_BY_HIT_KIND = Object.freeze({
  position: PHONEME_TIMING_EDIT_TYPES.RESET_OFFSET,
  preutter: PHONEME_TIMING_EDIT_TYPES.RESET_PREUTTER,
  overlap: PHONEME_TIMING_EDIT_TYPES.RESET_OVERLAP,
})

const NUMERIC_EDIT_TYPES = new Set(Object.values(EDIT_TYPE_BY_HIT_KIND))
const RESET_EDIT_TYPES = new Set(Object.values(RESET_TYPE_BY_HIT_KIND))
const ALL_EDIT_TYPES = new Set(Object.values(PHONEME_TIMING_EDIT_TYPES))

export function phonemeTimingEditTypeForHit(kind) {
  return EDIT_TYPE_BY_HIT_KIND[kind] || null
}

export function phonemeTimingResetEditTypeForHit(kind) {
  return RESET_TYPE_BY_HIT_KIND[kind] || null
}

export function isPhonemeTimingEditType(editType) {
  return ALL_EDIT_TYPES.has(editType)
}

export function isPhonemeTimingResetEditType(editType) {
  return RESET_EDIT_TYPES.has(editType)
}

export function buildPhonemeTimingEditRequest(preview, snapshot) {
  const hit = preview?.hit
  const editType = preview?.editType
  const normalizedValue = normalizePhonemeTimingEditValue(editType, preview?.value)
  if (!hit || !normalizedValue.ok) return null

  const partIndex = readInteger(hit.partIndex)
  const phonemeIndex = readInteger(hit.phonemeIndex)
  const noteKey = typeof hit.noteKey === 'string' ? hit.noteKey : ''
  if (partIndex < 0 || phonemeIndex < 0 || noteKey.length === 0) return null

  // Only semantic override fields cross the API boundary; geometry stays local.
  return {
    partIndex,
    noteKey,
    phonemeIndex,
    editType,
    value: normalizedValue.value,
    clientRevision: typeof snapshot?.revision === 'string' ? snapshot.revision : '',
  }
}

export function assertValidPhonemeTimingEditRequest(request) {
  const preview = {
    hit: {
      partIndex: request?.partIndex,
      noteKey: request?.noteKey,
      phonemeIndex: request?.phonemeIndex,
    },
    editType: request?.editType,
    value: request?.value,
  }
  const normalized = buildPhonemeTimingEditRequest(preview, { revision: request?.clientRevision })
  if (!normalized) throw new Error('Invalid phoneme timing edit request')
  return normalized
}

export function normalizePhonemeTimingEditResponse(response) {
  if (!response || response.ok !== true) {
    throw new Error('Invalid phoneme timing edit response')
  }
  if (!isPlainObject(response.snapshot) || !Array.isArray(response.affectedIndices)) {
    throw new Error('Invalid phoneme timing edit response')
  }
  if (response.phrases != null && !Array.isArray(response.phrases)) {
    throw new Error('Invalid phoneme timing edit response')
  }
  return {
    ok: true,
    snapshot: response.snapshot,
    affectedIndices: normalizePhonemeTimingAffectedIndices(response.affectedIndices),
    ...(response.phrases == null ? {} : { phrases: response.phrases }),
  }
}

export function normalizePhonemeTimingAffectedIndices(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => left - right)
}

function normalizePhonemeTimingEditValue(editType, value) {
  if (RESET_EDIT_TYPES.has(editType)) return resetValue(value)
  if (!NUMERIC_EDIT_TYPES.has(editType)) return invalidValue()
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalidValue()
  if (editType === PHONEME_TIMING_EDIT_TYPES.OFFSET_TICK && !Number.isInteger(value)) {
    return invalidValue()
  }
  return { ok: true, value }
}

function resetValue(value) {
  return value == null ? { ok: true, value: null } : invalidValue()
}

function invalidValue() {
  return { ok: false, value: null }
}

function readInteger(value) {
  return Number.isInteger(value) ? value : -1
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
