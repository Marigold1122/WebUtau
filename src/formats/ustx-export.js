// ============================================================
// webUTAU → USTX 导出转换
// ============================================================
// 职责：
//   1. 将 webUTAU Project 状态转换为 USTX 数据结构
//   2. 实现 _extensions 缝合逻辑（影子数据先提取、再覆盖、再缝合）
//   3. 处理 tick 绝对值 → 相对值转换（note.tick − part.position）
//   4. velocity → VEL expression 转换
//   5. Null 语义：webUTAU null → 不写入 YAML
//   6. 序列化为 YAML 字符串
// ============================================================

import yaml from 'js-yaml'
import {
  EXTENSIONS_KEY,
  USTX_VERSION,
  toUstxVibrato,
  WEBUTAU_ORPHAN_FIELDS,
} from './ustx-types.js'
import { normalizeShape } from './shape-map.js'

// ============================================================
// 常量
// ============================================================

const DEFAULT_PPQ = 480
const DEFAULT_BPM = 120
const VELOCITY_USTX_MAX = 200

// ============================================================
// 内部工具
// ============================================================

function asInteger(value, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback
}

function asNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asBoolean(value) {
  return Boolean(value)
}

function clampMidi(value) {
  const midi = asInteger(value, 60)
  return Math.max(0, Math.min(127, midi))
}

/** 深拷贝，用于 _extensions（可能含嵌套对象） */
function clone(obj) {
  if (obj == null) return null
  try {
    return structuredClone(obj)
  } catch {
    // 某些值（如函数）无法 clone，返回原值
    return obj
  }
}

/** 安全获取 _extensions（不修改原对象） */
function getExtensions(obj) {
  if (!obj || typeof obj !== 'object') return {}
  const ext = obj[EXTENSIONS_KEY]
  return (ext && typeof ext === 'object' && !Array.isArray(ext)) ? clone(ext) : {}
}

// ============================================================
// YAML 树安全清洗
// ============================================================

/**
 * 在 js-yaml.dump 之前对 USTX 树进行深度清洗：
 *   1. note.pitch / note.vibrato 若缺失则补全默认空结构（防御性编程）
 *   2. note.phoneme_expressions / note.phoneme_overrides → 空数组兜底
 *   3. 递归移除所有值为 null 或 undefined 的键，防止 YamlDotNet NRE
 */
// 对齐 UProject.CreateNote(): PortamentoStart=-40, PortamentoLength=80, shape=io
// OpenUtau-master Validate() 直接访问 pitch.data[0] 不做 Count>0 守卫，
// 空数组会导致 IndexOutOfRangeException，必须填入双锚点
const DEFAULT_EMPTY_PITCH = Object.freeze({
  snap_first: true,
  data: [
    { x: -40, y: 0, shape: 'io' },
    { x: 40, y: 0, shape: 'io' },
  ],
})
const DEFAULT_EMPTY_VIBRATO = Object.freeze(
  { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 },
)

function sanitizeUstxTree(root) {
  if (!root || typeof root !== 'object') return

  // 清洗所有 voice_parts 下的 notes
  const parts = root.voice_parts
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const notes = part.notes
      if (!Array.isArray(notes)) continue
      for (const note of notes) {
        if (!note || typeof note !== 'object') continue

        // 防御：pitch / vibrato 不存在或为 null 时，补全默认空结构
        if (note.pitch == null || typeof note.pitch !== 'object') {
          note.pitch = { ...DEFAULT_EMPTY_PITCH }
        }
        if (note.vibrato == null || typeof note.vibrato !== 'object') {
          note.vibrato = { ...DEFAULT_EMPTY_VIBRATO }
        }

        // 数组安全兜底
        if (!Array.isArray(note.phoneme_expressions)) {
          note.phoneme_expressions = []
        }
        if (!Array.isArray(note.phoneme_overrides)) {
          note.phoneme_overrides = []
        }
      }
    }
  }

  // 递归移除所有游荡的 null / undefined 值
  stripNullsRecursive(root)
}

function stripNullsRecursive(obj) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const item of obj) {
      stripNullsRecursive(item)
    }
    return
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) {
      delete obj[key]
    } else if (typeof value === 'object') {
      stripNullsRecursive(value)
    }
  }
}

// ============================================================
// 导出入口
// ============================================================

