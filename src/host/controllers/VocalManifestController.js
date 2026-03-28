import {
  applyManifestSync,
  attachManifestJob,
  createVocalRenderManifest,
  markManifestFailed,
  markManifestPhraseAvailable,
  markManifestPredictionReady,
  syncManifestWithPhrases,
} from '../vocal/VocalRenderManifest.js'

function resolveTrackPhrases(track, snapshot = null) {
  if (Array.isArray(snapshot?.phrases)) return snapshot.phrases
  if (Array.isArray(track?.voiceSnapshot?.phrases)) return track.voiceSnapshot.phrases
  return Array.isArray(track?.sourcePhrases) ? track.sourcePhrases : []
}

function getManifestPhraseState(manifest, phraseIndex) {
  if (!Number.isInteger(phraseIndex)) return null
  return (manifest?.phraseStates || []).find((phraseState) => phraseState?.phraseIndex === phraseIndex) || null
}

function manifestsEquivalent(left, right) {
  if (left === right) return true
  if (!left || !right) return false
  if ((left.revision || 0) !== (right.revision || 0)) return false
  if ((left.jobId || null) !== (right.jobId || null)) return false
  if ((left.status || 'idle') !== (right.status || 'idle')) return false
  if (Boolean(left.hasPredictedPitch) !== Boolean(right.hasPredictedPitch)) return false
  if ((left.error || null) !== (right.error || null)) return false

  const leftPhraseStates = Array.isArray(left.phraseStates) ? left.phraseStates : []
  const rightPhraseStates = Array.isArray(right.phraseStates) ? right.phraseStates : []
  if (leftPhraseStates.length !== rightPhraseStates.length) return false

  for (let index = 0; index < leftPhraseStates.length; index += 1) {
    const leftState = leftPhraseStates[index]
    const rightState = rightPhraseStates[index]
    if ((leftState?.phraseIndex ?? index) !== (rightState?.phraseIndex ?? index)) return false
    if ((leftState?.inputHash || null) !== (rightState?.inputHash || null)) return false
    if ((leftState?.status || 'pending') !== (rightState?.status || 'pending')) return false
    if ((leftState?.startMs ?? null) !== (rightState?.startMs ?? null)) return false
    if ((leftState?.durationMs ?? null) !== (rightState?.durationMs ?? null)) return false
  }

  return true
}

function buildPendingPhraseSyncKey({ trackId, jobId, phraseIndex, inputHash = null }) {
  return [
    trackId || 'track',
    jobId || 'job',
    Number.isInteger(phraseIndex) ? phraseIndex : -1,
    inputHash || 'no-hash',
  ].join(':')
}

export class VocalManifestController {
  constructor({ store, assetRegistry, logger = null } = {}) {
    this.store = store
    this.assetRegistry = assetRegistry
    this.logger = logger
    this.pendingPhraseSyncs = new Set()
  }

  resetProjectAssets() {
    this.pendingPhraseSyncs.clear()
    this.assetRegistry.reset()
  }

