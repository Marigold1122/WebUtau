import { PIANO_ROLL } from '../config/constants.js'

// tempo / timeSignature / keySignature 三类点位上的 time 字段允许 null，
// 表示"未知，由 timelineAxis 用 ticks + 上一段 bpm 反推绝对秒"。
// 之前用 normalizeTime 把 null 兜底成 0，导致非首条 tempo 出现"在 0 秒处突变 N 万 tick"
// 的伪结构，axis.timeToTick(任意 time>0) 都掉进 segment 1 加上 224640 偏移，
// 播放头视觉位置远超 timeline、ruler 点击算出错位 currentTime——这是
// "导入 USTX 后点击拖不动播放头 + 播放从远处开始"的根因。
// 显式区分：tempo/sig/key 用 normalizePointTime（保留 null），其它场合用 normalizeTime。
function normalizePointTime(value) {
  if (value == null) return null
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function normalizeTime(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizeTick(value) {
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function normalizeTempo(tempo = {}) {
  return {
    bpm: Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : PIANO_ROLL.DEFAULT_BPM,
    time: normalizePointTime(tempo.time),
    ticks: normalizeTick(tempo.ticks),
  }
}

function normalizeTimeSignature(signature = {}) {
  return {
    timeSignature: Array.isArray(signature.timeSignature)
      ? signature.timeSignature
      : [...PIANO_ROLL.DEFAULT_TIME_SIGNATURE],
    time: normalizePointTime(signature.time),
    ticks: normalizeTick(signature.ticks),
  }
}

function normalizeKeySignature(signature = {}) {
  const key = typeof signature.key === 'string' && signature.key.trim()
    ? signature.key.trim()
    : 'C'
  const scale = signature.scale === 'minor' ? 'minor' : 'major'
  return {
    key,
    scale,
    time: normalizePointTime(signature.time),
    ticks: normalizeTick(signature.ticks),
  }
}

// 排序比较器：time/ticks 都可能是 null。优先按 ticks 升序（USTX import 总是给 ticks），
// ticks 也缺时退化按 time。两个都 null 视为相等
function compareTimelinePoints(left, right) {
  const leftTick = Number.isFinite(left?.ticks) ? left.ticks : null
  const rightTick = Number.isFinite(right?.ticks) ? right.ticks : null
  if (leftTick != null && rightTick != null) return leftTick - rightTick
  const leftTime = Number.isFinite(left?.time) ? left.time : null
  const rightTime = Number.isFinite(right?.time) ? right.time : null
  if (leftTime != null && rightTime != null) return leftTime - rightTime
  if (leftTick != null) return -1
  if (rightTick != null) return 1
  return 0
}

export function createTempoDocument(tempoData = null) {
  const sourceTempos = Array.isArray(tempoData?.tempos) ? tempoData.tempos : []
  const sourceTimeSignatures = Array.isArray(tempoData?.timeSignatures) ? tempoData.timeSignatures : []
  const sourceKeySignatures = Array.isArray(tempoData?.keySignatures) ? tempoData.keySignatures : []
  const tempos = (sourceTempos.length > 0 ? sourceTempos : [{ bpm: PIANO_ROLL.DEFAULT_BPM, time: 0, ticks: 0 }])
    .map(normalizeTempo)
    .sort(compareTimelinePoints)
  const timeSignatures = (sourceTimeSignatures.length > 0
    ? sourceTimeSignatures
    : [{ timeSignature: [...PIANO_ROLL.DEFAULT_TIME_SIGNATURE], time: 0, ticks: 0 }])
    .map(normalizeTimeSignature)
    .sort(compareTimelinePoints)
  const keySignatures = sourceKeySignatures
    .map(normalizeKeySignature)
    .sort(compareTimelinePoints)

  return {
    tempos,
    timeSignatures,
    keySignatures,
    hasTempoInfo: tempoData?.hasTempoInfo ?? sourceTempos.length > 0,
    hasTimeSignatureInfo: tempoData?.hasTimeSignatureInfo ?? sourceTimeSignatures.length > 0,
    hasKeySignatureInfo: tempoData?.hasKeySignatureInfo ?? sourceKeySignatures.length > 0,
  }
}