/**
 * 将 webUTAU 项目状态序列化为 USTX YAML 字符串。
 *
 * 缝合逻辑:
 *   1. 从 project/track/note 各级别的 _extensions 提取导入时保留的未知字段
 *   2. 用当前 webUTAU 数据覆盖同名字段（用户编辑后的当前值优先）
 *   3. 未被覆盖的 _extensions 字段原样保留
 *
 * @param {object} projectState - webUTAU 项目状态
 * @param {object} [options]
 * @param {string} [options.projectName] - 覆写项目名
 * @returns {string} USTX YAML 字符串
 */
export function serializeWebUtauToUstx(projectState, options = {}) {
  if (!projectState || typeof projectState !== 'object') {
    throw new Error('serializeWebUtauToUstx: 缺少 projectState')
  }

  const ustx = buildUstxProject(projectState, options)
  sanitizeUstxTree(ustx)

  return yaml.dump(ustx, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    flowLevel: -1,
  })
}

// ============================================================
// Project 级别构建
// ============================================================

function buildUstxProject(state, options) {
  const projectExtensions = getExtensions(state)

  const name = asString(options.projectName || state.fileName, 'New Project')
  const tempos = buildTempos(state.tempoData)
  const timeSignatures = buildTimeSignatures(state.tempoData)

  const tracks = asArray(state.tracks)
  const ustxTracks = []
  const voiceParts = []

  tracks.forEach((track, index) => {
    const trackNo = asInteger(track.midiTrackIndex, index)
    const ustxTrack = buildUstxTrack(track, trackNo)
    ustxTracks.push(ustxTrack)

    // 每个 phrase → 一个 UVoicePart
    // 空 phrase（notes=[]）会让 buildVoicePart 返回 null，必须过滤掉，
    // 否则后续按 part.track_no 重映射时会 NPE
    const phrases = asArray(track.sourcePhrases)
    if (phrases.length > 0) {
      phrases.forEach((phrase, phraseIdx) => {
        const part = buildVoicePart(track, phrase, trackNo, phraseIdx)
        if (part) voiceParts.push(part)
      })
    } else {
      // 没有 phrase 分组 → 用 previewNotes 生成单一 part
      const previewNotes = asArray(track.previewNotes)
      if (previewNotes.length > 0) {
        const part = buildVoicePartFromNotes(track, previewNotes, trackNo, 0)
        if (part) voiceParts.push(part)
      }
    }
  })

  // 轨道重排：将 track_no 重新映射为 0, 1, 2, ... 连续整数，
  // 确保 OpenUtau 用 track_no 做数组索引时不会越界
  const trackNoRemap = new Map()
  ustxTracks.forEach((ustxTrack, newIndex) => {
    trackNoRemap.set(ustxTrack.track_no, newIndex)
    ustxTrack.track_no = newIndex
  })
  voiceParts.forEach((part) => {
    const oldNo = asInteger(part.track_no)
    const newNo = trackNoRemap.get(oldNo)
    if (newNo != null) {
      part.track_no = newNo
    }
  })

  // 项目级扩展缝合：从 _extensions 中拉取项目字段
  // 注意: 扩展槽键名保留原始 USTX YAML 的 snake_case，保证 Round-trip 无损
  const proj = {
    name,
    ustx_version: USTX_VERSION,
    comment: projectExtensions.comment ?? '',
    output_dir: projectExtensions.output_dir ?? 'Vocal',
    cache_dir: projectExtensions.cache_dir ?? 'UCache',
    expressions: projectExtensions.expressions || {},

    tempos: tempos.length > 0 ? tempos : [{ position: 0, bpm: DEFAULT_BPM }],
    time_signatures: timeSignatures.length > 0
      ? timeSignatures
      : [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }],

    tracks: ustxTracks,
    voice_parts: voiceParts,
    wave_parts: [],
  }

  // 缝合项目级孤儿扩展（未被显式覆盖的键）
  sewProjectExtensions(proj, projectExtensions)

  return proj
}

