import { startToneAudio } from '../audio/instruments/toneRuntime.js'
import { normalizeTrackVolume, resolveTrackPlaybackGain } from '../project/trackPlaybackState.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'

const LOOKAHEAD_SECONDS = 0.3

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

function buildPhraseEntries(tracks, audibleTrackIds, excludedTrackIds = new Set()) {
  const entries = []
  const trackIds = new Set()

  ;(tracks || []).forEach((track) => {
    if (!audibleTrackIds.has(track?.id)) return
    if (excludedTrackIds.has(track?.id)) return
    if (!isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) return
    const manifest = track?.vocalManifest
    const phraseStates = Array.isArray(manifest?.phraseStates) ? manifest.phraseStates : []

    phraseStates.forEach((phraseState) => {
      if (!Number.isFinite(phraseState?.startMs) || !Number.isFinite(phraseState?.durationMs)) return
      const startSec = Math.max(0, phraseState.startMs / 1000)
      const durationSec = Math.max(0.05, phraseState.durationMs / 1000)
      entries.push({
        key: [
          track.id,
          manifest?.revision || 0,
          phraseState.phraseIndex,
          phraseState.inputHash || 'no-hash',
        ].join(':'),
        trackId: track.id,
        revision: manifest?.revision || 0,
        phraseIndex: phraseState.phraseIndex,
        inputHash: phraseState.inputHash || null,
        jobId: manifest?.jobId || track?.jobRef?.jobId || null,
        startMs: phraseState.startMs,
        durationMs: phraseState.durationMs,
        startSec,
        endSec: startSec + durationSec,
        volume: normalizeTrackVolume(track.playbackState?.volume),
      })
      trackIds.add(track.id)
    })
  })

  entries.sort((left, right) => left.startSec - right.startSec)
  return {
    entries,
    trackIds: [...trackIds],
  }
}

export class HostVocalScheduler {
  constructor(assetRegistry, { logger = null, onPhraseMiss = null } = {}) {
    this.assetRegistry = assetRegistry
    this.logger = logger
    this.onPhraseMiss = onPhraseMiss
    this.rawContext = null
    this.entries = []
    this.activeSources = new Map()
    this.requestedMisses = new Set()
    this.active = false
  }

  async prepare({ tracks, audibleTrackIds, excludedTrackIds = new Set(), fromTimeSec = 0 }) {
    const { entries, trackIds } = buildPhraseEntries(tracks, audibleTrackIds || new Set(), excludedTrackIds)
    this.stop()
    this.entries = entries
    this.active = entries.length > 0
    if (this.active) {
      this.rawContext = await startToneAudio()
    }

    return {
      hasPlayablePhrases: entries.some((entry) => entry.endSec > fromTimeSec),
      duration: entries.reduce((maxValue, entry) => Math.max(maxValue, entry.endSec), 0),
      trackIds,
    }
  }

  tick(songTimeSec) {
    if (!this.active || !this.rawContext) return

    for (const [key, activeSource] of this.activeSources) {
      if (activeSource.endSec <= songTimeSec) {
        this.activeSources.delete(key)
      }
    }

    const windowEnd = songTimeSec + LOOKAHEAD_SECONDS
    this.entries.forEach((entry) => {
      if (entry.endSec <= songTimeSec) return
      if (entry.startSec > windowEnd) return
      if (this.activeSources.has(entry.key)) return

      const asset = this.assetRegistry.getAsset(entry)
      if (!asset?.buffer) {
        this._requestPhrase(entry)
        return
      }

      this._schedulePhrase(entry, asset.buffer, songTimeSec)
    })
  }

  stop() {
    this.entries = []
    this.active = false
    this.requestedMisses.clear()
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
    for (const [, activeSource] of this.activeSources) {
      if (activeSource.trackId !== trackId || !activeSource.gainNode) continue
      applyGainValue(activeSource.gainNode, nextVolume, this.rawContext?.currentTime)
      updated = true
    }
    return updated
  }

  _requestPhrase(entry) {
    if (!entry?.jobId || this.requestedMisses.has(entry.key)) return
    this.requestedMisses.add(entry.key)
    this.logger?.info?.('HostVocalScheduler phrase requested', {
      trackId: entry.trackId,
      phraseIndex: entry.phraseIndex,
      jobId: entry.jobId,
    })
    this.onPhraseMiss?.(entry)
  }

  _schedulePhrase(entry, audioBuffer, songTimeSec) {
    if (!audioBuffer || !this.rawContext) return
    const delayFromNow = entry.startSec - songTimeSec
    const offset = delayFromNow < 0 ? -delayFromNow : 0
    if (offset >= audioBuffer.duration) return

    const source = this.rawContext.createBufferSource()
    const gainNode = this.rawContext.createGain()
    source.buffer = audioBuffer
    applyGainValue(gainNode, entry.volume)
    source.connect(gainNode)
    gainNode.connect(this.rawContext.destination)

    const contextNow = this.rawContext.currentTime
    if (delayFromNow >= 0) {
      source.start(contextNow + delayFromNow)
    } else {
      source.start(contextNow, offset)
    }

    source.onended = () => {
      source.disconnect()
      gainNode.disconnect()
      this.activeSources.delete(entry.key)
    }

    this.activeSources.set(entry.key, {
      source,
      gainNode,
      trackId: entry.trackId,
      endSec: entry.endSec,
    })
  }
}
