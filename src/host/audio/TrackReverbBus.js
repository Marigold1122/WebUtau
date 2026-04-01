import { normalizeReverbConfig } from '../project/reverbConfigState.js'
import { diffReverbConfig } from './reverb/ReverbConfigDiff.js'
import { markReverbProbe } from './reverb/ReverbDebugProbe.js'
import { getSharedReverbEngineRegistry } from './reverb/ReverbEngineRegistry.js'
import { LEGACY_REVERB_ENGINE_ID } from './reverb/ReverbParameterSchema.js'

const REVERB_WET_ENABLE_THRESHOLD = 0.0001

export class TrackReverbBus {
  constructor({
    logger = null,
    config = null,
    engineId = LEGACY_REVERB_ENGINE_ID,
    engineRegistry = null,
  } = {}) {
    this.logger = logger
    this.config = normalizeReverbConfig(config)
    this.engineId = typeof engineId === 'string' && engineId.trim()
      ? engineId.trim()
      : LEGACY_REVERB_ENGINE_ID
    this.engineRegistry = engineRegistry || getSharedReverbEngineRegistry()
    this.rawContext = null
    this.inputNode = null
    this.outputNode = null
    this.preDelay = null
    this.highPass = null
    this.lowPass = null
    this.returnGain = null
    this.wetConnected = null
    this.backend = this.engineRegistry.create(this.engineId, { logger })
      || this.engineRegistry.create(LEGACY_REVERB_ENGINE_ID, { logger })
  }

  attach({ rawContext, inputNode, outputNode }) {
    if (!rawContext || !inputNode || !outputNode) return false
    if (this.rawContext === rawContext && this.inputNode === inputNode && this.outputNode === outputNode) {
      this._applyConfig()
      return true
    }

    this.dispose()
    this.rawContext = rawContext
    this.inputNode = inputNode
    this.outputNode = outputNode
    this.preDelay = rawContext.createDelay(0.2)
    this.highPass = rawContext.createBiquadFilter()
    this.lowPass = rawContext.createBiquadFilter()
    this.returnGain = rawContext.createGain()

    this.highPass.type = 'highpass'
    this.lowPass.type = 'lowpass'

    inputNode.connect(this.preDelay)
    this.preDelay.connect(this.highPass)
    this.highPass.connect(this.lowPass)
    this.returnGain.connect(outputNode)

    this.backend?.prepare?.(rawContext, this.config)
    this.wetConnected = null
    this._syncWetRouting()
    this._applyConfig()
    return true
  }

  setConfig(config = {}) {
    markReverbProbe('reverbBusSetConfigCalls')
    const nextConfig = normalizeReverbConfig(config, this.config)
    const diff = diffReverbConfig(this.config, nextConfig)
    if (!diff.hasChanges) return this.config
    this.config = nextConfig
    this._applyConfig(diff.changedKeys)
    if (diff.needsImpulseRebuild) {
      this.backend?.setConfig?.(this.config)
    }
    return this.config
  }

  dispose() {
    this.backend?.dispose?.()
    try { this.inputNode?.disconnect?.(this.preDelay) } catch (_error) {}
    try { this.preDelay?.disconnect?.() } catch (_error) {}
    try { this.highPass?.disconnect?.() } catch (_error) {}
    try { this.lowPass?.disconnect?.() } catch (_error) {}
    try { this.returnGain?.disconnect?.() } catch (_error) {}
    this.rawContext = null
    this.inputNode = null
    this.outputNode = null
    this.preDelay = null
    this.highPass = null
    this.lowPass = null
    this.returnGain = null
    this.wetConnected = null
  }

  _applyConfig(changedKeys = null) {
    if (!this.preDelay || !this.highPass || !this.lowPass || !this.returnGain) return false
    const hasKeyFilter = Array.isArray(changedKeys) && changedKeys.length > 0
    if (!hasKeyFilter || changedKeys.includes('preDelaySec')) {
      this.preDelay.delayTime.value = this.config.preDelaySec
    }
    if (!hasKeyFilter || changedKeys.includes('lowCutHz')) {
      this.highPass.frequency.value = this.config.lowCutHz
    }
    if (!hasKeyFilter || changedKeys.includes('highCutHz')) {
      this.lowPass.frequency.value = this.config.highCutHz
    }
    if (!hasKeyFilter || changedKeys.includes('returnGain')) {
      this.returnGain.gain.value = this.config.returnGain
      this._syncWetRouting()
    }
    return true
  }

  _syncWetRouting() {
    if (!this.lowPass || !this.returnGain || !this.backend) return false
    const shouldEnableWet = Number(this.config?.returnGain || 0) > REVERB_WET_ENABLE_THRESHOLD
    if (shouldEnableWet === this.wetConnected) return false
    if (shouldEnableWet) {
      this.backend?.connect?.(this.lowPass, this.returnGain)
      markReverbProbe('wetRouteConnectCalls')
    } else {
      this.backend?.disconnect?.()
      markReverbProbe('wetRouteDisconnectCalls')
    }
    this.wetConnected = shouldEnableWet
    return true
  }
}