/** 将项目级 _extensions 中未显式处理的键写回 USTX project */
function sewProjectExtensions(proj, extensions) {
  const handledKeys = new Set([
    'comment', 'output_dir', 'cache_dir', 'expressions',
    'exp_selectors', 'key', 'exp_primary', 'exp_secondary',
  ])
  for (const [key, value] of Object.entries(extensions)) {
    if (!handledKeys.has(key)) {
      proj[key] = value
    } else if (key === 'exp_selectors' && Array.isArray(value)) {
      proj.exp_selectors = value
    } else if (key === 'key' && Number.isFinite(value)) {
      proj.key = value
    } else if (key === 'exp_primary' && Number.isFinite(value)) {
      proj.exp_primary = value
    } else if (key === 'exp_secondary' && Number.isFinite(value)) {
      proj.exp_secondary = value
    }
  }
}

// ============================================================
// Track 级别构建
// ============================================================

function buildUstxTrack(track, trackNo) {
  const playbackState = track.playbackState || {}
  const trackExtensions = getExtensions(track)

  const ustxTrack = {
    track_no: trackNo,
    track_name: asString(track.name, `Track ${trackNo + 1}`),
    singer: asString(track.singerId || trackExtensions.singer, ''),
    phonemizer: buildPhonemizer(track.languageCode, trackExtensions),
    mute: asBoolean(playbackState.mute),
    solo: asBoolean(playbackState.solo),
    volume: webutauVolumeToUstx(playbackState.volume),
    pan: asNumber(playbackState.pan),
    renderer_settings: trackExtensions.renderer_settings || {
      renderer: 'WORLDLINE-R',
      resampler: '',
      wavtool: '',
    },
    track_expressions: trackExtensions.track_expressions || [],
    voice_color_names: trackExtensions.voice_color_names || [''],
  }

  // 非孤儿 track 级扩展缝合
  sewTrackExtensions(ustxTrack, trackExtensions, track)

  return ustxTrack
}

/** 将 track 级 _extensions 中未显式处理的键写回 */
function sewTrackExtensions(ustxTrack, extensions, track) {
  const handledKeys = new Set([
    'singer', 'renderer_settings', 'track_expressions', 'voice_color_names',
    'webutau_guitar_tone', 'webutau_reverb', 'webutau_voice_conversion',
  ])
  for (const [key, value] of Object.entries(extensions)) {
    if (handledKeys.has(key)) continue
    if (!(key in ustxTrack)) {
      ustxTrack[key] = value
    }
  }

  // webUTAU 独占字段 → _meta 扩展标签
  if (track.playbackState?.guitarTone) {
    ustxTrack._meta = ustxTrack._meta || {}
    ustxTrack._meta.webutau_guitar_tone = clone(track.playbackState.guitarTone)
  }
  if (track.playbackState?.reverb) {
    ustxTrack._meta = ustxTrack._meta || {}
    ustxTrack._meta.webutau_reverb = clone(track.playbackState.reverb)
  }
  if (extensions.webutau_voice_conversion) {
    ustxTrack._meta = ustxTrack._meta || {}
    ustxTrack._meta.webutau_voice_conversion = extensions.webutau_voice_conversion
  }
}

/**
 * 弱映射：webUTAU languageCode → USTX phonemizer
 * 导出时使用简单的已知映射，非精确但保留信息
 */
function buildPhonemizer(languageCode, extensions) {
  if (extensions.phonemizer) return extensions.phonemizer
  if (languageCode === 'JA') return 'OpenUtau.Core.DefaultPhonemizer'
  if (languageCode === 'ZH') return 'OpenUtau.Core.DefaultPhonemizer'
  return ''
}

// ============================================================
// VoicePart 构建
// ============================================================

function buildVoicePart(track, phrase, trackNo, phraseIdx) {
  const notes = asArray(phrase.notes)
  if (notes.length === 0) return null

  const partExtensions = getExtensions(phrase)
  // 动态计算最小绝对 tick，避免依赖可能过时的缓存 _startTick
  const partPosition = notes.length > 0 ? Math.min(...notes.map(n => asInteger(n.tick))) : 0
  // 显式计算 VoicePart 持续时长（最大 end tick − 最小 start tick）
  const partDuration = notes.length > 0
    ? Math.max(...notes.map(n => asInteger(n.tick) + Math.max(1, asInteger(n.durationTicks, 1)))) - partPosition
    : 0

  const part = {
    name: asString(partExtensions.name, `Part ${phraseIdx + 1}`),
    comment: asString(partExtensions.comment, ''),
    track_no: trackNo,
    position: partPosition,
    duration: partDuration,
    notes: notes.map((note) => buildUstxNote(note, partPosition)),
    // 注入默认 phonemes 桩，打通 note→phoneme 引用链
    phonemes: partExtensions.phonemes || [{ position: 0, phoneme: 'a' }],
    curves: partExtensions.curves || [],
  }

  // 缝合 part 级扩展
  sewPartExtensions(part, partExtensions)

  return part
}

