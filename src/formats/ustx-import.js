// ============================================================
// USTX → webUTAU 导入转换
// ============================================================
// 职责：
//   1. 解析 USTX YAML 字符串 → USTX 中间对象
//   2. 将 USTX 数据结构转换为 webUTAU 可消费的 Project 对象
//   3. 处理 tick 偏移量累加（part.position + note.position → 绝对 tick）
//   4. 处理 Null 语义（空 pitch/vibrato → null）
//   5. 将无法识别字段存入 _extensions（影子数据机制）
//   6. 从 VEL 表达式中还原 velocity
// ============================================================

import yaml from 'js-yaml'
import {
  EXTENSIONS_KEY,
  USTX_VERSION,
  USTX_ORPHAN_FIELDS,
  isUstxPitchEffectivelyNull,
  isUstxVibratoEffectivelyNull,
  fromUstxVibrato,
  TEMPO_FIELD_MAP,
  TIME_SIGNATURE_FIELD_MAP,
} from './ustx-types.js'
import { normalizeShape } from './shape-map.js'

// ============================================================
// 常量
// ============================================================

const DEFAULT_PPQ = 480
const DEFAULT_BPM = 120
const VELOCITY_USTX_MAX = 200
const VELOCITY_WEBUTAU_MAX = 1

// USTX phoneme 级 VEL expression → webUTAU 0-1 velocity 的转换
function velocityFromUstx(value) {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value / VELOCITY_USTX_MAX))
}

function velocityToWebutau(value) {
  const v = velocityFromUstx(value)
  return v != null ? Math.round(v * 1000) / 1000 : null
}

// ============================================================
// 内部工具
// ============================================================

function asNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function asInteger(value, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback
}

function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function clampMidi(value) {
  const midi = asInteger(value, 60)
  return Math.max(0, Math.min(127, midi))
}

function collectOrphanKeys(category) {
  const keys = new Set()
  for (const [path, def] of Object.entries(USTX_ORPHAN_FIELDS)) {
    if (def.category === category) {
      keys.add(path.split('.').pop())
    }
  }
  return keys
}

/** Note 级别需要在 USTX UNote 对象上识别为"孤儿"的键，导入时移入 _extensions */
const NOTE_ORPHAN_KEYS = collectOrphanKeys('note')
const PART_ORPHAN_KEYS = collectOrphanKeys('part')
const TRACK_ORPHAN_KEYS = collectOrphanKeys('track')
const PROJECT_ORPHAN_KEYS = collectOrphanKeys('project')

/** NOTE_ORPHAN_KEYS 中需要从 note 对象上特殊处理的键（在导入时额外读取） */
const NOTE_ORPHAN_READ_KEYS = new Set([
  'phonemeExpressions',
  'phonemeOverrides',
  'phonemeIndexes',
])

// ============================================================
// 导入入口
// ============================================================

/**
 * 解析 USTX YAML 字符串，转换为 webUTAU 兼容的 Project 对象。
 *
 * 返回值与 ImportProjectService.importFile() 的输出兼容，
 * 可直接传入 createTrackDocument() 构建完整 Track。
 *
 * @param {string} yamlString - USTX 文件的完整 YAML 文本
 * @returns {object} webUTAU 项目对象
 *   { fileName, ppq, tempoData, tracks[...] }
 */
export function parseUstxToWebUtau(yamlString) {
  if (typeof yamlString !== 'string' || !yamlString.trim()) {
    throw new Error('USTX 文件为空')
  }

  const ustx = parseYaml(yamlString)
  validateUstx(ustx)

  return convertProject(ustx)
}

function parseYaml(yamlString) {
  try {
    return yaml.load(yamlString)
  } catch (cause) {
    throw new Error('USTX 文件 YAML 解析失败', { cause })
  }
}

function validateUstx(ustx) {
  if (!ustx || typeof ustx !== 'object') {
    throw new Error('USTX 文件格式异常：根节点不是对象')
  }
  if (typeof ustx.ustx_version !== 'string' || !ustx.ustx_version) {
    throw new Error('USTX 文件缺少 ustx_version 字段')
  }
}

// ============================================================
// Project 级别转换
// ============================================================

