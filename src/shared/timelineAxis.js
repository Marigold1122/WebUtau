const DEFAULT_PPQ = 480
const DEFAULT_BEAT_WIDTH = 40
const DEFAULT_TIME_SIGNATURE = [4, 4]
const EPSILON = 0.000001

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function clampPositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampTempo(value) {
  return Number.isFinite(value) && value > 0 ? value : 120
}

function normalizeTimeSignature(value) {
  if (!Array.isArray(value) || value.length < 2) return [...DEFAULT_TIME_SIGNATURE]
  const beatsPerBar = clampPositive(Number(value[0]), DEFAULT_TIME_SIGNATURE[0])
  const beatUnit = clampPositive(Number(value[1]), DEFAULT_TIME_SIGNATURE[1])
  return [beatsPerBar, beatUnit]
}

function ticksToSeconds(ticks, bpm, ppq) {
  const safeTicks = clampNonNegative(ticks)
  return safeTicks * 60 / (clampTempo(bpm) * clampPositive(ppq, DEFAULT_PPQ))
}

function secondsToTicks(seconds, bpm, ppq) {
  const safeSeconds = clampNonNegative(seconds)
  return safeSeconds * clampTempo(bpm) * clampPositive(ppq, DEFAULT_PPQ) / 60
}

function comparePoints(left, right) {
  const leftTick = Number.isFinite(left?.ticks) ? left.ticks : null
  const rightTick = Number.isFinite(right?.ticks) ? right.ticks : null
  if (leftTick != null && rightTick != null && leftTick !== rightTick) return leftTick - rightTick

  const leftTime = Number.isFinite(left?.time) ? left.time : null
  const rightTime = Number.isFinite(right?.time) ? right.time : null
  if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime

  if (leftTick != null && rightTick == null) return -1
  if (leftTick == null && rightTick != null) return 1
  if (leftTime != null && rightTime == null) return -1
  if (leftTime == null && rightTime != null) return 1
  return 0
}

function createTempoPoint(point = {}) {
  return {
    bpm: clampTempo(point.bpm),
    time: Number.isFinite(point.time) ? Math.max(0, point.time) : null,
    ticks: Number.isFinite(point.ticks) ? Math.max(0, point.ticks) : null,
  }
}

function createTimeSignaturePoint(point = {}) {
  return {
    timeSignature: normalizeTimeSignature(point.timeSignature),
    time: Number.isFinite(point.time) ? Math.max(0, point.time) : null,
    ticks: Number.isFinite(point.ticks) ? Math.max(0, point.ticks) : null,
  }
}

function normalizeSubdivisionsPerBeat(value) {
  return Number.isFinite(value) && value > 1 ? Math.max(1, Math.round(value)) : 1
}

function buildTimeSignatureSegments(timeSignaturePoints, ppq) {
  const segments = []
  let startBarNumber = 1

  timeSignaturePoints.forEach((point, index) => {
    const [beatsPerBar, beatUnit] = point.timeSignature
    const beatTicks = Math.max(1, ppq * (4 / beatUnit))
    const nextStartTick = timeSignaturePoints[index + 1]?.ticks ?? Infinity
    segments.push({
      startTick: point.ticks,
      endTick: nextStartTick,
      beatsPerBar,
      beatUnit,
      beatTicks,
      startBarNumber,
    })

    if (!Number.isFinite(nextStartTick)) return
    const segmentDurationTicks = Math.max(0, nextStartTick - point.ticks)
    if (segmentDurationTicks <= EPSILON) return

    const completedBeats = Math.floor((segmentDurationTicks + EPSILON) / beatTicks)
    const completedBars = Math.floor(completedBeats / beatsPerBar)
    const beatNumberAtChange = (completedBeats % beatsPerBar) + 1
    startBarNumber += completedBars
    if (beatNumberAtChange !== 1) {
      startBarNumber += 1
    }
  })

  return segments
}

function findTimeSignatureSegmentIndexByTick(signatureSegments, tick) {
  let index = 0
  while (
    index + 1 < signatureSegments.length
    && signatureSegments[index].endTick <= tick + EPSILON
  ) {
    index += 1
  }
  return index
}

