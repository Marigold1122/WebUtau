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

export class VocalManifestController {
  constructor({ store, assetRegistry, logger = null } = {}) {
    this.store = store
    this.assetRegistry = assetRegistry
    this.logger = logger
  }

  resetProjectAssets() {
    this.assetRegistry.reset()
  }

  resetTrackFromSnapshot(trackId, snapshot = null) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
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
    const baseManifest = syncManifestWithPhrases(track.vocalManifest, resolveTrackPhrases(track), track.revision || 0)
    const manifest = applyManifestSync(baseManifest, {
      ...payload,
      revision: track.revision || 0,
    })
    this.store.replaceTrackVocalManifest(track.id, manifest)
    this._logManifest('HostVocalManifest updated', track.id, manifest)
    ;(payload.phraseStates || [])
      .filter((phraseState) => phraseState?.status === 'completed')
      .forEach((phraseState) => {
        this.handlePhraseReady({
          trackId: track.id,
          jobId: manifest.jobId,
          phraseIndex: phraseState.phraseIndex,
          inputHash: phraseState.inputHash,
          startMs: phraseState.startMs,
          durationMs: phraseState.durationMs,
        }).catch((error) => {
          this.logger?.info?.('HostVocalAssetRegistry phrase sync failed', {
            trackId: track.id,
            phraseIndex: phraseState.phraseIndex,
            error: error?.message || String(error),
          })
        })
      })
    return manifest
  }

  async handlePhraseReady(payload = {}) {
    const track = this.store.getTrack(payload.trackId)
    if (!track) return false
    const manifest = track.vocalManifest
    if (!manifest?.jobId || manifest.jobId !== payload.jobId) return false

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

    const nextManifest = markManifestPhraseAvailable(freshTrack.vocalManifest, {
      phraseIndex: phraseRef.phraseIndex,
      inputHash: phraseRef.inputHash,
      startMs: asset.startMs,
      durationMs: asset.durationMs,
    })
    this.store.replaceTrackVocalManifest(track.id, nextManifest)
    this._logManifest('HostVocalManifest updated', track.id, nextManifest)
    return true
  }

  markRenderComplete(trackId, snapshot = null) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
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
    const manifest = markManifestFailed(track.vocalManifest, error)
    this.store.replaceTrackVocalManifest(track.id, manifest)
    this._logManifest('HostVocalManifest updated', track.id, manifest)
    return manifest
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
