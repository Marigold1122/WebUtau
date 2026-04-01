import {
  DEFAULT_REVERB_PRESET_ID,
  getReverbPreset,
  normalizeReverbConfig,
  normalizeReverbPresetId,
} from './reverbConfigState.js'

export const DEFAULT_TRACK_REVERB_ENGINE_ID = 'convolver-legacy'
export const DEFAULT_TRACK_REVERB_SEND = 0
export const DEFAULT_TRACK_REVERB_ENABLED = true

const REVERB_GAIN_EPSILON = 0.0001

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeTrackReverbEngineId(value, fallback = DEFAULT_TRACK_REVERB_ENGINE_ID) {
  const resolvedValue = typeof value === 'string' ? value.trim() : ''
  if (resolvedValue) return resolvedValue
  const resolvedFallback = typeof fallback === 'string' ? fallback.trim() : ''
  return resolvedFallback || DEFAULT_TRACK_REVERB_ENGINE_ID
}

export function normalizeTrackReverbSend(value, fallback = DEFAULT_TRACK_REVERB_SEND) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_TRACK_REVERB_SEND
  const normalizedValue = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(0, Math.min(1, normalizedValue))
}

export function normalizeTrackReverbPresetId(value, fallback = DEFAULT_REVERB_PRESET_ID) {
  return normalizeReverbPresetId(value || fallback)
}

export function normalizeTrackReverbConfig(config = {}, fallback = null) {
  return normalizeReverbConfig(config, fallback)
}

function resolveDefaults(defaults = {}) {
  const defaultPresetId = normalizeTrackReverbPresetId(
    defaults?.reverb?.presetId ?? defaults?.reverbPresetId,
    DEFAULT_REVERB_PRESET_ID,
  )
  const presetConfig = getReverbPreset(defaultPresetId)?.config || null
  const defaultConfig = normalizeTrackReverbConfig(
    defaults?.reverb?.config ?? defaults?.reverbConfig,
    presetConfig,
  )
  const defaultSend = normalizeTrackReverbSend(
    defaults?.reverb?.send ?? defaults?.reverbSend,
    DEFAULT_TRACK_REVERB_SEND,
  )
  const defaultEnabled = hasOwn(defaults?.reverb, 'enabled')
    ? Boolean(defaults?.reverb?.enabled)
    : (Number(defaultConfig?.returnGain || 0) > REVERB_GAIN_EPSILON)
  return {
    engineId: normalizeTrackReverbEngineId(defaults?.reverb?.engineId),
    presetId: defaultPresetId,
    send: defaultSend,
    enabled: defaultEnabled,
    config: defaultConfig,
  }
}

function resolveLegacyConfigPatch(value) {
  if (!isPlainObject(value)) return null
  if (hasOwn(value, 'engineId') || hasOwn(value, 'presetId') || hasOwn(value, 'send') || hasOwn(value, 'config')) {
    return null
  }
  return value
}

function resolveIncomingReverbSource(state = {}) {
  if (isPlainObject(state) && (
    hasOwn(state, 'engineId')
    || hasOwn(state, 'presetId')
    || hasOwn(state, 'send')
    || hasOwn(state, 'enabled')
    || hasOwn(state, 'config')
  )) {
    return state
  }
  if (isPlainObject(state?.reverb) && (
    hasOwn(state.reverb, 'engineId')
    || hasOwn(state.reverb, 'presetId')
    || hasOwn(state.reverb, 'send')
    || hasOwn(state.reverb, 'enabled')
    || hasOwn(state.reverb, 'config')
  )) {
    return state.reverb
  }
  return {}
}

function resolveConfigInput(source = {}, reverbSource = {}) {
  if (hasOwn(reverbSource, 'config')) return reverbSource.config
  if (hasOwn(source, 'config')) return source.config
  if (hasOwn(source, 'reverbConfig')) return source.reverbConfig
  if (resolveLegacyConfigPatch(source?.reverb)) return source.reverb
  return null
}

function buildNormalizedReverbState(source = {}, defaults = {}, baseline = null) {
  const resolvedDefaults = baseline || resolveDefaults(defaults)
  const reverbSource = resolveIncomingReverbSource(source)
  const hasPresetChange = hasOwn(reverbSource, 'presetId') || hasOwn(source, 'reverbPresetId')
  const nextPresetId = normalizeTrackReverbPresetId(
    reverbSource?.presetId ?? source?.reverbPresetId,
    resolvedDefaults.presetId,
  )
  const presetConfig = getReverbPreset(nextPresetId)?.config || resolvedDefaults.config
  const configInput = resolveConfigInput(source, reverbSource)
  const nextConfig = configInput == null
    ? normalizeTrackReverbConfig(
      hasPresetChange ? presetConfig : resolvedDefaults.config,
      hasPresetChange ? presetConfig : resolvedDefaults.config,
    )
    : normalizeTrackReverbConfig(configInput, resolvedDefaults.config)
  const nextEnabled = hasOwn(reverbSource, 'enabled')
    ? Boolean(reverbSource.enabled)
    : resolvedDefaults.enabled
  return {
    engineId: normalizeTrackReverbEngineId(reverbSource?.engineId, resolvedDefaults.engineId),
    presetId: nextPresetId,
    send: normalizeTrackReverbSend(
      reverbSource?.send ?? source?.reverbSend,
      resolvedDefaults.send,
    ),
    enabled: nextEnabled,
    config: nextConfig,
  }
}

export function createTrackReverbState(state = {}, defaults = {}) {
  return buildNormalizedReverbState(state, defaults)
}

export function mergeTrackReverbState(currentState = {}, changes = {}, defaults = {}) {
  const current = createTrackReverbState(currentState, defaults)
  return buildNormalizedReverbState(changes, defaults, current)
}

export function toLegacyTrackReverbFields(reverbState = null) {
  const normalized = createTrackReverbState(reverbState)
  return {
    reverbSend: normalized.send,
    reverbPresetId: normalized.presetId,
    reverbConfig: normalized.config,
  }
}