function convertProject(ustx) {
  const tracks = asArray(ustx.tracks)
  const voiceParts = asArray(ustx.voice_parts)
  const tempos = asArray(ustx.tempos)
  const timeSignatures = asArray(ustx.time_signatures)

  // 按 track_no 建立 UTrack 索引
  const trackByNo = new Map()
  tracks.forEach((track) => {
    trackByNo.set(asInteger(track.track_no), track)
  })

  // 收集 project 级扩展
  const projectExtensions = {}
  for (const [key, value] of Object.entries(ustx)) {
    if (['tracks', 'voice_parts', 'wave_parts', 'tempos', 'time_signatures', 'name', 'ustx_version'].includes(key)) {
      continue
    }
    projectExtensions[key] = value
  }

  // 转换 webUTAU track 列表
  const webUtauTracks = convertTracks(voiceParts, trackByNo, tempos, timeSignatures)

  return {
    fileName: asString(ustx.name, 'New Project'),
    ppq: DEFAULT_PPQ,
    tempoData: convertTempoData(tempos, timeSignatures),
    tracks: webUtauTracks,
    [EXTENSIONS_KEY]: Object.keys(projectExtensions).length > 0 ? projectExtensions : undefined,
  }
}

// ============================================================
// Track / Part 级别转换
// ============================================================

function convertTracks(voiceParts, trackByNo, tempos, timeSignatures) {
  // voice_parts 已按 trackNo 排序，分组为 per-track 的 parts 列表
  const partsByTrack = new Map()
  voiceParts.forEach((part) => {
    const trackNo = asInteger(part.track_no)
    if (!partsByTrack.has(trackNo)) {
      partsByTrack.set(trackNo, [])
    }
    partsByTrack.get(trackNo).push(part)
  })

  const result = []
  let index = 0

  for (const [trackNo, parts] of partsByTrack) {
    const track = trackByNo.get(trackNo) || {}
    const webUtauTrack = convertTrack(track, parts, trackNo, index, tempos, timeSignatures)
    result.push(webUtauTrack)
    index += 1
  }

  return result
}

function convertTrack(ustxTrack, parts, trackNo, index, tempos, timeSignatures) {
  // 收集 UTrack 级别扩展（保留 USTX YAML 原生 snake_case 键名）
  const trackExtensions = {}
  const knownTrackKeys = new Set([
    'track_no', 'track_name', 'singer', 'phonemizer',
    'mute', 'solo', 'volume', 'pan',
    'track_color', 'voice_color_names',
    'renderer_settings', 'track_expressions',
  ])
  for (const [key, value] of Object.entries(ustxTrack)) {
    if (!knownTrackKeys.has(key)) {
      trackExtensions[key] = value
    }
  }
  // 明确保留孤儿字段（无论是否为空都存，保证 Round-trip 时能写回）
  if (ustxTrack.renderer_settings !== undefined) {
    trackExtensions.renderer_settings = ustxTrack.renderer_settings
  }
  if (ustxTrack.track_expressions !== undefined) {
    trackExtensions.track_expressions = ustxTrack.track_expressions
  }
  if (ustxTrack.voice_color_names !== undefined) {
    trackExtensions.voice_color_names = ustxTrack.voice_color_names
  }

  // 转换所有 part 中的 note
  const allPreviewNotes = []
  const sourcePhrases = []

  parts.forEach((part, partIdx) => {
    const partPosition = asInteger(part.position) // UVoicePart 绝对起始 tick
    const notes = asArray(part.notes)
    const partExtensions = {}

    // UVoicePart 级孤儿字段
    if (Array.isArray(part.curves) && part.curves.length > 0) {
      partExtensions.curves = part.curves
    }
    if (Array.isArray(part.phonemes)) {
      partExtensions.phonemes = part.phonemes
    }
    for (const [key, value] of Object.entries(part)) {
      if (['name', 'comment', 'track_no', 'position', 'notes', 'curves', 'phonemes'].includes(key)) {
        continue
      }
      partExtensions[key] = value
    }

    const convertedNotes = notes.map((ustxNote) =>
      convertNote(ustxNote, partPosition),
    )
    allPreviewNotes.push(...convertedNotes)

    const phrase = buildPhrase(convertedNotes, partIdx, partExtensions)
    sourcePhrases.push(phrase)
  })

  // 从 singer 字段推断语言（弱映射）
  const singer = asString(ustxTrack.singer)
  const phonemizer = asString(ustxTrack.phonemizer)
  const languageCode = inferLanguageCode(singer, phonemizer)

  return {
    index,
    name: asString(ustxTrack.track_name, `Track ${trackNo + 1}`),
    hasLyrics: true, // 从 USTX 导入的 voice part 默认包含歌词
    role: 'vocal',
    contentType: 'midi',
    duration: 0, // 后续由 previewNotes 重新计算
    durationTicks: 0,
    noteCount: allPreviewNotes.length,
    previewNotes: allPreviewNotes,
    sourcePhrases,
    playbackState: {
      assignedSourceId: 'vocal',
      mute: asBoolean(ustxTrack.mute),
      solo: asBoolean(ustxTrack.solo),
      volume: convertTrackVolume(ustxTrack.volume),
      pan: asNumber(ustxTrack.pan),
    },
    color: asString(ustxTrack.track_color, null),
    languageCode,
    singerId: singer || null,
    audioClip: null,
    [EXTENSIONS_KEY]: Object.keys(trackExtensions).length > 0 ? trackExtensions : undefined,
  }
}

