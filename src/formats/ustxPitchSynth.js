// ============================================================
// OpenUtau → webUTAU 音高曲线合成器
// ============================================================
//
// 目的：让 OpenUtau 原生导出的 USTX（没有 webUTAU 私有 _meta.webutau_voice_snapshot）
// 在导入 webUTAU 时也能立刻显示音高曲线，不需要等 AI 重新渲染。
//
// 实现：完整复刻 OpenUtau-master/OpenUtau.Core/Render/RenderPhrase.cs 第 238-307 的
// pitch 生成算法，确保两端"机械"算出的曲线一致——
//   1) 初始填平：每个采样点 pitch = note.tone × 100 (cents)
//   2) Vibrato 覆盖：UVibrato.Evaluate(nPos, nPeriod) 公式
//   3) Pitch points portamento 偏差叠加：MusicMath.InterpolateShape (io/i/o/l) 插值
//
// 关键单位：
//   - OpenUtau pitches[]：cents（int/float，note.tone * 100 为基准，偏差叠加）
//   - OpenUtau note.pitch.data[].x: ms（相对 note 起始）
//   - OpenUtau note.pitch.data[].y: 0.1 semitone（decicents，× 10 = cents）
//   - OpenUtau vibrato.depth: cents
//   - 采样间隔：pitchInterval = 5 ticks（PPQ 480 下 ≈ 5.2ms@120bpm）
//
//   - webUTAU pitchCurve[].pitch: MIDI 半音浮点（60.0 = C4）
//   - webUTAU pitchCurve[].tick: 绝对 tick
//   - webUTAU pitchDeviation.ys: cents
//   - webUTAU pitchStepTick: 5（与 OpenUtau pitchInterval 一致）
//
// 算法对应表：
//   OpenUtau pitches[i] (cents)  ÷ 100  =  webUTAU pitchCurve[i].pitch (semitones)
//   OpenUtau pitchStart + i * 5  =  webUTAU pitchCurve[i].tick
// ============================================================

import { createTimelineAxis } from '../shared/timelineAxis.js'
import { normalizeShape } from './shape-map.js'

const PITCH_STEP_TICK = 5  // 与 OpenUtau RenderPhrase.cs:238 const int pitchInterval = 5 完全一致

// ============================================================
// 插值函数 — 与 OpenUtau MusicMath.cs:123-183 严格 1:1 对齐
// ============================================================
// 单位：x/y 任意，函数纯几何插值；下面 x 是 ms 或 tick（看调用方），y 是 cents。
// epsilon 防御零长段（与 C# 端 const double ep = 0.001 一致）。

const EP = 0.001

function sinEasingInOut(x0, x1, y0, y1, x) {
  if (x1 - x0 < EP) return y1
  return y0 + (y1 - y0) * (1 - Math.cos((x - x0) / (x1 - x0) * Math.PI)) / 2
}

function sinEasingIn(x0, x1, y0, y1, x) {
  if (x1 - x0 < EP) return y1
  return y0 + (y1 - y0) * (1 - Math.cos((x - x0) / (x1 - x0) * Math.PI / 2))
}

function sinEasingOut(x0, x1, y0, y1, x) {
  if (x1 - x0 < EP) return y1
  return y0 + (y1 - y0) * Math.sin((x - x0) / (x1 - x0) * Math.PI / 2)
}

function linear(x0, x1, y0, y1, x) {
  if (x1 - x0 < EP) return y1
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
}

function interpolateShape(x0, x1, y0, y1, x, shape) {
  switch (normalizeShape(shape)) {
    case 'io': return sinEasingInOut(x0, x1, y0, y1, x)
    case 'i':  return sinEasingIn(x0, x1, y0, y1, x)
    case 'o':  return sinEasingOut(x0, x1, y0, y1, x)
    default:   return linear(x0, x1, y0, y1, x)  // 'l' 或未知 → 线性
  }
}

// ============================================================
// Vibrato 评估 — 与 OpenUtau UNote.cs:329-350 UVibrato.Evaluate 1:1 对齐
// ============================================================
// 输入：
//   nPos      — 当前位置在 note 内的归一化坐标 [0, 1]
//   nPeriod   — vibrato.period(ms) / note.durationMs，即周期归一到 note 长度
//   note      — 当前 note 的 vibrato 参数 + note.midi（cents 基准）
// 输出：cents（绝对，含 note.midi*100 基准）

