function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function clampMidi(value, fallback = 60) {
  const midi = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(0, Math.min(127, midi))
}

function clampVelocity(value) {
  if (!Number.isFinite(value)) return 0.8
  return Math.max(0, Math.min(1, value))
}

function normalizePreviewNote(note = {}) {
  const time = clampNonNegative(note.time)
  const duration = Math.max(0.05, clampNonNegative(note.duration, 0.05))
  const tick = Math.round(clampNonNegative(note.tick))
  const durationTicks = Math.max(1, Math.round(clampNonNegative(note.durationTicks, 1)))
  return {
    time,
    duration,
    tick,
    durationTicks,
    midi: clampMidi(note.midi),
    velocity: clampVelocity(note.velocity),
  }
}

function sortNotes(notes = []) {
  return [...notes].sort((left, right) => {
    if (left.tick !== right.tick) return left.tick - right.tick
    if (left.time !== right.time) return left.time - right.time
    if (left.midi !== right.midi) return left.midi - right.midi
    return left.durationTicks - right.durationTicks
  })
}

function cloneNotes(notes = []) {
  return sortNotes((Array.isArray(notes) ? notes : []).map((note) => normalizePreviewNote(note)))
}

function buildExactKey(note = {}) {
  return [
    Math.round(note.tick || 0),
    Math.max(1, Math.round(note.durationTicks || 1)),
    clampMidi(note.midi),
  ].join(':')
}

function buildLcsMatches(leftNotes = [], rightNotes = []) {
  const leftLength = leftNotes.length
  const rightLength = rightNotes.length
  const dp = Array.from({ length: leftLength + 1 }, () => Array(rightLength + 1).fill(0))

  for (let leftIndex = leftLength - 1; leftIndex >= 0; leftIndex -= 1) {
    const leftKey = buildExactKey(leftNotes[leftIndex])
    for (let rightIndex = rightLength - 1; rightIndex >= 0; rightIndex -= 1) {
      if (leftKey === buildExactKey(rightNotes[rightIndex])) {
        dp[leftIndex][rightIndex] = dp[leftIndex + 1][rightIndex + 1] + 1
      } else {
        dp[leftIndex][rightIndex] = Math.max(dp[leftIndex + 1][rightIndex], dp[leftIndex][rightIndex + 1])
      }
    }
  }

  const matches = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < leftLength && rightIndex < rightLength) {
    if (buildExactKey(leftNotes[leftIndex]) === buildExactKey(rightNotes[rightIndex])) {
      matches.push([leftIndex, rightIndex])
      leftIndex += 1
      rightIndex += 1
      continue
    }
    if (dp[leftIndex + 1][rightIndex] >= dp[leftIndex][rightIndex + 1]) {
      leftIndex += 1
    } else {
      rightIndex += 1
    }
  }
  return matches
}

function toTimeRange(note = {}) {
  const startTime = clampNonNegative(note.time)
  const endTime = Math.max(startTime + 0.05, startTime + clampNonNegative(note.duration, 0.05))
  return {
    startTime,
    endTime,
  }
}

function pushRange(ranges, startTime, endTime) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return
  const normalizedStart = Math.max(0, Math.min(startTime, endTime))
  const normalizedEnd = Math.max(normalizedStart, Math.max(startTime, endTime))
  ranges.push({
    startTime: normalizedStart,
    endTime: Math.max(normalizedStart + 0.05, normalizedEnd),
  })
}

function mergeRanges(ranges = [], {
  gapSec = 0.08,
  paddingSec = 0.05,
} = {}) {
  if (!Array.isArray(ranges) || ranges.length === 0) return []
  const sorted = [...ranges]
    .map((range) => ({
      startTime: Math.max(0, (range.startTime || 0) - paddingSec),
      endTime: Math.max(0, (range.endTime || 0) + paddingSec),
    }))
    .sort((left, right) => left.startTime - right.startTime)

  const merged = [sorted[0]]
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]
    const previous = merged[merged.length - 1]
    if (current.startTime <= previous.endTime + gapSec) {
      previous.endTime = Math.max(previous.endTime, current.endTime)
      continue
    }
    merged.push({ ...current })
  }
  return merged
}

function overlaps(left, right) {
  return left.startTime < right.endTime && right.startTime < left.endTime
}

function collectDirtyPhraseIndices(phrases = [], dirtyRanges = []) {
  if (!Array.isArray(phrases) || phrases.length === 0 || !Array.isArray(dirtyRanges) || dirtyRanges.length === 0) {
    return []
  }
  const indices = []
  phrases.forEach((phrase, index) => {
    const phraseRange = {
      startTime: clampNonNegative(phrase?.startTime),
      endTime: Math.max(
        clampNonNegative(phrase?.startTime),
        Number.isFinite(phrase?.endTime) ? phrase.endTime : clampNonNegative(phrase?.startTime),
      ),
    }
    if (dirtyRanges.some((range) => overlaps(phraseRange, range))) {
      indices.push(Number.isInteger(phrase?.index) ? phrase.index : index)
    }
  })
  return [...new Set(indices)].sort((left, right) => left - right)
}