/**
 * USTX volume (double, 通常为 dB) → webUTAU 0-1
 *
 * 必须是 webutauVolumeToUstx() 的反函数，否则 round-trip 会丢精度：
 *   导出: gain → 20 * log10(gain / 0.5)   （0.5→0 dB, 1→+6 dB, 0→-60 dB）
 *   导入: dB → 0.5 * 10 ** (dB / 20)
 * clamp 到 [0,1] 兜底 USTX 文件里出现极端 dB 值的情况
 */
function convertTrackVolume(ustxVolume) {
  if (!Number.isFinite(ustxVolume)) return 0.5
  const gain = 0.5 * Math.pow(10, ustxVolume / 20)
  return Math.max(0, Math.min(1, gain))
}

/** 弱映射：从 singer/phonemizer 推断语言代码 */
function inferLanguageCode(singer, phonemizer) {
  const lower = (singer + phonemizer).toLowerCase()
  if (lower.includes('japanese') || lower.includes('jpn') || lower.includes('ja')) return 'JA'
  if (lower.includes('chinese') || lower.includes('mandarin') || lower.includes('zh') || lower.includes('cmn')) return 'ZH'
  return null
}

// ============================================================
// Note 级别转换
// ============================================================

/**
 * 将单个 USTX UNote 转换为 webUTAU Note
 *
 * tick 计算: absoluteTick = partPosition + ustxNote.position
 */
function convertNote(ustxNote, partPosition) {
  const absoluteTick = partPosition + asInteger(ustxNote.position)
  const durationTicks = Math.max(1, asInteger(ustxNote.duration, 1))

  // pitch: null 语义 — 空 pitch 转为 null
  const rawPitch = ustxNote.pitch
  const pitch = isUstxPitchEffectivelyNull(rawPitch)
    ? null
    : convertPitch(rawPitch)

  // vibrato: null 语义 — length=0 转为 null
  const rawVibrato = ustxNote.vibrato
  const vibrato = isUstxVibratoEffectivelyNull(rawVibrato)
    ? null
    : fromUstxVibrato(rawVibrato)

  // velocity: 从 VEL expression 还原
  const velFromUstx = extractVelocityFromExpressions(ustxNote.phoneme_expressions)

  // 收集 note 级别扩展（保留 USTX YAML 原生 snake_case 键名）
  const noteExtensions = {}
  if (Array.isArray(ustxNote.phoneme_expressions)) {
    noteExtensions.phoneme_expressions = ustxNote.phoneme_expressions
  }
  if (Array.isArray(ustxNote.phoneme_overrides)) {
    noteExtensions.phoneme_overrides = ustxNote.phoneme_overrides
  }
  if (Array.isArray(ustxNote.phoneme_indexes)) {
    noteExtensions.phoneme_indexes = ustxNote.phoneme_indexes
  }
  // 收集其他非标准字段
  const knownNoteKeys = new Set([
    'position', 'duration', 'tone', 'lyric', 'tuning',
    'pitch', 'vibrato', 'phoneme_expressions', 'phoneme_overrides', 'phoneme_indexes',
  ])
  for (const [key, value] of Object.entries(ustxNote)) {
    if (!knownNoteKeys.has(key)) {
      noteExtensions[key] = value
    }
  }

  const note = {
    tick: absoluteTick,
    durationTicks,
    midi: clampMidi(ustxNote.tone),
    lyric: asString(ustxNote.lyric, 'a'),
    tuning: asInteger(ustxNote.tuning),
    velocity: velFromUstx != null
      ? velocityToWebutau(velFromUstx)
      : (0.8), // 默认值
  }

  if (pitch) note.pitch = pitch
  if (vibrato) note.vibrato = vibrato
  if (Object.keys(noteExtensions).length > 0) {
    note[EXTENSIONS_KEY] = noteExtensions
  }

  return note
}