function evaluateVibrato(nPos, nPeriod, vibrato, noteToneCents) {
  // OpenUtau UVibrato.NormalizedStart = 1 - length/100，length 为 % of note。
  // length=0 时 nStart=1，下面 nPos<nStart 永远成立 → y=0。caller 已用 length<=0 提前跳过。
  const length = vibrato.length / 100
  const nStart = 1 - length
  const nIn = length * (vibrato.in / 100)
  const nInPos = nStart + nIn
  const nOut = length * (vibrato.out / 100)
  const nOutPos = 1 - nOut

  const t = (nPos - nStart) / nPeriod + (vibrato.shift / 100)
  let y = Math.sin(2 * Math.PI * t) * vibrato.depth + (vibrato.depth / 100) * vibrato.drift

  if (nPos < nStart) {
    y = 0
  } else if (nIn > 0 && nPos < nInPos) {
    y *= (nPos - nStart) / nIn
  } else if (nOut > 0 && nPos > nOutPos) {
    y *= (1 - nPos) / nOut
  }

  // OpenUtau:    return new Vector2(..., note.AdjustedTone + y / 100)  (semitone)
  // RenderPhrase 取 .Y * 100 后写入 pitches[] (cents)
  // → 我们直接返回 cents：noteToneCents + y
  return noteToneCents + y
}

// ============================================================
// 单个 note 的 pitch points → 全局 portamento 列表（tick + cents 单位）
// ============================================================
// 与 OpenUtau RenderPhrase.cs:270-307 的循环对应：
//   pitchPoints = note.pitch.data
//     .Select(point => new PitchPoint(
//         timeAxis.MsPosToTickPos(noteStartMs + point.X) - part.position,
//         point.Y * 10 + note.AdjustedTone * 100,
//         point.shape))
// note.tick 是绝对 tick；OpenUtau 减 part.position 得到 part 相对 tick，
// 我们在 webUTAU 里直接用绝对 tick，方便跟 pitchCurve[].tick 对齐。

// OpenUtau UNote.AdjustedTone = tone + tuning / 100  (semitone)
// 我们的等价单位是 cents：midi*100 + tuning
function adjustedToneCents(note) {
  return (note?.midi ?? 60) * 100 + (note?.tuning || 0)
}

function buildPitchPoints(note, axis) {
  const noteStartSec = axis.tickToTime(note.tick)
  const noteToneCents = adjustedToneCents(note)

  const data = Array.isArray(note?.pitch?.data) ? note.pitch.data : []
  const points = data.map((p) => {
    const xMs = Number.isFinite(p?.x) ? p.x : 0
    const yDeci = Number.isFinite(p?.y) ? p.y : 0
    const absSec = noteStartSec + xMs / 1000
    return {
      tick: axis.timeToTick(absSec),
      cents: yDeci * 10 + noteToneCents,        // 0.1 semitone → cents
      shape: normalizeShape(p?.shape),
    }
  })

  if (points.length === 0) {
    // OpenUtau 缺省双锚点：(note.position, tone*100) 和 (note.End, tone*100)
    points.push({ tick: note.tick, cents: noteToneCents, shape: 'io' })
    points.push({ tick: note.tick + note.durationTicks, cents: noteToneCents, shape: 'io' })
  }

  return points
}

// ============================================================
// 单 note 的"基础音高"——OpenUtau 用 note.Prev 处理跨音符叠加，
// 我们传入 prevNote 显式实现。返回 cents。
// ============================================================
// OpenUtau RenderPhrase.cs:298-300:
//   float basePitch = note.Prev != null && x < note.Prev.End
//       ? note.Prev.AdjustedTone * 100
//       : note.AdjustedTone * 100;

function baseToneCents(note, prevNote, tick) {
  if (prevNote && tick < prevNote.tick + prevNote.durationTicks) {
    return adjustedToneCents(prevNote)
  }
  return adjustedToneCents(note)
}

// ============================================================
// Phrase 级合成入口
// ============================================================
// 输入：
//   notes      — 同一 phrase 的 webUTAU notes（绝对 tick / midi / pitch.data{snapFirst,data} / vibrato）
//   tempoData  — 项目 tempoData（用于 ms↔tick 换算）
//   ppq        — 项目 PPQ（默认 480）
// 输出：phrase 范围内的 pitchCurve 段 + pitchDeviation 端点（空数组）+ 元信息

