const AMP_SIM3_CABINET_IRS = Object.freeze({
  marshall1960Axis: Object.freeze({
    key: 'marshall-1960-axis',
    label: 'Marshall 1960, axis',
    url: '/vendor/amp-sim3/impulses/cabinet/Marshall1960.wav',
  }),
})

const AMP_SIM3_GUITAR_INSERT_ID = 'amp-sim3-clean-and-warm'
const GUITAR_TONE_FIELDS = Object.freeze([
  'inputGain',
  'preampStage1Gain',
  'distoStage1Drive',
  'preampStage2Gain',
  'distoStage2Drive',
  'outputGain',
  'bass',
  'mid',
  'treble',
  'presence',
  'cabinetMix',
  'eq60',
  'eq170',
  'eq350',
  'eq1000',
  'eq3500',
  'eq10000',
])
const GUITAR_TONE_DB_FIELDS = Object.freeze(['eq60', 'eq170', 'eq350', 'eq1000', 'eq3500', 'eq10000'])
const GUITAR_TONE_LIMITS = Object.freeze({
  inputGain: Object.freeze({ min: 0, max: 2 }),
  preampStage1Gain: Object.freeze({ min: 0, max: 2 }),
  distoStage1Drive: Object.freeze({ min: 0, max: 10 }),
  preampStage2Gain: Object.freeze({ min: 0, max: 2 }),
  distoStage2Drive: Object.freeze({ min: 0, max: 10 }),
  outputGain: Object.freeze({ min: 0, max: 2 }),
  bass: Object.freeze({ min: 0, max: 10 }),
  mid: Object.freeze({ min: 0, max: 10 }),
  treble: Object.freeze({ min: 0, max: 10 }),
  presence: Object.freeze({ min: 0, max: 10 }),
  cabinetMix: Object.freeze({ min: 0, max: 1 }),
  eq60: Object.freeze({ min: -18, max: 18 }),
  eq170: Object.freeze({ min: -18, max: 18 }),
  eq350: Object.freeze({ min: -18, max: 18 }),
  eq1000: Object.freeze({ min: -18, max: 18 }),
  eq3500: Object.freeze({ min: -18, max: 18 }),
  eq10000: Object.freeze({ min: -18, max: 18 }),
})

export const TRACK_INSERT_PROFILES = Object.freeze({
  'amp-sim3-clean-and-warm': Object.freeze({
    insertId: 'amp-sim3-clean-and-warm',
    engine: 'amp-sim3',
    derivedFromPreset: 'Clean and Warm',
    inputGain: 1,
    lowShelf1: Object.freeze({ frequency: 720, gain: -6 }),
    lowShelf2: Object.freeze({ frequency: 320, gain: 1.600000023841858 }),
    preampStage1Gain: 1,
    distoStage1: Object.freeze({ type: 'asymetric', drive: 7.8 }),
    highPass1: Object.freeze({ frequency: 6, q: 0.707099974155426 }),
    lowShelf3: Object.freeze({ frequency: 720, gain: -6 }),
    preampStage2Gain: 1,
    distoStage2: Object.freeze({ type: 'standard', drive: 0.9 }),
    outputGain: 0.7,
    tone: Object.freeze({ bass: 6.7, mid: 7.1, treble: 3.2, presence: 6.9 }),
    postCuts: Object.freeze({
      low: Object.freeze({ frequency: 60, gain: -19 }),
      high: Object.freeze({ frequency: 10000, gain: -25 }),
    }),
    graphicEq: Object.freeze([10, 5, -7, -7, 16, 0]),
    cabinet: Object.freeze({
      ...AMP_SIM3_CABINET_IRS.marshall1960Axis,
      mix: 0.88,
    }),
  }),
  'amp-sim3-superclean-jazz-bass-adapted': Object.freeze({
    insertId: 'amp-sim3-superclean-jazz-bass-adapted',
    engine: 'amp-sim3',
    derivedFromPreset: 'SuperClean/Jazz',
    // Legacy fallback profile kept for backwards compatibility with existing states.
    inputGain: 1,
    lowShelf1: Object.freeze({ frequency: 720, gain: -6 }),
    lowShelf2: Object.freeze({ frequency: 320, gain: -6.300000190734863 }),
    preampStage1Gain: 1,
    distoStage1: Object.freeze({ type: 'crunch', drive: 5.4 }),
    highPass1: Object.freeze({ frequency: 6, q: 0.707099974155426 }),
    lowShelf3: Object.freeze({ frequency: 720, gain: -6 }),
    preampStage2Gain: 1,
    distoStage2: Object.freeze({ type: 'crunch', drive: 5.4 }),
    outputGain: 0.7,
    tone: Object.freeze({ bass: 7.0, mid: 5.1, treble: 5.2, presence: 3.1 }),
    postCuts: Object.freeze({
      low: Object.freeze({ frequency: 60, gain: -19 }),
      high: Object.freeze({ frequency: 10000, gain: -25 }),
    }),
    graphicEq: Object.freeze([10, 7, 0, -10, 5, 12]),
    cabinet: null,
  }),
  'nam-bass-ampeg-svt-2-pro': Object.freeze({
    insertId: 'nam-bass-ampeg-svt-2-pro',
    engine: 'nam-bass',
    label: 'Ampeg SVT-2 Pro',
    source: 'tone3000',
    gear: 'full-rig',
    license: 'cc-by',
    runtimeBaseUrl: '/',
    modelUrl: 'https://api.tone3000.com/storage/v1/object/public/models/cd13118254942980.nam',
    inputGain: 1,
    outputGain: 1,
    bridgeInputGain: 1,
  }),
})

