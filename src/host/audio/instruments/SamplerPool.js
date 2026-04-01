import { getInstrumentSourceConfig, resolveInstrumentPlaybackParams } from './sourceCatalog.js'
import { loadToneRuntime } from './toneRuntime.js'

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

function buildSamplerKey(trackId, sourceId) {
  return `${trackId || 'global'}::${sourceId || 'unknown'}`
}

function createSamplerEntry(Tone, config, urls, destination = null, volume = 0) {
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
    })
    if (destination) {
      entry.sampler.connect(destination)
    } else {
      entry.sampler.toDestination()
    }
  })

  return entry
}

export class SamplerPool {
  constructor({ audioGraph = null } = {}) {
    this.audioGraph = audioGraph
    this.entries = new Map()
    this.tone = null
  }

  async prepareTrackSources(trackSourceRefs = []) {
    const uniqueRefs = this._normalizeTrackSourceRefs(trackSourceRefs)
    if (uniqueRefs.length === 0) return []
    this.tone ||= await loadToneRuntime()
    const Tone = this.tone
    await Tone.start()
    await this.audioGraph?.ensureReady?.()
    await Promise.all(uniqueRefs.map((ref) => this._prepareTrackSource(ref)))
    return uniqueRefs
  }

  async prepareSources(sourceIds = []) {
    return this.prepareTrackSources((Array.isArray(sourceIds) ? sourceIds : []).map((sourceId) => ({
      trackId: `source:${sourceId}`,
      sourceId,
    })))
  }

  triggerAttackRelease(trackId, sourceId, midi, durationSec, audioTimeSec, playbackOptions = 0.8) {
    const entry = this.entries.get(buildSamplerKey(trackId, sourceId))
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

  triggerAttack(trackId, sourceId, midi, audioTimeSec, playbackOptions = 0.8) {
    const entry = this.entries.get(buildSamplerKey(trackId, sourceId))
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

  releaseTrack(trackId) {
    if (!trackId) return false
    const keysToDelete = [...this.entries.keys()].filter((key) => key.startsWith(`${trackId}::`))
    keysToDelete.forEach((key) => {
      const entry = this.entries.get(key)
      if (entry?.type === 'layered') {
        entry.layers.forEach((layer) => layer.sampler?.dispose?.())
      } else {
        entry?.single?.sampler?.dispose?.()
      }
      this.entries.delete(key)
    })
    return keysToDelete.length > 0
  }

  getAudioTime() {
    return this.tone?.now?.() || 0
  }

  setTrackVolume(trackId, volume) {
    return this.audioGraph?.setTrackVolume?.(trackId, volume) || false
  }

  setTrackReverbSend(trackId, reverbSend) {
    return (
      this.audioGraph?.setTrackReverbSend?.(trackId, reverbSend)
      || this.audioGraph?.setTrackSendAmount?.(trackId, reverbSend)
      || false
    )
  }

  setTrackReverbConfig(trackId, reverbConfig) {
    return this.audioGraph?.setTrackReverbConfig?.(trackId, reverbConfig) || false
  }

  _resolvePlayback(sourceId, playbackOptions, durationSec = null) {
    const options = playbackOptions && typeof playbackOptions === 'object' && !Array.isArray(playbackOptions)
      ? playbackOptions
      : {
        velocity: playbackOptions,
        durationSec,
        preview: false,
      }
    return resolveInstrumentPlaybackParams(sourceId, {
      velocity: options.velocity,
      durationSec: Number.isFinite(options.durationSec)
        ? options.durationSec
        : durationSec,
      preview: options.preview === true,
    })
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

  _normalizeTrackSourceRefs(trackSourceRefs = []) {
    const deduped = new Map()
    ;(Array.isArray(trackSourceRefs) ? trackSourceRefs : []).forEach((ref) => {
      const sourceId = typeof ref === 'string' ? ref : ref?.sourceId
      const trackId = typeof ref === 'object' && ref ? ref.trackId || null : null
      if (!sourceId || !trackId) return
      const key = buildSamplerKey(trackId, sourceId)
      if (!deduped.has(key)) {
        deduped.set(key, {
          trackId,
          sourceId,
          volume: ref?.volume,
          reverbSend: ref?.reverbSend ?? ref?.sendAmount,
          reverbConfig: ref?.reverbConfig,
        })
      }
    })
    return [...deduped.values()]
  }

  async _prepareTrackSource(ref) {
    const key = buildSamplerKey(ref.trackId, ref.sourceId)
    if (this.entries.has(key)) {
      this.audioGraph?.syncTrackState?.(ref.trackId, {
        volume: ref.volume,
        reverbSend: ref.reverbSend,
        reverbConfig: ref.reverbConfig,
      })
      return this._waitUntilReady(this.entries.get(key))
    }

    const config = getInstrumentSourceConfig(ref.sourceId)
    if (!config) return null
    const Tone = this.tone
    if (!Tone) return null
    const destination = this.audioGraph?.getTrackInput?.(ref.trackId, {
      volume: ref.volume,
      reverbSend: ref.reverbSend,
      reverbConfig: ref.reverbConfig,
    }) || null

    if (Array.isArray(config.velocityLayers) && config.velocityLayers.length > 0) {
      const layers = config.velocityLayers.map((layer) => {
        const entry = createSamplerEntry(
          Tone,
          config,
          buildViolinLayerSamples(config, layer),
          destination,
          layer.volume || 0,
        )
        entry.maxVelocity = layer.maxVelocity
        return entry
      })
      const layeredEntry = { type: 'layered', layers }
      this.entries.set(key, layeredEntry)
      await this._waitUntilReady(layeredEntry)
      return layeredEntry
    }

    const single = createSamplerEntry(Tone, config, config.samples, destination, config.volume || 0)
    const singleEntry = { type: 'single', single }
    this.entries.set(key, singleEntry)
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