function synthesizePhrasePitchCurve(notes, tempoData, ppq) {
  if (!Array.isArray(notes) || notes.length === 0) return null

  const safePpq = Number.isFinite(ppq) && ppq > 0 ? ppq : 480
  const axis = createTimelineAxis({ tempoData, ppq: safePpq, totalTicks: 0 })

  // 按 tick 升序，方便 prevNote 引用——webUTAU phrase 的 notes 通常已排序，再保险一次
  const sorted = [...notes].sort((a, b) => (a.tick || 0) - (b.tick || 0))

  // OpenUtau 用 pitchStart = position - part.position - leading；leading 是 phoneme 前导。
  // 我们这边没有 phoneme leading 概念，pitchStart 直接对齐第一个 note 起始的 5 tick 网格。
  const firstNote = sorted[0]
  const lastNote = sorted[sorted.length - 1]
  const startTick = Math.floor((firstNote.tick || 0) / PITCH_STEP_TICK) * PITCH_STEP_TICK
  const endTick = Math.ceil(((lastNote.tick || 0) + (lastNote.durationTicks || 0)) / PITCH_STEP_TICK) * PITCH_STEP_TICK
  const sampleCount = Math.max(1, (endTick - startTick) / PITCH_STEP_TICK + 1)

  // 1) 初始填平 — pitches[i] = noteAt(i).AdjustedTone * 100 cents
  // 与 RenderPhrase.cs:243-253 对齐：每个 note 范围内填该 note 的 tone，后续未覆盖位置沿用上一个值。
  const pitches = new Float32Array(sampleCount)
  let index = 0
  for (const note of sorted) {
    const tc = adjustedToneCents(note)
    while (index < sampleCount && startTick + index * PITCH_STEP_TICK < note.tick + note.durationTicks) {
      pitches[index] = tc
      index += 1
    }
  }
  // 尾部空位用最后一个值填充（防御极端情况：lastNote 不到 endTick）
  let fillStart = Math.max(1, index)
  for (let i = fillStart; i < sampleCount; i++) {
    pitches[i] = pitches[i - 1]
  }
  // 头部空位（第一个 note 前的 leading 区）OpenUtau 默认填 firstNote.AdjustedTone*100：
  if (sorted.length > 0 && firstNote.tick > startTick) {
    const headSamples = Math.ceil((firstNote.tick - startTick) / PITCH_STEP_TICK)
    const fillVal = adjustedToneCents(firstNote)
    for (let i = 0; i < headSamples && i < sampleCount; i++) {
      if (pitches[i] === 0) pitches[i] = fillVal
    }
  }

  // 2) Vibrato 覆盖 — UVibrato.Evaluate(nPos, nPeriod) 写入 pitches[i] = y * 100 cents
  // 注意 OpenUtau 用 nPeriod = vibrato.period(ms) / noteDurationMs。
  for (const note of sorted) {
    const v = note.vibrato
    if (!v || !(v.length > 0)) continue
    const noteStartTick = note.tick
    const noteEndTick = note.tick + note.durationTicks
    const startIndex = Math.max(0, Math.ceil((noteStartTick - startTick) / PITCH_STEP_TICK))
    const endIndex = Math.min(sampleCount, Math.floor((noteEndTick - startTick) / PITCH_STEP_TICK))
    const noteStartSec = axis.tickToTime(noteStartTick)
    const noteEndSec = axis.tickToTime(noteEndTick)
    const noteDurationMs = Math.max(EP, (noteEndSec - noteStartSec) * 1000)
    const nPeriod = (v.period || 0) / noteDurationMs
    const toneCents = adjustedToneCents(note)
    if (!(nPeriod > 0)) continue
    for (let i = startIndex; i < endIndex; i++) {
      const tickAt = startTick + i * PITCH_STEP_TICK
      const nPos = (tickAt - noteStartTick) / Math.max(1, note.durationTicks)
      pitches[i] = evaluateVibrato(nPos, nPeriod, v, toneCents)
    }
  }

  // 3) Pitch points portamento 偏差叠加 — InterpolateShape(prevPoint, point, x, shape)
  // 与 RenderPhrase.cs:269-307 对齐，关键在两个细节：
  //   a) 每个 note 的 pitch.data 转成绝对 tick 锚点；首尾分别延伸到 note.tick / note.End
  //   b) basePitch 在 (prevNote.End 前) 用 prevNote.tone*100，否则用 currentNote.tone*100
  //      所以同一个 portamento 跨 note 边界时，pitches[index] += (interp - basePitch) 自动处理"接缝"
  for (let n = 0; n < sorted.length; n++) {
    const note = sorted[n]
    const prevNote = n > 0 ? sorted[n - 1] : null
    const points = buildPitchPoints(note, axis)

    // 首尾延伸——RenderPhrase.cs:284-291
    if (n === 0 && points[0].tick > startTick) {
      points.unshift({ tick: startTick, cents: points[0].cents, shape: points[0].shape })
    } else if (points[0].tick > note.tick) {
      points.unshift({ tick: note.tick, cents: points[0].cents, shape: points[0].shape })
    }
    const noteEndTick = note.tick + note.durationTicks
    const last = points[points.length - 1]
    if (last.tick < noteEndTick) {
      points.push({ tick: noteEndTick, cents: last.cents, shape: last.shape })
    }

    let lastPoint = points[0]
    let sampleIdx = Math.max(0, Math.floor((lastPoint.tick - startTick) / PITCH_STEP_TICK))
    for (let p = 1; p < points.length; p++) {
      const point = points[p]
      let x = startTick + sampleIdx * PITCH_STEP_TICK
      while (x < point.tick && sampleIdx < sampleCount) {
        const interpCents = interpolateShape(
          lastPoint.tick, point.tick,
          lastPoint.cents, point.cents,
          x, lastPoint.shape,
        )
        const basePitch = baseToneCents(note, prevNote, x)
        pitches[sampleIdx] += interpCents - basePitch
        sampleIdx += 1
        x += PITCH_STEP_TICK
      }
      lastPoint = point
    }
  }

  // 转 webUTAU 格式：pitchCurve[].pitch = cents / 100，单位半音浮点
  const pitchCurve = new Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    pitchCurve[i] = {
      tick: startTick + i * PITCH_STEP_TICK,
      pitch: pitches[i] / 100,
    }
  }

  return { pitchCurve, startTick, endTick }
}

