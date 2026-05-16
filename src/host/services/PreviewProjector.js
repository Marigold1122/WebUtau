import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { createPreviewNoteDocument } from '../../shared/noteDocument.js'
import { isAudioTrack } from '../project/trackContentType.js'

const DEFAULT_PPQ = 480

function getTrackDuration(track) {
  if (isAudioTrack(track)) {
    return Math.max(0, (track.audioClip?.startTime || 0) + (track.audioClip?.duration || 0))
  }
  if (track?.duration) return track.duration
  const previewNotes = Array.isArray(track?.previewNotes) ? track.previewNotes : []
  return previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), 0)
}

export function getProjectDuration(tracks = []) {
  return tracks.reduce((maxDuration, track) => Math.max(maxDuration, getTrackDuration(track)), 0)
}

export function samplePreviewNotes(notes = [], maxCount = 96) {
  if (!Array.isArray(notes) || notes.length <= maxCount) return notes || []
  const step = Math.max(1, Math.ceil(notes.length / maxCount))
  return notes.filter((_, index) => index % step === 0)
}

function normalizePpq(ppq) {
  return Number.isFinite(ppq) && ppq > 0 ? ppq : DEFAULT_PPQ
}

function projectTickValue(axis, time) {
  return Math.max(0, Math.round(axis.timeToTick(Number.isFinite(time) ? time : 0)))
}

function projectNotePreview(note, axis) {
  const startTime = Number.isFinite(note?.time) ? Math.max(0, note.time) : 0
  const duration = Number.isFinite(note?.duration) ? Math.max(0, note.duration) : 0
  const startTick = Number.isFinite(note?.tick) ? Math.max(0, Math.round(note.tick)) : projectTickValue(axis, startTime)
  const endTick = Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)
    ? Math.max(startTick, Math.round(note.tick + note.durationTicks))
    : projectTickValue(axis, startTime + duration)

  return {
    ...createPreviewNoteDocument({
      ...note,
      time: startTime,
      duration,
      tick: startTick,
      durationTicks: duration <= 0 ? 0 : Math.max(1, endTick - startTick),
    }),
  }
}

export function projectPreviewNotes(notes = [], tempoData = null, ppq = DEFAULT_PPQ) {
  const axis = createTimelineAxis({
    tempoData,
    ppq: normalizePpq(ppq),
    totalTicks: 0,
  })

  return (Array.isArray(notes) ? notes : []).map((note) => projectNotePreview(note, axis))
}

