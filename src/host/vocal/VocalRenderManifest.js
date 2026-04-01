function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

function createPhraseState(phrase = {}, phraseIndex = 0) {
  return {
    phraseIndex: Number.isInteger(phrase.phraseIndex) ? phrase.phraseIndex : phrase.index ?? phraseIndex,
    inputHash: typeof phrase.inputHash === 'string' ? phrase.inputHash : null,
    status: typeof phrase.status === 'string' ? phrase.status : 'pending',
    startMs: Number.isFinite(phrase.startMs) ? phrase.startMs : null,
    durationMs: Number.isFinite(phrase.durationMs) ? phrase.durationMs : null,
  }
}

function buildPhraseStateMap(manifest) {
  const map = new Map()
  ;(manifest?.phraseStates || []).forEach((phraseState) => {
    map.set(phraseState.phraseIndex, phraseState)
  })
  return map
}

function summarizeManifest(manifest) {
  const phraseStates = Array.isArray(manifest?.phraseStates) ? manifest.phraseStates : []
  const completedPhraseCount = phraseStates.filter((phraseState) => phraseState.status === 'available').length
  return {
    ...manifest,
    completedPhraseCount,
    totalPhraseCount: phraseStates.length,
    lastSyncedAt: new Date().toISOString(),
  }
}

function normalizeProgressStatus(nextStatus, existingStatus, options = {}) {
  const hashChanged = options.hashChanged === true
  if (!hashChanged && existingStatus === 'available') return 'available'
  if (nextStatus === 'available') return 'available'
  if (nextStatus === 'failed') return 'failed'
  if (nextStatus === 'completed' || nextStatus === 'rendering' || nextStatus === 'preparing' || nextStatus === 'queued') {
    return 'rendering'
  }
  return 'pending'
}

export function createVocalRenderManifest(options = {}) {
  const phrases = Array.isArray(options.phrases) ? options.phrases : []
  const phraseStates = Array.isArray(options.phraseStates)
    ? options.phraseStates.map((phraseState, index) => createPhraseState(phraseState, index))
    : phrases.map((phrase, index) => createPhraseState(phrase, index))

  return summarizeManifest({
    revision: Number.isInteger(options.revision) ? options.revision : 0,
    jobId: options.jobId || null,
    status: typeof options.status === 'string' ? options.status : 'idle',
    hasPredictedPitch: Boolean(options.hasPredictedPitch),
    error: options.error || null,
    phraseStates,
  })
}

export function cloneVocalRenderManifest(manifest) {
  return cloneValue(manifest, createVocalRenderManifest())
}

export function syncManifestWithPhrases(manifest, phrases, revision = 0) {
  const safePhrases = Array.isArray(phrases) ? phrases : []
  const previousMap = buildPhraseStateMap(manifest)
  const preservePrevious = manifest?.revision === revision
  const nextPhraseStates = safePhrases.map((phrase, index) => {
    const phraseIndex = Number.isInteger(phrase?.index) ? phrase.index : index
    const previous = previousMap.get(phraseIndex)
    if (preservePrevious && previous && previous.inputHash === phrase?.inputHash) {
      return {
        ...previous,
        phraseIndex,
        inputHash: phrase.inputHash || previous.inputHash || null,
      }
    }
    return createPhraseState({
      phraseIndex,
      inputHash: phrase?.inputHash || null,
      status: 'pending',
    }, index)
  })

  return summarizeManifest({
    revision,
    jobId: manifest?.jobId || null,
    status: manifest?.status || 'idle',
    hasPredictedPitch: Boolean(manifest?.hasPredictedPitch),
    error: manifest?.error || null,
    phraseStates: nextPhraseStates,
  })
}

export function attachManifestJob(manifest, jobId) {
  return summarizeManifest({
    ...createVocalRenderManifest(manifest),
    jobId: jobId || null,
    status: jobId ? 'rendering' : manifest?.status || 'idle',
    error: null,
  })
}

export function markManifestPredictionReady(manifest) {
  return summarizeManifest({
    ...createVocalRenderManifest(manifest),
    hasPredictedPitch: true,
    error: null,
  })
}

export function applyManifestSync(manifest, payload = {}) {
  const nextManifest = createVocalRenderManifest(manifest)
  const previousMap = buildPhraseStateMap(nextManifest)
  const nextPhraseStates = Array.isArray(payload.phraseStates) && payload.phraseStates.length > 0
    ? payload.phraseStates.map((phraseState, index) => {
      const phraseIndex = Number.isInteger(phraseState?.phraseIndex) ? phraseState.phraseIndex : index
      const previous = previousMap.get(phraseIndex)
      const nextInputHash = phraseState?.inputHash || previous?.inputHash || null
      const hashChanged = (previous?.inputHash || null) !== nextInputHash
      return {
        phraseIndex,
        inputHash: nextInputHash,
        status: normalizeProgressStatus(phraseState?.status, previous?.status, { hashChanged }),
        startMs: Number.isFinite(phraseState?.startMs) ? phraseState.startMs : previous?.startMs ?? null,
        durationMs: Number.isFinite(phraseState?.durationMs) ? phraseState.durationMs : previous?.durationMs ?? null,
      }
    })
    : nextManifest.phraseStates

  return summarizeManifest({
    revision: Number.isInteger(payload.revision) ? payload.revision : nextManifest.revision,
    jobId: payload.jobId || nextManifest.jobId || null,
    status: typeof payload.status === 'string' ? payload.status : nextManifest.status,
    hasPredictedPitch: payload.hasPredictedPitch == null
      ? nextManifest.hasPredictedPitch
      : Boolean(payload.hasPredictedPitch),
    error: payload.error ?? nextManifest.error ?? null,
    phraseStates: nextPhraseStates,
  })
}

export function markManifestPhraseAvailable(manifest, payload = {}) {
  const nextManifest = createVocalRenderManifest(manifest)
  const phraseIndex = payload.phraseIndex
  if (!Number.isInteger(phraseIndex)) return nextManifest

  const previousMap = buildPhraseStateMap(nextManifest)
  const nextPhraseStates = nextManifest.phraseStates.map((phraseState) => {
    if (phraseState.phraseIndex !== phraseIndex) return phraseState
    return {
      ...phraseState,
      inputHash: payload.inputHash || phraseState.inputHash || null,
      status: 'available',
      startMs: Number.isFinite(payload.startMs) ? payload.startMs : phraseState.startMs,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : phraseState.durationMs,
    }
  })

  if (!previousMap.has(phraseIndex)) {
    nextPhraseStates.push(createPhraseState({
      phraseIndex,
      inputHash: payload.inputHash || null,
      status: 'available',
      startMs: payload.startMs,
      durationMs: payload.durationMs,
    }))
  }

  return summarizeManifest({
    ...nextManifest,
    phraseStates: nextPhraseStates.sort((left, right) => left.phraseIndex - right.phraseIndex),
  })
}

export function markManifestFailed(manifest, error) {
  return summarizeManifest({
    ...createVocalRenderManifest(manifest),
    status: 'failed',
    error: error || '未知错误',
  })
}
