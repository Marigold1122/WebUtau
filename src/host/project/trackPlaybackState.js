import { normalizeAssignedSourceId } from './trackSourceAssignment.js'

export const DEFAULT_TRACK_VOLUME = 0.5
export const MAX_TRACK_PLAYBACK_GAIN = 2

export function normalizeTrackVolume(value, fallback = DEFAULT_TRACK_VOLUME) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_TRACK_VOLUME
  const normalizedValue = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(0, Math.min(1, normalizedValue))
}

export function resolveTrackPlaybackGain(value, fallback = DEFAULT_TRACK_VOLUME) {
  return normalizeTrackVolume(value, fallback) * MAX_TRACK_PLAYBACK_GAIN
}

export function createTrackPlaybackState(state = {}) {
  return {
    assignedSourceId: normalizeAssignedSourceId(state.assignedSourceId),
    mute: Boolean(state.mute),
    solo: Boolean(state.solo),
    volume: normalizeTrackVolume(state.volume),
  }
}

export function mergeTrackPlaybackState(currentState, changes = {}) {
  return createTrackPlaybackState({
    ...createTrackPlaybackState(currentState),
    ...changes,
  })
}
