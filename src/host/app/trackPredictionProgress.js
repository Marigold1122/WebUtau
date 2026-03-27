function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

const PREP_PROGRESS_RANGES = {
  queued: [6, 10],
  loadingMidi: [10, 20],
  phonemizing: [20, 42],
  predictingPitch: [42, 90],
  rendering: [90, 99],
}

function normalizePercent(progress) {
  if (!Number.isFinite(progress)) return null
  const raw = progress <= 1 ? progress * 100 : progress
  return clamp(Math.round(raw), 0, 100)
}

function mapRatioToRange(current, total, [start, end]) {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null
  const ratio = clamp(current / total, 0, 1)
  return Math.round(start + (end - start) * ratio)
}

function parseIndexedProgress(text, pattern, range) {
  const match = String(text || '').match(pattern)
  if (!match) return null
  const current = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  return mapRatioToRange(current, total, range)
}

function parseProgressText(progressText, status, completed, total) {
  const text = String(progressText || '').trim()
  if (!text) return null

  if (/Loading MIDI/i.test(text)) {
    return PREP_PROGRESS_RANGES.loadingMidi[0]
  }

  if (/Phonemizing/i.test(text)) {
    return PREP_PROGRESS_RANGES.phonemizing[0]
  }

  const predicted = parseIndexedProgress(
    text,
    /Predicting pitch\s*\((\d+)\s*\/\s*(\d+)\)/i,
    PREP_PROGRESS_RANGES.predictingPitch,
  )
  if (predicted != null) return predicted

  if (/Predicting pitch/i.test(text)) {
    return PREP_PROGRESS_RANGES.predictingPitch[0]
  }

  const rendered = parseIndexedProgress(
    text,
    /Rendering phrase\s*(\d+)\s*\/\s*(\d+)/i,
    PREP_PROGRESS_RANGES.rendering,
  )
  if (rendered != null) return rendered

  if (/Writing full WAV/i.test(text)) {
    return PREP_PROGRESS_RANGES.rendering[1]
  }

  if (status === 'rendering') {
    return mapRatioToRange(completed, total, PREP_PROGRESS_RANGES.rendering)
  }

  return null
}

export function getPredictionProgressPercent(payload) {
  const normalized = normalizePercent(payload?.progress)
  const textPercent = parseProgressText(
    payload?.progress,
    payload?.status,
    payload?.completed,
    payload?.total,
  )

  if (payload?.status === 'queued') {
    if (normalized != null) return clamp(normalized, PREP_PROGRESS_RANGES.queued[0], PREP_PROGRESS_RANGES.queued[1])
    return PREP_PROGRESS_RANGES.queued[0]
  }

  if (payload?.status === 'preparing') {
    if (normalized != null) return clamp(normalized, PREP_PROGRESS_RANGES.loadingMidi[0], PREP_PROGRESS_RANGES.predictingPitch[1])
    if (textPercent != null) return textPercent
    return PREP_PROGRESS_RANGES.phonemizing[0]
  }

  if (payload?.status === 'rendering') {
    if (normalized != null) return clamp(normalized, PREP_PROGRESS_RANGES.rendering[0], PREP_PROGRESS_RANGES.rendering[1])
    if (textPercent != null) return textPercent
    return PREP_PROGRESS_RANGES.rendering[0]
  }

  if (payload?.status === 'completed') return 99
  return 0
}

export function getPredictionPhase(payload) {
  return payload?.status === 'queued' ? 'queued' : 'predicting'
}

export function buildPredictionOverlayText(percent) {
  return `正在预测音高 ${percent}%`
}

export function buildPredictionStatusText(trackName, percent) {
  return `音高预测: ${trackName || '当前轨道'} ${percent}%`
}

export function buildRenderProgressText(trackName, payload) {
  const name = trackName || '当前轨道'
  if (payload?.total > 0) {
    return `音频渲染: ${name} ${payload.completed}/${payload.total}`
  }
  return `音频渲染: ${name}`
}
