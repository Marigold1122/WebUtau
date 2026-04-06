import {
  mergeTrackGuitarToneConfig,
  normalizeTrackGuitarToneConfig,
} from '../audio/insert/trackInsertCatalog.js'
import { normalizeAssignedSourceId } from './trackSourceAssignment.js'
import {
  DEFAULT_TRACK_REVERB_SEND,
  createTrackReverbState,
  mergeTrackReverbState,
  normalizeTrackReverbConfig,
  normalizeTrackReverbPresetId,
  normalizeTrackReverbSend,
  toLegacyTrackReverbFields,
} from './trackReverbState.js'

export const DEFAULT_TRACK_VOLUME = 0.5
export const MAX_TRACK_PLAYBACK_GAIN = 2
export const DEFAULT_TRACK_REVERB_PRESET_ID = normalizeTrackReverbPresetId()

export {
  DEFAULT_TRACK_REVERB_SEND,
  normalizeTrackGuitarToneConfig,
  normalizeTrackReverbConfig,
  normalizeTrackReverbPresetId,
  normalizeTrackReverbSend,
}

export function normalizeTrackVolume(value, fallback = DEFAULT_TRACK_VOLUME) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_TRACK_VOLUME
  const normalizedValue = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(0, Math.min(1, normalizedValue))
}

export function resolveTrackPlaybackGain(value, fallback = DEFAULT_TRACK_VOLUME) {
  return normalizeTrackVolume(value, fallback) * MAX_TRACK_PLAYBACK_GAIN
}

export function createTrackPlaybackState(state = {}, defaults = {}) {
  const reverb = createTrackReverbState(state, defaults)
  return {
    assignedSourceId: normalizeAssignedSourceId(state.assignedSourceId),
    mute: Boolean(state.mute),
    solo: Boolean(state.solo),
    volume: normalizeTrackVolume(state.volume, defaults?.volume),
    ...toLegacyTrackReverbFields(reverb),
    reverb,
    guitarTone: normalizeTrackGuitarToneConfig(state?.guitarTone, defaults?.guitarTone),
  }
}

export function mergeTrackPlaybackState(currentState, changes = {}, defaults = {}) {
  const current = createTrackPlaybackState(currentState, defaults)
  const nextReverb = mergeTrackReverbState(current.reverb, changes, defaults)
  return createTrackPlaybackState({
    ...current,
    ...changes,
    ...toLegacyTrackReverbFields(nextReverb),
    reverb: nextReverb,
    guitarTone: Object.prototype.hasOwnProperty.call(changes || {}, 'guitarTone')
      ? mergeTrackGuitarToneConfig(current.guitarTone, changes.guitarTone)
      : current.guitarTone,
  }, defaults)
}