function normalizePhraseStateRange(phraseState = {}, fallbackIndex = 0) {
  const phraseIndex = Number.isInteger(phraseState?.phraseIndex) ? phraseState.phraseIndex : fallbackIndex
  const startMs = Number.isFinite(phraseState?.startMs) ? phraseState.startMs : null
  const durationMs = Number.isFinite(phraseState?.durationMs) ? phraseState.durationMs : null
  if (startMs == null || durationMs == null) return null
  const startTime = Math.max(0, startMs / 1000)
  const endTime = Math.max(startTime, (startMs + durationMs) / 1000)
  return {
    phraseIndex,
    startTime,
    endTime,
  }
}

function collectDirtyPhraseIndicesFromStates(phraseStates = [], dirtyRanges = []) {
  if (!Array.isArray(phraseStates) || phraseStates.length === 0 || !Array.isArray(dirtyRanges) || dirtyRanges.length === 0) {
    return []
  }
  const indices = []
  phraseStates.forEach((phraseState, index) => {
    const normalizedRange = normalizePhraseStateRange(phraseState, index)
    if (!normalizedRange) return
    if (dirtyRanges.some((range) => overlaps(normalizedRange, range))) {
      indices.push(normalizedRange.phraseIndex)
    }
  })
  return [...new Set(indices)].sort((left, right) => left - right)
}

function buildExactDirtyRangesFromStates(phraseStates = [], dirtyPhraseIndices = []) {
  if (!Array.isArray(phraseStates) || phraseStates.length === 0 || !Array.isArray(dirtyPhraseIndices) || dirtyPhraseIndices.length === 0) {
    return []
  }
  const dirtySet = new Set(dirtyPhraseIndices)
  return phraseStates
    .map((phraseState, index) => normalizePhraseStateRange(phraseState, index))
    .filter((range) => range && dirtySet.has(range.phraseIndex))
    .map((range) => ({
      startTime: range.startTime,
      endTime: range.endTime,
    }))
}

function buildExactDirtyRangesFromPhrases(phrases = [], dirtyPhraseIndices = []) {
  if (!Array.isArray(phrases) || phrases.length === 0 || !Array.isArray(dirtyPhraseIndices) || dirtyPhraseIndices.length === 0) {
    return []
  }
  const dirtySet = new Set(dirtyPhraseIndices)
  return phrases
    .map((phrase, index) => {
      const phraseIndex = Number.isInteger(phrase?.index) ? phrase.index : index
      if (!dirtySet.has(phraseIndex)) return null
      const startTime = clampNonNegative(phrase?.startTime)
      const endTime = Math.max(
        startTime,
        Number.isFinite(phrase?.endTime) ? phrase.endTime : startTime,
      )
      return {
        startTime,
        endTime,
      }
    })
    .filter(Boolean)
}

function appendUnmatchedDirtyRanges(exactRanges = [], rawRanges = []) {
  if (!Array.isArray(rawRanges) || rawRanges.length === 0) return Array.isArray(exactRanges) ? exactRanges : []
  const nextRanges = Array.isArray(exactRanges) ? [...exactRanges] : []
  rawRanges.forEach((range) => {
    if (nextRanges.some((existing) => overlaps(existing, range))) return
    nextRanges.push({
      startTime: range.startTime,
      endTime: range.endTime,
    })
  })
  return nextRanges
}

const INTERNAL_EDIT_PPQ = 480

function normalizeSourcePpq(ppq) {
  return Number.isFinite(ppq) && ppq > 0 ? Math.round(ppq) : INTERNAL_EDIT_PPQ
}

function convertTicksToInternalPpq(ticks, sourcePpq = INTERNAL_EDIT_PPQ) {
  const normalizedTicks = Math.round(clampNonNegative(ticks))
  const normalizedSourcePpq = normalizeSourcePpq(sourcePpq)
  if (normalizedSourcePpq === INTERNAL_EDIT_PPQ) return normalizedTicks
  return Math.max(0, Math.round((normalizedTicks * INTERNAL_EDIT_PPQ) / normalizedSourcePpq))
}

