import { resolveAudibleTrackIds } from '../../monitor/TrackAudibilityResolver.js'
import { isAudioTrack } from '../../project/trackContentType.js'
import { normalizeTrackReverbSend, normalizeTrackVolume, resolveTrackPlaybackGain } from '../../project/trackPlaybackState.js'
import { isVoiceRuntimeSource } from '../../project/trackSourceAssignment.js'
import { getHostPlaybackSourceId, getInstrumentSourceConfig, resolveInstrumentPlaybackParams } from '../instruments/sourceCatalog.js'
import { startToneAudio } from '../instruments/toneRuntime.js'
import { buildImpulseResponse } from '../reverb/ImpulseResponseBuilder.js'
import { normalizeReverbConfig } from '../../project/reverbConfigState.js'
import { getProjectDuration } from '../../services/PreviewProjector.js'
import { collectConvertedTrackRefs } from '../../vocal/VocalPlaybackResolver.js'
import { encodeWavFile } from './encodeWavFile.js'

const REVERB_TAIL_EXTRA_SEC = 1.5
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const REVERB_WET_THRESHOLD = 0.0001

// ── 通用工具 ────────────────────────────────────────

function midiToNoteName(midi) {
  const n = Math.max(0, Math.round(Number.isFinite(midi) ? midi : 60))
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`
}

function noteNameToMidi(name) {
  const m = name.match(/^([A-G]#?)(-?\d+)$/)
  if (!m) return 60
  const idx = NOTE_NAMES.indexOf(m[1])
  return idx >= 0 ? idx + (parseInt(m[2], 10) + 1) * 12 : 60
}

function findNearestSample(noteNames, targetMidi) {
  let best = noteNames[0]
  let bestDist = Infinity
  for (const name of noteNames) {
    const d = Math.abs(noteNameToMidi(name) - targetMidi)
    if (d < bestDist) { bestDist = d; best = name }
  }
  return best
}

function serializeReverbConfig(config) {
  const c = normalizeReverbConfig(config)
  return `${c.decaySec}:${c.decayCurve}:${c.preDelaySec}:${c.lowCutHz}:${c.highCutHz}:${c.returnGain}`
}

// ── 采样缓存（模块级，AudioBuffer 可跨 AudioContext 复用）──

const sampleBufferCache = new Map()

async function loadSampleBuffers(sourceId) {
  if (sampleBufferCache.has(sourceId)) return sampleBufferCache.get(sourceId)
  const config = getInstrumentSourceConfig(sourceId)
  if (!config) return null

  const ctx = await startToneAudio()
  const sampleMap = new Map()
  const tasks = []

  if (Array.isArray(config.velocityLayers) && config.velocityLayers.length > 0) {
    for (const layer of config.velocityLayers) {
      for (const noteKey of config.noteKeys) {
        tasks.push({ key: `${noteKey}:${layer.suffix}`, url: `${config.baseUrl}LLVln_ArcoVib_${noteKey}${layer.suffix}.mp3`, noteKey })
      }
    }
  } else if (config.samples) {
    for (const [noteKey, fileName] of Object.entries(config.samples)) {
      tasks.push({ key: noteKey, url: `${config.baseUrl}${fileName}`, noteKey })
    }
  }

  await Promise.all(tasks.map(async ({ key, url, noteKey }) => {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return
      const buf = await ctx.decodeAudioData(await resp.arrayBuffer())
      sampleMap.set(key, { buffer: buf, noteKey, midi: noteNameToMidi(noteKey) })
    } catch (_e) {}
  }))

  const result = { config, sampleMap }
  sampleBufferCache.set(sourceId, result)
  return result
}

// ── 采样查找 ────────────────────────────────────────

function findBestSample(sampleMap, sourceConfig, targetMidi, velocity) {
  if (Array.isArray(sourceConfig.velocityLayers) && sourceConfig.velocityLayers.length > 0) {
    const pb = resolveInstrumentPlaybackParams(null, { velocity })
    const layer = sourceConfig.velocityLayers.find((l) => pb.layerVelocity <= l.maxVelocity)
      || sourceConfig.velocityLayers[sourceConfig.velocityLayers.length - 1]
    const nearest = findNearestSample(sourceConfig.noteKeys, targetMidi)
    const entry = sampleMap.get(`${nearest}:${layer.suffix}`)
    if (entry) return entry
    for (const l of sourceConfig.velocityLayers) {
      const fb = sampleMap.get(`${nearest}:${l.suffix}`)
      if (fb) return fb
    }
    return null
  }
  const keys = [...sampleMap.keys()]
  if (keys.length === 0) return null
  return sampleMap.get(findNearestSample(keys, targetMidi)) || null
}

// ── 音源收集（复用原逻辑）────────────────────────────

function collectInstrumentNotes(tracks, audibleTrackIds) {
  const notes = []
  const trackSourceMeta = new Map()
  tracks.forEach((track) => {
    if (!audibleTrackIds.has(track.id)) return
    const dirtyRanges = Array.isArray(track?.pendingVoiceEditState?.dirtyRanges) ? track.pendingVoiceEditState.dirtyRanges : []
    const previewDirtyVocal = track?.playbackState?.assignedSourceId === 'vocal' && dirtyRanges.length > 0
    const sourceId = previewDirtyVocal ? 'piano' : getHostPlaybackSourceId(track.playbackState?.assignedSourceId)
    if (!sourceId) return
    trackSourceMeta.set(track.id, {
      sourceId,
      volume: normalizeTrackVolume(track.playbackState?.volume),
      reverbSend: track.playbackState?.reverbSend,
      reverbConfig: track.playbackState?.reverbConfig,
    })
    ;(track.previewNotes || []).forEach((note) => {
      const startSec = Number.isFinite(note?.time) ? Math.max(0, note.time) : 0
      const durationSec = Number.isFinite(note?.duration) ? Math.max(0.05, note.duration) : 0.05
      const endSec = startSec + durationSec
      if (previewDirtyVocal && !dirtyRanges.some((r) => startSec < (r?.endTime || 0) && (r?.startTime || 0) < endSec)) return
      notes.push({ trackId: track.id, sourceId, midi: note.midi, velocity: Number.isFinite(note?.velocity) ? note.velocity : 0.8, startSec, durationSec })
    })
  })
  return { notes, trackSourceMeta }
}

function collectVocalEntries(tracks, audibleTrackIds, excludedTrackIds = new Set()) {
  const entries = []
  ;(tracks || []).forEach((track) => {
    if (!audibleTrackIds.has(track?.id) || excludedTrackIds.has(track?.id)) return
    if (!isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) return
    const dirtyPhraseIndices = new Set(track?.pendingVoiceEditState?.dirtyPhraseIndices || [])
    const manifest = track?.vocalManifest
    ;(Array.isArray(manifest?.phraseStates) ? manifest.phraseStates : []).forEach((ps) => {
      if (dirtyPhraseIndices.has(ps?.phraseIndex)) return
      if (!Number.isFinite(ps?.startMs) || !Number.isFinite(ps?.durationMs)) return
      entries.push({
        trackId: track.id,
        key: [track.id, manifest?.revision || 0, ps.phraseIndex, ps.inputHash || 'no-hash'].join(':'),
        revision: manifest?.revision || 0, phraseIndex: ps.phraseIndex,
        inputHash: ps.inputHash || null,
        jobId: manifest?.jobId || track?.jobRef?.jobId || null,
        startSec: Math.max(0, ps.startMs / 1000),
        volume: normalizeTrackVolume(track.playbackState?.volume),
        reverbSend: track.playbackState?.reverbSend,
        reverbConfig: track.playbackState?.reverbConfig,
      })
    })
  })
  return entries
}

function collectImportedAudioEntries(tracks, audibleTrackIds, registry) {
  const entries = []
  ;(tracks || []).forEach((track) => {
    if (!audibleTrackIds.has(track?.id) || !isAudioTrack(track)) return
    const clip = track.audioClip
    const asset = registry.getAsset(clip?.assetId)
    if (!asset?.buffer) return
    const startSec = Number.isFinite(clip?.startTime) ? Math.max(0, clip.startTime) : 0
    const duration = Number.isFinite(clip?.duration) && clip.duration > 0 ? clip.duration : asset.buffer.duration
    entries.push({
      trackId: track.id, buffer: asset.buffer, startSec, duration,
      volume: normalizeTrackVolume(track.playbackState?.volume),
      reverbSend: track.playbackState?.reverbSend,
      reverbConfig: track.playbackState?.reverbConfig,
    })
  })
  return entries
}

async function collectConvertedVocalEntries(tracks, audibleTrackIds, registry) {
  const entries = []
  for (const ref of collectConvertedTrackRefs(tracks, audibleTrackIds)) {
    const asset = registry.getAsset(ref.assetKey)
    if (!asset?.buffer) continue
    const track = tracks.find((t) => t.id === ref.trackId)
    entries.push({
      trackId: ref.trackId, buffer: asset.buffer,
      volume: normalizeTrackVolume(track?.playbackState?.volume),
      reverbSend: track?.playbackState?.reverbSend,
      reverbConfig: track?.playbackState?.reverbConfig,
    })
  }
  return entries
}

function getMaxReverbDecaySec(tracks) {
  let max = 0
  ;(tracks || []).forEach((track) => {
    const c = normalizeReverbConfig(track?.playbackState?.reverbConfig)
    if (normalizeTrackReverbSend(track?.playbackState?.reverbSend) > 0.001) {
      max = Math.max(max, c.decaySec + c.preDelaySec)
    }
  })
  return max
}

// ── 乐器渲染（原生 playbackRate，无 Convolver）────────

const CHUNK_NOTE_THRESHOLD = 200
const CHUNK_DURATION_SEC = 15

async function renderInstrumentTrack(trackNotes, sampleCaches, sampleRate, numCh, totalSamples) {
  // 计算该轨实际需要渲染的时长
  let trackEndSec = 0
  for (const note of trackNotes) {
    const release = Math.min(sampleCaches.get(note.sourceId)?.config?.release || 1, 2)
    const end = note.startSec + note.durationSec + release + 0.01
    if (end > trackEndSec) trackEndSec = end
  }
  const trackSamples = Math.min(totalSamples, Math.ceil(trackEndSec * sampleRate))

  // 音符数少于阈值：单个 OfflineAudioContext 直接渲染
  if (trackNotes.length <= CHUNK_NOTE_THRESHOLD) {
    return renderNoteChunk(trackNotes, sampleCaches, sampleRate, numCh, trackSamples, 0)
  }

  // 重轨：按时间切片，每个切片各用一个 OfflineAudioContext 并发渲染（多核并行）
  const chunkCount = Math.max(2, Math.ceil(trackEndSec / CHUNK_DURATION_SEC))
  const chunkDuration = trackEndSec / chunkCount
  const chunks = Array.from({ length: chunkCount }, () => [])
  for (const note of trackNotes) {
    const ci = Math.min(Math.floor(note.startSec / chunkDuration), chunkCount - 1)
    chunks[ci].push(note)
  }

  const chunkResults = await Promise.all(chunks.map((notes, i) => {
    if (notes.length === 0) return null
    const chunkStartSec = i * chunkDuration
    return renderNoteChunk(notes, sampleCaches, sampleRate, numCh, totalSamples, chunkStartSec)
      .then((buffer) => ({ buffer, startSample: Math.round(chunkStartSec * sampleRate) }))
  }))

  // 合并切片到一个连续缓冲区
  const merged = Array.from({ length: numCh }, () => new Float32Array(trackSamples))
  for (const result of chunkResults) {
    if (!result) continue
    for (let ch = 0; ch < numCh; ch++) {
      const src = result.buffer.getChannelData(ch)
      const dst = merged[ch]
      const start = result.startSample
      const end = Math.min(start + src.length, trackSamples)
      for (let i = start, j = 0; i < end; i++, j++) {
        dst[i] += src[j]
      }
    }
  }

  return { numberOfChannels: numCh, length: trackSamples, sampleRate, getChannelData: (ch) => merged[ch] }
}

function renderNoteChunk(notes, sampleCaches, sampleRate, numCh, maxSamples, offsetSec) {
  let endSec = 0
  for (const note of notes) {
    const release = Math.min(sampleCaches.get(note.sourceId)?.config?.release || 1, 2)
    const adjusted = (note.startSec - offsetSec) + note.durationSec + release + 0.01
    if (adjusted > endSec) endSec = adjusted
  }
  const chunkSamples = Math.max(1, Math.min(maxSamples, Math.ceil(endSec * sampleRate)))

  const ctx = new OfflineAudioContext(numCh, chunkSamples, sampleRate)
  const master = ctx.createGain()
  master.connect(ctx.destination)

  for (const note of notes) {
    const cache = sampleCaches.get(note.sourceId)
    if (!cache) continue
    const sample = findBestSample(cache.sampleMap, cache.config, note.midi, note.velocity)
    if (!sample) continue

    const pb = resolveInstrumentPlaybackParams(note.sourceId, { velocity: note.velocity, durationSec: note.durationSec })
    const source = ctx.createBufferSource()
    source.buffer = sample.buffer
    source.playbackRate.value = 2 ** ((note.midi - sample.midi) / 12)

    const gain = ctx.createGain()
    gain.gain.value = pb.outputVelocity
    source.connect(gain)
    gain.connect(master)

    const release = Math.min(cache.config.release || 1, 2)
    const adjustedStart = note.startSec - offsetSec
    source.start(adjustedStart)
    const noteEnd = adjustedStart + note.durationSec
    gain.gain.setValueAtTime(pb.outputVelocity, noteEnd)
    gain.gain.linearRampToValueAtTime(0, noteEnd + release)
    source.stop(noteEnd + release + 0.01)
  }

  return ctx.startRendering()
}

async function resampleBuffer(audioBuffer, targetSampleRate, numCh) {
  if (!audioBuffer || audioBuffer.sampleRate === targetSampleRate) return audioBuffer
  const targetLength = Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate))
  const ctx = new OfflineAudioContext(numCh, targetLength, targetSampleRate)
  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(ctx.destination)
  source.start(0)
  return ctx.startRendering()
}

function mixAudioBuffer(dryChannels, reverbChannels, audioBuffer, startSample, dryGain, sendGain, numChannels, totalSamples) {
  const srcChannels = audioBuffer.numberOfChannels
  const srcLen = audioBuffer.length
  for (let ch = 0; ch < numChannels; ch++) {
    const src = audioBuffer.getChannelData(Math.min(ch, srcChannels - 1))
    const dry = dryChannels[ch]
    const rev = reverbChannels?.[ch]
    const end = Math.min(startSample + srcLen, totalSamples)
    for (let i = startSample, j = 0; i < end; i++, j++) {
      dry[i] += src[j] * dryGain
      if (rev) rev[i] += src[j] * sendGain
    }
  }
}

// ── 混响处理（每组配置仅一个 ConvolverNode）────────────

async function applyReverbChain(config, sendChannels, sampleRate, numChannels) {
  const len = sendChannels[0].length
  const ctx = new OfflineAudioContext(numChannels, len, sampleRate)

  const srcBuf = ctx.createBuffer(numChannels, len, sampleRate)
  for (let ch = 0; ch < numChannels; ch++) {
    srcBuf.getChannelData(ch).set(sendChannels[ch])
  }

  const source = ctx.createBufferSource()
  source.buffer = srcBuf

  const preDelay = ctx.createDelay(0.2)
  preDelay.delayTime.value = config.preDelaySec

  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = config.lowCutHz

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = config.highCutHz

  const convolver = ctx.createConvolver()
  convolver.normalize = true
  convolver.buffer = buildImpulseResponse(ctx, config)

  const returnGain = ctx.createGain()
  returnGain.gain.value = config.returnGain

  source.connect(preDelay)
  preDelay.connect(hp)
  hp.connect(lp)
  lp.connect(convolver)
  convolver.connect(returnGain)
  returnGain.connect(ctx.destination)

  source.start(0)
  return ctx.startRendering()
}

// ── 前瞻式限幅器 ──────────────────────────────────
// 纯线性增益变化，在峰值到来前平滑降低增益，峰值过后平滑恢复，
// 不引入任何谐波失真。低于阈值的信号完全不受影响。

function applyLookaheadLimiter(channels, numCh, totalSamples, sampleRate) {
  const threshold = 0.95
  const lookaheadSamples = Math.round(0.005 * sampleRate)
  const releaseCoeff = Math.exp(-1000 / (100 * sampleRate))
  const decayPerSample = Math.exp(-1 / lookaheadSamples)

  // 1. 计算各通道合并的逐采样峰值
  const env = new Float32Array(totalSamples)
  for (let ch = 0; ch < numCh; ch++) {
    const data = channels[ch]
    for (let i = 0; i < totalSamples; i++) {
      const v = data[i] > 0 ? data[i] : -data[i]
      if (v > env[i]) env[i] = v
    }
  }

  // 快速检查是否需要限幅
  let maxPeak = 0
  for (let i = 0; i < totalSamples; i++) {
    if (env[i] > maxPeak) maxPeak = env[i]
  }
  if (maxPeak <= threshold) return

  // 2. 反向扫描：将峰值信息向前传播（模拟前瞻窗口）
  let runMax = 0
  for (let i = totalSamples - 1; i >= 0; i--) {
    runMax = env[i] > runMax ? env[i] : runMax * decayPerSample
    env[i] = runMax > threshold ? threshold / runMax : 1
  }

  // 3. 正向平滑：瞬时启动 + 平滑释放，避免增益跳变
  let gain = 1
  for (let i = 0; i < totalSamples; i++) {
    const target = env[i]
    if (target < gain) {
      gain = target
    } else {
      gain = gain * releaseCoeff + target * (1 - releaseCoeff)
    }
    env[i] = gain
  }

  // 4. 应用增益
  for (let ch = 0; ch < numCh; ch++) {
    const data = channels[ch]
    for (let i = 0; i < totalSamples; i++) data[i] *= env[i]
  }
}

// ── 尾部静音裁剪 ──────────────────────────────────

function findTrimLength(channels, numChannels, totalSamples, minSamples, sampleRate) {
  const threshold = 0.0005
  const blockSize = 512
  let lastAudible = minSamples
  for (let ch = 0; ch < numChannels; ch++) {
    const data = channels[ch]
    for (let i = totalSamples - 1; i >= minSamples; i -= blockSize) {
      const start = Math.max(minSamples, i - blockSize + 1)
      let peak = 0
      for (let j = start; j <= i; j++) {
        const v = Math.abs(data[j])
        if (v > peak) peak = v
      }
      if (peak > threshold) {
        lastAudible = Math.max(lastAudible, Math.min(totalSamples, i + sampleRate))
        break
      }
    }
  }
  return Math.min(totalSamples, lastAudible)
}

// ── 导出器 ──────────────────────────────────────────

export class OfflineAudioExporter {
  constructor({ projectStore, sessionStore, audioGraph, vocalAssetRegistry, importedAudioAssetRegistry, convertedVocalAssetRegistry, logger = null }) {
    this.projectStore = projectStore
    this.sessionStore = sessionStore
    this.audioGraph = audioGraph
    this.vocalAssetRegistry = vocalAssetRegistry
    this.importedAudioAssetRegistry = importedAudioAssetRegistry
    this.convertedVocalAssetRegistry = convertedVocalAssetRegistry
    this.logger = logger
  }

  async exportWav({ sampleRate = 44100, bitDepth = 16, channels = 2, trackIds = null, onProgress = null } = {}) {
    const project = this.projectStore.getProject()
    if (!project?.tracks?.length) throw new Error('当前没有可导出的项目')

    const tracks = project.tracks
    const audibleTrackIds = trackIds
      ? new Set(trackIds)
      : resolveAudibleTrackIds(tracks, { ...this.sessionStore.getSnapshot(), focusSoloTrackId: null })
    const baseDuration = getProjectDuration(tracks)
    if (baseDuration <= 0) throw new Error('项目时长为零，没有可导出的内容')

    const reverbTailSec = getMaxReverbDecaySec(tracks)
    const totalDuration = baseDuration + reverbTailSec + REVERB_TAIL_EXTRA_SEC
    const numCh = channels === 1 ? 1 : 2
    const totalSamples = Math.ceil(totalDuration * sampleRate)

    onProgress?.({ phase: 'prepare', message: '正在准备...', percent: 0 })

    // 分配输出缓冲区
    const dryMix = Array.from({ length: numCh }, () => new Float32Array(totalSamples))

    // 混响分组：按配置聚合发送信号，只需一个 Convolver / 组
    const reverbGroups = new Map()
    function getReverbSendChannels(config, sendGain) {
      if (sendGain < REVERB_WET_THRESHOLD) return null
      const normalized = normalizeReverbConfig(config)
      if (normalized.returnGain < REVERB_WET_THRESHOLD) return null
      const key = serializeReverbConfig(normalized)
      if (!reverbGroups.has(key)) {
        reverbGroups.set(key, { config: normalized, channels: Array.from({ length: numCh }, () => new Float32Array(totalSamples)) })
      }
      return reverbGroups.get(key).channels
    }

    // ── 1. 收集所有音源 ──

    onProgress?.({ phase: 'collect', message: '正在收集音频资源...', percent: 2 })
    const convertedVocalEntries = await collectConvertedVocalEntries(tracks, audibleTrackIds, this.convertedVocalAssetRegistry)
    const convertedTrackIds = new Set(convertedVocalEntries.map((e) => e.trackId))
    const { notes: instrumentNotes, trackSourceMeta } = collectInstrumentNotes(tracks, audibleTrackIds)
    const vocalEntries = collectVocalEntries(tracks, audibleTrackIds, convertedTrackIds)
    const importedAudioEntries = collectImportedAudioEntries(tracks, audibleTrackIds, this.importedAudioAssetRegistry)

    // ── 2. 加载乐器采样 ──

    onProgress?.({ phase: 'load', message: '正在加载乐器采样...', percent: 5 })
    const sourceIds = [...new Set(instrumentNotes.map((n) => n.sourceId))]
    const sampleCaches = new Map()
    await Promise.all(sourceIds.map(async (id) => {
      const c = await loadSampleBuffers(id)
      if (c) sampleCaches.set(id, c)
    }))

    // ── 3. 预加载人声片段 ──

    const missingVocals = vocalEntries.filter((e) => !this.vocalAssetRegistry.getAsset(e)?.buffer && e.jobId)
    if (missingVocals.length > 0) {
      onProgress?.({ phase: 'load', message: `正在下载 ${missingVocals.length} 个人声片段...`, percent: 8 })
      await Promise.allSettled(missingVocals.map((e) => this.vocalAssetRegistry.ensurePhraseAsset(e)))
    }

    // ── 4. 按轨道渲染乐器（原生 playbackRate 保证音质）──

    const notesByTrack = new Map()
    for (const note of instrumentNotes) {
      if (!notesByTrack.has(note.trackId)) notesByTrack.set(note.trackId, [])
      notesByTrack.get(note.trackId).push(note)
    }

    // 按音符数降序排列，最复杂的轨先开始渲染
    const instrumentTracks = [...notesByTrack.entries()]
      .map(([trackId, notes]) => ({ trackId, notes, meta: trackSourceMeta.get(trackId) }))
      .filter((t) => t.meta)
      .sort((a, b) => b.notes.length - a.notes.length)
    const trackCount = instrumentTracks.length
    let completedTracks = 0
    onProgress?.({ phase: 'mix', message: `正在并发渲染 ${trackCount} 条乐器轨 (0/${trackCount})...`, percent: 10 })
    const instrumentResults = await Promise.all(instrumentTracks.map(({ trackId, notes, meta }) =>
      renderInstrumentTrack(notes, sampleCaches, sampleRate, numCh, totalSamples).then((buffer) => {
        completedTracks++
        onProgress?.({ phase: 'mix', message: `正在并发渲染乐器轨 (${completedTracks}/${trackCount})...`, percent: 10 + (completedTracks / trackCount) * 25 })
        return { trackId, meta, buffer }
      }),
    ))
    for (const result of instrumentResults) {
      const dryGain = resolveTrackPlaybackGain(result.meta.volume)
      const sendGain = normalizeTrackReverbSend(result.meta.reverbSend)
      const revCh = getReverbSendChannels(result.meta.reverbConfig, sendGain)
      mixAudioBuffer(dryMix, revCh, result.buffer, 0, dryGain, sendGain, numCh, totalSamples)
    }

    // ── 5. 混合人声片段（重采样到导出采样率）──

    onProgress?.({ phase: 'mix', message: '正在混合人声片段...', percent: 38 })
    for (const entry of vocalEntries) {
      const asset = this.vocalAssetRegistry.getAsset(entry)
      if (asset?.buffer) {
        const buf = await resampleBuffer(asset.buffer, sampleRate, numCh)
        const dryGain = resolveTrackPlaybackGain(entry.volume)
        const sendGain = normalizeTrackReverbSend(entry.reverbSend)
        const revCh = getReverbSendChannels(entry.reverbConfig, sendGain)
        mixAudioBuffer(dryMix, revCh, buf, Math.round(entry.startSec * sampleRate), dryGain, sendGain, numCh, totalSamples)
      }
    }

    // ── 6. 混合已转换人声 ──

    for (const entry of convertedVocalEntries) {
      const buf = await resampleBuffer(entry.buffer, sampleRate, numCh)
      const dryGain = resolveTrackPlaybackGain(entry.volume)
      const sendGain = normalizeTrackReverbSend(entry.reverbSend)
      const revCh = getReverbSendChannels(entry.reverbConfig, sendGain)
      mixAudioBuffer(dryMix, revCh, buf, 0, dryGain, sendGain, numCh, totalSamples)
    }

    // ── 7. 混合导入音频 ──

    for (const entry of importedAudioEntries) {
      const buf = await resampleBuffer(entry.buffer, sampleRate, numCh)
      const dryGain = resolveTrackPlaybackGain(entry.volume)
      const sendGain = normalizeTrackReverbSend(entry.reverbSend)
      const revCh = getReverbSendChannels(entry.reverbConfig, sendGain)
      mixAudioBuffer(dryMix, revCh, buf, Math.round(entry.startSec * sampleRate), dryGain, sendGain, numCh, totalSamples)
    }

    onProgress?.({ phase: 'mix', message: '混合完成', percent: 50 })

    // ── 8. 混响处理（每组配置一个 ConvolverNode）──

    const groupKeys = [...reverbGroups.keys()]
    for (let gi = 0; gi < groupKeys.length; gi++) {
      const group = reverbGroups.get(groupKeys[gi])
      onProgress?.({ phase: 'reverb', message: `正在处理混响 (${gi + 1}/${groupKeys.length})...`, percent: 50 + ((gi + 1) / Math.max(1, groupKeys.length)) * 35 })
      const wetBuffer = await applyReverbChain(group.config, group.channels, sampleRate, numCh)
      for (let ch = 0; ch < numCh; ch++) {
        const wet = wetBuffer.getChannelData(ch)
        const dry = dryMix[ch]
        const len = Math.min(wet.length, dry.length)
        for (let i = 0; i < len; i++) dry[i] += wet[i]
      }
      group.channels = null
    }

    // ── 9. 前瞻式限幅器（纯线性增益变化，不引入谐波失真）──

    applyLookaheadLimiter(dryMix, numCh, totalSamples, sampleRate)

    // ── 10. 裁剪尾部静音 ──

    onProgress?.({ phase: 'encode', message: '正在裁剪并编码...', percent: 88 })
    const trimLength = findTrimLength(dryMix, numCh, totalSamples, Math.ceil(baseDuration * sampleRate), sampleRate)
    const finalChannels = dryMix.map((ch) => ch.subarray(0, trimLength))

    // ── 10. 编码 WAV ──

    onProgress?.({ phase: 'encode', message: '正在编码 WAV 文件...', percent: 92 })
    const audioLike = {
      numberOfChannels: numCh,
      sampleRate,
      length: trimLength,
      getChannelData: (ch) => finalChannels[ch],
    }
    const wavBlob = encodeWavFile(audioLike, bitDepth)

    onProgress?.({ phase: 'done', message: '导出完成', percent: 100 })
    const fileName = `${project.fileName?.replace(/\.[^.]+$/, '') || 'export'}_mix_${sampleRate}hz_${bitDepth}bit.wav`
    return new File([wavBlob], fileName, { type: 'audio/wav' })
  }
}
