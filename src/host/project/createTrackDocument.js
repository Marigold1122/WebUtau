import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { createPhraseDocuments } from '../../shared/phraseDocument.js'
import { normalizeAudioClip, normalizeTrackContentType, TRACK_CONTENT_TYPES } from './trackContentType.js'
import { createTrackJobRef } from './trackJobRef.js'
import { createTrackPlaybackState } from './trackPlaybackState.js'
import { createPrepState } from './trackPrepState.js'
import { getRoleForAssignedSource } from './trackSourceAssignment.js'
import { createVocalRenderManifest } from '../vocal/VocalRenderManifest.js'
import { createTrackVoiceConversionState } from '../vocal/TrackVoiceConversionState.js'

function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

function createRenderState() {
  return {
    status: 'idle',
    completed: 0,
    total: 0,
    error: null,
  }
}

export function createTrackDocument(trackSummary, sourcePhrases = [], languageCode = null, playbackDefaults = null) {
  const playbackState = createTrackPlaybackState(trackSummary?.playbackState, playbackDefaults || {})
  const phrases = createPhraseDocuments(sourcePhrases)
  const contentType = normalizeTrackContentType(trackSummary?.contentType)
  const audioClip = normalizeAudioClip(trackSummary?.audioClip)
  return {
    id: `track-${trackSummary.index}`,
    midiTrackIndex: trackSummary.index,
    name: trackSummary.name,
    hasLyrics: trackSummary.hasLyrics,
    role: trackSummary?.role || (contentType === TRACK_CONTENT_TYPES.AUDIO
      ? 'audio'
      : getRoleForAssignedSource(playbackState.assignedSourceId)),
    contentType,
    languageCode: normalizeOptionalLanguageCode(languageCode),
    singerId: null,
    duration: trackSummary.duration || 0,
    durationTicks: trackSummary.durationTicks || 0,
    noteCount: trackSummary.noteCount || 0,
    phraseCount: null,
    previewNotes: cloneValue(trackSummary.previewNotes, []),
    sourcePhrases: phrases,
    audioClip,
    voiceSnapshot: null,
    pendingVoiceEditState: null,
    vocalManifest: createVocalRenderManifest({ phrases, revision: 0 }),
    voiceConversionState: createTrackVoiceConversionState(),
    playbackState,
    revision: 0,
    jobRef: createTrackJobRef(),
    prepState: createPrepState(),
    renderState: createRenderState(),
  }
}
