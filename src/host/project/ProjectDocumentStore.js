import { createTempoDocument } from '../../shared/tempoDocument.js'
import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { createPhraseDocuments } from '../../shared/phraseDocument.js'
import { buildPreviewProjection } from '../services/PreviewProjector.js'
import { createTrackDocument } from './createTrackDocument.js'
import { createProjectMixState, mergeProjectMixState } from './projectMixState.js'
import { migrateProjectReverbState } from './migrations/reverbStateMigration.js'
import { createTrackPlaybackState, mergeTrackPlaybackState } from './trackPlaybackState.js'
import { isAudioTrack, normalizeAudioClip, normalizeTrackContentType, TRACK_CONTENT_TYPES } from './trackContentType.js'

function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

const DEFAULT_PPQ = 480

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function clampMidi(value) {
  const midi = Number.isFinite(value) ? Math.round(value) : 60
  return Math.max(0, Math.min(127, midi))
}

function clampVelocity(value) {
  if (!Number.isFinite(value)) return 0.8
  return Math.max(0, Math.min(1, value))
}

function normalizePreviewNote(note = {}) {
  const time = clampNonNegative(note.time)
  const duration = Math.max(0.05, clampNonNegative(note.duration, 0.05))
  const tick = Math.round(clampNonNegative(note.tick))
  const durationTicks = Math.max(1, Math.round(clampNonNegative(note.durationTicks, 1)))
  return {
    time,
    duration,
    tick,
    durationTicks,
    midi: clampMidi(note.midi),
    velocity: clampVelocity(note.velocity),
  }
}

function sortPreviewNotes(notes = []) {
  return [...notes].sort((left, right) => {
    if (left.tick !== right.tick) return left.tick - right.tick
    if (left.time !== right.time) return left.time - right.time
    return left.midi - right.midi
  })
}

function buildPreviewStats(previewNotes = []) {
  return previewNotes.reduce((acc, note) => {
    acc.duration = Math.max(acc.duration, note.time + note.duration)
    acc.durationTicks = Math.max(acc.durationTicks, note.tick + note.durationTicks)
    return acc
  }, {
    noteCount: previewNotes.length,
    duration: 0,
    durationTicks: 0,
  })
}

function buildTrackPlaybackDefaults(mixState = null) { const defaultConfig = mixState?.reverb || null; return {
  reverbPresetId: mixState?.reverbPresetId, reverbConfig: defaultConfig, reverb: { presetId: mixState?.reverbPresetId, send: 0, enabled: Number(defaultConfig?.returnGain || 0) > 0.0001, config: defaultConfig },
} }

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

function getTrackStartTime(track) {
  if (isAudioTrack(track)) return clampNonNegative(track.audioClip?.startTime)
  return (Array.isArray(track?.previewNotes) ? track.previewNotes : []).reduce((minValue, note) => {
    return Math.min(minValue, clampNonNegative(note?.time))
  }, Infinity)
}

function getTrackStartTick(track, axis) {
  if (isAudioTrack(track)) return Math.max(0, Math.round(axis.timeToTick(clampNonNegative(track.audioClip?.startTime))))
  return (Array.isArray(track?.previewNotes) ? track.previewNotes : []).reduce((minValue, note) => {
    const tick = Number.isFinite(note?.tick) ? Math.max(0, Math.round(note.tick)) : 0
    return Math.min(minValue, tick)
  }, Infinity)
}

function shiftPreviewNotes(previewNotes = [], deltaTime = 0, deltaTick = 0) {
  return sortPreviewNotes(
    (Array.isArray(previewNotes) ? previewNotes : []).map((note) => normalizePreviewNote({
      ...note,
      time: clampNonNegative(note?.time + deltaTime),
      tick: Math.max(0, Math.round((note?.tick || 0) + deltaTick)),
    })),
  )
}

function shiftSourcePhrases(sourcePhrases = [], deltaTime = 0) {
  return createPhraseDocuments((Array.isArray(sourcePhrases) ? sourcePhrases : []).map((phrase) => ({
    ...phrase,
    startTime: clampNonNegative(phrase?.startTime + deltaTime),
    endTime: clampNonNegative(phrase?.endTime + deltaTime),
    notes: (Array.isArray(phrase?.notes) ? phrase.notes : []).map((note) => ({
      ...note,
      time: clampNonNegative(note?.time + deltaTime),
    })),
  })))
}

