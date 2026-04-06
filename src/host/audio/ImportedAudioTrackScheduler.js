import { startToneAudio } from './instruments/toneRuntime.js'
import { isAudioTrack } from '../project/trackContentType.js'
import {
  normalizeTrackReverbConfig,
  normalizeTrackReverbSend,
  normalizeTrackVolume,
  resolveTrackPlaybackGain,
} from '../project/trackPlaybackState.js'

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
  constructor(assetRegistry, { logger = null, audioGraph = null } = {}) {
    this.assetRegistry = assetRegistry
    this.logger = logger
    this.audioGraph = audioGraph
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
          insertId: null,
          volume: normalizeTrackVolume(track.playbackState?.volume),
          reverbSend: track.playbackState?.reverbSend,
          reverbConfig: track.playbackState?.reverbConfig,
        }
      })
      .filter(Boolean)

    readyEntries.forEach((entry) => {
      this.audioGraph?.syncTrackState?.(entry.trackId, {
        insertId: null,
        volume: entry.volume,
        reverbSend: entry.reverbSend,
        reverbConfig: entry.reverbConfig,
      })
    })

    this.entries = readyEntries
    this.active = readyEntries.length > 0
    if (this.active) {
      this.rawContext = this.audioGraph
        ? await this.audioGraph.ensureReady()
        : await startToneAudio()
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
    if (this.audioGraph?.setTrackVolume?.(trackId, nextVolume)) {
      updated = true
    }
    const activeSource = this.activeSources.get(trackId)
    if (activeSource?.gainNode) {
      applyGainValue(activeSource.gainNode, nextVolume, this.rawContext?.currentTime)
      updated = true
    }
    return updated
  }

  setTrackReverbSend(trackId, sendAmount) {
    if (!trackId) return false
    const nextSendAmount = normalizeTrackReverbSend(sendAmount)
    let updated = false
    this.entries.forEach((entry) => {
      if (entry.trackId !== trackId) return
      entry.reverbSend = nextSendAmount
      updated = true
    })
    if (
      this.audioGraph?.setTrackReverbSend?.(trackId, nextSendAmount)
      || this.audioGraph?.setTrackSendAmount?.(trackId, nextSendAmount)
    ) {
      updated = true
    }
    return updated
  }

  setTrackReverbConfig(trackId, reverbConfig) {
    if (!trackId) return false
    const nextConfig = normalizeTrackReverbConfig(reverbConfig)
    let updated = false
    this.entries.forEach((entry) => {
      if (entry.trackId !== trackId) return
      entry.reverbConfig = nextConfig
      updated = true
    })
    if (this.audioGraph?.setTrackReverbConfig?.(trackId, nextConfig)) {
      updated = true
    }
    return updated
  }

  _scheduleTrack(entry, songTimeSec) {
    const buffer = entry.buffer
    if (!buffer || !this.rawContext) return
    if (songTimeSec >= entry.endSec) return

    const source = this.rawContext.createBufferSource()
    let gainNode = null
    source.buffer = buffer
    const trackInput = this.audioGraph?.getTrackInput?.(entry.trackId, {
      insertId: entry.insertId,
      volume: entry.volume,
      reverbSend: entry.reverbSend,
      reverbConfig: entry.reverbConfig,
    }) || null
    if (trackInput) {
      source.connect(trackInput)
    } else {
      gainNode = this.rawContext.createGain()
      applyGainValue(gainNode, entry.volume)
      source.connect(gainNode)
      gainNode.connect(this.rawContext.destination)
    }

    const startDelay = Math.max(0, entry.startSec - songTimeSec)
    const offset = Math.max(0, songTimeSec - entry.startSec)
    source.start(this.rawContext.currentTime + startDelay, offset)
    source.onended = () => {
      source.disconnect()
      gainNode?.disconnect()
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
