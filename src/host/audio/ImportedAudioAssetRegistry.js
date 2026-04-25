import { getToneRawContext } from './instruments/toneRuntime.js'

const DEFAULT_WAVEFORM_PEAK_COUNT = 192

function createAssetId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `audio-${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

function clampPeakValue(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function createWaveformPeaks(buffer, peakCount = DEFAULT_WAVEFORM_PEAK_COUNT) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length <= 0) return []
  const safePeakCount = Math.max(24, Math.round(peakCount))
  const channels = Math.max(1, buffer.numberOfChannels || 1)
  const peaks = new Array(safePeakCount).fill(0)

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    if (!channelData?.length) continue
    const samplesPerPeak = Math.max(1, Math.floor(channelData.length / safePeakCount))
    for (let peakIndex = 0; peakIndex < safePeakCount; peakIndex += 1) {
      const start = peakIndex * samplesPerPeak
      const end = peakIndex === safePeakCount - 1
        ? channelData.length
        : Math.min(channelData.length, start + samplesPerPeak)
      let peak = peaks[peakIndex]
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const amplitude = Math.abs(channelData[sampleIndex] || 0)
        if (amplitude > peak) peak = amplitude
      }
      peaks[peakIndex] = peak
    }
  }

  return peaks.map((peak) => Math.round(clampPeakValue(peak) * 1000) / 1000)
}

export class ImportedAudioAssetRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.entries = new Map()
  }

  getAsset(assetId) {
    return assetId ? this.entries.get(assetId) || null : null
  }

  async registerFile(file, { trackId = null } = {}) {
    if (!(file instanceof Blob)) {
      throw new Error('无效的音频文件')
    }
    const fullArrayBuffer = await file.arrayBuffer()
    if (!fullArrayBuffer || fullArrayBuffer.byteLength <= 0) {
      throw new Error('音频文件为空')
    }
    // decodeAudioData 在多数浏览器实现里会 detach 传入的 ArrayBuffer，
    // 所以保存原始字节得先 slice 一份副本——session 期间和工程序列化都会用到这份副本
    const rawBytes = fullArrayBuffer.slice(0)

    const buffer = await this._decode(fullArrayBuffer)
    const assetId = createAssetId()
    const entry = this._buildEntry({
      assetId,
      trackId,
      fileName: typeof file.name === 'string' && file.name ? file.name : 'audio',
      mimeType: typeof file.type === 'string' ? file.type : '',
      rawBytes,
      buffer,
    })
    this.entries.set(assetId, entry)
    this.logger?.info?.('Imported audio asset registered', {
      assetId,
      trackId,
      fileName: entry.fileName,
      duration: entry.duration,
      bytes: rawBytes.byteLength,
      waveformPeakCount: entry.waveformPeaks.length,
    })
    return entry
  }

  // 从工程文件加载时调：assetId 必须沿用文件里记录的，否则轨道引用会断
  async registerSerializedAsset({
    assetId,
    fileName = 'audio',
    mimeType = '',
    rawBytes,
    trackId = null,
  } = {}) {
    if (!assetId) throw new Error('registerSerializedAsset 缺少 assetId')
    if (!(rawBytes instanceof ArrayBuffer) || rawBytes.byteLength <= 0) {
      throw new Error('registerSerializedAsset 的 rawBytes 无效')
    }
    // 同样 slice 一份给 decode 用，rawBytes 自身留作"原始字节"以便下次再保存
    const decodingBuffer = rawBytes.slice(0)
    const buffer = await this._decode(decodingBuffer)
    const entry = this._buildEntry({ assetId, trackId, fileName, mimeType, rawBytes, buffer })
    this.entries.set(assetId, entry)
    this.logger?.info?.('Imported audio asset restored from project file', {
      assetId,
      trackId,
      fileName,
      duration: entry.duration,
      bytes: rawBytes.byteLength,
    })
    return entry
  }

  // 给序列化用——返回浅拷贝列表，调用方不必拿到内部 Map
  listEntries() {
    return Array.from(this.entries.values()).map((entry) => ({
      assetId: entry.assetId,
      trackId: entry.trackId,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      duration: entry.duration,
      waveformPeaks: entry.waveformPeaks,
      rawBytes: entry.rawBytes,
    }))
  }

  async _decode(arrayBuffer) {
    let buffer = null
    try {
      const rawContext = await getToneRawContext()
      buffer = await rawContext.decodeAudioData(arrayBuffer)
    } catch (error) {
      throw new Error('无法解码音频文件，可能是不支持的编码或文件已损坏', { cause: error })
    }
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error('音频解码结果为空')
    }
    return buffer
  }

  _buildEntry({ assetId, trackId, fileName, mimeType, rawBytes, buffer }) {
    return {
      assetId,
      trackId,
      fileName,
      mimeType,
      rawBytes,
      buffer,
      duration: buffer.duration || 0,
      waveformPeaks: createWaveformPeaks(buffer),
    }
  }

  bindTrack(assetId, trackId) {
    const entry = this.getAsset(assetId)
    if (!entry) return null
    entry.trackId = trackId || null
    return entry
  }

  releaseTrack(trackId) {
    if (!trackId) return
    for (const [assetId, entry] of this.entries) {
      if (entry.trackId !== trackId) continue
      this.entries.delete(assetId)
    }
  }

  reset() {
    this.entries.clear()
  }
}
