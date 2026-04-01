import { normalizeReverbConfig } from '../../project/reverbConfigState.js'
import { ConvolverImpulseCache } from './ConvolverImpulseCache.js'
import { diffReverbConfig } from './ReverbConfigDiff.js'
import { markImpulseRebuildCost, markReverbProbe } from './ReverbDebugProbe.js'
import { buildImpulseResponse } from './ImpulseResponseBuilder.js'

const IMPULSE_CACHE = new ConvolverImpulseCache({
  maxEntries: 64,
  keyPrecision: 4,
})

export class ConvolverReverbBackend {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.rawContext = null
    this.config = normalizeReverbConfig()
    this.convolver = null
    this.inputNode = null
    this.outputNode = null
  }

  prepare(rawContext, config = null) {
    if (!rawContext) return false
    const normalizedConfig = normalizeReverbConfig(config, this.config)
    if (this.rawContext !== rawContext || !this.convolver) {
      this.disconnect()
      this.rawContext = rawContext
      this.convolver = rawContext.createConvolver()
      this.convolver.normalize = true
    }
    this.config = normalizedConfig
    this._applyImpulseBuffer()
    return true
  }

  connect(inputNode, outputNode) {
    if (!this.convolver || !inputNode || !outputNode) return false
    this.disconnect()
    inputNode.connect(this.convolver)
    this.convolver.connect(outputNode)
    this.inputNode = inputNode
    this.outputNode = outputNode
    return true
  }

  disconnect() {
    try { this.inputNode?.disconnect?.(this.convolver) } catch (_error) {}
    try { this.convolver?.disconnect?.(this.outputNode) } catch (_error) {}
    try { this.convolver?.disconnect?.() } catch (_error) {}
    this.inputNode = null
    this.outputNode = null
  }

  setConfig(config = {}) {
    markReverbProbe('reverbBackendSetConfigCalls')
    const nextConfig = normalizeReverbConfig(config, this.config)
    const diff = diffReverbConfig(this.config, nextConfig)
    if (!diff.hasChanges) return this.config
    this.config = nextConfig
    if (this.rawContext && this.convolver && diff.needsImpulseRebuild) {
      this._applyImpulseBuffer()
    }
    return this.config
  }

  dispose() {
    this.disconnect()
    this.rawContext = null
    this.convolver = null
  }

  _applyImpulseBuffer() {
    if (!this.rawContext || !this.convolver) return false
    const buildStartedAt = nowMs()
    const { buffer, cacheHit } = IMPULSE_CACHE.getOrCreate(
      this.rawContext,
      this.config,
      buildImpulseResponse,
    )
    if (!buffer) return false
    this.convolver.buffer = buffer
    if (cacheHit) {
      markReverbProbe('impulseCacheHits')
      return true
    }
    markReverbProbe('impulseCacheMisses')
    markImpulseRebuildCost(nowMs() - buildStartedAt)
    return true
  }
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}
