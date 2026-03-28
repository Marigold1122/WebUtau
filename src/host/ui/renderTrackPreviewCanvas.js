const MAX_CANVAS_WIDTH = 16384

function getTrackColor(color) {
  return color || '#3b8b88'
}

function clampPeak(peak) {
  if (!Number.isFinite(peak)) return 0
  return Math.max(0, Math.min(1, peak))
}

function getPitchBounds(notes) {
  const midiValues = (notes || [])
    .map((note) => note?.midi)
    .filter((midi) => Number.isFinite(midi))

  if (midiValues.length === 0) {
    return { minMidi: 60, maxMidi: 72 }
  }

  return {
    minMidi: Math.min(...midiValues) - 2,
    maxMidi: Math.max(...midiValues) + 2,
  }
}

function getNoteAbsoluteX(note, ppq, beatWidth, axis) {
  if (Number.isFinite(note?.tick)) {
    return Math.max(0, (note.tick / ppq) * beatWidth)
  }
  if (axis && Number.isFinite(note?.time)) {
    return Math.max(0, axis.timeToX(note.time))
  }
  return 0
}

function getNoteAbsoluteEndX(note, ppq, beatWidth, axis) {
  if (Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)) {
    return Math.max(0, ((note.tick + note.durationTicks) / ppq) * beatWidth)
  }
  if (axis && Number.isFinite(note?.time) && Number.isFinite(note?.duration)) {
    return Math.max(0, axis.timeToX(note.time + note.duration))
  }
  return 0
}

function renderAudioWaveform(context, audioClip, drawHeight, color, axis, xOrigin = 0) {
  const peaks = Array.isArray(audioClip?.waveformPeaks) ? audioClip.waveformPeaks : []
  const duration = Number.isFinite(audioClip?.duration) ? audioClip.duration : 0
  if (peaks.length < 2 || duration <= 0) return false

  const startTime = Number.isFinite(audioClip?.startTime) ? Math.max(0, audioClip.startTime) : 0
  const endTime = startTime + duration
  const clipStartX = axis ? Math.max(0, axis.timeToX(startTime) - xOrigin) : 0
  const clipEndX = axis ? Math.max(clipStartX + 2, axis.timeToX(endTime) - xOrigin) : context.canvas.width
  const clipWidth = Math.max(2, clipEndX - clipStartX)
  const centerY = drawHeight / 2
  const halfHeight = Math.max((drawHeight - 10) / 2, 2)

  context.save()
  context.beginPath()
  context.moveTo(clipStartX, centerY)
  context.lineTo(clipEndX, centerY)
  context.strokeStyle = color
  context.globalAlpha = 0.18
  context.lineWidth = 1
  context.stroke()

  context.beginPath()
  context.moveTo(clipStartX, centerY)
  peaks.forEach((peak, index) => {
    const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1)
    const x = clipStartX + ratio * clipWidth
    const y = centerY - clampPeak(peak) * halfHeight
    context.lineTo(x, y)
  })
  for (let index = peaks.length - 1; index >= 0; index -= 1) {
    const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1)
    const x = clipStartX + ratio * clipWidth
    const y = centerY + clampPeak(peaks[index]) * halfHeight
    context.lineTo(x, y)
  }
  context.closePath()
  context.fillStyle = color
  context.globalAlpha = 0.6
  context.fill()

  context.beginPath()
  context.moveTo(clipStartX, centerY)
  peaks.forEach((peak, index) => {
    const ratio = peaks.length === 1 ? 0 : index / (peaks.length - 1)
    const x = clipStartX + ratio * clipWidth
    const y = centerY - clampPeak(peak) * halfHeight
    context.lineTo(x, y)
  })
  context.strokeStyle = color
  context.globalAlpha = 0.92
  context.lineWidth = 1.2
  context.stroke()
  context.restore()
  return true
}

export function renderTrackPreviewCanvas(
  canvas,
  notes,
  width,
  ppq,
  beatWidth,
  color,
  height,
  axis = null,
  audioClip = null,
  options = {},
) {
  const drawWidth = Math.max(1, Math.floor(width))
  const drawHeight = Math.max(1, Math.floor(height))
  const canvasWidth = Math.min(drawWidth, MAX_CANVAS_WIDTH)
  const context = canvas.getContext('2d')
  const fill = getTrackColor(color)
  const xOrigin = Number.isFinite(options?.xOrigin) ? Math.max(0, options.xOrigin) : 0
  const { minMidi, maxMidi } = getPitchBounds(notes)
  const midiRange = Math.max(maxMidi - minMidi, 1)

  canvas.width = canvasWidth
  canvas.height = drawHeight
  canvas.style.width = `${drawWidth}px`
  canvas.style.height = `${drawHeight}px`
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.save()

  if (drawWidth > MAX_CANVAS_WIDTH) {
    context.scale(canvasWidth / drawWidth, 1)
  }

  if (renderAudioWaveform(context, audioClip, drawHeight, fill, axis, xOrigin)) {
    context.restore()
    return
  }

  const padding = 4
  const innerHeight = Math.max(drawHeight - padding * 2, 1)
  const noteHeight = Math.max(innerHeight / midiRange, 1.5)

  context.fillStyle = fill
  context.globalAlpha = 0.82

  for (const note of notes || []) {
    const absoluteStartX = getNoteAbsoluteX(note, ppq, beatWidth, axis)
    const absoluteEndX = getNoteAbsoluteEndX(note, ppq, beatWidth, axis)
    const x = Math.max(0, absoluteStartX - xOrigin)
    const noteWidth = Math.max(2, absoluteEndX - absoluteStartX)
    const y = padding + (1 - (note.midi - minMidi) / midiRange) * innerHeight
    context.fillRect(x, y - noteHeight / 2, noteWidth, noteHeight)
  }

  context.restore()
}
