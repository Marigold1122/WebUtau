import { REVERB_PRESET_CATALOG } from './ReverbPresetCatalog.js'
import {
  DEFAULT_REVERB_PRESET_TAG,
  hasReverbPresetTag,
  listReverbPresetTagOptions,
  normalizeReverbPresetTag,
} from './ReverbPresetTags.js'

export const REVERB_PRESETS = REVERB_PRESET_CATALOG

export const DEFAULT_REVERB_PRESET_ID = 'zita-vocal-default'
export const DEFAULT_REVERB_CONFIG = Object.freeze({
  ...REVERB_PRESETS[DEFAULT_REVERB_PRESET_ID].config,
})

const PRESET_LIST = Object.freeze(Object.values(REVERB_PRESETS))

function clampRange(value, min, max, fallback) {
  const resolvedValue = Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, resolvedValue))
}

function clonePreset(preset = {}) {
  return {
    ...preset,
    tags: Array.isArray(preset.tags) ? [...preset.tags] : [],
    config: { ...preset.config },
  }
}

function resolveConfigBaseline(fallback = null) {
  const source = fallback && typeof fallback === 'object'
    ? fallback
    : DEFAULT_REVERB_CONFIG
  return {
    decaySec: clampRange(source.decaySec, 0.3, 8, DEFAULT_REVERB_CONFIG.decaySec),
    decayCurve: clampRange(source.decayCurve, 0.5, 4, DEFAULT_REVERB_CONFIG.decayCurve),
    preDelaySec: clampRange(source.preDelaySec, 0, 0.12, DEFAULT_REVERB_CONFIG.preDelaySec),
    lowCutHz: clampRange(source.lowCutHz, 20, 1200, DEFAULT_REVERB_CONFIG.lowCutHz),
    highCutHz: clampRange(source.highCutHz, 800, 18000, DEFAULT_REVERB_CONFIG.highCutHz),
    returnGain: clampRange(source.returnGain, 0, 2, DEFAULT_REVERB_CONFIG.returnGain),
  }
}

export function normalizeReverbPresetId(value) {
  return REVERB_PRESETS[value]?.id || DEFAULT_REVERB_PRESET_ID
}

export function getReverbPreset(presetId = DEFAULT_REVERB_PRESET_ID) {
  return REVERB_PRESETS[normalizeReverbPresetId(presetId)]
}

export function listReverbPresetTags() {
  return listReverbPresetTagOptions(PRESET_LIST)
}

export function listReverbPresets(options = {}) {
  const normalizedTag = normalizeReverbPresetTag(
    options?.tag,
    DEFAULT_REVERB_PRESET_TAG,
  )
  return PRESET_LIST
    .filter((preset) => hasReverbPresetTag(preset, normalizedTag))
    .map((preset) => clonePreset(preset))
}

export function normalizeReverbConfig(config = {}, fallback = null) {
  const baseline = resolveConfigBaseline(fallback)
  return {
    decaySec: clampRange(config?.decaySec, 0.3, 8, baseline.decaySec),
    decayCurve: clampRange(config?.decayCurve, 0.5, 4, baseline.decayCurve),
    preDelaySec: clampRange(config?.preDelaySec, 0, 0.12, baseline.preDelaySec),
    lowCutHz: clampRange(config?.lowCutHz, 20, 1200, baseline.lowCutHz),
    highCutHz: clampRange(config?.highCutHz, 800, 18000, baseline.highCutHz),
    returnGain: clampRange(config?.returnGain, 0, 2, baseline.returnGain),
  }
}
