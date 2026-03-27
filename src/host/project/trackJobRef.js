import { isTrackPrepPending } from './trackPrepState.js'

function isRenderPending(track) {
  const status = track?.renderState?.status
  return status === 'queued' || status === 'preparing' || status === 'rendering'
}

export function createTrackJobRef() {
  return {
    taskId: null,
    jobId: null,
    kind: null,
    phase: 'idle',
    intent: null,
    revision: 0,
    status: 'idle',
    startedAt: null,
    error: null,
  }
}

export function hasActiveTrackJob(track) {
  return track?.jobRef?.status === 'active'
}

export function hasOngoingTrackWork(track) {
  return isTrackPrepPending(track) || isRenderPending(track) || hasActiveTrackJob(track)
}
