const TRACK_COLORS = ['#3b8b88', '#c94234', '#d4a035', '#66a06f', '#c05640', '#4b6a88']

export function getTrackColor(index = 0) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.round(index)) : 0
  return TRACK_COLORS[safeIndex % TRACK_COLORS.length]
}

export function getTrackColorById(trackId, tracks = []) {
  const trackIndex = (Array.isArray(tracks) ? tracks : []).findIndex((track) => track?.id === trackId)
  return getTrackColor(trackIndex < 0 ? 0 : trackIndex)
}