function buildRulerMarksInRange({
  totalTicks,
  signatureSegments,
  startTick = 0,
  endTick = totalTicks,
  tickToTime,
  tickToX,
  subdivisionsPerBeat = 1,
}) {
  const safeStartTick = clampNonNegative(startTick)
  const safeEndTick = Number.isFinite(totalTicks)
    ? Math.min(clampNonNegative(endTick, safeStartTick), totalTicks)
    : clampNonNegative(endTick, safeStartTick)
  if (safeEndTick + EPSILON < safeStartTick || signatureSegments.length === 0) return []

  const marks = []
  const safeSubdivisionsPerBeat = normalizeSubdivisionsPerBeat(subdivisionsPerBeat)
  let segmentIndex = findTimeSignatureSegmentIndexByTick(signatureSegments, safeStartTick)

  while (segmentIndex < signatureSegments.length) {
    const segment = signatureSegments[segmentIndex]
    if (segment.startTick > safeEndTick + EPSILON) break

    const beatTicks = segment.beatTicks
    const rangeStartOffset = Math.max(0, safeStartTick - segment.startTick)
    let beatIndex = Math.max(0, Math.floor((rangeStartOffset + EPSILON) / beatTicks))

    while (true) {
      const tick = segment.startTick + beatIndex * beatTicks
      if (tick > safeEndTick + EPSILON) break
      if (Number.isFinite(segment.endTick) && tick >= segment.endTick - EPSILON) break

      const barNumber = segment.startBarNumber + Math.floor(beatIndex / segment.beatsPerBar)
      const beatNumber = (beatIndex % segment.beatsPerBar) + 1

      if (tick >= safeStartTick - EPSILON) {
        const kind = beatNumber === 1 ? 'bar' : 'beat'
        marks.push({
          tick,
          time: tickToTime(tick),
          x: tickToX(tick),
          beatNumber,
          barNumber,
          isBar: beatNumber === 1,
          isBeat: beatNumber !== 1,
          isSubdivision: false,
          subdivisionIndex: 0,
          kind,
        })
      }

      if (safeSubdivisionsPerBeat > 1) {
        const subdivisionTicks = beatTicks / safeSubdivisionsPerBeat
        const beatEndTick = Number.isFinite(segment.endTick)
          ? Math.min(tick + beatTicks, segment.endTick)
          : tick + beatTicks
        for (let subdivisionIndex = 1; subdivisionIndex < safeSubdivisionsPerBeat; subdivisionIndex += 1) {
          const subdivisionTick = tick + subdivisionTicks * subdivisionIndex
          if (subdivisionTick >= beatEndTick - EPSILON) break
          if (subdivisionTick < safeStartTick - EPSILON || subdivisionTick > safeEndTick + EPSILON) continue
          marks.push({
            tick: subdivisionTick,
            time: tickToTime(subdivisionTick),
            x: tickToX(subdivisionTick),
            beatNumber,
            barNumber,
            isBar: false,
            isBeat: false,
            isSubdivision: true,
            subdivisionIndex,
            kind: 'sub',
          })
        }
      }

      beatIndex += 1
    }

    segmentIndex += 1
  }

  return marks
}

function finalizeTempoPoints(tempoData, ppq) {
  const inputPoints = Array.isArray(tempoData?.tempos) ? tempoData.tempos : []
  const points = [{ bpm: 120, time: 0, ticks: 0 }, ...inputPoints]
    .map(createTempoPoint)
    .sort(comparePoints)

  const finalized = []
  points.forEach((point, index) => {
    const nextPoint = { ...point }
    if (index === 0) {
      nextPoint.time = 0
      nextPoint.ticks = 0
    } else {
      const previous = finalized[finalized.length - 1]
      if (!Number.isFinite(nextPoint.time) && Number.isFinite(nextPoint.ticks)) {
        nextPoint.time = previous.time + ticksToSeconds(nextPoint.ticks - previous.ticks, previous.bpm, ppq)
      }
      if (!Number.isFinite(nextPoint.ticks) && Number.isFinite(nextPoint.time)) {
        nextPoint.ticks = previous.ticks + secondsToTicks(nextPoint.time - previous.time, previous.bpm, ppq)
      }
      nextPoint.time = Math.max(previous.time, clampNonNegative(nextPoint.time, previous.time))
      nextPoint.ticks = Math.max(previous.ticks, clampNonNegative(nextPoint.ticks, previous.ticks))
    }

    const previous = finalized[finalized.length - 1]
    if (previous && Math.abs(previous.ticks - nextPoint.ticks) <= EPSILON) {
      finalized[finalized.length - 1] = nextPoint
      return
    }
    finalized.push(nextPoint)
  })
  return finalized
}

function findSegmentIndexByTick(tempoPoints, tick) {
  let index = 0
  while (index + 1 < tempoPoints.length && tempoPoints[index + 1].ticks <= tick + EPSILON) {
    index += 1
  }
  return index
}

function findSegmentIndexByTime(tempoPoints, time) {
  let index = 0
  while (index + 1 < tempoPoints.length && tempoPoints[index + 1].time <= time + EPSILON) {
    index += 1
  }
  return index
}

function tickToTimeWithTempo(tempoPoints, ppq, tick) {
  const safeTick = clampNonNegative(tick)
  const index = findSegmentIndexByTick(tempoPoints, safeTick)
  const point = tempoPoints[index]
  return point.time + ticksToSeconds(safeTick - point.ticks, point.bpm, ppq)
}

