import { getToneRawContext } from '../audio/instruments/toneRuntime.js'

async function decodeAsset(assetUrl) {
  const response = await fetch(assetUrl)
  if (!response.ok) {
    throw new Error(`converted vocal download failed: ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const rawContext = await getToneRawContext()
  return rawContext.decodeAudioData(arrayBuffer)
}

export class ConvertedVocalAssetRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.entries = new Map()
  }

  getAsset(assetKey) {
    const entry = this.entries.get(assetKey)
    return entry?.buffer ? entry : null
  }

  hasAsset(assetKey) {
    return Boolean(this.getAsset(assetKey))
  }

  async ensureAsset(ref = {}) {
    const assetKey = ref.assetKey
    const assetUrl = ref.assetUrl
    if (!assetKey || !assetUrl) throw new Error('缺少转换音频资产标识')

    const current = this.entries.get(assetKey)
    if (current?.buffer) return current
    if (current?.promise) return current.promise

    const entry = {
      assetKey,
      trackId: ref.trackId || null,
      sourceJobId: ref.sourceJobId || null,
      sourceRevision: Number.isInteger(ref.sourceRevision) ? ref.sourceRevision : 0,
      assetUrl,
      buffer: null,
      promise: null,
    }

    entry.promise = decodeAsset(assetUrl)
      .then((buffer) => {
        entry.buffer = buffer
        entry.promise = null
        this.logger?.info?.('ConvertedVocalAsset ready', {
          trackId: entry.trackId,
          assetKey,
          duration: buffer.duration,
        })
        return entry
      })
      .catch((error) => {
        this.entries.delete(assetKey)
        throw error
      })

    this.entries.set(assetKey, entry)
    return entry.promise
  }

  releaseTrack(trackId) {
    if (!trackId) return
    for (const [assetKey, entry] of this.entries) {
      if (entry.trackId !== trackId) continue
      this.entries.delete(assetKey)
    }
  }

  reset() {
    this.entries.clear()
  }
}
