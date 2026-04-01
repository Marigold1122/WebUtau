const DEFAULT_EPSILON = 0.0001

export const REVERB_CONFIG_KEYS = Object.freeze([
  'decaySec',
  'decayCurve',
  'preDelaySec',
  'lowCutHz',
  'highCutHz',
  'returnGain',
])

export const IMPULSE_REBUILD_KEYS = Object.freeze([
  'decaySec',
  'decayCurve',
])

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

export function isNearlyEqual(left, right, epsilon = DEFAULT_EPSILON) {
  return Math.abs(toFiniteNumber(left) - toFiniteNumber(right)) < epsilon
}

export function getChangedReverbKeys(previousConfig = {}, nextConfig = {}, {
  keys = REVERB_CONFIG_KEYS,
  epsilon = DEFAULT_EPSILON,
} = {}) {
  const safeKeys = Array.isArray(keys) && keys.length > 0
    ? keys
    : REVERB_CONFIG_KEYS
  return safeKeys.filter((key) => !isNearlyEqual(previousConfig?.[key], nextConfig?.[key], epsilon))
}

export function isSameReverbConfig(previousConfig = {}, nextConfig = {}, {
  keys = REVERB_CONFIG_KEYS,
  epsilon = DEFAULT_EPSILON,
} = {}) {
  return getChangedReverbKeys(previousConfig, nextConfig, { keys, epsilon }).length === 0
}

export function shouldRebuildImpulseFromKeys(changedKeys = [], impulseKeys = IMPULSE_REBUILD_KEYS) {
  if (!Array.isArray(changedKeys) || changedKeys.length === 0) return false
  const keySet = new Set(Array.isArray(impulseKeys) ? impulseKeys : IMPULSE_REBUILD_KEYS)
  return changedKeys.some((key) => keySet.has(key))
}

export function diffReverbConfig(previousConfig = {}, nextConfig = {}, options = {}) {
  const changedKeys = getChangedReverbKeys(previousConfig, nextConfig, options)
  return {
    changedKeys,
    hasChanges: changedKeys.length > 0,
    needsImpulseRebuild: shouldRebuildImpulseFromKeys(
      changedKeys,
      options?.impulseKeys || IMPULSE_REBUILD_KEYS,
    ),
  }
}
