import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'

export function canUseConvertedVocal(track) {
  const state = track?.voiceConversionState
  if (!state) return false
  if (!isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) return false
  return state.status === 'ready'
    && state.appliedVariant === 'converted'
    && !state.stale
    && Boolean(state.resultAssetKey)
    && Boolean(state.resultAssetUrl)
}

export function collectConvertedTrackRefs(tracks, audibleTrackIds) {
  const refs = []

  ;(tracks || []).forEach((track) => {
    if (!track?.id || !audibleTrackIds.has(track.id)) return
    if (!canUseConvertedVocal(track)) return
    refs.push({
      trackId: track.id,
      assetKey: track.voiceConversionState.resultAssetKey,
      assetUrl: track.voiceConversionState.resultAssetUrl,
      sourceJobId: track.voiceConversionState.sourceJobId || null,
      sourceRevision: track.voiceConversionState.sourceRevision || 0,
    })
  })

  return refs
}
