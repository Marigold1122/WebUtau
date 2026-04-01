function createSeededRandom(seed = 1) {
  let value = (Math.floor(seed) || 1) >>> 0
  return () => {
    value = (1664525 * value + 1013904223) >>> 0
    return value / 0xFFFFFFFF
  }
}

export function buildImpulseResponse(rawContext, config = {}) {
  if (!rawContext) return null
  const durationSec = Number.isFinite(config?.decaySec) ? Math.max(0.01, config.decaySec) : 1
  const decayCurve = Number.isFinite(config?.decayCurve) ? Math.max(0.01, config.decayCurve) : 1
  const sampleRate = rawContext.sampleRate || 48000
  const frameCount = Math.max(1, Math.round(sampleRate * durationSec))
  const buffer = rawContext.createBuffer(2, frameCount, sampleRate)
  const leftRandom = createSeededRandom(17)
  const rightRandom = createSeededRandom(73)

  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    const random = channelIndex === 0 ? leftRandom : rightRandom
    for (let frame = 0; frame < frameCount; frame += 1) {
      const decayPosition = 1 - (frame / frameCount)
      const amplitude = decayPosition ** decayCurve
      channelData[frame] = ((random() * 2) - 1) * amplitude
    }
  }

  return buffer
}
