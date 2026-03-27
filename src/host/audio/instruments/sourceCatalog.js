import { getEffectiveSourceId, normalizeAssignedSourceId } from '../../project/trackSourceAssignment.js'

export const HOST_INSTRUMENT_SOURCE_IDS = ['piano', 'violin', 'drums']

function clampUnit(value, fallback = 0.8) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function applyVelocityCurve(velocity, exponent = 1, minimum = 0) {
  const normalizedVelocity = clampUnit(velocity)
  const normalizedExponent = Number.isFinite(exponent) && exponent > 0 ? exponent : 1
  const curvedVelocity = normalizedExponent === 1
    ? normalizedVelocity
    : normalizedVelocity ** normalizedExponent
  return clampUnit(Math.max(minimum, curvedVelocity))
}

const SOURCE_CONFIGS = {
  piano: {
    baseUrl: '/samples/piano/',
    release: 1.2,
    samples: {
      A0: 'A0.mp3',
      C1: 'C1.mp3',
      A1: 'A1.mp3',
      C2: 'C2.mp3',
      A2: 'A2.mp3',
      C3: 'C3.mp3',
      A3: 'A3.mp3',
      C4: 'C4.mp3',
      'D#4': 'Ds4.mp3',
      'F#4': 'Fs4.mp3',
      A4: 'A4.mp3',
      C5: 'C5.mp3',
      'D#5': 'Ds5.mp3',
      'F#5': 'Fs5.mp3',
      A5: 'A5.mp3',
      C6: 'C6.mp3',
      A6: 'A6.mp3',
      C7: 'C7.mp3',
      C8: 'C8.mp3',
    },
  },
  violin: {
    baseUrl: '/samples/violin/',
    release: 0.8,
    noteKeys: ['G3', 'A3', 'C4', 'E4', 'G4', 'A4', 'C5', 'E5', 'G5', 'A5', 'C6', 'E6', 'G6', 'A6', 'C7'],
    velocityLayers: [
      { maxVelocity: 0.35, suffix: '_p', volume: 7 },
      { maxVelocity: 1, suffix: '_f', volume: 0 },
    ],
    playbackResponse: {
      minLayerVelocity: 1,
      outputVelocityExponent: 0.5,
      minOutputVelocity: 0.56,
      shortNote: {
        maxDurationSec: 0.4,
        minOutputVelocity: 0.76,
      },
      preview: {
        minOutputVelocity: 0.72,
      },
    },
  },
  drums: {
    baseUrl: '/samples/drums/',
    release: 0.3,
    samples: {
      C2: 'kick-v2.mp3',
      'C#2': 'sidestick-v2.mp3',
      D2: 'snare-v2.mp3',
      E2: 'rimshot-v2.mp3',
      F2: 'tom-low-v2.mp3',
      'F#2': 'hihat-closed-v2.mp3',
      G2: 'tom-mid-v2.mp3',
      'G#2': 'hihat-foot-v2.mp3',
      A2: 'tom-high-v2.mp3',
      'A#2': 'hihat-open-v2.mp3',
      'C#3': 'crash-v2.mp3',
      'D#3': 'ride-v2.mp3',
      F3: 'ride-bell-v2.mp3',
    },
  },
}

export function isHostInstrumentSource(sourceId) {
  return HOST_INSTRUMENT_SOURCE_IDS.includes(sourceId)
}

export function getHostPlaybackSourceId(assignedSourceId) {
  const normalized = normalizeAssignedSourceId(assignedSourceId)
  if (normalized === 'vocal') return null
  const effectiveSourceId = getEffectiveSourceId(assignedSourceId)
  return isHostInstrumentSource(effectiveSourceId) ? effectiveSourceId : null
}

export function getInstrumentSourceConfig(sourceId) {
  const source = getHostPlaybackSourceId(sourceId) || sourceId
  return source ? SOURCE_CONFIGS[source] || null : null
}

export function getInstrumentSourceIds(sourceIds = []) {
  return [...new Set(
    sourceIds
      .map((sourceId) => getHostPlaybackSourceId(sourceId))
      .filter(Boolean),
  )]
}

export function resolveInstrumentPlaybackParams(sourceId, {
  velocity = 0.8,
  durationSec = null,
  preview = false,
} = {}) {
  const config = getInstrumentSourceConfig(sourceId)
  const normalizedVelocity = clampUnit(velocity, 0.8)
  const response = config?.playbackResponse || null

  if (!response) {
    return {
      layerVelocity: normalizedVelocity,
      outputVelocity: Math.max(0.01, normalizedVelocity),
    }
  }

  let layerVelocity = normalizedVelocity
  let outputVelocity = applyVelocityCurve(
    normalizedVelocity,
    response.outputVelocityExponent,
    response.minOutputVelocity || 0,
  )
  if (Number.isFinite(response.minLayerVelocity)) {
    layerVelocity = Math.max(layerVelocity, clampUnit(response.minLayerVelocity, layerVelocity))
  }

  const shortNote = response.shortNote
  if (
    shortNote
    && Number.isFinite(durationSec)
    && durationSec > 0
    && durationSec <= shortNote.maxDurationSec
  ) {
    layerVelocity = Math.max(layerVelocity, clampUnit(shortNote.minLayerVelocity, layerVelocity))
    outputVelocity = Math.max(outputVelocity, clampUnit(shortNote.minOutputVelocity, outputVelocity))
  }

  const previewResponse = response.preview
  if (preview && previewResponse) {
    layerVelocity = Math.max(layerVelocity, clampUnit(previewResponse.minLayerVelocity, layerVelocity))
    outputVelocity = Math.max(outputVelocity, clampUnit(previewResponse.minOutputVelocity, outputVelocity))
  }

  return {
    layerVelocity: clampUnit(layerVelocity),
    outputVelocity: Math.max(0.01, clampUnit(outputVelocity)),
  }
}