  resetTrackFromSnapshot(trackId, snapshot = null) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    this._clearPendingPhraseSyncs(trackId)
    this.assetRegistry.releaseTrack(trackId)
    const manifest = createVocalRenderManifest({
      revision: track.revision || 0,
      phrases: resolveTrackPhrases(track, snapshot),
    })
    this.store.replaceTrackVocalManifest(trackId, manifest)
    this._logManifest('HostVocalManifest reset', trackId, manifest)
    return manifest
  }

  markJobSubmitted(trackId, jobId) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    this._clearPendingPhraseSyncs(trackId)
    const manifest = attachManifestJob(
      syncManifestWithPhrases(track.vocalManifest, resolveTrackPhrases(track), track.revision || 0),
      jobId,
    )
    this.store.replaceTrackVocalManifest(trackId, manifest)
    this._logManifest('HostVocalManifest updated', trackId, manifest)
    return manifest
  }

  markPredictionReady(trackId, snapshot = null) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    let manifest = syncManifestWithPhrases(track.vocalManifest, resolveTrackPhrases(track, snapshot), track.revision || 0)
    manifest = attachManifestJob(manifest, snapshot?.jobId || track.jobRef?.jobId || null)
    manifest = markManifestPredictionReady(manifest)
    this.store.replaceTrackVocalManifest(trackId, manifest)
    this._logManifest('HostVocalManifest updated', trackId, manifest)
    return manifest
  }

  syncRenderManifest(payload = {}) {
    const track = this.store.getTrack(payload.trackId)
    if (!track) return null
    const currentManifest = track.vocalManifest
    const baseManifest = syncManifestWithPhrases(track.vocalManifest, resolveTrackPhrases(track), track.revision || 0)
    const manifest = applyManifestSync(baseManifest, {
      ...payload,
      revision: track.revision || 0,
    })
    if (!manifestsEquivalent(currentManifest, manifest)) {
      this.store.replaceTrackVocalManifest(track.id, manifest)
      this._logManifest('HostVocalManifest updated', track.id, manifest)
    }
    ;(payload.phraseStates || [])
      .filter((phraseState) => phraseState?.status === 'completed')
      .forEach((phraseState) => {
        this._schedulePhraseReadySync(track.id, manifest.jobId, phraseState)
      })
    return manifest
  }

  async handlePhraseReady(payload = {}) {
    const track = this.store.getTrack(payload.trackId)
    if (!track) return false
    const manifest = track.vocalManifest
    if (!manifest?.jobId || manifest.jobId !== payload.jobId || !Number.isInteger(payload.phraseIndex)) return false
    if (getManifestPhraseState(manifest, payload.phraseIndex)?.status === 'available') return false

    const phraseRef = {
      trackId: track.id,
      revision: manifest.revision || 0,
      jobId: manifest.jobId,
      phraseIndex: payload.phraseIndex,
      inputHash: payload.inputHash || null,
      startMs: payload.startMs,
      durationMs: payload.durationMs,
    }

    const asset = await this.assetRegistry.ensurePhraseAsset(phraseRef)
    const freshTrack = this.store.getTrack(track.id)
    if (!freshTrack?.vocalManifest || freshTrack.vocalManifest.jobId !== phraseRef.jobId) return false
    if (getManifestPhraseState(freshTrack.vocalManifest, phraseRef.phraseIndex)?.status === 'available') return false

    const nextManifest = markManifestPhraseAvailable(freshTrack.vocalManifest, {
      phraseIndex: phraseRef.phraseIndex,
      inputHash: phraseRef.inputHash,
      startMs: asset.startMs,
      durationMs: asset.durationMs,
    })
    if (manifestsEquivalent(freshTrack.vocalManifest, nextManifest)) return false
    this.store.replaceTrackVocalManifest(track.id, nextManifest)
    this._logManifest('HostVocalManifest updated', track.id, nextManifest)
    return true
  }

  markRenderComplete(trackId, snapshot = null) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    this._clearPendingPhraseSyncs(trackId)
    let manifest = syncManifestWithPhrases(track.vocalManifest, resolveTrackPhrases(track, snapshot), track.revision || 0)
    manifest = attachManifestJob(manifest, snapshot?.jobId || track.jobRef?.jobId || null)
    manifest = {
      ...manifest,
      status: 'completed',
    }
    this.store.replaceTrackVocalManifest(track.id, manifest)
    this._logManifest('HostVocalManifest updated', track.id, manifest)
    return manifest
  }

  markRenderFailed(trackId, error) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    this._clearPendingPhraseSyncs(trackId)
    const manifest = markManifestFailed(track.vocalManifest, error)
    this.store.replaceTrackVocalManifest(track.id, manifest)
    this._logManifest('HostVocalManifest updated', track.id, manifest)
    return manifest
  }

  _schedulePhraseReadySync(trackId, jobId, phraseState = {}) {
    if (!trackId || !jobId || !Number.isInteger(phraseState?.phraseIndex)) return
    const track = this.store.getTrack(trackId)
    if (!track) return
    if (getManifestPhraseState(track.vocalManifest, phraseState.phraseIndex)?.status === 'available') return

    const syncKey = buildPendingPhraseSyncKey({
      trackId,
      jobId,
      phraseIndex: phraseState.phraseIndex,
      inputHash: phraseState.inputHash || null,
    })
    if (this.pendingPhraseSyncs.has(syncKey)) return
    this.pendingPhraseSyncs.add(syncKey)

    this.handlePhraseReady({
      trackId,
      jobId,
      phraseIndex: phraseState.phraseIndex,
      inputHash: phraseState.inputHash,
      startMs: phraseState.startMs,
      durationMs: phraseState.durationMs,
    })
      .catch((error) => {
        this.logger?.info?.('HostVocalAssetRegistry phrase sync failed', {
          trackId,
          phraseIndex: phraseState.phraseIndex,
          error: error?.message || String(error),
        })
      })
      .finally(() => {
        this.pendingPhraseSyncs.delete(syncKey)
      })
  }

  _clearPendingPhraseSyncs(trackId) {
    if (!trackId) return
    const prefix = `${trackId}:`
    for (const syncKey of this.pendingPhraseSyncs) {
      if (syncKey.startsWith(prefix)) this.pendingPhraseSyncs.delete(syncKey)
    }
  }

  _logManifest(message, trackId, manifest) {
    this.logger?.info?.(message, {
      trackId,
      revision: manifest?.revision || 0,
      completed: manifest?.completedPhraseCount || 0,
      total: manifest?.totalPhraseCount || 0,
      status: manifest?.status || 'idle',
    })
  }
}