const INSTRUMENT_SOURCE_INSERT_IDS = Object.freeze({
  guitar: AMP_SIM3_GUITAR_INSERT_ID,
  bass: 'nam-bass-ampeg-svt-2-pro',
})

function clampNumber(value, min, max, fallback = min) {
  const safeValue = Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, safeValue))
}

function cloneProfile(profile) {
  return profile ? structuredClone(profile) : null
}

function createTrackGuitarToneConfigFromProfile(profile) {
  const graphicEq = Array.isArray(profile?.graphicEq) ? profile.graphicEq : []
  return {
    inputGain: Number(profile?.inputGain) || 0,
    preampStage1Gain: Number(profile?.preampStage1Gain) || 0,
    distoStage1Drive: Number(profile?.distoStage1?.drive) || 0,
    preampStage2Gain: Number(profile?.preampStage2Gain) || 0,
    distoStage2Drive: Number(profile?.distoStage2?.drive) || 0,
    outputGain: Number(profile?.outputGain) || 0,
    bass: Number(profile?.tone?.bass) || 0,
    mid: Number(profile?.tone?.mid) || 0,
    treble: Number(profile?.tone?.treble) || 0,
    presence: Number(profile?.tone?.presence) || 0,
    cabinetMix: Number(profile?.cabinet?.mix) || 0,
    eq60: Number(graphicEq[0]) || 0,
    eq170: Number(graphicEq[1]) || 0,
    eq350: Number(graphicEq[2]) || 0,
    eq1000: Number(graphicEq[3]) || 0,
    eq3500: Number(graphicEq[4]) || 0,
    eq10000: Number(graphicEq[5]) || 0,
  }
}

const DEFAULT_TRACK_GUITAR_TONE_CONFIG = Object.freeze(
  createTrackGuitarToneConfigFromProfile(TRACK_INSERT_PROFILES[AMP_SIM3_GUITAR_INSERT_ID]),
)

function normalizeTrackGuitarToneField(key, value, fallbackConfig) {
  const limits = GUITAR_TONE_LIMITS[key]
  const fallbackValue = fallbackConfig?.[key]
  return clampNumber(value, limits.min, limits.max, fallbackValue)
}

export function createDefaultTrackGuitarToneConfig() {
  return structuredClone(DEFAULT_TRACK_GUITAR_TONE_CONFIG)
}