function buildVoicePartFromNotes(track, previewNotes, trackNo, phraseIdx) {
  if (previewNotes.length === 0) return null

  const trackExtensions = getExtensions(track)
  const partPosition = previewNotes.length > 0 ? Math.min(...previewNotes.map(n => asInteger(n.tick))) : 0
  const partDuration = previewNotes.length > 0
    ? Math.max(...previewNotes.map(n => asInteger(n.tick) + Math.max(1, asInteger(n.durationTicks, 1)))) - partPosition
    : 0

  return {
    name: `Part ${phraseIdx + 1}`,
    comment: '',
    track_no: trackNo,
    position: partPosition,
    duration: partDuration,
    notes: previewNotes.map((note) => buildUstxNote(note, partPosition)),
    phonemes: trackExtensions.phonemes || [{ position: 0, phoneme: 'a' }],
    curves: trackExtensions.curves || [],
  }
}

function sewPartExtensions(part, extensions) {
  const handledKeys = new Set(['name', 'comment', 'curves', 'phonemes'])
  for (const [key, value] of Object.entries(extensions)) {
    if (handledKeys.has(key)) continue
    const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
    if (!(snakeKey in part)) {
      part[snakeKey] = value
    }
  }
  if (Array.isArray(extensions.phonemes)) {
    part.phonemes = extensions.phonemes
  }
}

// ============================================================
// Note 级别构建
// ============================================================

/**
 * 将 webUTAU Note 转换为 USTX UNote
 *
 * tick 计算: USTX position = webUTAU tick − partPosition（相对化）
 */
function buildUstxNote(webUtauNote, partPosition) {
  const tick = asInteger(webUtauNote.tick)
  const relativePosition = Math.max(0, tick - partPosition)
  const noteExtensions = getExtensions(webUtauNote)

  const ustxNote = {
    position: relativePosition,
    duration: Math.max(1, asInteger(webUtauNote.durationTicks, 1)),
    tone: clampMidi(webUtauNote.midi),
    lyric: asString(webUtauNote.lyric, 'a'),
    tuning: asInteger(webUtauNote.tuning),
  }

  // pitch: 必须始终存在（OpenUtau UNote.pitch 无默认初始化器，YamlDotNet 反序列化后为 null 会 NRE）
  // 默认值采用双锚点——对齐 UProject.CreateNote() 的 PortamentoStart=-40 / PortamentoLength=80
  ustxNote.pitch = webUtauNote.pitch
    ? {
        snap_first: webUtauNote.pitch.snapFirst !== false,
        data: asArray(webUtauNote.pitch.data).map(buildPitchPoint),
      }
    : { ...DEFAULT_EMPTY_PITCH }

  // vibrato: 必须始终存在，默认值对齐 UVibrato 字段初始化器
  ustxNote.vibrato = webUtauNote.vibrato
    ? toUstxVibrato(webUtauNote.vibrato)
    : { ...DEFAULT_EMPTY_VIBRATO }

  // velocity → VEL expression
  const velExpression = buildVelExpression(webUtauNote.velocity)
  const existingExpressions = noteExtensions.phoneme_expressions || []
  const mergedExpressions = mergePhonemeExpressions(existingExpressions, velExpression)
  ustxNote.phoneme_expressions = mergedExpressions

  // phoneme_overrides: 从扩展槽保留
  ustxNote.phoneme_overrides = noteExtensions.phoneme_overrides || []

  // 注入默认 phoneme_indexes 桩，指向 voice_part.phonemes[0]
  ustxNote.phoneme_indexes = [0]

  // 缝合 note 级扩展（可能覆写 phoneme_indexes 为导入时保留的原始值）
  sewNoteExtensions(ustxNote, noteExtensions)

  return ustxNote
}

function buildPitchPoint(webUtauPoint) {
  return {
    x: asNumber(webUtauPoint?.x),
    y: asNumber(webUtauPoint?.y),
    shape: normalizeShape(webUtauPoint?.shape),
  }
}