/**
 * 从 USTX phoneme_expressions 中提取 VEL 值
 *
 * 策略：取第一个 VEL expression，或所有 VEL 的均值
 */
function extractVelocityFromExpressions(phonemeExpressions) {
  if (!Array.isArray(phonemeExpressions) || phonemeExpressions.length === 0) {
    return null
  }
  const velExpressions = phonemeExpressions.filter(
    (exp) => exp?.abbr === 'vel' && Number.isFinite(exp?.value),
  )
  if (velExpressions.length === 0) return null
  if (velExpressions.length === 1) return velExpressions[0].value
  // 多 phoneme：取平均值
  const sum = velExpressions.reduce((acc, exp) => acc + exp.value, 0)
  return sum / velExpressions.length
}

// ============================================================
// Pitch 转换
// ============================================================

function convertPitch(ustxPitch) {
  const snapFirst = ustxPitch.snap_first !== false // 默认 true
  const data = Array.isArray(ustxPitch.data)
    ? ustxPitch.data.map(convertPitchPoint)
    : []

  // 空 data 且无 snapFirst 显式设置 → null
  if (data.length === 0 && ustxPitch.snap_first == null) {
    return null
  }

  return { snapFirst, data }
}

function convertPitchPoint(ustxPoint) {
  return {
    x: asNumber(ustxPoint?.x),
    y: asNumber(ustxPoint?.y),
    shape: normalizeShape(ustxPoint?.shape),
  }
}

// ============================================================
// Phrase 构建
// ============================================================

function buildPhrase(notes, partIndex, partExtensions) {
  if (notes.length === 0) {
    return {
      index: partIndex,
      startTime: 0,
      endTime: 0,
      notes: [],
    }
  }

  const firstNote = notes[0]
  const lastNote = notes[notes.length - 1]
  const startTick = firstNote.tick
  const endTick = lastNote.tick + lastNote.durationTicks

  // Time 是派生字段，此处置 0（由 ImportProjectService.applyProjectTiming 重新计算）
  const phrase = {
    index: partIndex,
    startTime: 0,
    endTime: 0,
    notes,
    // 保存原始 tick 范围用于后续 time 计算
    _startTick: startTick,
    _endTick: endTick,
  }

  if (partExtensions && Object.keys(partExtensions).length > 0) {
    phrase[EXTENSIONS_KEY] = partExtensions
  }

  return phrase
}

// ============================================================
// Tempo / TimeSignature 转换
// ============================================================

function convertTempoData(tempos, timeSignatures) {
  const hasTempoInfo = tempos.length > 1 // 多于默认 1 条说明有非默认 tempo 变化
  const hasTimeSignatureInfo = timeSignatures.length > 1

  const convertedTempos = tempos.length > 0
    ? tempos.map(convertTempo)
    : [{ bpm: DEFAULT_BPM, time: 0, ticks: 0 }]

  const convertedSignatures = timeSignatures.length > 0
    ? timeSignatures.map(convertTimeSignature)
    : [{ timeSignature: [4, 4], time: 0, ticks: 0 }]

  return {
    tempos: convertedTempos,
    timeSignatures: convertedSignatures,
    keySignatures: [], // USTX key 通过 project.key (0-11) 管理，放入 _extensions 而非 tempoData
    hasTempoInfo,
    hasTimeSignatureInfo,
    hasKeySignatureInfo: false,
  }
}

function convertTempo(ustxTempo) {
  return {
    bpm: asNumber(ustxTempo.bpm, DEFAULT_BPM),
    time: 0, // 后续由 timelineAxis 通过 tick 反算
    ticks: asInteger(ustxTempo.position),
  }
}

function convertTimeSignature(ustxSig) {
  const numerator = asInteger(ustxSig.beat_per_bar, 4)
  const denominator = asInteger(ustxSig.beat_unit, 4)
  return {
    timeSignature: [numerator, denominator],
    time: 0, // 后续反算
    ticks: asInteger(ustxSig.bar_position),
  }
}

// ============================================================
// 通用工具
// ============================================================

function asArray(value) {
  return Array.isArray(value) ? value : []
}
