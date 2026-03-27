import { createPhraseDocuments } from '../../shared/phraseDocument.js'
import { createTempoDocument } from '../../shared/tempoDocument.js'

function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

function buildPreviewNotesFromPhrases(phrases) {
  return (Array.isArray(phrases) ? phrases : [])
    .flatMap((phrase) => phrase.notes || [])
    .map((note) => ({
      time: note.time,
      duration: note.duration,
      midi: note.midi,
      velocity: note.velocity,
    }))
}

function getTrackDuration(previewNotes) {
  if (previewNotes.length === 0) return 0
  return previewNotes.reduce((maxDuration, note) => Math.max(maxDuration, note.time + note.duration), 0)
}

export function buildRuntimeSnapshot(meta, phraseStore) {
  const phrases = createPhraseDocuments(phraseStore.getPhrases())
  const previewNotes = buildPreviewNotesFromPhrases(phrases)

  return {
    trackId: meta.trackId,
    trackIndex: meta.trackIndex,
    trackName: meta.trackName,
    languageCode: meta.languageCode,
    jobId: phraseStore.getJobId(),
    tempoData: createTempoDocument(meta.tempoData),
    bpm: phraseStore.getBpm(),
    phraseCount: phrases.length,
    noteCount: previewNotes.length,
    duration: getTrackDuration(previewNotes),
    previewNotes,
    phrases,
    pitchData: cloneValue(phraseStore.getPitchData(), null),
    encodedMidi: phraseStore.getMidiFile(),
  }
}

export function cloneSnapshot(snapshot) {
  return cloneValue(snapshot, null)
}
