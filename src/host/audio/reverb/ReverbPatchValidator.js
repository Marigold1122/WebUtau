import { normalizeReverbConfig } from '../../project/reverbConfigState.js'
import { dampRatioToHighCutHz } from './ReverbParameterSchema.js'

const DIRECT_REVERB_KEYS = Object.freeze([
  'decaySec',
  'decayCurve',
  'preDelaySec',
  'lowCutHz',
  'highCutHz',
  'returnGain',
])

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function isObjectLike(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function listPatchKeys(patch = {}) {
  return Object.keys(isObjectLike(patch) ? patch : {})
}

export function normalizeReverbPatch(engineId, patch = {}, fallbackConfig = null) {
  void engineId
  if (!isObjectLike(patch)) {
    return { patch: {}, acceptedKeys: [], droppedKeys: [] }
  }

  const normalizedInput = { ...patch }
  if (hasOwn(patch, 'dampRatio') && Number.isFinite(patch.dampRatio)) {
    normalizedInput.highCutHz = dampRatioToHighCutHz(patch.dampRatio)
  }
  const normalizedConfig = normalizeReverbConfig(normalizedInput, fallbackConfig)
  const acceptedPatch = {}
  DIRECT_REVERB_KEYS.forEach((key) => {
    if (!hasOwn(normalizedInput, key)) return
    acceptedPatch[key] = normalizedConfig[key]
  })

  const acceptedKeys = Object.keys(acceptedPatch)
  const droppedKeys = listPatchKeys(patch).filter((key) => (
    !DIRECT_REVERB_KEYS.includes(key) && key !== 'dampRatio'
  ))
  return {
    patch: acceptedPatch,
    acceptedKeys,
    droppedKeys,
  }
}

export function isEmptyReverbPatch(patch = {}) {
  return listPatchKeys(patch).length === 0
}