export class ProjectDocumentStore {
  constructor() {
    this._project = null
  }

  setProject(project) {
    const sourceProject = migrateProjectReverbState(project)?.project || project
    const mixState = createProjectMixState(sourceProject?.mixState)
    const playbackDefaults = buildTrackPlaybackDefaults(mixState)
    const tracks = (Array.isArray(sourceProject?.tracks) ? sourceProject.tracks : []).map((track) => ({
      ...track,
      playbackState: createTrackPlaybackState(track?.playbackState, playbackDefaults),
    }))
    this._project = {
      fileName: sourceProject?.fileName || '',
      ppq: Number.isFinite(sourceProject?.ppq) && sourceProject.ppq > 0 ? sourceProject.ppq : DEFAULT_PPQ,
      tempoData: createTempoDocument(sourceProject?.tempoData),
      mixState,
      tracks,
      selectedTrackId: sourceProject?.selectedTrackId ?? tracks[0]?.id ?? null,
      editorTrackId: sourceProject?.editorTrackId ?? null,
    }
  }

  ensureProject(seed = {}) {
    if (this._project) return this._project
    this.setProject({
      fileName: seed.fileName || '',
      ppq: Number.isFinite(seed.ppq) && seed.ppq > 0 ? seed.ppq : DEFAULT_PPQ,
      tempoData: seed.tempoData || null,
      mixState: seed.mixState || null,
      tracks: [],
      selectedTrackId: null,
      editorTrackId: null,
    })
    return this._project
  }

  getProject() {
    return this._project
  }

  getTracks() {
    return this._project?.tracks || []
  }

  getTrack(trackId) {
    return this.getTracks().find((track) => track.id === trackId) || null
  }

  getSelectedTrack() {
    return this.getTrack(this._project?.selectedTrackId ?? null)
  }

  getEditorTrack() {
    return this.getTrack(this._project?.editorTrackId ?? null)
  }

  _getNextTrackIndex() {
    return this.getTracks().reduce((maxValue, track) => {
      if (!Number.isFinite(track?.midiTrackIndex)) return maxValue
      return Math.max(maxValue, Math.round(track.midiTrackIndex))
    }, -1) + 1
  }

  _getTrackInsertIndex(afterTrackId = null) {
    const tracks = this.getTracks()
    if (!afterTrackId) return tracks.length
    const currentIndex = tracks.findIndex((track) => track.id === afterTrackId)
    if (currentIndex < 0) return tracks.length
    return currentIndex + 1
  }

  createTrack({ name = null, languageCode = null, afterTrackId = null } = {}) {
    const project = this.ensureProject()
    const nextTrackIndex = this._getNextTrackIndex()
    const playbackDefaults = buildTrackPlaybackDefaults(project.mixState)
    const track = createTrackDocument({
      index: nextTrackIndex,
      name: name || `Track ${project.tracks.length + 1}`,
      hasLyrics: false,
      duration: 0,
      durationTicks: 0,
      noteCount: 0,
      previewNotes: [],
    }, [], languageCode, playbackDefaults)
    const insertIndex = this._getTrackInsertIndex(afterTrackId)
    project.tracks.splice(insertIndex, 0, track)
    project.selectedTrackId = track.id
    return track
  }