export function normalizeTrackGuitarToneConfig(config = {}, fallback = DEFAULT_TRACK_GUITAR_TONE_CONFIG) {
  const safeConfig = config && typeof config === 'object' ? config : {}
  const fallbackConfig = fallback && typeof fallback === 'object'
    ? fallback
    : DEFAULT_TRACK_GUITAR_TONE_CONFIG

  return Object.freeze(GUITAR_TONE_FIELDS.reduce((acc, key) => {
    acc[key] = normalizeTrackGuitarToneField(key, safeConfig[key], fallbackConfig)
    return acc
  }, {}))
}

export function mergeTrackGuitarToneConfig(currentConfig, patch = {}) {
  const baseConfig = normalizeTrackGuitarToneConfig(currentConfig)
  const safePatch = patch && typeof patch === 'object' ? patch : {}
  return normalizeTrackGuitarToneConfig({
    ...baseConfig,
    ...safePatch,
  }, baseConfig)
}

export function isSameTrackGuitarToneConfig(left, right) {
  const normalizedLeft = normalizeTrackGuitarToneConfig(left)
  const normalizedRight = normalizeTrackGuitarToneConfig(right)
  return GUITAR_TONE_FIELDS.every((key) => Math.abs(normalizedLeft[key] - normalizedRight[key]) < 0.0001)
}

export function supportsTrackGuitarToneSource(sourceId) {
  return resolveInstrumentTrackInsertId(sourceId) === AMP_SIM3_GUITAR_INSERT_ID
}

export function supportsTrackGuitarToneInsertId(insertId) {
  return normalizeTrackInsertId(insertId) === AMP_SIM3_GUITAR_INSERT_ID
}

export function resolveInstrumentTrackInsertId(sourceId) {
  return typeof sourceId === 'string' ? INSTRUMENT_SOURCE_INSERT_IDS[sourceId] || null : null
}

export function getTrackInsertProfile(insertId) {
  return typeof insertId === 'string' ? TRACK_INSERT_PROFILES[insertId] || null : null
}

export function buildTrackInsertProfile(insertId, { guitarToneConfig = null } = {}) {
  const baseProfile = getTrackInsertProfile(insertId)
  if (!baseProfile) return null

  const resolvedProfile = cloneProfile(baseProfile)
  if (!supportsTrackGuitarToneInsertId(insertId)) return resolvedProfile

  const resolvedToneConfig = normalizeTrackGuitarToneConfig(
    guitarToneConfig,
    createTrackGuitarToneConfigFromProfile(baseProfile),
  )
  resolvedProfile.inputGain = resolvedToneConfig.inputGain
  resolvedProfile.preampStage1Gain = resolvedToneConfig.preampStage1Gain
  resolvedProfile.distoStage1 = {
    ...resolvedProfile.distoStage1,
    drive: resolvedToneConfig.distoStage1Drive,
  }
  resolvedProfile.preampStage2Gain = resolvedToneConfig.preampStage2Gain
  resolvedProfile.distoStage2 = {
    ...resolvedProfile.distoStage2,
    drive: resolvedToneConfig.distoStage2Drive,
  }
  resolvedProfile.outputGain = resolvedToneConfig.outputGain
  resolvedProfile.tone = {
    ...resolvedProfile.tone,
    bass: resolvedToneConfig.bass,
    mid: resolvedToneConfig.mid,
    treble: resolvedToneConfig.treble,
    presence: resolvedToneConfig.presence,
  }
  resolvedProfile.graphicEq = GUITAR_TONE_DB_FIELDS.map((key) => resolvedToneConfig[key])
  if (resolvedProfile.cabinet) {
    resolvedProfile.cabinet = {
      ...resolvedProfile.cabinet,
      mix: resolvedToneConfig.cabinetMix,
    }
  }
  return resolvedProfile
}

export function normalizeTrackInsertId(insertId) {
  const normalized = typeof insertId === 'string' ? insertId.trim() : ''
  return normalized && TRACK_INSERT_PROFILES[normalized] ? normalized : null
}
