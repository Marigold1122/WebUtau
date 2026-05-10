/**
 * 把"播放头时间（秒）"格式化成 status bar 实时显示用的两种文本：
 *   - 时间码：'1:23.456'（永远以 0 起步，跨小时则 'HH:MM:SS.mmm'）
 *   - 小节-拍-tick：'2.3.0240'（DAW 标准；遇到拍号变化会用对应 segment 的 beats-per-bar）
 *
 * 设计要点：
 *   - 纯函数，无 DOM 依赖，方便单测
 *   - createBarBeatFormatter 接受 tempoData / ppq，返回一个**轻量函数**
 *     可重复对不同 timeSec 调用而不重算 segments，让 RAF 60Hz 调用零额外分配
 *   - tempoData 缺失时 fallback 到 4/4 拍、120 BPM——保证永远能渲染出文本
 *
 * 不依赖 createTimelineAxis：那个对象较重（含 DOM-aware 的 X 计算），这里只要时间↔tick
 */

const DEFAULT_PPQ = 480
const DEFAULT_BPM = 120
const DEFAULT_TIME_SIGNATURE = [4, 4]

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function clampPositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// ── 时间码：mm:ss.mmm（≥ 1h 时切到 hh:mm:ss.mmm） ───────────────
export function formatTimecode(timeSec) {
  const safe = clampNonNegative(timeSec, 0)
  const totalMs = Math.floor(safe * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const sec = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const min = totalMin % 60
  const hr = Math.floor(totalMin / 60)
  const msStr = String(ms).padStart(3, '0')
  const secStr = String(sec).padStart(2, '0')
  if (hr > 0) {
    const minStr = String(min).padStart(2, '0')
    return `${hr}:${minStr}:${secStr}.${msStr}`
  }
  return `${min}:${secStr}.${msStr}`
}

// ── 小节-拍-tick：基于 tempoData / ppq 内置一份轻量 segment 索引 ───
function buildTempoPoints(tempoData) {
  const inputPoints = Array.isArray(tempoData?.tempos) ? tempoData.tempos : []
  const points = inputPoints.map((point) => ({
    bpm: clampPositive(Number(point?.bpm), DEFAULT_BPM),
    time: clampNonNegative(point?.time, 0),
    ticks: clampNonNegative(point?.ticks, 0),
  }))
  if (points.length === 0 || (points[0].time !== 0 && points[0].ticks !== 0)) {
    points.unshift({ bpm: DEFAULT_BPM, time: 0, ticks: 0 })
  }
  points.sort((a, b) => a.time - b.time)
  return points
}

function buildTimeSignatureSegments(tempoData, ppq) {
  const inputPoints = Array.isArray(tempoData?.timeSignatures) ? tempoData.timeSignatures : []
  const points = inputPoints.map((point) => {
    const sig = Array.isArray(point?.timeSignature) ? point.timeSignature : DEFAULT_TIME_SIGNATURE
    return {
      ticks: clampNonNegative(point?.ticks, 0),
      beatsPerBar: clampPositive(Number(sig[0]), DEFAULT_TIME_SIGNATURE[0]),
      beatUnit: clampPositive(Number(sig[1]), DEFAULT_TIME_SIGNATURE[1]),
    }
  })
  if (points.length === 0 || points[0].ticks !== 0) {
    points.unshift({
      ticks: 0,
      beatsPerBar: DEFAULT_TIME_SIGNATURE[0],
      beatUnit: DEFAULT_TIME_SIGNATURE[1],
    })
  }
  points.sort((a, b) => a.ticks - b.ticks)

  const segments = []
  let startBarNumber = 1
  points.forEach((point, index) => {
    const beatTicks = Math.max(1, ppq * (4 / point.beatUnit))
    const nextStartTick = points[index + 1]?.ticks ?? Number.POSITIVE_INFINITY
    segments.push({
      startTick: point.ticks,
      endTick: nextStartTick,
      beatsPerBar: point.beatsPerBar,
      beatTicks,
      startBarNumber,
    })
    if (Number.isFinite(nextStartTick)) {
      const segDuration = Math.max(0, nextStartTick - point.ticks)
      const completedBeats = Math.floor(segDuration / beatTicks)
      const completedBars = Math.floor(completedBeats / point.beatsPerBar)
      const remainder = completedBeats % point.beatsPerBar
      startBarNumber += completedBars + (remainder !== 0 ? 1 : 0)
    }
  })
  return segments
}

function timeToTickWith(tempoPoints, ppq, time) {
  let index = 0
  while (index + 1 < tempoPoints.length && tempoPoints[index + 1].time <= time) index += 1
  const point = tempoPoints[index]
  const ticksPerSecond = (point.bpm * ppq) / 60
  return point.ticks + Math.max(0, time - point.time) * ticksPerSecond
}

function tickToBarBeat(segments, ppq, tick) {
  let index = 0
  while (index + 1 < segments.length && segments[index].endTick <= tick) index += 1
  const seg = segments[index]
  const offsetTick = Math.max(0, tick - seg.startTick)
  const beatIndex = Math.floor(offsetTick / seg.beatTicks)
  const tickInBeat = Math.round(offsetTick - beatIndex * seg.beatTicks)
  const bar = seg.startBarNumber + Math.floor(beatIndex / seg.beatsPerBar)
  const beat = (beatIndex % seg.beatsPerBar) + 1
  return { bar, beat, tickInBeat }
}

/**
 * 创建一个 bar-beat 格式化器。tempoData / ppq 在创建时**预算一次** segment，
 * 之后对每一帧的 timeSec 调用是 O(log N) 的 segment 查找，零分配。
 *
 * @param {object} options
 * @param {object|null} options.tempoData
 * @param {number} options.ppq
 * @returns {(timeSec: number) => string}  返回 'bar.beat.tickInBeat' 字符串，4 位 tick 0 padding
 */
export function createBarBeatFormatter({ tempoData = null, ppq = DEFAULT_PPQ } = {}) {
  const safePpq = clampPositive(Number(ppq), DEFAULT_PPQ)
  const tempoPoints = buildTempoPoints(tempoData)
  const segments = buildTimeSignatureSegments(tempoData, safePpq)
  return function format(timeSec) {
    const safeTime = clampNonNegative(timeSec, 0)
    const tick = timeToTickWith(tempoPoints, safePpq, safeTime)
    const { bar, beat, tickInBeat } = tickToBarBeat(segments, safePpq, tick)
    return `${bar}.${beat}.${String(tickInBeat).padStart(4, '0')}`
  }
}
