/**
 * 将 AudioBuffer 编码为 WAV 文件 Blob。
 * 支持 16 位和 24 位 PCM 编码。
 */
export function encodeWavFile(audioBuffer, bitDepth = 16) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
    throw new Error('无效的 AudioBuffer')
  }
  const safeBitDepth = bitDepth === 24 ? 24 : 16
  const numberOfChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const length = audioBuffer.length
  const bytesPerSample = safeBitDepth / 8
  const blockAlign = numberOfChannels * bytesPerSample
  const dataByteLength = length * blockAlign
  const headerSize = 44
  const buffer = new ArrayBuffer(headerSize + dataByteLength)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataByteLength, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, safeBitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataByteLength, true)

  const channels = []
  for (let ch = 0; ch < numberOfChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch))
  }

  let offset = headerSize
  if (safeBitDepth === 16) {
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i] || 0))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
        offset += 2
      }
    }
  } else {
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i] || 0))
        const intSample = sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF
        const clamped = Math.round(intSample)
        view.setUint8(offset, clamped & 0xFF)
        view.setUint8(offset + 1, (clamped >> 8) & 0xFF)
        view.setUint8(offset + 2, (clamped >> 16) & 0xFF)
        offset += 3
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}
