import { getHostPlaybackSourceId } from './sourceCatalog.js'
import { normalizeTrackVolume } from '../../project/trackPlaybackState.js'

const LOOKAHEAD_SECONDS = 0.3

function createScheduledNotes(tracks, audibleTrackIds, fromTimeSec) {
  const notes = []
  const trackVolumes = new Map()
  const sourceIds = new Set()

  tracks.forEach((track) => {
    if (!audibleTrackIds.has(track.id)) return
    const dirtyRanges = Array.isArray(track?.pendingVoiceEditState?.dirtyRanges)
      ? track.pendingVoiceEditState.dirtyRanges
      : []
    const previewDirtyVocal = track?.playbackState?.assignedSourceId === 'vocal' && dirtyRanges.length > 0
    const sourceId = previewDirtyVocal
      ? 'piano'
      : getHostPlaybackSourceId(track.playbackState?.assignedSourceId)
    if (!sourceId) return
    trackVolumes.set(track.id, normalizeTrackVolume(track.playbackState?.volume))
    sourceIds.add(sourceId)

    ;(track.previewNotes || []).forEach((note) => {
      const startSec = Number.isFinite(note?.time) ? Math.max(0, note.time) : 0
      const durationSec = Number.isFinite(note?.duration) ? Math.max(0.05, note.duration) : 0.05
      const endSec = startSec + durationSec
      if (endSec <= fromTimeSec) return
      if (
        previewDirtyVocal
        && !dirtyRanges.some((range) => startSec < (range?.endTime || 0) && (range?.startTime || 0) < endSec)
      ) {
        return
      }

      notes.push({
        trackId: track.id,
        sourceId,
        midi: note.midi,
        velocity: Number.isFinite(note?.velocity) ? note.velocity : 0.8,
        startSec,
        endSec,
      })
    })
  })

  notes.sort((left, right) => left.startSec - right.startSec)
  return {
    notes,
    sourceIds: [...sourceIds],
    trackVolumes,
  }
}

function findStartIndex(notes, fromTimeSec) {
  let index = 0
  while (index < notes.length && notes[index].endSec <= fromTimeSec) {
    index += 1
  }
  return index
}

export class InstrumentScheduler {
  constructor(samplerPool) {
    this.samplerPool = samplerPool
    this.notes = []
    this.nextIndex = 0
    this.duration = 0
    this.active = false
    this.prepareToken = 0
    this.trackVolumes = new Map()
  }

  async prepare({ tracks, audibleTrackIds, fromTimeSec = 0 }) {
    const token = ++this.prepareToken
    const { notes, sourceIds, trackVolumes } = createScheduledNotes(
      tracks || [],
      audibleTrackIds || new Set(),
      fromTimeSec,
    )
    const nextIndex = findStartIndex(notes, fromTimeSec)
    const duration = notes.reduce((maxValue, note) => Math.max(maxValue, note.endSec), 0)
    this._clearState()

    await this.samplerPool.prepareSources(sourceIds)
    if (token !== this.prepareToken) {
      return {
        hasPlayableNotes: false,
        duration: 0,
        sourceIds: [],
      }
    }

    this.notes = notes
    this.nextIndex = nextIndex
    this.duration = duration
    this.active = notes.length > 0
    this.trackVolumes = trackVolumes

    return {
      hasPlayableNotes: notes.length > 0,
      duration,
      sourceIds,
    }
  }

  tick(songTimeSec) {
    if (!this.active) return

    const targetSongTime = songTimeSec + LOOKAHEAD_SECONDS
    const audioNow = this.samplerPool.getAudioTime()

    while (this.nextIndex < this.notes.length) {
      const note = this.notes[this.nextIndex]
      if (note.startSec > targetSongTime) break

      const remainingDuration = note.endSec - songTimeSec
      const audioDelay = Math.max(0, note.startSec - songTimeSec)
      const playbackDuration = note.startSec >= songTimeSec
        ? note.endSec - note.startSec
        : remainingDuration
      const trackVolume = this.trackVolumes.get(note.trackId) ?? 1

      if (playbackDuration > 0.05) {
        this.samplerPool.triggerAttackRelease(
          note.sourceId,
          note.midi,
          playbackDuration,
          audioNow + audioDelay,
          {
            velocity: note.velocity,
            durationSec: playbackDuration,
            trackVolume,
          },
        )
      }

      this.nextIndex += 1
    }
  }

  stop() {
    this.prepareToken += 1
    this._clearState()
  }

  setTrackVolume(trackId, volume) {
    if (!trackId) return false
    this.trackVolumes.set(trackId, normalizeTrackVolume(volume))
    return true
  }

  _clearState() {
    this.active = false
    this.notes = []
    this.nextIndex = 0
    this.duration = 0
    this.trackVolumes = new Map()
    this.samplerPool.releaseAll()
  }
}