// ============================================================
// 顶层：把整轨 phrases 合成成一份 voiceSnapshot 用的 pitchData
// ============================================================
// 输入：
//   phrases    — webUTAU sourcePhrases 形式（每个 phrase.notes 含绝对 tick）
//   tempoData  — 项目 tempoData
//   ppq        — 项目 PPQ
// 输出：
//   { pitchCurve: [{tick,pitch}], pitchDeviation: {xs:[],ys:[]}, midiPpq, pitchStepTick }
// 设计取舍：
//   - 多个 phrase 的曲线段按 tick 拼接成一份大 pitchCurve（与后端 AI 输出语义一致——
//     PianoRollNotes._drawPitchPath 内已经按 phrase 范围过滤渲染）。
//   - pitchDeviation 留空——OpenUtau 没有等价数据，AI 的 deviation 是经过模型推断的产物。
//   - 合成结果是 OpenUtau 的"机械"曲线，而非 AI 拟合曲线；用户后续可重渲获得 AI 版。

export function synthesizePitchDataFromUstxPhrases(phrases, tempoData, ppq = 480) {
  if (!Array.isArray(phrases) || phrases.length === 0) return null

  const segments = []
  for (const phrase of phrases) {
    const notes = Array.isArray(phrase?.notes) ? phrase.notes : []
    const seg = synthesizePhrasePitchCurve(notes, tempoData, ppq)
    if (seg && seg.pitchCurve.length > 0) segments.push(seg)
  }
  if (segments.length === 0) return null

  // 多 phrase 拼接：按 tick 升序合并，去重（同 tick 取后者）
  const merged = []
  const seen = new Map()
  for (const seg of segments) {
    for (const pt of seg.pitchCurve) {
      seen.set(pt.tick, pt.pitch)
    }
  }
  for (const [tick, pitch] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    merged.push({ tick, pitch })
  }

  return {
    pitchCurve: merged,
    pitchDeviation: { xs: [], ys: [] },
    midiPpq: Number.isFinite(ppq) && ppq > 0 ? Math.round(ppq) : 480,
    pitchStepTick: PITCH_STEP_TICK,
  }
}

// ============================================================
// 包装：合成完整 voiceSnapshot（用于 ustx-import）
// ============================================================
// 设计：合成出来的 voiceSnapshot 跟 .webutau 工程文件持久化的形状一致，
// 让上游 createTrackDocument 后能直接 patch 进去（prepState=ready，立即可播）。
// renderManifest / encodedMidi 等"会话级"字段留 null——webUTAU 自己加载时会
// 按需重建（vocalManifestController 会在轨道挂入后填充）。

export function buildSynthesizedVoiceSnapshot({ phrases, tempoData, ppq, trackName, languageCode }) {
  const pitchData = synthesizePitchDataFromUstxPhrases(phrases, tempoData, ppq)
  if (!pitchData) return null

  return {
    trackId: null,                  // setProject 时按 createTrackDocument 的 id 决定
    trackIndex: null,
    trackName: trackName || '',
    languageCode: languageCode || null,
    jobId: null,                    // 没经过后端任务，留空
    tempoData: tempoData || null,
    bpm: tempoData?.tempos?.[0]?.bpm || 120,
    phraseCount: phrases.length,
    noteCount: phrases.reduce((s, p) => s + (p?.notes?.length || 0), 0),
    duration: 0,                    // applyProjectTiming 后端会重算
    previewNotes: [],               // 不重复存
    phrases: [],                    // 不重复存（store 自己有 sourcePhrases）
    pitchData,
    encodedMidi: null,
    renderManifest: null,
  }
}
