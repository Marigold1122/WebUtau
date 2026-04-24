import {
  getInstrumentSourceConfig,
  resolveInstrumentPlaybackParams,
  noteNameToMidi,
} from './sourceCatalog.js'
import { SourceSamplerRegistry } from './SourceSamplerRegistry.js'
import { loadToneRuntime } from './toneRuntime.js'
import { resolveInstrumentTrackInsertId } from '../insert/trackInsertCatalog.js'
import { sortChunksByPlaybackPriority, timeToChunkIndex } from './samplePlanBuilder.js'

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

const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI number → Scientific Pitch Notation（sharp 形式，与 sourceCatalog 缓存 key 对齐）。 */
function midiToNoteKey(midi) {
  const m = Math.round(Number.isFinite(midi) ? midi : 60)
  const pitchClass = ((m % 12) + 12) % 12
  return `${MIDI_NOTE_NAMES[pitchClass]}${Math.floor(m / 12) - 1}`
}

/** 从 variantMap 里挑出对应这些 MIDI 的 url 子集（MIDI 不在映射里就跳过）。 */
function filterVariantMapToMidis(variantMap, midis) {
  const urls = {}
  for (const m of midis) {
    const key = midiToNoteKey(m)
    if (variantMap[key] != null) urls[key] = variantMap[key]
  }
  return urls
}

/**
 * Tone.Sampler 如果初始 urls 为空，triggerAttack 会抛 "No available buffers for note"。
 * 这里给出兜底：用 fallback MIDI 集（通常是 triggeredCatalogMidis）里第一个命中的 key。
 */
function ensureNonEmptyUrls(urls, variantMap, fallbackMidis) {
  if (Object.keys(urls).length > 0) return urls
  if (fallbackMidis) {
    for (const m of fallbackMidis) {
      const key = midiToNoteKey(m)
      if (variantMap[key] != null) return { [key]: variantMap[key] }
    }
  }
  const firstKey = Object.keys(variantMap)[0]
  return firstKey ? { [firstKey]: variantMap[firstKey] } : urls
}

