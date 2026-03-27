export function createPrepState() {
  return {
    status: 'idle',
    progress: 0,
    error: null,
  }
}

export function hasPredictedPitch(snapshot) {
  return Array.isArray(snapshot?.pitchData?.pitchCurve) && snapshot.pitchData.pitchCurve.length > 0
}

export function isTrackPrepReady(track) {
  return track?.prepState?.status === 'ready'
}

export function isTrackPrepPending(track) {
  return track?.prepState?.status === 'queued' || track?.prepState?.status === 'predicting'
}
