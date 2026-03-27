export function resolveAudibleTrackIds(tracks, sessionState = {}) {
  const safeTracks = Array.isArray(tracks) ? tracks : []
  const focusSoloTrackId = sessionState.focusSoloTrackId || null

  if (focusSoloTrackId) return new Set([focusSoloTrackId])

  const soloTracks = safeTracks.filter((track) => track?.playbackState?.solo && !track?.playbackState?.mute)
  if (soloTracks.length > 0) return new Set(soloTracks.map((track) => track.id))

  return new Set(
    safeTracks
      .filter((track) => !track?.playbackState?.mute)
      .map((track) => track.id),
  )
}