// ============================================================
// Velocity → VEL Expression 转换
// ============================================================

/**
 * 将 webUTAU note.velocity (0–1) 转换为单个 VEL phoneme expression
 * @returns {object|null} { abbr: 'vel', index: 0, value: 0–200 }
 */
function buildVelExpression(velocity) {
  if (!Number.isFinite(velocity)) return null
  const velValue = Math.round(Math.max(0, Math.min(1, velocity)) * VELOCITY_USTX_MAX)
  return { abbr: 'vel', index: 0, value: velValue }
}

/**
 * 将 webUTAU velocity 转换的 VEL expression 与 _extensions 中保留的
 * 原有 phonemeExpressions 合并。策略：
 *   - 如果 _extensions 中已有 VEL，用当前值覆盖
 *   - 如果 _extensions 中有其他 expression（DYN, PITD 等），保留
 *   - 确保每个 (index, abbr) 组合唯一
 */
function mergePhonemeExpressions(existingExpressions, velExpression) {
  const result = []
  const seen = new Set()

  // 先加入当前 velocity（包括显式 0：用户把 velocity 拉到 0 时不能被吞掉，
  // 否则 round-trip 会因为缺 VEL 表达式而 fallback 到默认 0.8）
  if (velExpression) {
    result.push(velExpression)
    seen.add(`${velExpression.index}|${velExpression.abbr}`)
  }

  // 保留 _extensions 中的其他表达式（排除 VEL，因为已被当前值覆盖）
  for (const exp of existingExpressions) {
    if (!exp || typeof exp !== 'object') continue
    const key = `${exp.index ?? 0}|${exp.abbr ?? ''}`
    if (!seen.has(key) && exp.abbr !== 'vel') {
      result.push({
        index: asInteger(exp.index, 0),
        abbr: asString(exp.abbr, ''),
        value: asNumber(exp.value, 0),
      })
      seen.add(key)
    }
  }

  return result
}

// ============================================================
// Note 级扩展缝合
// ============================================================

function sewNoteExtensions(ustxNote, extensions) {
  const handledKeys = new Set([
    'phoneme_expressions',
    'phoneme_overrides',
    'phoneme_indexes',
  ])

  if (Array.isArray(extensions.phoneme_indexes) && extensions.phoneme_indexes.length > 0) {
    ustxNote.phoneme_indexes = extensions.phoneme_indexes
  }

  for (const [key, value] of Object.entries(extensions)) {
    if (handledKeys.has(key)) continue
    if (!(key in ustxNote)) {
      ustxNote[key] = value
    }
  }
}

// ============================================================
// Tempo / TimeSignature 构建
// ============================================================

function buildTempos(tempoData) {
  if (!tempoData) return [{ position: 0, bpm: DEFAULT_BPM }]
  const source = asArray(tempoData.tempos)
  if (source.length === 0) return [{ position: 0, bpm: DEFAULT_BPM }]
  return source.map((t) => ({
    position: asInteger(t.ticks),
    bpm: asNumber(t.bpm, DEFAULT_BPM),
  }))
}

function buildTimeSignatures(tempoData) {
  if (!tempoData) return [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }]
  const source = asArray(tempoData.timeSignatures)
  if (source.length === 0) return [{ bar_position: 0, beat_per_bar: 4, beat_unit: 4 }]
  return source.map((ts) => {
    const sig = Array.isArray(ts.timeSignature) ? ts.timeSignature : [4, 4]
    return {
      bar_position: asInteger(ts.ticks),
      beat_per_bar: asInteger(sig[0], 4),
      beat_unit: asInteger(sig[1], 4),
    }
  })
}

// ============================================================
// Volume 单位转换
// ============================================================

/**
 * webUTAU 0-1 线性增益 → USTX 近似 dB
 *
 * 弱映射（不可逆），已记录在 TRACK_FIELD_MAP.volume.note
 */
function webutauVolumeToUstx(volume) {
  if (!Number.isFinite(volume)) return 0
  if (volume <= 0) return -60
  if (volume >= 1) return 6
  // 以 0.5 为 0dB 参考点: dB = 20 * log10(volume / 0.5)
  return Math.round(20 * Math.log10(volume / 0.5) * 100) / 100
}
