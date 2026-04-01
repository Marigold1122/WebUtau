import { LEGACY_REVERB_ENGINE_ID } from './ReverbParameterSchema.js'
import { LegacyConvolverEngine } from './engines/LegacyConvolverEngine.js'

function normalizeEngineId(engineId) {
  const resolvedId = typeof engineId === 'string' ? engineId.trim() : ''
  return resolvedId || LEGACY_REVERB_ENGINE_ID
}

export class ReverbEngineRegistry {
  constructor() {
    this.factories = new Map()
  }

  register(engineId, factory) {
    const resolvedEngineId = normalizeEngineId(engineId)
    if (typeof factory !== 'function') return false
    this.factories.set(resolvedEngineId, factory)
    return true
  }

  has(engineId) {
    return this.factories.has(normalizeEngineId(engineId))
  }

  list() {
    return [...this.factories.keys()]
  }

  create(engineId, options = {}) {
    const resolvedEngineId = normalizeEngineId(engineId)
    const factory = this.factories.get(resolvedEngineId)
      || this.factories.get(LEGACY_REVERB_ENGINE_ID)
    if (typeof factory !== 'function') return null
    return factory(options)
  }
}

let sharedRegistry = null

function registerBuiltInEngines(registry) {
  registry.register(LEGACY_REVERB_ENGINE_ID, (options) => new LegacyConvolverEngine(options))
}

export function createReverbEngineRegistry() {
  const registry = new ReverbEngineRegistry()
  registerBuiltInEngines(registry)
  return registry
}

export function getSharedReverbEngineRegistry() {
  if (!sharedRegistry) {
    sharedRegistry = createReverbEngineRegistry()
  }
  return sharedRegistry
}
