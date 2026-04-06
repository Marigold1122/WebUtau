import { getEffectiveSourceId, normalizeAssignedSourceId } from '../../project/trackSourceAssignment.js'

export const HOST_INSTRUMENT_SOURCE_IDS = ['piano', 'violin', 'drums', 'bass', 'guitar']

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

const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }

function fileNoteToSamplerKey(fileNote) {
  const match = fileNote.match(/^([A-G][bs]?)(\d+)$/)
  if (!match) return fileNote
  const base = match[1]
  const oct = match[2]
  if (base.endsWith('s')) return base.replace('s', '#') + oct
  if (FLAT_TO_SHARP[base]) return FLAT_TO_SHARP[base] + oct
  return fileNote
}

function buildNoteSamples(noteKeys, prefix, suffix) {
  return Object.fromEntries(
    noteKeys.map((note) => [fileNoteToSamplerKey(note), `${prefix}${note}${suffix}.mp3`]),
  )
}

const SOURCE_CONFIGS = {
  piano: buildPianoConfig(),
  violin: buildViolinConfig(),
  drums: buildDrumsConfig(),
  bass: buildBassConfig(),
  guitar: buildGuitarConfig(),
}

function buildPianoConfig() {
  const noteKeys = [
    'A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3',
    'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6',
    'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8',
  ]
  return {
    baseUrl: '/samples/piano-hq/',
    release: 1.2,
    velocityLayers: Array.from({ length: 8 }, (_, i) => ({
      maxVelocity: (i + 1) / 8,
      samples: buildNoteSamples(noteKeys, '', `_v${i + 1}`),
      volume: i === 0 ? 6 : 0,
    })),
    playbackResponse: {
      outputVelocityExponent: 0.6,
      minOutputVelocity: 0.15,
    },
  }
}

function buildViolinConfig() {
  const noteKeys = ['G3', 'A3', 'C4', 'E4', 'G4', 'A4', 'C5', 'E5', 'G5', 'A5', 'C6', 'E6', 'G6', 'A6', 'C7']
  return {
    baseUrl: '/samples/violin/',
    release: 0.8,
    noteKeys,
    velocityLayers: [
      { maxVelocity: 0.35, suffix: '_p', volume: 7 },
      { maxVelocity: 1, suffix: '_f', volume: 0 },
    ],
    playbackResponse: {
      minLayerVelocity: 1,
      outputVelocityExponent: 0.5,
      minOutputVelocity: 0.56,
      shortNote: { maxDurationSec: 0.4, minOutputVelocity: 0.76 },
      preview: { minOutputVelocity: 0.72 },
    },
  }
}

function buildDrumsConfig() {
  const drumPieces = [
    { midi: 'C2', name: 'kick' },
    { midi: 'C#2', name: 'sidestick' },
    { midi: 'D2', name: 'snare' },
    { midi: 'E2', name: 'rimshot' },
    { midi: 'F2', name: 'tom-low' },
    { midi: 'F#2', name: 'hihat-closed' },
    { midi: 'G2', name: 'tom-mid' },
    { midi: 'G#2', name: 'hihat-foot' },
    { midi: 'A2', name: 'tom-high' },
    { midi: 'A#2', name: 'hihat-open' },
    { midi: 'C#3', name: 'crash' },
    { midi: 'D#3', name: 'ride' },
    { midi: 'F3', name: 'ride-bell' },
  ]
  return {
    baseUrl: '/samples/drums-hq/',
    release: 0.3,
    velocityLayers: Array.from({ length: 8 }, (_, i) => ({
      maxVelocity: (i + 1) / 8,
      samples: Object.fromEntries(
        drumPieces.map((d) => [d.midi, `${d.name}-v${i + 1}-r1.mp3`]),
      ),
      volume: i === 0 ? 5 : 0,
    })),
  }
}

function buildBassConfig() {
  const noteKeys = [
    'Gb0', 'A0', 'C1', 'D1', 'F1', 'Ab1', 'B1', 'D2', 'F2', 'Ab2',
    'B2', 'D3', 'F3', 'Ab3', 'B3', 'D4', 'F4', 'Ab4', 'A4',
  ]
  const velIds = ['pp', 'p', 'mf', 'f', 'ff']
  return {
    baseUrl: '/samples/bass-hq/',
    release: 0.3,
    velocityLayers: velIds.map((vel, i) => ({
      maxVelocity: (i + 1) / velIds.length,
      samples: Object.fromEntries(
        noteKeys.map((note) => [fileNoteToSamplerKey(note), `${note}_${vel}_rr1.mp3`]),
      ),
      volume: i === 0 ? 5 : 0,
    })),
    playbackResponse: {
      outputVelocityExponent: 0.7,
      minOutputVelocity: 0.2,
    },
  }
}

function buildGuitarConfig() {
  const noteKeys = [
    'Db2', 'E2', 'Gb2', 'A2', 'C3', 'Eb3', 'Gb3', 'A3',
    'C4', 'Eb4', 'Gb4', 'A4', 'C5', 'Eb5', 'Gb5', 'A5', 'C6', 'D6',
  ]
  const velIds = ['p', 'mp', 'mf', 'f']
  return {
    baseUrl: '/samples/guitar-hq/',
    release: 0.5,
    velocityLayers: velIds.map((vel, i) => ({
      maxVelocity: (i + 1) / velIds.length,
      samples: Object.fromEntries(
        noteKeys.map((note) => [fileNoteToSamplerKey(note), `${note}_${vel}_rr1.mp3`]),
      ),
      volume: i === 0 ? 4 : 0,
    })),
    playbackResponse: {
      outputVelocityExponent: 0.7,
      minOutputVelocity: 0.2,
    },
  }
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