// 防御：voice runtime 的 phraseStore.rebuildFromEdit 在某些回路下把 phrase.notes 的
// tick / time 都搞成 part-relative（甚至全 0），唯一可靠的字段往往只剩 phrase.startTime
// 和 note.durationTicks。flatMap 之前必须重建每个 note 的绝对 tick：
//   - tick 全相同（污染）+ time 全相同 → 用 phrase.startTick + 累积 durationTicks 顺序排列
//   - tick 全相同 但 time 有差异 → 用 phrase.startTime + note.time
//   - 都正常 → 直接采信
function flattenPhraseNotesWithAbsoluteTime(phrases, axis) {
  const out = []
  for (const phrase of phrases) {
    const phraseStartSec = Number.isFinite(phrase?.startTime) ? Math.max(0, phrase.startTime) : 0
    const phraseStartTick = axis ? Math.max(0, Math.round(axis.timeToTick(phraseStartSec))) : 0
    const notes = Array.isArray(phrase?.notes) ? phrase.notes : []
    if (notes.length === 0) continue

    const tickValues = notes.map((n) => (Number.isFinite(n?.tick) ? Math.round(n.tick) : 0))
    const timeValues = notes.map((n) => (Number.isFinite(n?.time) ? n.time : 0))
    const tickPolluted = notes.length > 1 && tickValues.every((t) => t === tickValues[0])
    const timePolluted = notes.length > 1 && timeValues.every((t) => t === timeValues[0])

    if (tickPolluted && timePolluted) {
      // 最严重污染：tick / time 都丢了，用 durationTicks 累积重建
      // 这里假设 phrase 内 note 紧密相连——大多数 vocal 数据如此；如果有间隙，
      // 间隙信息无法从 runtime 反馈中恢复，但至少音符不再堆叠在同一 tick 上
      let cursorTick = phraseStartTick
      for (const note of notes) {
        const dt = Number.isFinite(note?.durationTicks) ? Math.max(1, Math.round(note.durationTicks)) : 1
        const cursorTime = axis ? axis.tickToTime(cursorTick) : 0
        out.push({
          ...note,
          tick: cursorTick,
          durationTicks: dt,
          time: cursorTime,
          duration: axis ? axis.tickToTime(cursorTick + dt) - cursorTime : Math.max(0.05, dt / 480 * 0.5),
        })
        cursorTick += dt
      }
    } else if (timePolluted) {
      // time 全相同（多数 0），但 tick 有差异。两种可能：
      //   A) tick 也是 part-relative（典型：rebuildFromEdit 污染，note[0].tick 通常 = 0）
      //   B) time=0 只是兜底（createTrackDocument 没跑 applyProjectTiming），tick 是绝对
      // 用 axis 反推 firstTick 对应的时间，跟 phraseStartSec 比较——绝对 tick 反推的时间
      // 应当接近 phrase 起始时间（差 < 2 秒在 phrase 时长尺度内合理）
      const firstTick = tickValues[0] || 0
      const firstTickReverseTime = axis ? axis.tickToTime(firstTick) : 0
      const tickIsAbsolute = Math.abs(firstTickReverseTime - phraseStartSec) < 2.0
      const ticksLookPartRelative = !tickIsAbsolute && firstTick < phraseStartTick
      for (const note of notes) {
        const noteTick = Number.isFinite(note?.tick) ? Math.max(0, Math.round(note.tick)) : 0
        const absTick = ticksLookPartRelative ? noteTick + phraseStartTick : noteTick
        const absTime = axis ? axis.tickToTime(absTick) : 0
        out.push({ ...note, tick: absTick, time: absTime })
      }
    } else {
      // time 各不相同：判断"整个 phrase 是否 part-relative"
      // 关键修复：之前用"note.time < phraseStartSec → 加偏移"——但当 backend 重建后
      // 把 phrase[0].startTime 设得晚于第一个 note.time（典型："开头孤儿" 落到 phrase[0]，
      // note.time=16.83s 但 phrase.startTime=18s），单条 note.time<startTime 会被误判
      // 成 part-relative 加偏移 → tick 翻倍错位 → 用户感受到"开头缺音符"。
      // 严格判定：仅当**所有 notes 的 time 都 < phraseStartSec**（rebuildFromEdit 典型
      // 污染特征：phrase 内 N 个 note 集体落在 phrase 起始之前）才加偏移
      const allTimesBeforeStart = phraseStartSec > 0
        && notes.every((n) => Number.isFinite(n?.time) && n.time < phraseStartSec)
      for (const note of notes) {
        const rawTime = Number.isFinite(note?.time) ? note.time : 0
        const absoluteTime = allTimesBeforeStart ? phraseStartSec + rawTime : rawTime
        const next = { ...note, time: absoluteTime }
        if (tickPolluted) {
          delete next.tick
          delete next.durationTicks
        }
        out.push(next)
      }
    }
  }
  return out
}

export function buildPreviewProjection(snapshot = null, tempoData = null, ppq = DEFAULT_PPQ) {
  const effectiveTempo = snapshot?.tempoData || tempoData
  const sharedAxis = createTimelineAxis({
    tempoData: effectiveTempo,
    ppq: normalizePpq(ppq),
    totalTicks: 0,
  })
  const sourceNotes = Array.isArray(snapshot?.phrases)
    ? flattenPhraseNotesWithAbsoluteTime(snapshot.phrases, sharedAxis)
    : Array.isArray(snapshot?.previewNotes)
      ? snapshot.previewNotes
      : []
  const previewNotes = projectPreviewNotes(sourceNotes, effectiveTempo, ppq)
  const duration = previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.time + note.duration), 0)
  const durationTicks = previewNotes.reduce((maxValue, note) => Math.max(maxValue, note.tick + note.durationTicks), 0)

  return {
    previewNotes,
    noteCount: previewNotes.length,
    duration,
    durationTicks,
  }
}
