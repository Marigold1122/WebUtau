import { RENDER_API_BASE_URL } from '../../api/RenderApi.js'
import { getToneRawContext } from '../audio/instruments/toneRuntime.js'

function buildAssetKey(ref = {}) {
  return [
    ref.trackId || 'track',
    Number.isInteger(ref.revision) ? ref.revision : 0,
    Number.isInteger(ref.phraseIndex) ? ref.phraseIndex : -1,
    ref.inputHash || 'no-hash',
  ].join(':')
}

async function fetchPhraseBuffer(jobId, phraseIndex) {
  const response = await fetch(`${RENDER_API_BASE_URL}/api/jobs/${jobId}/phrases/${phraseIndex}`)
  if (!response.ok) {
    throw new Error(`phrase download failed: ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const rawContext = await getToneRawContext()
  return rawContext.decodeAudioData(arrayBuffer)
}

export class HostVocalAssetRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.entries = new Map()
  }

  getAssetKey(ref) {
    return buildAssetKey(ref)
  }

  getAsset(ref) {
    const key = buildAssetKey(ref)
    const entry = this.entries.get(key)
    return entry?.buffer ? entry : null
  }

  hasAsset(ref) {
    return Boolean(this.getAsset(ref))
  }

  async ensurePhraseAsset(ref = {}) {
    const key = buildAssetKey(ref)
    const current = this.entries.get(key)
    if (current?.buffer) return current
    if (current?.promise) return current.promise

    const entry = {
      key,
      trackId: ref.trackId || null,
      revision: Number.isInteger(ref.revision) ? ref.revision : 0,
      phraseIndex: Number.isInteger(ref.phraseIndex) ? ref.phraseIndex : -1,
      inputHash: ref.inputHash || null,
      startMs: Number.isFinite(ref.startMs) ? ref.startMs : null,
      durationMs: Number.isFinite(ref.durationMs) ? ref.durationMs : null,
      buffer: null,
      promise: null,
    }

    entry.promise = fetchPhraseBuffer(ref.jobId, entry.phraseIndex)
      .then((buffer) => {
        entry.buffer = buffer
        entry.promise = null
        this.logger?.info?.('HostVocalAssetRegistry phrase downloaded', {
          trackId: entry.trackId,
          revision: entry.revision,
          phraseIndex: entry.phraseIndex,
          inputHash: entry.inputHash,
        })
        return entry
      })
      .catch((error) => {
        this.entries.delete(key)
        throw error
      })

    this.entries.set(key, entry)
    return entry.promise
  }

  releaseTrack(trackId) {
    if (!trackId) return
    for (const [key, entry] of this.entries) {
      if (entry.trackId !== trackId) continue
      this.entries.delete(key)
    }
  }

  reset() {
    this.entries.clear()
  }
}
