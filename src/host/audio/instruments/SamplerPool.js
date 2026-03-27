import { getInstrumentSourceConfig, resolveInstrumentPlaybackParams } from './sourceCatalog.js'
import { loadToneRuntime } from './toneRuntime.js'
import { resolveTrackPlaybackGain } from '../../project/trackPlaybackState.js'

function clampUnit(value, fallback = 0.8) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function midiToNoteName(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const normalizedMidi = Math.max(0, Math.round(Number.isFinite(midi) ? midi : 60))
  return `${noteNames[normalizedMidi % 12]}${Math.floor(normalizedMidi / 12) - 1}`
}

function buildViolinLayerSamples(config, layer) {
  return Object.fromEntries(
    config.noteKeys.map((note) => [note, `LLVln_ArcoVib_${note}${layer.suffix}.mp3`]),
  )
}

function createSamplerEntry(Tone, config, urls, volume = 0) {
  const entry = {
    ready: false,
    sampler: null,
    readyPromise: null,
  }

  entry.readyPromise = new Promise((resolve) => {
    entry.sampler = new Tone.Sampler({
      urls,
      baseUrl: config.baseUrl,
      release: config.release || 1,
      volume,
      onload: () => {
        entry.ready = true
        resolve(entry)
      },
    }).toDestination()
  })

  return entry
}

export class SamplerPool {
  constructor() {
    this.entries = new Map()
    this.tone = null
  }

  async prepareSources(sourceIds = []) {
    const uniqueSourceIds = [...new Set(sourceIds)].filter(Boolean)
    if (uniqueSourceIds.length === 0) return []
    this.tone ||= await loadToneRuntime()
    const Tone = this.tone
    await Tone.start()
    await Promise.all(uniqueSourceIds.map((sourceId) => this._prepareSource(sourceId)))
    return uniqueSourceIds
  }

  triggerAttackRelease(sourceId, midi, durationSec, audioTimeSec, playbackOptions = 0.8) {
    const entry = this.entries.get(sourceId)
    if (!entry) return false

    const playback = this._resolvePlayback(sourceId, playbackOptions, durationSec)
    const sampler = this._resolveSampler(entry, playback.layerVelocity)
    if (!sampler) return false

    sampler.triggerAttackRelease(
      midiToNoteName(midi),
      Math.max(0.05, durationSec),
      audioTimeSec,
      playback.outputVelocity,
    )
    return true
  }

  triggerAttack(sourceId, midi, audioTimeSec, playbackOptions = 0.8) {
    const entry = this.entries.get(sourceId)
    if (!entry) return null

    const playback = this._resolvePlayback(sourceId, playbackOptions)
    const sampler = this._resolveSampler(entry, playback.layerVelocity)
    if (!sampler) return null

    const noteName = midiToNoteName(midi)
    sampler.triggerAttack(
      noteName,
      audioTimeSec,
      playback.outputVelocity,
    )
    return { sampler, noteName }
  }

  triggerRelease(token, audioTimeSec) {
    if (!token?.sampler || !token?.noteName) return false
    token.sampler.triggerRelease(token.noteName, audioTimeSec)
    return true
  }

  releaseAll() {
    this.entries.forEach((entry) => {
      if (entry.type === 'layered') {
        entry.layers.forEach((layer) => layer.sampler?.releaseAll?.())
        return
      }
      entry.single.sampler?.releaseAll?.()
    })
  }

  getAudioTime() {
    return this.tone?.now?.() || 0
  }

  _resolvePlayback(sourceId, playbackOptions, durationSec = null) {
    const options = playbackOptions && typeof playbackOptions === 'object' && !Array.isArray(playbackOptions)
      ? playbackOptions
      : {
        velocity: playbackOptions,
        durationSec,
        preview: false,
        trackVolume: 1,
      }
    const resolvedPlayback = resolveInstrumentPlaybackParams(sourceId, {
      velocity: options.velocity,
      durationSec: Number.isFinite(options.durationSec)
        ? options.durationSec
        : durationSec,
      preview: options.preview === true,
    })
    const trackVolume = Math.max(0, resolveTrackPlaybackGain(options.trackVolume))
    return {
      ...resolvedPlayback,
      outputVelocity: Math.max(0, resolvedPlayback.outputVelocity * trackVolume),
      trackVolume,
    }
  }

  _resolveSampler(entry, velocity) {
    if (entry.type === 'single') {
      return entry.single.ready ? entry.single.sampler : null
    }

    const normalizedVelocity = Math.max(0, Math.min(velocity, 1))
    const matchedLayer = entry.layers.find((layer) => normalizedVelocity <= layer.maxVelocity && layer.ready)
    if (matchedLayer) return matchedLayer.sampler
    const fallbackLayer = [...entry.layers].reverse().find((layer) => layer.ready)
    return fallbackLayer?.sampler || null
  }

  async _prepareSource(sourceId) {
    if (this.entries.has(sourceId)) {
      return this._waitUntilReady(this.entries.get(sourceId))
    }

    const config = getInstrumentSourceConfig(sourceId)
    if (!config) return null
    const Tone = this.tone
    if (!Tone) return null

    if (Array.isArray(config.velocityLayers) && config.velocityLayers.length > 0) {
      const layers = config.velocityLayers.map((layer) => {
        const entry = createSamplerEntry(Tone, config, buildViolinLayerSamples(config, layer), layer.volume || 0)
        entry.maxVelocity = layer.maxVelocity
        return entry
      })
      const layeredEntry = { type: 'layered', layers }
      this.entries.set(sourceId, layeredEntry)
      await this._waitUntilReady(layeredEntry)
      return layeredEntry
    }

    const single = createSamplerEntry(Tone, config, config.samples, config.volume || 0)
    const singleEntry = { type: 'single', single }
    this.entries.set(sourceId, singleEntry)
    await this._waitUntilReady(singleEntry)
    return singleEntry
  }

  _waitUntilReady(entry) {
    if (!entry) return Promise.resolve(null)
    if (entry.type === 'layered') {
      return Promise.all(entry.layers.map((layer) => layer.readyPromise)).then(() => entry)
    }
    return entry.single.readyPromise.then(() => entry)
  }
}
