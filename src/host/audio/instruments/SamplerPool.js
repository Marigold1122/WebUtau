import { getInstrumentSourceConfig, resolveInstrumentPlaybackParams } from './sourceCatalog.js'
import { SourceSamplerRegistry } from './SourceSamplerRegistry.js'
import { loadToneRuntime } from './toneRuntime.js'
import { resolveInstrumentTrackInsertId } from '../insert/trackInsertCatalog.js'

function midiToNoteName(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const normalizedMidi = Math.max(0, Math.round(Number.isFinite(midi) ? midi : 60))
  return `${noteNames[normalizedMidi % 12]}${Math.floor(normalizedMidi / 12) - 1}`
}

/**
 * 规范化一层的 samples 字段：既支持"单变体"的对象，也支持"多变体"的对象数组，
 * 统一返回数组形式（长度 ≥ 1），后续一视同仁地按 round-robin 处理。
 */
function normalizeVariantSamples(layerSamples) {
  if (Array.isArray(layerSamples)) {
    return layerSamples.filter((v) => v && typeof v === 'object' && Object.keys(v).length > 0)
  }
  if (layerSamples && typeof layerSamples === 'object' && Object.keys(layerSamples).length > 0) {
    return [layerSamples]
  }
  return []
}

function buildLayerVariantMaps(config, layer) {
  const explicit = normalizeVariantSamples(layer.samples)
  if (explicit.length > 0) return explicit
  // 兼容 violin 的 suffix + noteKeys 写法：当前只有 1 个变体
  if (config.noteKeys && layer.suffix) {
    return [Object.fromEntries(
      config.noteKeys.map((note) => [note, `LLVln_ArcoVib_${note}${layer.suffix}.mp3`]),
    )]
  }
  return []
}

/**
 * round-robin 变体选择："随机但不连续"。
 *   - count ≤ 1 → 始终 0
 *   - 否则从 [0..count-1] 里随机挑一个 ≠ lastIndex
 * 通过 random() 注入随机源便于测试。
 */
export function pickNextVariantIndex(count, lastIndex, random = Math.random) {
  if (!Number.isFinite(count) || count <= 1) return 0
  if (lastIndex < 0 || lastIndex >= count) {
    return Math.floor(random() * count)
  }
  let next = Math.floor(random() * (count - 1))
  if (next >= lastIndex) next += 1
  return next
}

function buildSamplerKey(trackId, sourceId) {
  return `${trackId || 'global'}::${sourceId || 'unknown'}`
}

