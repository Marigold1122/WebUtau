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

// Master fader：volume ∈ [0, 1]、gain = volume × MAX_MASTER_GAIN
// 默认 0.5 → gain 1.0（与原硬编码 masterGain=1 等价，老工程加载零行为变化）
// MAX_MASTER_GAIN = 2 → 50% fader 是 unity，与轨道 fader 的 unity 位置一致
export const DEFAULT_MASTER_VOLUME = 0.5
export const MAX_MASTER_GAIN = 2

export function normalizeMasterVolume(value, fallback = DEFAULT_MASTER_VOLUME) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_MASTER_VOLUME
  const v = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(0, Math.min(1, v))
}

export function resolveMasterGain(volume) {
  return normalizeMasterVolume(volume) * MAX_MASTER_GAIN
}

export function createProjectMixState(state = {}) {
  const reverbPresetId = normalizeProjectReverbPresetId(state?.reverbPresetId ?? state?.presetId)
  const preset = getProjectReverbPreset(reverbPresetId)
  return {
    reverbPresetId,
    reverb: normalizeProjectReverbConfig(state?.reverb, preset?.config),
    masterChain: normalizeMasterChain(state?.masterChain),
    masterVolume: normalizeMasterVolume(state?.masterVolume),
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
  if (Object.prototype.hasOwnProperty.call(changes, 'masterVolume')) {
    nextState.masterVolume = normalizeMasterVolume(changes.masterVolume, current.masterVolume)
  } else {
    nextState.masterVolume = current.masterVolume
  }
  delete nextState.presetId
  return nextState
}
