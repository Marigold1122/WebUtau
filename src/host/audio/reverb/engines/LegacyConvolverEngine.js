import { LEGACY_REVERB_ENGINE_ID } from '../ReverbParameterSchema.js'
import { ConvolverReverbBackend } from '../ConvolverReverbBackend.js'

export class LegacyConvolverEngine {
  constructor({ logger = null } = {}) {
    this.engineId = LEGACY_REVERB_ENGINE_ID
    this.logger = logger
    this.backend = new ConvolverReverbBackend({ logger })
  }

  prepare(rawContext, config = null) {
    return this.backend.prepare(rawContext, config)
  }

  connect(inputNode, outputNode) {
    return this.backend.connect(inputNode, outputNode)
  }

  disconnect() {
    this.backend.disconnect()
  }

  setConfig(config = {}) {
    return this.backend.setConfig(config)
  }

  dispose() {
    this.backend.dispose()
  }
}