export class SamplerPool {
  constructor({ audioGraph = null, random = Math.random } = {}) {
    this.audioGraph = audioGraph
    this.entries = new Map()
    this.tone = null
    this.sourceRegistry = new SourceSamplerRegistry()
    this.random = typeof random === 'function' ? random : Math.random
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
      this._forEachVariant(entry, (v) => v.sampler?.releaseAll?.())
    })
  }

  releaseTrack(trackId) {
    if (!trackId) return false
    const keysToDelete = [...this.entries.keys()].filter((key) => key.startsWith(`${trackId}::`))
    keysToDelete.forEach((key) => {
      const entry = this.entries.get(key)
      if (entry) entry._disposed = true // 阻断尚未触发的后台变体加载
      this._forEachVariant(entry, (v) => v.sampler?.dispose?.())
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

  setTrackGuitarTone(trackId, guitarTone) {
    return this.audioGraph?.setTrackGuitarTone?.(trackId, guitarTone) || false
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
      return this._pickReadySampler(entry.single)
    }

    const normalizedVelocity = Math.max(0, Math.min(velocity, 1))
    const matchedLayer = entry.layers.find((layer) => normalizedVelocity <= layer.maxVelocity && this._layerHasReadyVariant(layer))
    if (matchedLayer) return this._pickReadySampler(matchedLayer)
    const fallbackLayer = [...entry.layers].reverse().find((layer) => this._layerHasReadyVariant(layer))
    if (!fallbackLayer) return null
    return this._pickReadySampler(fallbackLayer)
  }

  _layerHasReadyVariant(layer) {
    return Array.isArray(layer.variants) && layer.variants.some((v) => v.ready)
  }

  /**
   * 在一个 { variants, lastVariantIndex } 槽位里挑出下一个可用 sampler。
   * 只考虑 ready 的变体；如果只剩一个 ready，就直接用它（失去 RR 但不会 404）。
   */
  _pickReadySampler(slot) {
    if (!slot) return null
    // 兼容 single：entry.single 本身就是一个 sampler entry
    if (slot.sampler && !Array.isArray(slot.variants)) {
      return slot.ready ? slot.sampler : null
    }
    const variants = slot.variants || []
    const readyIndices = []
    for (let i = 0; i < variants.length; i++) {
      if (variants[i].ready) readyIndices.push(i)
    }
    if (readyIndices.length === 0) return null
    if (readyIndices.length === 1) return variants[readyIndices[0]].sampler

    const lastIndex = slot.lastVariantIndex
    const lastPositionAmongReady = readyIndices.indexOf(lastIndex)
    const picked = pickNextVariantIndex(
      readyIndices.length,
      lastPositionAmongReady,
      this.random,
    )
    const chosenIndex = readyIndices[picked]
    slot.lastVariantIndex = chosenIndex
    return variants[chosenIndex].sampler
  }

  _forEachVariant(entry, fn) {
    if (!entry) return
    if (entry.type === 'layered') {
      entry.layers.forEach((layer) => (layer.variants || []).forEach(fn))
      return
    }
    if (entry.single) fn(entry.single)
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
          guitarTone: ref?.guitarTone,
        })
      }
    })
    return [...deduped.values()]
  }

  async _prepareTrackSource(ref) {
    const key = buildSamplerKey(ref.trackId, ref.sourceId)
    const insertId = resolveInstrumentTrackInsertId(ref.sourceId)
    if (this.entries.has(key)) {
      this.audioGraph?.syncTrackState?.(ref.trackId, {
        insertId,
        volume: ref.volume,
        reverbSend: ref.reverbSend,
        reverbConfig: ref.reverbConfig,
        guitarTone: ref.guitarTone,
      })
      return this._waitUntilReady(this.entries.get(key))
    }

    const config = getInstrumentSourceConfig(ref.sourceId)
    if (!config) return null
    const Tone = this.tone
    if (!Tone) return null
    const destination = this.audioGraph?.getTrackInput?.(ref.trackId, {
      insertId,
      volume: ref.volume,
      reverbSend: ref.reverbSend,
      reverbConfig: ref.reverbConfig,
      guitarTone: ref.guitarTone,
    }) || null
    const toneContext = Tone.getContext?.() || null

    if (Array.isArray(config.velocityLayers) && config.velocityLayers.length > 0) {
      const layers = config.velocityLayers.map((layer) => {
        const variantMaps = buildLayerVariantMaps(config, layer)
        const variants = variantMaps.map((urls, idx) => {
          if (idx === 0) {
            // variant 0 是"能开播"的最低保底，阻塞加载
            return this.sourceRegistry.createSamplerEntry({
              Tone,
              config,
              urls,
              destination,
              volume: layer.volume || 0,
              toneContext,
            })
          }
          // variants 1+ 为 round-robin 点缀音色，先占位，variant 0 就绪后再后台加载。
          // _pickReadySampler 会跳过 ready=false 的槽位，期间降级为 variant 0 单变体，不影响播放。
          return {
            ready: false,
            sampler: null,
            readyPromise: null,
            error: null,
            _deferred: {
              Tone,
              config,
              urls,
              destination,
              volume: layer.volume || 0,
              toneContext,
            },
          }
        })
        return {
          maxVelocity: layer.maxVelocity,
          variants,
          lastVariantIndex: -1,
        }
      })
      const layeredEntry = { type: 'layered', layers }
      this.entries.set(key, layeredEntry)
      // 只阻塞 variant 0
      await this._waitUntilRequiredReady(layeredEntry)
      // 触发其余变体的后台加载（不 await；失败只打日志，不影响播放）
      this._scheduleDeferredVariantLoad(layeredEntry)
      return layeredEntry
    }

    const single = this.sourceRegistry.createSamplerEntry({
      Tone,
      config,
      urls: config.samples,
      destination,
      volume: config.volume || 0,
      toneContext,
    })
    const singleEntry = { type: 'single', single }
    this.entries.set(key, singleEntry)
    await this._waitUntilReady(singleEntry)
    return singleEntry
  }

  _waitUntilReady(entry) {
    // 回访已缓存的 entry 时（见 _prepareTrackSource 起始 short-circuit），只需等 required 变体，
    // 其余变体的后台加载已由首次 prepare 触发（或已完成）。
    return this._waitUntilRequiredReady(entry)
  }

  /** 只等待"必选"变体：layered 每层的 variant 0；single entry 则等其 readyPromise。 */
  _waitUntilRequiredReady(entry) {
    if (!entry) return Promise.resolve(null)
    if (entry.type === 'layered') {
      const promises = []
      entry.layers.forEach((layer) => {
        const required = layer.variants?.[0]
        if (required?.readyPromise) promises.push(required.readyPromise)
      })
      return Promise.all(promises).then(() => entry)
    }
    return entry.single.readyPromise.then(() => entry)
  }

  /**
   * 把所有含 `_deferred` 的变体真正创建出来，异步返回 Sampler。
   * 为避免抢占首屏带宽/解码资源：放进 microtask 等当前 prepare 流程返回后再启动。
   */
  _scheduleDeferredVariantLoad(entry) {
    if (!entry || entry.type !== 'layered') return
    const queueTask = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (fn) => Promise.resolve().then(fn)
    queueTask(() => {
      if (entry._disposed) return
      entry.layers.forEach((layer) => {
        const variants = layer.variants || []
        for (let idx = 0; idx < variants.length; idx += 1) {
          const placeholder = variants[idx]
          if (!placeholder?._deferred) continue
          const deferred = placeholder._deferred
          placeholder._deferred = null
          try {
            const real = this.sourceRegistry.createSamplerEntry(deferred)
            variants[idx] = real
            real.readyPromise.catch((err) => {
              console.warn('[SamplerPool] deferred variant load failed', err)
            })
          } catch (err) {
            console.warn('[SamplerPool] deferred variant setup failed', err)
          }
        }
      })
    })
  }
}