export class SamplerPool {
  constructor({ audioGraph = null, random = Math.random } = {}) {
    this.audioGraph = audioGraph
    this.entries = new Map()
    this.tone = null
    this.sourceRegistry = new SourceSamplerRegistry()
    this.random = typeof random === 'function' ? random : Math.random
    /** trackKey → Set<chunkIndex>，已就绪的 variant-0 chunk 集合。 */
    this.chunkReadinessByKey = new Map()
    /** 监听"触发时所在 chunk 未就绪"的事件订阅者。 */
    this.missingSampleListeners = new Set()
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

  /**
   * 基于 samplePlanBuilder 生成的 playbackPlan 做"只加载实际触发音高 + 按时间分块"的准备。
   * 阻塞直到每条轨 variant 0 的 **当前 chunk** 就绪；其余 chunk 与 variants 1+ 后台继续。
   *
   * ref 约定：{ trackId, sourceId, volume, reverbSend, reverbConfig, guitarTone, playbackPlan }
   * playbackPlan: { chunkMidisByIndex, triggeredCatalogMidis, currentChunkIndex, chunkDurationSec }
   */
  async prepareChunkedPlaybackPlan(refs = []) {
    const uniqueRefs = this._normalizeChunkedRefs(refs)
    if (uniqueRefs.length === 0) return []
    this.tone ||= await loadToneRuntime()
    const Tone = this.tone
    await Tone.start()
    await this.audioGraph?.ensureReady?.()
    await Promise.all(uniqueRefs.map((ref) => this._prepareChunkedTrackSource(ref)))
    return uniqueRefs
  }

  /** 注册 "触发时所在 chunk 未就绪" 事件监听器。返回 unsubscribe。 */
  onMissingSample(listener) {
    if (typeof listener !== 'function') return () => {}
    this.missingSampleListeners.add(listener)
    return () => this.missingSampleListeners.delete(listener)
  }

  /** 查询某轨 / 某 chunk 是否已加载到可用程度（至少 variant 0 的 MIDI 子集就绪）。 */
  isChunkReady(trackId, sourceId, chunkIndex) {
    const key = buildSamplerKey(trackId, sourceId)
    return this.chunkReadinessByKey.get(key)?.has(chunkIndex) === true
  }

  /** 由 Scheduler.tick 在触发 note 前调用：若 chunk 未就绪则向监听者广播。 */
  reportMissingChunk({ trackId, sourceId, chunkIndex, songTimeSec } = {}) {
    if (this.missingSampleListeners.size === 0) return
    const payload = {
      trackId,
      sourceId,
      chunkIndex,
      songTimeSec,
      at: (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now(),
    }
    this.missingSampleListeners.forEach((fn) => {
      try {
        fn(payload)
      } catch (err) {
        console.warn('[SamplerPool] missingSample listener threw', err)
      }
    })
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
      this.chunkReadinessByKey.delete(key)
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

  // ========== chunked playback plan 分支 ==========

  _normalizeChunkedRefs(refs) {
    const deduped = new Map()
    ;(Array.isArray(refs) ? refs : []).forEach((ref) => {
      if (!ref?.trackId || !ref?.sourceId) return
      const key = buildSamplerKey(ref.trackId, ref.sourceId)
      if (!deduped.has(key)) {
        deduped.set(key, {
          trackId: ref.trackId,
          sourceId: ref.sourceId,
          volume: ref.volume,
          reverbSend: ref.reverbSend ?? ref.sendAmount,
          reverbConfig: ref.reverbConfig,
          guitarTone: ref.guitarTone,
          playbackPlan: ref.playbackPlan || null,
        })
      }
    })
    return [...deduped.values()]
  }

  async _prepareChunkedTrackSource(ref) {
    const key = buildSamplerKey(ref.trackId, ref.sourceId)
    const insertId = resolveInstrumentTrackInsertId(ref.sourceId)

    if (this.entries.has(key)) {
      // 已有 entry（例如预览链路已按全量加载），直接复用：chunked 模式下命中的 MIDI 可能比全量少，
      // 但预览已经加载了全量 → 反过来命中率更高，不用重做。
      this.audioGraph?.syncTrackState?.(ref.trackId, {
        insertId,
        volume: ref.volume,
        reverbSend: ref.reverbSend,
        reverbConfig: ref.reverbConfig,
        guitarTone: ref.guitarTone,
      })
      // 把当前 chunk 标记为就绪（预览路径已全量加载，所有 chunk 都能触发）
      if (ref.playbackPlan?.currentChunkIndex != null) {
        this._markChunkReady(key, ref.playbackPlan.currentChunkIndex)
      }
      return this._waitUntilReady(this.entries.get(key))
    }

    const config = getInstrumentSourceConfig(ref.sourceId)
    if (!config) return null
    const Tone = this.tone
    if (!Tone) return null
    const plan = ref.playbackPlan
    if (
      !plan
      || !Array.isArray(config.velocityLayers)
      || config.velocityLayers.length === 0
      || !(plan.chunkMidisByIndex instanceof Map)
    ) {
      // 没有 plan / 配置不支持分层 → 退回全量路径（例如 single-sampler 音色）
      return this._prepareTrackSource(ref)
    }

    const destination = this.audioGraph?.getTrackInput?.(ref.trackId, {
      insertId,
      volume: ref.volume,
      reverbSend: ref.reverbSend,
      reverbConfig: ref.reverbConfig,
      guitarTone: ref.guitarTone,
    }) || null
    const toneContext = Tone.getContext?.() || null
    const baseUrl = config.baseUrl || ''
    const currentChunkMidis = plan.chunkMidisByIndex.get(plan.currentChunkIndex) || new Set()

    const layers = config.velocityLayers.map((layerConfig) => {
      const variantMaps = buildLayerVariantMaps(config, layerConfig)
      const variant0Map = variantMaps[0] || {}
      const initialUrls = ensureNonEmptyUrls(
        filterVariantMapToMidis(variant0Map, currentChunkMidis),
        variant0Map,
        plan.triggeredCatalogMidis,
      )
      const variant0 = this.sourceRegistry.createSamplerEntry({
        Tone,
        config,
        urls: initialUrls,
        destination,
        volume: layerConfig.volume || 0,
        toneContext,
      })
      variant0._loadedMidis = new Set(
        Object.keys(initialUrls)
          .map((k) => noteNameToMidi(k))
          .filter((m) => Number.isFinite(m)),
      )
      variant0._variantMap = variant0Map

      const lazyVariants = variantMaps.slice(1).map((vMap) => ({
        ready: false,
        sampler: null,
        readyPromise: null,
        error: null,
        _deferredVariant: {
          Tone,
          config,
          variantMap: vMap,
          destination,
          volume: layerConfig.volume || 0,
          toneContext,
          triggeredCatalogMidis: plan.triggeredCatalogMidis,
        },
      }))

      return {
        maxVelocity: layerConfig.maxVelocity,
        variants: [variant0, ...lazyVariants],
        lastVariantIndex: -1,
      }
    })

    const layeredEntry = {
      type: 'layered',
      layers,
      _trackKey: key,
      _plan: plan,
      _config: config,
      _baseUrl: baseUrl,
      _Tone: Tone,
    }
    this.entries.set(key, layeredEntry)

    await this._waitUntilRequiredReady(layeredEntry)
    this._markChunkReady(key, plan.currentChunkIndex)
    this._scheduleChunkedBackgroundLoad(layeredEntry)
    return layeredEntry
  }

  _markChunkReady(key, chunkIndex) {
    if (!Number.isFinite(chunkIndex)) return
    let set = this.chunkReadinessByKey.get(key)
    if (!set) {
      set = new Set()
      this.chunkReadinessByKey.set(key, set)
    }
    set.add(chunkIndex)
  }

  _scheduleChunkedBackgroundLoad(entry) {
    const queueTask = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (fn) => Promise.resolve().then(fn)
    queueTask(() => this._runChunkedBackgroundLoad(entry))
  }

  async _runChunkedBackgroundLoad(entry) {
    if (!entry || entry._disposed) return
    const plan = entry._plan
    const Tone = entry._Tone
    const baseUrl = entry._baseUrl
    const trackKey = entry._trackKey

    // 1) variant 0 的其余 chunk：按播放优先级顺序串行加载（同 chunk 内跨层并行）
    const sortedOtherChunks = sortChunksByPlaybackPriority(
      [...plan.chunkMidisByIndex.keys()].filter((i) => i !== plan.currentChunkIndex),
      plan.currentChunkIndex,
    )
    for (const chunkIdx of sortedOtherChunks) {
      if (entry._disposed) return
      const chunkMidis = plan.chunkMidisByIndex.get(chunkIdx) || new Set()
      await Promise.all(entry.layers.map(async (layer) => {
        const v0 = layer.variants?.[0]
        if (!v0?.sampler || !v0._variantMap) return
        const variantMap = v0._variantMap
        const pendingAdds = []
        for (const midi of chunkMidis) {
          if (v0._loadedMidis.has(midi)) continue
          const noteKey = midiToNoteKey(midi)
          if (variantMap[noteKey] == null) continue
          pendingAdds.push({ midi, noteKey, relativeUrl: variantMap[noteKey] })
        }
        await Promise.all(pendingAdds.map(async ({ midi, noteKey, relativeUrl }) => {
          try {
            const buffer = await this.sourceRegistry.loadSharedBuffer(Tone, baseUrl, relativeUrl)
            if (entry._disposed) return
            v0.sampler.add(noteKey, buffer)
            v0._loadedMidis.add(midi)
          } catch (err) {
            console.warn('[SamplerPool] chunk buffer load failed', err)
          }
        }))
      }))
      if (entry._disposed) return
      this._markChunkReady(trackKey, chunkIdx)
    }

    // 2) variants 1+：为每个占位创建实际 Sampler（只覆盖整首歌触发过的 MIDI，不再分块）
    entry.layers.forEach((layer) => {
      layer.variants.forEach((v, idx) => {
        if (idx === 0 || !v._deferredVariant || entry._disposed) return
        const deferred = v._deferredVariant
        v._deferredVariant = null
        try {
          const urls = ensureNonEmptyUrls(
            filterVariantMapToMidis(deferred.variantMap, deferred.triggeredCatalogMidis),
            deferred.variantMap,
            deferred.triggeredCatalogMidis,
          )
          const real = this.sourceRegistry.createSamplerEntry({
            Tone: deferred.Tone,
            config: deferred.config,
            urls,
            destination: deferred.destination,
            volume: deferred.volume,
            toneContext: deferred.toneContext,
          })
          layer.variants[idx] = real
          real.readyPromise.catch((err) => {
            console.warn('[SamplerPool] lazy variant load failed', err)
          })
        } catch (err) {
          console.warn('[SamplerPool] lazy variant setup failed', err)
        }
      })
    })
  }
}