function buildSegmentEdits(oldSegment = [], newSegment = [], edits = [], dirtyRanges = [], { ppq = INTERNAL_EDIT_PPQ } = {}) {
  const pairedCount = Math.min(oldSegment.length, newSegment.length)

  for (let index = 0; index < pairedCount; index += 1) {
    const oldNote = oldSegment[index]
    const newNote = newSegment[index]
    const moved = oldNote.tick !== newNote.tick || oldNote.midi !== newNote.midi
    const resized = oldNote.durationTicks !== newNote.durationTicks

    if (!moved && !resized) continue

    const oldRange = toTimeRange(oldNote)
    const newRange = toTimeRange(newNote)
    pushRange(dirtyRanges, oldRange.startTime, oldRange.endTime)
    pushRange(dirtyRanges, newRange.startTime, newRange.endTime)

    if (moved) {
      edits.push({
        action: 'move',
        position: convertTicksToInternalPpq(oldNote.tick, ppq),
        duration: Math.max(1, convertTicksToInternalPpq(oldNote.durationTicks, ppq)),
        tone: oldNote.midi,
        newPosition: convertTicksToInternalPpq(newNote.tick, ppq),
        newTone: newNote.midi,
      })
    }

    if (resized) {
      edits.push({
        action: 'resize',
        position: convertTicksToInternalPpq(moved ? newNote.tick : oldNote.tick, ppq),
        duration: Math.max(1, convertTicksToInternalPpq(newNote.durationTicks, ppq)),
        tone: moved ? newNote.midi : oldNote.midi,
      })
    }
  }

  for (let index = pairedCount; index < oldSegment.length; index += 1) {
    const note = oldSegment[index]
    const range = toTimeRange(note)
    pushRange(dirtyRanges, range.startTime, range.endTime)
    edits.push({
      action: 'remove',
      position: convertTicksToInternalPpq(note.tick, ppq),
      duration: Math.max(1, convertTicksToInternalPpq(note.durationTicks, ppq)),
      tone: note.midi,
    })
  }

  for (let index = pairedCount; index < newSegment.length; index += 1) {
    const note = newSegment[index]
    const range = toTimeRange(note)
    pushRange(dirtyRanges, range.startTime, range.endTime)
    edits.push({
      action: 'add',
      position: convertTicksToInternalPpq(note.tick, ppq),
      duration: Math.max(1, convertTicksToInternalPpq(note.durationTicks, ppq)),
      tone: note.midi,
      lyric: 'a',
    })
  }
}

function buildNoteEdits(baseNotes = [], nextNotes = [], { ppq = INTERNAL_EDIT_PPQ } = {}) {
  const matches = buildLcsMatches(baseNotes, nextNotes)
  const edits = []
  const dirtyRanges = []

  let baseIndex = 0
  let nextIndex = 0

  matches.forEach(([matchedBaseIndex, matchedNextIndex]) => {
    buildSegmentEdits(
      baseNotes.slice(baseIndex, matchedBaseIndex),
      nextNotes.slice(nextIndex, matchedNextIndex),
      edits,
      dirtyRanges,
      { ppq },
    )
    baseIndex = matchedBaseIndex + 1
    nextIndex = matchedNextIndex + 1
  })

  buildSegmentEdits(
    baseNotes.slice(baseIndex),
    nextNotes.slice(nextIndex),
    edits,
    dirtyRanges,
    { ppq },
  )

  return {
    edits,
    dirtyRanges: mergeRanges(dirtyRanges),
  }
}

export function hasPendingVoiceNoteEdits(track) {
  return Boolean(track?.pendingVoiceEditState?.edits?.length)
}

export function buildPendingVoiceNoteEditState({
  basePreviewNotes = [],
  nextPreviewNotes = [],
  basePhrases = [],
  basePhraseStates = [],
  ppq = INTERNAL_EDIT_PPQ,
} = {}) {
  const normalizedBaseNotes = cloneNotes(basePreviewNotes)
  const normalizedNextNotes = cloneNotes(nextPreviewNotes)
  const { edits, dirtyRanges: noteDirtyRanges } = buildNoteEdits(normalizedBaseNotes, normalizedNextNotes, { ppq })
  const dirtyPhraseIndices = basePhraseStates.length > 0
    ? collectDirtyPhraseIndicesFromStates(basePhraseStates, noteDirtyRanges)
    : collectDirtyPhraseIndices(basePhrases, noteDirtyRanges)
  const exactPhraseDirtyRanges = basePhraseStates.length > 0
    ? buildExactDirtyRangesFromStates(basePhraseStates, dirtyPhraseIndices)
    : buildExactDirtyRangesFromPhrases(basePhrases, dirtyPhraseIndices)
  const dirtyRanges = exactPhraseDirtyRanges.length > 0
    ? appendUnmatchedDirtyRanges(exactPhraseDirtyRanges, noteDirtyRanges)
    : noteDirtyRanges

  return {
    basePreviewNotes: normalizedBaseNotes,
    previewNotes: normalizedNextNotes,
    edits,
    dirtyRanges,
    dirtyPhraseIndices,
    needsVoiceRerender: edits.length > 0,
  }
}
