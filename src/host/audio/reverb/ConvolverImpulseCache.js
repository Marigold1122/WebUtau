function clampPositiveInteger(value, fallback = 32) {
  const normalized = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(1, normalized)
}

function roundForKey(value, digits = 4) {
  if (!Number.isFinite(value)) return 'NaN'
  return Number(value).toFixed(digits)
}

export class ConvolverImpulseCache {
  constructor({ maxEntries = 32, keyPrecision = 4 } = {}) {
    this.maxEntries = clampPositiveInteger(maxEntries)
    this.keyPrecision = clampPositiveInteger(keyPrecision, 4)
    this.cache = new Map()
    this.contextIds = new WeakMap()
    this.nextContextId = 1
  }

  getOrCreate(rawContext, config = {}, builder) {
    if (!rawContext || typeof builder !== 'function') {
      return { buffer: null, cacheHit: false }
    }
    const cacheKey = this._buildCacheKey(rawContext, config)
    if (this.cache.has(cacheKey)) {
      const cachedBuffer = this.cache.get(cacheKey)
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cachedBuffer)
      return {
        buffer: cachedBuffer,
        cacheHit: true,
      }
    }

    const builtBuffer = builder(rawContext, config)
    if (!builtBuffer) {
      return { buffer: null, cacheHit: false }
    }

    this.cache.set(cacheKey, builtBuffer)
    this._trimOverflow()
    return {
      buffer: builtBuffer,
      cacheHit: false,
    }
  }

  clear() {
    this.cache.clear()
  }

  _trimOverflow() {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next()?.value
      if (!oldestKey) break
      this.cache.delete(oldestKey)
    }
  }

  _buildCacheKey(rawContext, config = {}) {
    const contextId = this._resolveContextId(rawContext)
    return [
      contextId,
      rawContext.sampleRate || 48000,
      roundForKey(config?.decaySec, this.keyPrecision),
      roundForKey(config?.decayCurve, this.keyPrecision),
    ].join(':')
  }

  _resolveContextId(rawContext) {
    let contextId = this.contextIds.get(rawContext)
    if (contextId) return contextId
    contextId = this.nextContextId
    this.nextContextId += 1
    this.contextIds.set(rawContext, contextId)
    return contextId
  }
}
