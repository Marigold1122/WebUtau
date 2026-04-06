export class SourceSamplerRegistry {
  constructor() {
    this.bufferPromises = new Map()
  }

  createSamplerEntry({
    Tone,
    config,
    urls,
    destination = null,
    volume = 0,
    toneContext = null,
  }) {
    const entry = {
      ready: false,
      sampler: null,
      readyPromise: null,
      error: null,
    }

    entry.readyPromise = (async () => {
      const resolvedUrls = await this._resolveUrls(Tone, config?.baseUrl || '', urls)
      entry.sampler = new Tone.Sampler({
        urls: resolvedUrls,
        baseUrl: '',
        release: config?.release || 1,
        volume,
        ...(toneContext ? { context: toneContext } : {}),
      })

      if (destination) {
        entry.sampler.connect(destination)
      } else {
        entry.sampler.toDestination?.()
      }

      entry.ready = true
      return entry
    })().catch((error) => {
      entry.error = error
      throw error
    })

    return entry
  }

  async _resolveUrls(Tone, baseUrl, urls = {}) {
    const pairs = await Promise.all(
      Object.entries(urls).map(async ([note, url]) => [
        note,
        await this._loadBuffer(Tone, this._resolveAssetUrl(baseUrl, url)),
      ]),
    )
    return Object.fromEntries(pairs)
  }

  _loadBuffer(Tone, resolvedUrl) {
    if (!this.bufferPromises.has(resolvedUrl)) {
      const promise = Promise.resolve(Tone.ToneAudioBuffer.load(resolvedUrl)).catch((error) => {
        this.bufferPromises.delete(resolvedUrl)
        throw error
      })
      this.bufferPromises.set(resolvedUrl, promise)
    }
    return this.bufferPromises.get(resolvedUrl)
  }

  _resolveAssetUrl(baseUrl, url) {
    if (!baseUrl) return url
    return `${baseUrl}${url}`
  }
}
