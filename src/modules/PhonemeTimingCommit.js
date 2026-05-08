import phraseStore from '../core/PhraseStore.js'
import renderApi from '../api/RenderApi.js'
import audioEngine from './AudioEngine.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import phonemeTimingStore from './PhonemeTimingStore.js'
import {
  buildPhonemeTimingEditRequest,
  normalizePhonemeTimingAffectedIndices,
  normalizePhonemeTimingEditResponse,
} from '../shared/phonemeTimingContract.js'

export function buildPhonemeTimingCommitRequest(preview, snapshot = phonemeTimingStore.getSnapshot()) {
  return buildPhonemeTimingEditRequest(preview, snapshot)
}

export async function commitPhonemeTimingPreview(preview, deps = defaultDeps()) {
  const request = buildPhonemeTimingCommitRequest(preview, deps.store.getSnapshot())
  if (!request) throw new Error('Invalid phoneme timing preview')

  const jobId = deps.phraseStore.getJobId()
  if (!jobId) throw new Error('No active job')

  const seed = collectPreviewPhraseIndices(preview)
  const cacheSnapshot = deps.cache.capture?.(seed) ?? []
  const interactiveEditToken = deps.jobs.beginInteractiveEdit?.(seed) ?? null
  if (seed.length > 0) {
    deps.cache.clearIndices(seed)
    deps.audio.cancelPhrases?.(seed)
  }

  try {
    const response = await deps.api.applyPhonemeTimingEdit(jobId, request)
    applyPhonemeTimingCommitResponse(response, preview, {
      ...deps,
      cacheSnapshot,
      interactiveEditToken,
      optimisticSeed: seed,
    })
    return response
  } catch (error) {
    deps.cache.restore?.(cacheSnapshot)
    deps.store.setPreview?.(null)
    deps.jobs.endInteractiveEdit?.(interactiveEditToken)
    throw error
  }
}

export function applyPhonemeTimingCommitResponse(response, preview, deps = defaultDeps()) {
  const normalized = normalizePhonemeTimingEditResponse(response)
  const seed = deps.optimisticSeed ?? collectPreviewPhraseIndices(preview)
  const affected = normalized.affectedIndices.length > 0 ? normalized.affectedIndices : seed
  const phrases = Array.isArray(normalized.phrases) ? normalized.phrases : []
  const phraseUpdate = applyReturnedPhraseMetadata(phrases, deps.phraseStore)
  const phraseCount = deps.phraseStore.getPhrases().length
  const affectedSet = new Set(affected)
  const restoredSeed = seed.filter((index) => !affectedSet.has(index))
  const affectedToClear = deps.optimisticSeed
    ? affected.filter((index) => !seed.includes(index))
    : affected

  deps.store.setSnapshot(normalized.snapshot)

  if (restoredSeed.length > 0 && Array.isArray(deps.cacheSnapshot)) {
    deps.cache.restore?.(deps.cacheSnapshot.filter((entry) => restoredSeed.includes(entry.phraseIndex)))
  }

  if (affectedToClear.length > 0) {
    deps.cache.clearIndices(affectedToClear)
    deps.audio.cancelPhrases?.(affectedToClear)
  }
  if (phraseUpdate.phrasesChanged) {
    deps.cache.clearAbove(phraseCount)
  }

  restartPhonemeTimingRender(deps, {
    affectedIndices: affected,
    phraseCount,
    phrasesChanged: phraseUpdate.phrasesChanged,
    snapshot: normalized.snapshot,
  })
  deps.jobs.endInteractiveEdit?.(deps.interactiveEditToken)
}

export function collectPreviewPhraseIndices(preview) {
  const values = []
  if (Number.isInteger(preview?.hit?.phraseIndex)) values.push(preview.hit.phraseIndex)
  for (const item of Array.isArray(preview?.items) ? preview.items : []) {
    if (Number.isInteger(item?.phraseIndex)) values.push(item.phraseIndex)
  }
  return normalizeIndices(values)
}

function defaultDeps() {
  return {
    api: renderApi,
    audio: audioEngine,
    cache: renderCache,
    jobs: renderJobManager,
    phraseStore,
    store: phonemeTimingStore,
  }
}

function normalizeIndices(values) {
  return normalizePhonemeTimingAffectedIndices(values)
}

function applyReturnedPhraseMetadata(phrases, phraseStore) {
  if (!Array.isArray(phrases) || phrases.length === 0) {
    return { phrasesChanged: false, timingChanged: false }
  }

  const current = phraseStore.getPhrases()
  if (canApplyTimingMetadataOnly(phrases, current)
    && typeof phraseStore.applyBackendPhraseTimingMetadata === 'function') {
    return {
      phrasesChanged: false,
      timingChanged: phraseStore.applyBackendPhraseTimingMetadata(phrases),
    }
  }

  phraseStore.rebuildFromEdit(phrases)
  return { phrasesChanged: true, timingChanged: true }
}

function canApplyTimingMetadataOnly(phrases, currentPhrases) {
  if (!Array.isArray(currentPhrases) || currentPhrases.length === 0) return false
  return phrases.every((phrase) => {
    const index = Number.isInteger(phrase?.index) ? phrase.index : -1
    const current = currentPhrases[index]
    if (!current) return false
    return phraseNoteShapeMatches(phrase, current)
  })
}

function phraseNoteShapeMatches(backendPhrase, currentPhrase) {
  const backendNotes = Array.isArray(backendPhrase?.notes) ? backendPhrase.notes : []
  const currentNotes = Array.isArray(currentPhrase?.notes) ? currentPhrase.notes : []
  if (backendNotes.length !== currentNotes.length) return false
  return backendNotes.every((note, index) => {
    const current = currentNotes[index]
    return Math.max(0, Math.round(note?.position || 0)) === Math.max(0, Math.round(current?.tick || 0))
      && Math.max(1, Math.round(note?.duration || 1)) === Math.max(1, Math.round(current?.durationTicks || 1))
      && Math.round(note?.tone || 60) === Math.round(current?.midi || 60)
  })
}

function restartPhonemeTimingRender(deps, options) {
  if (options.affectedIndices.length === 0 && !options.phrasesChanged) return
  if (typeof deps.jobs.restartForPhonemeTimingEdit === 'function') {
    deps.jobs.restartForPhonemeTimingEdit(options)
    return
  }
  deps.jobs.restartForEdit(options.phraseCount)
  deps.store.setSnapshot?.(options.snapshot)
}
