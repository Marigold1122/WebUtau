import phraseStore from '../core/PhraseStore.js'
import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'
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
  const renderVersion = buildPhonemeTimingRenderVersion(request)
  const phraseHashSnapshot = deps.phraseStore.capturePhraseHashes?.(seed) ?? []
  const cacheSnapshot = deps.cache.capture?.(seed) ?? []
  const interactiveEditToken = deps.jobs.beginInteractiveEdit?.(seed) ?? null
  if (seed.length > 0) {
    applyPhonemeTimingRenderVersion(deps.phraseStore, seed, renderVersion)
    deps.cache.clearIndices(seed)
    emitCacheInvalidated(deps, seed)
    deps.audio.cancelPhrases?.(seed)
  }

  try {
    const response = await deps.api.applyPhonemeTimingEdit(jobId, request)
    applyPhonemeTimingCommitResponse(response, preview, {
      ...deps,
      cacheSnapshot,
      interactiveEditToken,
      optimisticSeed: seed,
      phraseHashSnapshot,
      renderVersion,
    })
    return response
  } catch (error) {
    deps.phraseStore.restorePhraseHashes?.(phraseHashSnapshot)
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
  const renderVersion = deps.renderVersion || buildPhonemeTimingSnapshotRenderVersion(normalized.snapshot)
  // Backend should send Phrases only when structure truly changed. If a
  // non-trivial project (>4 phrases) still flags at least 50% of phrases as affected with
  // phrasesChanged=false, treat it as anomalous and fall back to the wide restart
  // path so renderJobManager preserves cached audio via hasAudio() rather than
  // clearing nearly everything piecewise.
  const looksLikeStructureChange = !phraseUpdate.phrasesChanged
    && phraseCount > 4
    && affected.length > Math.floor(phraseCount / 2)
  const phrasesChanged = phraseUpdate.phrasesChanged || looksLikeStructureChange
  const affectedSet = new Set(affected)
  const restoredSeed = seed.filter((index) => !affectedSet.has(index))
  const affectedToClear = deps.optimisticSeed
    ? affected.filter((index) => !seed.includes(index))
    : affected

  deps.store.setSnapshot(normalized.snapshot)

  if (restoredSeed.length > 0 && Array.isArray(deps.cacheSnapshot)) {
    deps.phraseStore.restorePhraseHashes?.((deps.phraseHashSnapshot || []).filter((entry) => restoredSeed.includes(entry.phraseIndex)))
    deps.cache.restore?.(deps.cacheSnapshot.filter((entry) => restoredSeed.includes(entry.phraseIndex)))
  }

  if (affected.length > 0) {
    applyPhonemeTimingRenderVersion(deps.phraseStore, affected, renderVersion)
  }

  if (affectedToClear.length > 0) {
    deps.cache.clearIndices(affectedToClear)
    emitCacheInvalidated(deps, affectedToClear)
    deps.audio.cancelPhrases?.(affectedToClear)
  }
  if (phraseUpdate.phrasesChanged) {
    deps.cache.clearAbove(phraseCount)
  }

  restartPhonemeTimingRender(deps, {
    affectedIndices: affected,
    phraseCount,
    phrasesChanged,
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
    events: eventBus,
  }
}

function normalizeIndices(values) {
  return normalizePhonemeTimingAffectedIndices(values)
}

function applyReturnedPhraseMetadata(phrases, phraseStore) {
  // Contract: backend only sends Phrases when phrase count or split actually changed
  // (see SynthesisController.PhonemeTiming.cs and the PhrasesChanged flag). Reaching
  // here with a non-empty phrases array means structure changed, so rebuild directly.
  if (!Array.isArray(phrases) || phrases.length === 0) {
    return { phrasesChanged: false, timingChanged: false }
  }
  phraseStore.rebuildFromEdit(phrases)
  return { phrasesChanged: true, timingChanged: true }
}

function restartPhonemeTimingRender(deps, options) {
  if (options.affectedIndices.length === 0 && !options.phrasesChanged) return
  if (typeof deps.jobs.restartForPhonemeTimingEdit === 'function') {
    deps.jobs.restartForPhonemeTimingEdit(options)
    // restartForPhonemeTimingEdit delegates to restartForEdit when phrasesChanged,
    // and restartForEdit clears phonemeTimingStore (it's also used by reset paths).
    // Re-apply the authoritative snapshot so the visual layer doesn't flash empty.
    if (options.phrasesChanged) deps.store.setSnapshot?.(options.snapshot)
    return
  }
  deps.jobs.restartForEdit(options.phraseCount)
  deps.store.setSnapshot?.(options.snapshot)
}

function applyPhonemeTimingRenderVersion(phraseStore, indices, renderVersion) {
  phraseStore?.applyPhonemeTimingRenderVersion?.(indices, renderVersion)
}

function emitCacheInvalidated(deps, indices) {
  if (!Array.isArray(indices) || indices.length === 0) return
  for (const phraseIndex of indices) {
    deps.events?.emit?.(EVENTS.CACHE_INVALIDATED, { phraseIndex })
  }
}

function buildPhonemeTimingRenderVersion(request) {
  return fnvRenderVersion([
    request?.clientRevision || '',
    request?.partIndex ?? '',
    request?.noteKey || '',
    request?.phonemeIndex ?? '',
    request?.editType || '',
    request?.value == null ? '<null>' : request.value,
  ])
}

function buildPhonemeTimingSnapshotRenderVersion(snapshot) {
  return fnvRenderVersion([snapshot?.revision || 'snapshot'])
}

function fnvRenderVersion(values) {
  let hash = 2166136261
  let length = 0
  for (const value of values) {
    const text = String(value)
    length += text.length
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 31
    hash = Math.imul(hash, 16777619)
  }
  return `${length.toString(36)}-${(hash >>> 0).toString(36)}`
}
