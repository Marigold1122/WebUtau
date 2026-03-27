import { createTimelineAxis } from '../../shared/timelineAxis.js'

const DEFAULT_PPQ = 480
const DEFAULT_BEAT_WIDTH = 40
const DEFAULT_TIME_SIGNATURE = [4, 4]
const MIN_VIEW_BARS = 64
const TAIL_BARS = 8
const SNAP_DIVISION = 4

function getBaseTimeSignature(tempoData = null) {
  const signature = tempoData?.timeSignatures?.[0]?.timeSignature
  if (!Array.isArray(signature) || signature.length < 2) return DEFAULT_TIME_SIGNATURE
  const beatsPerBar = Number.isFinite(signature[0]) && signature[0] > 0 ? Math.round(signature[0]) : DEFAULT_TIME_SIGNATURE[0]
  const beatUnit = Number.isFinite(signature[1]) && signature[1] > 0 ? Math.round(signature[1]) : DEFAULT_TIME_SIGNATURE[1]
  return [beatsPerBar, beatUnit]
}

function getTrackMaxTick(track) {
  if (Number.isFinite(track?.durationTicks) && track.durationTicks > 0) {
    return track.durationTicks
  }

  const previewNotes = Array.isArray(track?.previewNotes) ? track.previewNotes : []
  return previewNotes.reduce((maxTick, note) => {
    const startTick = Number.isFinite(note?.tick) ? note.tick : 0
    const durationTicks = Number.isFinite(note?.durationTicks) ? note.durationTicks : 0
    return Math.max(maxTick, startTick + durationTicks)
  }, 0)
}

export function getTrackTimelineMetrics(project) {
  const ppq = Number.isFinite(project?.ppq) && project.ppq > 0 ? project.ppq : DEFAULT_PPQ
  const tracks = Array.isArray(project?.tracks) ? project.tracks : []
  const contentEndTick = tracks.reduce((maxTick, track) => Math.max(maxTick, getTrackMaxTick(track)), 0)
  const [beatsPerBar, beatUnit] = getBaseTimeSignature(project?.tempoData)
  const beatTicks = Math.max(1, ppq * (4 / beatUnit))
  const totalTicks = Math.max(
    MIN_VIEW_BARS * beatsPerBar * beatTicks,
    contentEndTick + TAIL_BARS * beatsPerBar * beatTicks,
  )
  const beatWidth = DEFAULT_BEAT_WIDTH
  const axis = createTimelineAxis({
    tempoData: project?.tempoData,
    ppq,
    beatWidth,
    totalTicks,
  })

  return {
    axis,
    beatWidth,
    ppq,
    snapTicks: Math.max(1, Math.round(ppq / SNAP_DIVISION)),
    snapDivision: SNAP_DIVISION,
    timelineWidth: axis.timelineWidth,
    totalTicks,
  }
}

export function tickToTimelineX(tick, ppq, beatWidth) {
  if (!Number.isFinite(tick) || tick <= 0) return 0
  return (tick / ppq) * beatWidth
}
