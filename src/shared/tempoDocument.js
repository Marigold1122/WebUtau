import { PIANO_ROLL } from '../config/constants.js'

function normalizeTime(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizeTick(value) {
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function normalizeTempo(tempo = {}) {
  return {
    bpm: Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : PIANO_ROLL.DEFAULT_BPM,
    time: normalizeTime(tempo.time),
    ticks: normalizeTick(tempo.ticks),
  }
}

function normalizeTimeSignature(signature = {}) {
  return {
    timeSignature: Array.isArray(signature.timeSignature)
      ? signature.timeSignature
      : [...PIANO_ROLL.DEFAULT_TIME_SIGNATURE],
    time: normalizeTime(signature.time),
    ticks: normalizeTick(signature.ticks),
  }
}

function normalizeKeySignature(signature = {}) {
  const key = typeof signature.key === 'string' && signature.key.trim()
    ? signature.key.trim()
    : 'C'
  const scale = signature.scale === 'minor' ? 'minor' : 'major'
  return {
    key,
    scale,
    time: normalizeTime(signature.time),
    ticks: normalizeTick(signature.ticks),
  }
}

export function createTempoDocument(tempoData = null) {
  const sourceTempos = Array.isArray(tempoData?.tempos) ? tempoData.tempos : []
  const sourceTimeSignatures = Array.isArray(tempoData?.timeSignatures) ? tempoData.timeSignatures : []
  const sourceKeySignatures = Array.isArray(tempoData?.keySignatures) ? tempoData.keySignatures : []
  const tempos = (sourceTempos.length > 0 ? sourceTempos : [{ bpm: PIANO_ROLL.DEFAULT_BPM, time: 0 }])
    .map(normalizeTempo)
    .sort((left, right) => left.time - right.time)
  const timeSignatures = (sourceTimeSignatures.length > 0
    ? sourceTimeSignatures
    : [{ timeSignature: [...PIANO_ROLL.DEFAULT_TIME_SIGNATURE], time: 0 }])
    .map(normalizeTimeSignature)
    .sort((left, right) => left.time - right.time)
  const keySignatures = sourceKeySignatures
    .map(normalizeKeySignature)
    .sort((left, right) => left.time - right.time)

  return {
    tempos,
    timeSignatures,
    keySignatures,
    hasTempoInfo: tempoData?.hasTempoInfo ?? sourceTempos.length > 0,
    hasTimeSignatureInfo: tempoData?.hasTimeSignatureInfo ?? sourceTimeSignatures.length > 0,
    hasKeySignatureInfo: tempoData?.hasKeySignatureInfo ?? sourceKeySignatures.length > 0,
  }
}
