/**
 * 给 status bar 实时显示用的"选区摘要"——纯函数，无 DOM / i18n 依赖。
 *
 * 摘要 = 选中音符数 + 音域（midiLow / midiHigh）+ 时长跨度（spanSec）。
 * 时长跨度 = 从最早 note 起点到最晚 note 终点的总秒数（不是单个 note 的 duration）。
 *
 * 两个编辑器（宿主乐器编辑器 / 声部 runtime）都喂同样形状的 note：
 *   { time: number, duration: number, midi: number }
 * 因此能共用同一个 summarize 函数。
 *
 * 返回 null 表示"无可摘要项"——调用方据此隐藏 status bar 的"选区"字段
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {Array<{ time: number, duration: number, midi: number }>} notes
 * @returns {{ count: number, midiLow: number, midiHigh: number, spanSec: number } | null}
 */
export function summarizeNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return null
  let count = 0
  let midiLow = Number.POSITIVE_INFINITY
  let midiHigh = Number.NEGATIVE_INFINITY
  let earliestStart = Number.POSITIVE_INFINITY
  let latestEnd = Number.NEGATIVE_INFINITY
  for (const note of notes) {
    if (!note || !isFiniteNumber(note.midi)) continue
    count += 1
    if (note.midi < midiLow) midiLow = note.midi
    if (note.midi > midiHigh) midiHigh = note.midi
    const start = isFiniteNumber(note.time) ? Math.max(0, note.time) : 0
    const dur = isFiniteNumber(note.duration) ? Math.max(0, note.duration) : 0
    if (start < earliestStart) earliestStart = start
    if (start + dur > latestEnd) latestEnd = start + dur
  }
  if (count === 0) return null
  // 防御：如果所有 note 没有时间信息（极端情况），spanSec 算 0 而不是 -Infinity
  const spanSec = (Number.isFinite(earliestStart) && Number.isFinite(latestEnd) && latestEnd >= earliestStart)
    ? latestEnd - earliestStart
    : 0
  return {
    count,
    midiLow: Number.isFinite(midiLow) ? Math.round(midiLow) : 60,
    midiHigh: Number.isFinite(midiHigh) ? Math.round(midiHigh) : 60,
    spanSec,
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI 数值 → 音名（C4 / F#5 / Bb3 等；用 # 不用 ♭）。无效输入返回空串 */
export function midiToNoteName(midi) {
  if (!isFiniteNumber(midi)) return ''
  const m = Math.round(midi)
  const octave = Math.floor(m / 12) - 1
  const name = NOTE_NAMES[((m % 12) + 12) % 12]
  return `${name}${octave}`
}

/**
 * 把 spanSec 渲染成紧凑文本：
 *   - < 1s     → "240ms"
 *   - < 60s    → "1.20s"
 *   - >= 60s   → "1:23.456"
 */
export function formatSpan(spanSec) {
  if (!isFiniteNumber(spanSec) || spanSec < 0) return '0ms'
  if (spanSec < 1) return `${Math.round(spanSec * 1000)}ms`
  if (spanSec < 60) return `${spanSec.toFixed(2)}s`
  const totalMs = Math.floor(spanSec * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  return `${min}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