  createAudioTrack({
    name = null,
    afterTrackId = null,
    fileName = '',
    mimeType = '',
    duration = 0,
    startTime = 0,
    assetId = '',
    waveformPeaks = [],
  } = {}) {
    const project = this.ensureProject()
    const nextTrackIndex = this._getNextTrackIndex()
    const playbackDefaults = buildTrackPlaybackDefaults(project.mixState)
    const axis = createTimelineAxis({
      tempoData: project.tempoData,
      ppq: project.ppq,
      totalTicks: 0,
    })
    const safeDuration = clampNonNegative(duration)
    const safeStartTime = clampNonNegative(startTime)
    const durationTicks = Math.max(0, Math.round(axis.timeToTick(safeStartTime + safeDuration)))
    const track = createTrackDocument({
      index: nextTrackIndex,
      name: name || `Audio ${project.tracks.length + 1}`,
      hasLyrics: false,
      role: 'audio',
      contentType: TRACK_CONTENT_TYPES.AUDIO,
      duration: safeStartTime + safeDuration,
      durationTicks,
      noteCount: 0,
      previewNotes: [],
      audioClip: {
        assetId,
        fileName,
        mimeType,
        startTime: safeStartTime,
        duration: safeDuration,
        waveformPeaks,
      },
    }, [], null, playbackDefaults)
    const insertIndex = this._getTrackInsertIndex(afterTrackId)
    project.tracks.splice(insertIndex, 0, track)
    project.selectedTrackId = track.id
    return track
  }

  removeTrack(trackId) {
    const project = this._project
    if (!project) return null
    const index = project.tracks.findIndex((track) => track.id === trackId)
    if (index < 0) return null
    const [removedTrack] = project.tracks.splice(index, 1)
    if (project.editorTrackId === trackId) {
      project.editorTrackId = null
    }
    if (project.selectedTrackId === trackId) {
      const fallback = project.tracks[index] || project.tracks[index - 1] || null
      project.selectedTrackId = fallback?.id ?? null
    } else if (!project.selectedTrackId && project.tracks.length > 0) {
      project.selectedTrackId = project.tracks[0].id
    }
    return removedTrack
  }

  replaceTrackNotes(trackId, notes = []) {
    return this.replaceTrackPreviewNotes(trackId, notes, {
      rebuildSourcePhrases: true,
      clearVoiceSnapshot: true,
      clearPendingVoiceEditState: true,
    })
  }

  replaceTrackPreviewNotes(trackId, notes = [], {
    rebuildSourcePhrases = true,
    clearVoiceSnapshot = true,
    clearPendingVoiceEditState = false,
  } = {}) {
    const track = this.getTrack(trackId)
    if (!track) return null
    const normalizedNotes = sortPreviewNotes(
      (Array.isArray(notes) ? notes : []).map((note) => normalizePreviewNote(note)),
    )
    const stats = buildPreviewStats(normalizedNotes)
    track.previewNotes = cloneValue(normalizedNotes, [])
    if (rebuildSourcePhrases) {
      track.sourcePhrases = buildSourcePhrasesFromPreviewNotes(normalizedNotes)
    }
    track.noteCount = stats.noteCount
    track.phraseCount = Array.isArray(track.sourcePhrases) ? track.sourcePhrases.length : 0
    track.duration = stats.duration
    track.durationTicks = stats.durationTicks
    if (clearVoiceSnapshot) track.voiceSnapshot = null
    if (clearPendingVoiceEditState) track.pendingVoiceEditState = null
    return track
  }

  shiftTrackContent(trackId, deltaTime = 0) {
    const track = this.getTrack(trackId)
    const project = this._project
    if (!track || !project || !Number.isFinite(deltaTime) || Math.abs(deltaTime) < 0.0005) {
      return { moved: false, deltaTime: 0, deltaTick: 0 }
    }

    const axis = createTimelineAxis({
      tempoData: project.tempoData,
      ppq: project.ppq,
      totalTicks: 0,
    })
    const startTime = getTrackStartTime(track)
    const startTick = getTrackStartTick(track, axis)
    if (!Number.isFinite(startTime) || !Number.isFinite(startTick)) {
      return { moved: false, deltaTime: 0, deltaTick: 0 }
    }

    const nextStartTime = Math.max(0, startTime + deltaTime)
    const nextStartTick = Math.max(0, Math.round(axis.timeToTick(nextStartTime)))
    const actualDeltaTime = nextStartTime - startTime
    const actualDeltaTick = nextStartTick - startTick
    if (Math.abs(actualDeltaTime) < 0.0005 && actualDeltaTick === 0) {
      return { moved: false, deltaTime: 0, deltaTick: 0 }
    }

    if (isAudioTrack(track)) {
      const audioClip = normalizeAudioClip({
        ...track.audioClip,
        startTime: nextStartTime,
      })
      track.audioClip = audioClip
      track.duration = (audioClip?.startTime || 0) + (audioClip?.duration || 0)
      track.durationTicks = Math.max(0, Math.round(axis.timeToTick(track.duration)))
      track.voiceSnapshot = null
      return {
        moved: true,
        deltaTime: actualDeltaTime,
        deltaTick: actualDeltaTick,
      }
    }

    track.previewNotes = shiftPreviewNotes(track.previewNotes, actualDeltaTime, actualDeltaTick)
    track.sourcePhrases = shiftSourcePhrases(track.sourcePhrases, actualDeltaTime)
    const stats = buildPreviewStats(track.previewNotes)
    track.noteCount = stats.noteCount
    track.phraseCount = track.sourcePhrases.length
    track.duration = stats.duration
    track.durationTicks = stats.durationTicks
    track.voiceSnapshot = null
    return {
      moved: true,
      deltaTime: actualDeltaTime,
      deltaTick: actualDeltaTick,
    }
  }

