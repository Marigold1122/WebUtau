import {
  DEFAULT_REVERB_CONFIG,
  DEFAULT_REVERB_PRESET_ID,
  REVERB_PRESETS,
  getReverbPreset,
  listReverbPresetTags,
  listReverbPresets,
  normalizeReverbConfig,
  normalizeReverbPresetId,
} from './reverbConfigState.js'
import {
  DEFAULT_MASTER_CHAIN,
  mergeMasterChain,
  normalizeMasterChain,
} from './masterChainState.js'

export const PROJECT_REVERB_PRESETS = REVERB_PRESETS
export const DEFAULT_PROJECT_REVERB_PRESET_ID = DEFAULT_REVERB_PRESET_ID
export const DEFAULT_PROJECT_REVERB_CONFIG = DEFAULT_REVERB_CONFIG
export const getProjectReverbPreset = getReverbPreset
export const listProjectReverbPresetTags = listReverbPresetTags
export const listProjectReverbPresets = listReverbPresets
export const normalizeProjectReverbPresetId = normalizeReverbPresetId
export const normalizeProjectReverbConfig = normalizeReverbConfig

export { DEFAULT_MASTER_CHAIN, normalizeMasterChain, mergeMasterChain }

export function createProjectMixState(state = {}) {
  const reverbPresetId = normalizeProjectReverbPresetId(state?.reverbPresetId ?? state?.presetId)
  const preset = getProjectReverbPreset(reverbPresetId)
  return {
    reverbPresetId,
    reverb: normalizeProjectReverbConfig(state?.reverb, preset?.config),
    masterChain: normalizeMasterChain(state?.masterChain),
  }
}

export function mergeProjectMixState(currentState, changes = {}) {
  const current = createProjectMixState(currentState)
  const hasPresetChange = Object.prototype.hasOwnProperty.call(changes, 'reverbPresetId')
    || Object.prototype.hasOwnProperty.call(changes, 'presetId')
  const nextPresetId = hasPresetChange
    ? normalizeProjectReverbPresetId(changes?.reverbPresetId ?? changes?.presetId)
    : current.reverbPresetId
  const presetBaseline = getProjectReverbPreset(nextPresetId)?.config || DEFAULT_PROJECT_REVERB_CONFIG
  const nextState = {
    ...current,
    ...(changes || {}),
    reverbPresetId: nextPresetId,
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'reverb')) {
    nextState.reverb = normalizeProjectReverbConfig(
      changes?.reverb,
      hasPresetChange ? presetBaseline : current.reverb,
    )
  } else if (hasPresetChange) {
    nextState.reverb = normalizeProjectReverbConfig(presetBaseline, presetBaseline)
  } else {
    nextState.reverb = current.reverb
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'masterChain')) {
    nextState.masterChain = mergeMasterChain(current.masterChain, changes.masterChain || {})
  } else {
    nextState.masterChain = current.masterChain
  }
  delete nextState.presetId
  return nextState
}
