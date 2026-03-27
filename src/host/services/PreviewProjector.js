import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { isAudioTrack } from '../project/trackContentType.js'

const DEFAULT_PPQ = 480

function getTrackDuration(track) {
  if (isAudioTrack(track)) {
    return Math.max(0, (track.audioClip?.startTime || 0) + (track.audioClip?.duration || 0))
  }
  if (track?.duration) return track.duration
  const previewNotes = Array.isArray(track?.previewNotes) ? track.previewNotes : []
  return previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), 0)
}

export function getProjectDuration(tracks = []) {
  return tracks.reduce((maxDuration, track) => Math.max(maxDuration, getTrackDuration(track)), 0)
}

export function samplePreviewNotes(notes = [], maxCount = 96) {
  if (!Array.isArray(notes) || notes.length <= maxCount) return notes || []
  const step = Math.max(1, Math.ceil(notes.length / maxCount))
  return notes.filter((_, index) => index % step === 0)
}

function normalizePpq(ppq) {
  return Number.isFinite(ppq) && ppq > 0 ? ppq : DEFAULT_PPQ
}

function projectTickValue(axis, time) {
  return Math.max(0, Math.round(axis.timeToTick(Number.isFinite(time) ? time : 0)))
}

function projectNotePreview(note, axis) {
  const startTime = Number.isFinite(note?.time) ? Math.max(0, note.time) : 0
  const duration = Number.isFinite(note?.duration) ? Math.max(0, note.duration) : 0
  const startTick = Number.isFinite(note?.tick) ? Math.max(0, Math.round(note.tick)) : projectTickValue(axis, startTime)
  const endTick = Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)
    ? Math.max(startTick, Math.round(note.tick + note.durationTicks))
    : projectTickValue(axis, startTime + duration)

  return {
    time: startTime,
    duration,
    tick: startTick,
    durationTicks: duration <= 0 ? 0 : Math.max(1, endTick - startTick),
    midi: note?.midi,
    velocity: note?.velocity,
  }
}

export function projectPreviewNotes(notes = [], tempoData = null, ppq = DEFAULT_PPQ) {
  const axis = createTimelineAxis({
    tempoData,
    ppq: normalizePpq(ppq),
    totalTicks: 0,
  })

  return (Array.isArray(notes) ? notes : []).map((note) => projectNotePreview(note, axis))
}

export function buildPreviewProjection(snapshot = null, tempoData = null, ppq = DEFAULT_PPQ) {
  const sourceNotes = Array.isArray(snapshot?.phrases)
    ? snapshot.phrases.flatMap((phrase) => phrase?.notes || [])
    : Array.isArray(snapshot?.previewNotes)
      ? snapshot.previewNotes
      : []
  const previewNotes = projectPreviewNotes(sourceNotes, snapshot?.tempoData || tempoData, ppq)
  const duration = previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), 0)
  const durationTicks = previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.tick + note.durationTicks), 0)

  return {
    previewNotes,
    noteCount: previewNotes.length,
    duration,
    durationTicks,
  }
}
