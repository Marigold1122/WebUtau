import { Midi } from '@tonejs/midi'
import midiImporter from '../../modules/MidiImporter.js'
import midiEncoder from '../../modules/MidiEncoder.js'
import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { createPhraseDocuments } from '../../shared/phraseDocument.js'
import { createTempoDocument } from '../../shared/tempoDocument.js'
import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { createTrackDocument } from '../project/createTrackDocument.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { isTrackPrepReady } from '../project/trackPrepState.js'

function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

function clampMidi(value, fallback = 60) {
  const midi = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(0, Math.min(127, midi))
}

function clampVelocity(value, fallback = 0.8) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function createEncodedMidi(phrases, tempoData) {
  const bpm = tempoData?.tempos?.[0]?.bpm || 120
  const timeSignature = tempoData?.timeSignatures?.[0]?.timeSignature || [4, 4]
  return midiEncoder.encode(phrases, bpm, timeSignature)
}

function sanitizeBaseName(fileName = '') {
  const normalized = String(fileName || '').trim()
  if (!normalized) return 'melody-export'
  return normalized.replace(/\.[^.]+$/, '') || 'melody-export'
}

function buildTempoHeader(project = {}) {
  const tempoData = createTempoDocument(project?.tempoData)
  return {
    name: sanitizeBaseName(project?.fileName),
    ppq: Number.isFinite(project?.ppq) && project.ppq > 0 ? project.ppq : 480,
    tempos: (tempoData?.tempos || []).map((tempo) => ({
      bpm: tempo.bpm,
      ticks: Number.isFinite(tempo.ticks) ? tempo.ticks : 0,
    })),
    timeSignatures: (tempoData?.timeSignatures || []).map((signature) => ({
      ticks: Number.isFinite(signature.ticks) ? signature.ticks : 0,
      timeSignature: Array.isArray(signature.timeSignature) ? signature.timeSignature : [4, 4],
    })),
    keySignatures: (tempoData?.keySignatures || []).map((signature) => ({
      ticks: Number.isFinite(signature.ticks) ? signature.ticks : 0,
      key: typeof signature.key === 'string' && signature.key ? signature.key : 'C',
      scale: signature.scale === 'minor' ? 'minor' : 'major',
    })),
    meta: [],
  }
}

function buildPreviewStats(previewNotes = []) {
  return previewNotes.reduce((acc, note) => {
    acc.duration = Math.max(acc.duration, note.time + note.duration)
    acc.durationTicks = Math.max(acc.durationTicks, note.tick + note.durationTicks)
    return acc
  }, {
    noteCount: Array.isArray(previewNotes) ? previewNotes.length : 0,
    duration: 0,
    durationTicks: 0,
  })
}

function buildSourcePhrasesFromPreviewNotes(previewNotes = []) {
  if (!Array.isArray(previewNotes) || previewNotes.length === 0) return []
  const phraseNotes = previewNotes.map((note) => ({
    time: note.time,
    duration: note.duration,
    midi: note.midi,
    velocity: note.velocity,
    lyric: 'a',
  }))
  const endTime = phraseNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), 0)
  return createPhraseDocuments([{
    index: 0,
    startTime: phraseNotes[0].time,
    endTime,
    notes: phraseNotes,
  }])
}

function buildRetimedSourcePhrases(sourcePhrases = [], previewNotes = []) {
  if (!Array.isArray(sourcePhrases) || sourcePhrases.length === 0) {
    return buildSourcePhrasesFromPreviewNotes(previewNotes)
  }
  let noteIndex = 0
  return createPhraseDocuments(sourcePhrases.map((phrase, phraseIndex) => {
    const nextNotes = (Array.isArray(phrase?.notes) ? phrase.notes : []).map((note) => {
      const previewNote = previewNotes[noteIndex] || null
      noteIndex += 1
      return {
        ...note,
        time: previewNote?.time ?? note?.time ?? 0,
        duration: previewNote?.duration ?? note?.duration ?? 0,
        midi: previewNote?.midi ?? note?.midi ?? 60,
        velocity: previewNote?.velocity ?? note?.velocity ?? 0.8,
      }
    })
    const startTime = nextNotes[0]?.time ?? 0
    const endTime = nextNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), startTime)
    return {
      ...phrase,
      index: Number.isInteger(phrase?.index) ? phrase.index : phraseIndex,
      startTime,
      endTime,
      notes: nextNotes,
    }
  }))
}

function getExportableTracks(project = {}) {
  return (Array.isArray(project?.tracks) ? project.tracks : [])
    .filter((track) => !isAudioTrack(track) && Array.isArray(track?.previewNotes) && track.previewNotes.length > 0)
}

function getTrackProgramNumber(track = {}) {
  const sourceId = track?.playbackState?.assignedSourceId || null
  if (sourceId === 'violin') return 40
  if (sourceId === 'vocal') return 52
  if (sourceId === 'drums') return 0
  return 0
}

function getTrackChannel(track = {}, trackIndex = 0) {
  if (track?.playbackState?.assignedSourceId === 'drums') return 9
  const channel = trackIndex % 15
  return channel >= 9 ? channel + 1 : channel
}