function timeToTickWithTempo(tempoPoints, ppq, time) {
  const safeTime = clampNonNegative(time)
  const index = findSegmentIndexByTime(tempoPoints, safeTime)
  const point = tempoPoints[index]
  return point.ticks + secondsToTicks(safeTime - point.time, point.bpm, ppq)
}

function finalizeTimeSignaturePoints(tempoData, tempoPoints, ppq) {
  const inputPoints = Array.isArray(tempoData?.timeSignatures) ? tempoData.timeSignatures : []
  const points = [{ timeSignature: DEFAULT_TIME_SIGNATURE, time: 0, ticks: 0 }, ...inputPoints]
    .map(createTimeSignaturePoint)
    .sort(comparePoints)

  const finalized = []
  points.forEach((point, index) => {
    const nextPoint = { ...point }
    if (index === 0) {
      nextPoint.time = 0
      nextPoint.ticks = 0
    } else {
      if (!Number.isFinite(nextPoint.time) && Number.isFinite(nextPoint.ticks)) {
        nextPoint.time = tickToTimeWithTempo(tempoPoints, ppq, nextPoint.ticks)
      }
      if (!Number.isFinite(nextPoint.ticks) && Number.isFinite(nextPoint.time)) {
        nextPoint.ticks = timeToTickWithTempo(tempoPoints, ppq, nextPoint.time)
      }
      const previous = finalized[finalized.length - 1]
      nextPoint.time = Math.max(previous.time, clampNonNegative(nextPoint.time, previous.time))
      nextPoint.ticks = Math.max(previous.ticks, clampNonNegative(nextPoint.ticks, previous.ticks))
    }

    const previous = finalized[finalized.length - 1]
    if (previous && Math.abs(previous.ticks - nextPoint.ticks) <= EPSILON) {
      finalized[finalized.length - 1] = nextPoint
      return
    }
    finalized.push(nextPoint)
  })
  return finalized
}

export function createTimelineAxis({
  tempoData = null,
  ppq = DEFAULT_PPQ,
  beatWidth = DEFAULT_BEAT_WIDTH,
  totalTicks = 0,
} = {}) {
  const safePpq = clampPositive(ppq, DEFAULT_PPQ)
  const safeBeatWidth = clampPositive(beatWidth, DEFAULT_BEAT_WIDTH)
  const safeTotalTicks = clampNonNegative(totalTicks)
  const tempoPoints = finalizeTempoPoints(tempoData, safePpq)
  const timeSignaturePoints = finalizeTimeSignaturePoints(tempoData, tempoPoints, safePpq)
  const signatureSegments = buildTimeSignatureSegments(timeSignaturePoints, safePpq)

  const tickToX = (tick) => (clampNonNegative(tick) / safePpq) * safeBeatWidth
  const xToTick = (x) => (clampNonNegative(x) / safeBeatWidth) * safePpq
  const tickToTime = (tick) => tickToTimeWithTempo(tempoPoints, safePpq, tick)
  const timeToTick = (time) => timeToTickWithTempo(tempoPoints, safePpq, time)
  const timeToX = (time) => tickToX(timeToTick(time))
  const xToTime = (x) => tickToTime(xToTick(x))
  const timelineWidth = Math.ceil(tickToX(safeTotalTicks))
  const rulerMarksCache = new Map()

  return {
    ppq: safePpq,
    beatWidth: safeBeatWidth,
    totalTicks: safeTotalTicks,
    timelineWidth,
    duration: tickToTime(safeTotalTicks),
    tempoPoints,
    timeSignaturePoints,
    signatureSegments,
    tickToX,
    xToTick,
    tickToTime,
    timeToTick,
    timeToX,
    xToTime,
    getRulerMarksInRange(options = {}) {
      const safeStartTick = clampNonNegative(options?.startTick)
      const safeEndTick = Number.isFinite(options?.endTick)
        ? Math.max(safeStartTick, options.endTick)
        : safeTotalTicks
      return buildRulerMarksInRange({
        totalTicks: Math.max(safeTotalTicks, safeEndTick),
        signatureSegments,
        startTick: safeStartTick,
        endTick: safeEndTick,
        tickToTime,
        tickToX,
        subdivisionsPerBeat: options?.subdivisionsPerBeat,
      })
    },
    getRulerMarks(options = {}) {
      const safeSubdivisionsPerBeat = normalizeSubdivisionsPerBeat(options?.subdivisionsPerBeat)
      if (!rulerMarksCache.has(safeSubdivisionsPerBeat)) {
        rulerMarksCache.set(safeSubdivisionsPerBeat, buildRulerMarksInRange({
          totalTicks: safeTotalTicks,
          signatureSegments,
          startTick: 0,
          endTick: safeTotalTicks,
          tickToTime,
          tickToX,
          subdivisionsPerBeat: safeSubdivisionsPerBeat,
        }))
      }
      return rulerMarksCache.get(safeSubdivisionsPerBeat)
    },
  }
}
