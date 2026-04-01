export const LEGACY_REVERB_ENGINE_ID = 'convolver-legacy'
export const DEFAULT_REVERB_ENGINE_ID = LEGACY_REVERB_ENGINE_ID

const HIGH_CUT_MIN_HZ = 800
const HIGH_CUT_MAX_HZ = 18000

function formatSeconds(value) {
  return `${Number(value).toFixed(2)} s`
}

function formatMilliseconds(value) {
  return `${Math.round(Number(value) * 1000)} ms`
}

function formatHertz(value) {
  return `${Math.round(Number(value))} Hz`
}

function formatPercent(value) {
  return `${Math.round(Number(value) * 100)} %`
}

export function clamp01(value, fallback = 0) {
  const resolvedValue = Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.min(1, resolvedValue))
}

export function highCutHzToDampRatio(value) {
  const safeValue = Number.isFinite(value) ? value : 7200
  return clamp01((HIGH_CUT_MAX_HZ - safeValue) / (HIGH_CUT_MAX_HZ - HIGH_CUT_MIN_HZ))
}

export function dampRatioToHighCutHz(value) {
  return Math.round(HIGH_CUT_MAX_HZ - clamp01(value) * (HIGH_CUT_MAX_HZ - HIGH_CUT_MIN_HZ))
}

function cloneDefinition(definition = {}) {
  return {
    ...definition,
  }
}

function normalizeEngineId(engineId) {
  if (typeof engineId === 'string' && engineId.trim()) return engineId.trim()
  return DEFAULT_REVERB_ENGINE_ID
}

const LEGACY_CONVOLVER_SCHEMA = Object.freeze([
  Object.freeze({
    key: 'decaySec',
    label: 'Decay',
    min: 0.3,
    max: 8,
    step: 0.01,
    tone: 'orange',
    defaultValue: 2.4,
    realtimeSafe: false,
    needsImpulseRebuild: true,
    format: formatSeconds,
  }),
  Object.freeze({
    key: 'decayCurve',
    label: 'Curve',
    min: 0.5,
    max: 4,
    step: 0.01,
    tone: 'blue',
    defaultValue: 2.2,
    realtimeSafe: false,
    needsImpulseRebuild: true,
    format: (value) => Number(value).toFixed(2),
  }),
  Object.freeze({
    key: 'preDelaySec',
    label: 'Pre-Delay',
    min: 0,
    max: 0.12,
    step: 0.001,
    tone: 'grey',
    defaultValue: 0.028,
    realtimeSafe: true,
    needsImpulseRebuild: false,
    format: formatMilliseconds,
  }),
  Object.freeze({
    key: 'lowCutHz',
    label: 'Low-Cut',
    min: 20,
    max: 1200,
    step: 1,
    tone: 'grey',
    defaultValue: 180,
    realtimeSafe: true,
    needsImpulseRebuild: false,
    format: formatHertz,
  }),
  Object.freeze({
    key: 'dampRatio',
    label: 'Damp',
    min: 0,
    max: 1,
    step: 0.01,
    tone: 'grey',
    defaultValue: highCutHzToDampRatio(7200),
    realtimeSafe: true,
    needsImpulseRebuild: false,
    format: (value) => formatPercent(clamp01(value)),
    readValue: (reverb = {}) => highCutHzToDampRatio(reverb?.highCutHz),
    toConfig: (value) => ({ highCutHz: dampRatioToHighCutHz(value) }),
  }),
  Object.freeze({
    key: 'returnGain',
    label: 'Return',
    min: 0,
    max: 2,
    step: 0.01,
    tone: 'green',
    defaultValue: 0.9,
    realtimeSafe: true,
    needsImpulseRebuild: false,
    format: formatPercent,
  }),
])

const SCHEMA_BY_ENGINE_ID = Object.freeze({
  [LEGACY_REVERB_ENGINE_ID]: LEGACY_CONVOLVER_SCHEMA,
})

export function listReverbSchemaEngines() {
  return Object.keys(SCHEMA_BY_ENGINE_ID)
}

export function getReverbParameterSchema(engineId = DEFAULT_REVERB_ENGINE_ID) {
  const resolvedEngineId = normalizeEngineId(engineId)
  const schema = SCHEMA_BY_ENGINE_ID[resolvedEngineId] || SCHEMA_BY_ENGINE_ID[DEFAULT_REVERB_ENGINE_ID]
  return schema.map(cloneDefinition)
}

export function getReverbParameter(engineId, key) {
  if (!key) return null
  const schema = getReverbParameterSchema(engineId)
  return schema.find((definition) => definition.key === key) || null
}

export function hasReverbParameter(engineId, key) {
  return Boolean(getReverbParameter(engineId, key))
}
