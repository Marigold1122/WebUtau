import {
  LEGACY_REVERB_ENGINE_ID,
  clamp01,
  dampRatioToHighCutHz,
  getReverbParameterSchema,
  highCutHzToDampRatio,
} from '../../audio/reverb/ReverbParameterSchema.js'
import { formatReverbKnobLabel } from './reverbDockI18n.js'

const TRACK_SEND_DEFINITION = Object.freeze({
  key: 'reverbSend',
  label: formatReverbKnobLabel('Send'),
  min: 0,
  max: 1,
  step: 0.01,
  tone: 'green',
  format: (value) => `${Math.round(clamp01(value) * 100)} %`,
})

const PROJECT_DEFINITION_CACHE = new Map()
const TRACK_DEFINITION_CACHE = new Map()

function normalizeEngineId(engineId) {
  const resolvedEngineId = typeof engineId === 'string' ? engineId.trim() : ''
  return resolvedEngineId || LEGACY_REVERB_ENGINE_ID
}

function freezeDefinitions(definitions = []) {
  return Object.freeze((Array.isArray(definitions) ? definitions : []).map((definition) => (
    Object.freeze({ ...definition })
  )))
}

function buildProjectDefinitions(engineId) {
  return getReverbParameterSchema(engineId).map((definition) => {
    if (definition.key !== 'returnGain') return definition
    return {
      ...definition,
      label: formatReverbKnobLabel('Dry/Wet Return'),
      tone: 'green',
    }
  }).map((definition) => ({
    ...definition,
    label: formatReverbKnobLabel(definition.label),
  }))
}

function buildTrackDefinitions(engineId) {
  const reverbDefinitions = getReverbParameterSchema(engineId).map((definition) => {
    if (definition.key !== 'returnGain') return definition
    return {
      ...definition,
      label: formatReverbKnobLabel('Return'),
      tone: 'blue',
    }
  }).map((definition) => ({
    ...definition,
    label: formatReverbKnobLabel(definition.label),
  }))
  return [TRACK_SEND_DEFINITION, ...reverbDefinitions]
}

export function getProjectModuleDefinitions(engineId = LEGACY_REVERB_ENGINE_ID) {
  const resolvedEngineId = normalizeEngineId(engineId)
  if (!PROJECT_DEFINITION_CACHE.has(resolvedEngineId)) {
    PROJECT_DEFINITION_CACHE.set(
      resolvedEngineId,
      freezeDefinitions(buildProjectDefinitions(resolvedEngineId)),
    )
  }
  return PROJECT_DEFINITION_CACHE.get(resolvedEngineId)
}

export function getTrackModuleDefinitions(engineId = LEGACY_REVERB_ENGINE_ID) {
  const resolvedEngineId = normalizeEngineId(engineId)
  if (!TRACK_DEFINITION_CACHE.has(resolvedEngineId)) {
    TRACK_DEFINITION_CACHE.set(
      resolvedEngineId,
      freezeDefinitions(buildTrackDefinitions(resolvedEngineId)),
    )
  }
  return TRACK_DEFINITION_CACHE.get(resolvedEngineId)
}

export { clamp01, highCutHzToDampRatio, dampRatioToHighCutHz }
