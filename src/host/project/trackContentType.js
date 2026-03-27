export const TRACK_CONTENT_TYPES = Object.freeze({
  MIDI: 'midi',
  AUDIO: 'audio',
})

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function normalizeWaveformPeaks(peaks) {
  if (!Array.isArray(peaks)) return []
  return peaks
    .map((peak) => {
      if (!Number.isFinite(peak)) return null
      return Math.max(0, Math.min(1, Number(peak)))
    })
    .filter((peak) => peak != null)
}

export function normalizeTrackContentType(contentType) {
  return contentType === TRACK_CONTENT_TYPES.AUDIO
    ? TRACK_CONTENT_TYPES.AUDIO
    : TRACK_CONTENT_TYPES.MIDI
}

export function normalizeAudioClip(audioClip = null) {
  if (!audioClip || typeof audioClip !== 'object') return null
  if (!audioClip.assetId) return null
  return {
    assetId: String(audioClip.assetId),
    fileName: typeof audioClip.fileName === 'string' && audioClip.fileName ? audioClip.fileName : 'audio',
    mimeType: typeof audioClip.mimeType === 'string' ? audioClip.mimeType : '',
    startTime: clampNonNegative(audioClip.startTime),
    duration: clampNonNegative(audioClip.duration),
    waveformPeaks: normalizeWaveformPeaks(audioClip.waveformPeaks),
  }
}

export function isAudioTrack(track) {
  return normalizeTrackContentType(track?.contentType) === TRACK_CONTENT_TYPES.AUDIO
    && Boolean(normalizeAudioClip(track?.audioClip))
}