export class ImportProjectService {
  async importFile(file, languageCode = null) {
    const tracks = await midiImporter.loadFile(file)
    return {
      fileName: file.name,
      ppq: midiImporter.getPpq(),
      tempoData: createTempoDocument(midiImporter.tempoData),
      tracks: tracks.map((track) => createTrackDocument(
        track,
        midiImporter.getTrackPhrases(track.index),
        normalizeOptionalLanguageCode(languageCode),
      )),
    }
  }

  applyProjectTiming(project, {
    tempoData = null,
    ppq = null,
  } = {}) {
    if (!project) return null
    const sourcePpq = Number.isFinite(project.ppq) && project.ppq > 0 ? project.ppq : 480
    const targetPpq = Number.isFinite(ppq) && ppq > 0 ? Math.round(ppq) : sourcePpq
    const targetTempoData = createTempoDocument(tempoData)
    const tickScale = targetPpq / sourcePpq
    const axis = createTimelineAxis({
      tempoData: targetTempoData,
      ppq: targetPpq,
      totalTicks: 0,
    })

    const tracks = (Array.isArray(project.tracks) ? project.tracks : []).map((track) => {
      if (isAudioTrack(track)) return track

      const previewNotes = (Array.isArray(track.previewNotes) ? track.previewNotes : []).map((note) => {
        const scaledTick = Math.max(0, Math.round((note?.tick || 0) * tickScale))
        const scaledDurationTicks = Math.max(1, Math.round((note?.durationTicks || 1) * tickScale))
        const startTime = axis.tickToTime(scaledTick)
        const endTime = axis.tickToTime(scaledTick + scaledDurationTicks)
        return {
          time: startTime,
          duration: Math.max(0.05, endTime - startTime),
          tick: scaledTick,
          durationTicks: scaledDurationTicks,
          midi: clampMidi(note?.midi),
          velocity: clampVelocity(note?.velocity),
        }
      })
      const stats = buildPreviewStats(previewNotes)
      const sourcePhrases = buildRetimedSourcePhrases(track.sourcePhrases, previewNotes)

      return {
        ...track,
        previewNotes,
        sourcePhrases,
        noteCount: stats.noteCount,
        phraseCount: sourcePhrases.length,
        duration: stats.duration,
        durationTicks: stats.durationTicks,
        voiceSnapshot: null,
      }
    })

    return {
      ...project,
      ppq: targetPpq,
      tempoData: targetTempoData,
      tracks,
    }
  }

  buildVoiceSnapshot(track, tempoDataSource) {
    const prepReady = isTrackPrepReady(track)
    if (track.voiceSnapshot) {
      const snapshot = cloneValue(track.voiceSnapshot, null)
      if (!snapshot) return null
      snapshot.trackId = track.id
      snapshot.trackIndex = track.midiTrackIndex
      snapshot.trackName = track.name
      snapshot.languageCode = normalizeOptionalLanguageCode(track.languageCode)
      snapshot.jobId = track.jobRef?.jobId || null
      if (!prepReady) snapshot.pitchData = null
      snapshot.renderManifest = cloneValue(track.vocalManifest, null)
      return snapshot
    }

    const phrases = createPhraseDocuments(track.sourcePhrases)
    const tempoData = createTempoDocument(tempoDataSource)
    const bpm = tempoData?.tempos?.[0]?.bpm || 120

    return {
      trackId: track.id,
      trackIndex: track.midiTrackIndex,
      trackName: track.name,
      languageCode: normalizeOptionalLanguageCode(track.languageCode),
      jobId: prepReady ? (track.jobRef?.jobId || null) : null,
      tempoData,
      bpm,
      phraseCount: phrases.length,
      noteCount: phrases.flatMap((phrase) => phrase.notes || []).length,
      duration: track.duration,
      previewNotes: cloneValue(track.previewNotes, []),
      phrases,
      pitchData: prepReady ? cloneValue(track.voiceSnapshot?.pitchData, null) : null,
      encodedMidi: createEncodedMidi(phrases, tempoData),
      renderManifest: cloneValue(track.vocalManifest, null),
    }
  }

  buildProjectMidiFile(project) {
    const exportableTracks = getExportableTracks(project)
    if (exportableTracks.length === 0) return null

    const midi = new Midi()
    midi.header.fromJSON(buildTempoHeader(project))

    exportableTracks.forEach((track, index) => {
      const midiTrack = midi.addTrack()
      midiTrack.name = track.name || `Track ${index + 1}`
      midiTrack.channel = getTrackChannel(track, index)
      midiTrack.instrument.number = getTrackProgramNumber(track)
      ;(track.previewNotes || []).forEach((note) => {
        midiTrack.addNote({
          midi: note.midi,
          ticks: note.tick,
          durationTicks: note.durationTicks,
          velocity: note.velocity,
        })
      })
    })

    return new File(
      [midi.toArray()],
      `${sanitizeBaseName(project?.fileName)}.mid`,
      { type: 'audio/midi' },
    )
  }
}