  setSelectedTrack(trackId) {
    if (!this.getTrack(trackId)) return
    this._project.selectedTrackId = trackId
  }

  setEditorTrack(trackId) {
    this._project.editorTrackId = trackId
    if (trackId) this.setSelectedTrack(trackId)
  }

  updateTrack(trackId, changes) {
    const track = this.getTrack(trackId)
    if (!track) return null
    Object.assign(track, changes)
    if (changes && 'contentType' in changes) {
      track.contentType = normalizeTrackContentType(changes.contentType)
    }
    if (changes && 'audioClip' in changes) {
      track.audioClip = normalizeAudioClip(changes.audioClip)
    }
    return track
  }

  incrementTrackRevision(trackId) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.revision = (track.revision || 0) + 1
    return track.revision
  }

  updateTrackJobRef(trackId, jobRef) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.jobRef = {
      ...track.jobRef,
      ...jobRef,
    }
    return track
  }

  updateTrackPrepState(trackId, prepState) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.prepState = {
      ...track.prepState,
      ...prepState,
    }
    return track
  }

  updateTrackRenderState(trackId, renderState) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.renderState = {
      ...track.renderState,
      ...renderState,
    }
    return track
  }

  updateTrackPlaybackState(trackId, playbackState) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.playbackState = mergeTrackPlaybackState(
      track.playbackState,
      playbackState,
      buildTrackPlaybackDefaults(this._project?.mixState),
    )
    return track
  }

  updateProjectMixState(mixState) {
    const project = this._project
    if (!project) return null
    project.mixState = mergeProjectMixState(project.mixState, mixState)
    return project.mixState
  }

  replaceTrackVocalManifest(trackId, vocalManifest) {
    const track = this.getTrack(trackId)
    if (!track || !vocalManifest) return null
    track.vocalManifest = cloneValue(vocalManifest, track.vocalManifest)
    return track
  }

  updateTrackVoiceConversionState(trackId, changes) {
    const track = this.getTrack(trackId)
    if (!track) return null
    track.voiceConversionState = {
      ...track.voiceConversionState,
      ...cloneValue(changes, {}),
    }
    return track
  }

  replaceTrackVoiceConversionState(trackId, voiceConversionState) {
    const track = this.getTrack(trackId)
    if (!track || !voiceConversionState) return null
    track.voiceConversionState = cloneValue(voiceConversionState, track.voiceConversionState)
    return track
  }

  replaceVoiceSnapshot(trackId, snapshot) {
    const track = this.getTrack(trackId)
    if (!track || !snapshot) return null
    const projection = buildPreviewProjection(snapshot, this._project?.tempoData, this._project?.ppq)
    track.voiceSnapshot = cloneValue(snapshot, null)
    track.sourcePhrases = createPhraseDocuments(snapshot?.phrases)
    track.previewNotes = cloneValue(projection.previewNotes, track.previewNotes)
    track.noteCount = projection.noteCount ?? snapshot.noteCount ?? track.noteCount
    track.phraseCount = snapshot.phraseCount ?? track.sourcePhrases.length ?? track.phraseCount
    track.duration = projection.duration ?? snapshot.duration ?? track.duration
    track.durationTicks = projection.durationTicks ?? track.durationTicks
    return track
  }
}
