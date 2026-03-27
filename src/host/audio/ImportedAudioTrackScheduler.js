import { startToneAudio } from './instruments/toneRuntime.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { normalizeTrackVolume, resolveTrackPlaybackGain } from '../project/trackPlaybackState.js'

function applyGainValue(gainNode, volume, contextTime = null) {
  if (!gainNode) return
  const nextVolume = resolveTrackPlaybackGain(volume)
  if (Number.isFinite(contextTime)) {
    gainNode.gain.cancelScheduledValues(contextTime)
    gainNode.gain.setValueAtTime(nextVolume, contextTime)
    return
  }
  gainNode.gain.value = nextVolume
}

export class ImportedAudioTrackScheduler {
  constructor(assetRegistry, { logger = null } = {}) {
    this.assetRegistry = assetRegistry
    this.logger = logger
    this.rawContext = null
    this.entries = []
    this.activeSources = new Map()
    this.active = false
  }

  async prepare({ tracks, audibleTrackIds, fromTimeSec = 0 }) {
    this.stop()

    const readyEntries = (Array.isArray(tracks) ? tracks : [])
      .filter((track) => audibleTrackIds?.has(track.id) && isAudioTrack(track))
      .map((track) => {
        const clip = track.audioClip
        const asset = this.assetRegistry.getAsset(clip?.assetId)
        if (!asset?.buffer) return null
        const startSec = Number.isFinite(clip?.startTime) ? Math.max(0, clip.startTime) : 0
        const duration = Number.isFinite(clip?.duration) && clip.duration > 0
          ? clip.duration
          : asset.buffer.duration
        return {
          trackId: track.id,
          assetId: clip.assetId,
          buffer: asset.buffer,
          startSec,
          duration,
          endSec: startSec + duration,
          volume: normalizeTrackVolume(track.playbackState?.volume),
        }
      })
      .filter(Boolean)

    this.entries = readyEntries
    this.active = readyEntries.length > 0
    if (this.active) {
      this.rawContext = await startToneAudio()
    }

    return {
      hasPlayableAudioTracks: readyEntries.some((entry) => entry.endSec > fromTimeSec),
      duration: readyEntries.reduce((maxValue, entry) => Math.max(maxValue, entry.endSec), 0),
      trackIds: readyEntries.map((entry) => entry.trackId),
    }
  }

  tick(songTimeSec) {
    if (!this.active || !this.rawContext) return

    for (const [trackId, activeSource] of this.activeSources) {
      if (activeSource.endSec <= songTimeSec) {
        this.activeSources.delete(trackId)
      }
    }

    this.entries.forEach((entry) => {
      if (this.activeSources.has(entry.trackId)) return
      this._scheduleTrack(entry, songTimeSec)
    })
  }

  stop() {
    this.entries = []
    this.active = false
    for (const [, activeSource] of this.activeSources) {
      try {
        activeSource.source.onended = null
        activeSource.source.stop()
        activeSource.source.disconnect()
        activeSource.gainNode?.disconnect()
      } catch (_error) {
      }
    }
    this.activeSources.clear()
  }

  setTrackVolume(trackId, volume) {
    if (!trackId) return false
    const nextVolume = normalizeTrackVolume(volume)
    let updated = false
    this.entries.forEach((entry) => {
      if (entry.trackId !== trackId) return
      entry.volume = nextVolume
      updated = true
    })
    const activeSource = this.activeSources.get(trackId)
    if (activeSource?.gainNode) {
      applyGainValue(activeSource.gainNode, nextVolume, this.rawContext?.currentTime)
      updated = true
    }
    return updated
  }

  _scheduleTrack(entry, songTimeSec) {
    const buffer = entry.buffer
    if (!buffer || !this.rawContext) return
    if (songTimeSec >= entry.endSec) return

    const source = this.rawContext.createBufferSource()
    const gainNode = this.rawContext.createGain()
    source.buffer = buffer
    applyGainValue(gainNode, entry.volume)
    source.connect(gainNode)
    gainNode.connect(this.rawContext.destination)

    const startDelay = Math.max(0, entry.startSec - songTimeSec)
    const offset = Math.max(0, songTimeSec - entry.startSec)
    source.start(this.rawContext.currentTime + startDelay, offset)
    source.onended = () => {
      source.disconnect()
      gainNode.disconnect()
      this.activeSources.delete(entry.trackId)
    }

    this.activeSources.set(entry.trackId, {
      source,
      gainNode,
      endSec: entry.endSec,
    })
    this.logger?.info?.('Imported audio track scheduled', {
      trackId: entry.trackId,
      assetId: entry.assetId,
      songTimeSec,
      startDelay,
      offset,
    })
  }
}
