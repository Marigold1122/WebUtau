// ============================================================
// USTX / UST ↔ webUTAU 字段映射字典 & 数据格式规范
// ============================================================
// 职责：
//   1. 定义三种格式（webUTAU JS / USTX YAML / UST INI）之间的
//      精确字段映射，标注需要特殊处理的字段
//   2. 定义 Null 语义对齐策略
//   3. 定义影子数据机制（Shadow Data），保证无损 Round-trip
//   4. 提供字段转换的常量表和工具函数
//
// 命名约定：
//   webUTAU 内部: camelCase（JS 惯例）
//   USTX YAML:     snake_case（OpenUtau YamlDotNet 序列化惯例）
//   UST:           PascalCase（UTAU ini 惯例）
// ============================================================

// ============================================================
// SECTION 0: USTX 版本常量
// ============================================================

/** 导出的 USTX 文件版本号 */
export const USTX_VERSION = '0.6'

/** UST 文件版本头 */
export const UST_VERSION_HEADER = 'UST Version 1.20'

// ============================================================
// SECTION 1: Note 级别字段映射
// ============================================================

/**
 * Note 字段映射表
 *
 * 每个条目:
 *   wb: webUTAU JS key
 *   ux: USTX YAML key
 *   us: UST ini key
 *   tx: 转换说明 ( '=' 直接映射, 其他为函数名 )
 *   note: 特殊说明（null = 无特殊处理）
 *
 * 特别注意:
 *   - USTX UNote.position 是相对于所在 UVoicePart.position 的 tick 偏移量
 *   - webUTAU note.tick 是绝对 tick
 *   - 转换时需要在 Import/Export 层做加减法，见 convertNotePosition()
 */
export const NOTE_FIELD_MAP = Object.freeze({
  // ── 核心定位 ──
  tick: {
    wb: 'tick',
    ux: 'position',
    us: null,                // UST 没有独立的 position，由 [#NNNN] 序号隐含
    tx: '=',
    note: 'USTX: 相对于 UVoicePart.position 的偏移量。webUTAU: 绝对 tick。需在 part 边界做加减。',
  },
  durationTicks: {
    wb: 'durationTicks',
    ux: 'duration',
    us: 'Length',
    tx: '=',
    note: 'USTX duration 最小值 10 ticks（Validate 时 clamp）；webUTAU 最小值 1 tick。导出时不做 clamp，由接收方自行处理。',
  },

  // ── 音高 ──
  midi: {
    wb: 'midi',
    ux: 'tone',
    us: 'NoteNum',
    tx: '=',
    note: '0–127 MIDI note number。三者语义完全一致。',
  },

  // ── 歌词 ──
  lyric: {
    wb: 'lyric',
    ux: 'lyric',
    us: 'Lyric',
    tx: '=',
    note: "webUTAU 默认值 'a'；USTX 默认值 NotePresets.Default.DefaultLyric（'a'）；UST 为任意非换行字符串。",
  },

  // ── 音高微调 ──
  tuning: {
    wb: 'tuning',
    ux: 'tuning',
    us: 'Modulation',
    tx: '=',
    note: '单位: cents（百分之一半音程）。三者语义与单位完全一致。',
  },

  // ── 力度 / 音量（需要特殊处理） ──
  velocity: {
    wb: 'velocity',
    ux: null,                // USTX UNote 没有 per-note velocity
    us: 'Intensity',
    tx: 'velocity',
    note: '【孤儿字段-USTX方向】webUTAU velocity (0–1) → USTX 需映射为 VEL 表达式 (per-phoneme, 0–200)。见 convertVelocityToExpression()。反向导入时从 VEL 表达式还原。',
  },

  // ── 时间（派生字段） ──
  time: {
    wb: 'time',
    ux: null,                // USTX 由 position+tempo 计算 (PositionMs)
    us: null,                // UST 由 Length/480 * 60/BPM 计算
    tx: 'derived',
    note: '派生字段，不参与序列化。由 tick + tempo map 实时计算。导入 USTX/UST 后通过 timelineAxis.tickToTime() 重新推导。',
  },
  duration: {
    wb: 'duration',
    ux: null,
    us: null,
    tx: 'derived',
    note: '派生字段，同 time。',
  },
})

// ============================================================
// SECTION 2: Pitch / PitchPoint 字段映射
// ============================================================

/**
 * Pitch 对象字段映射
 *
 * 双方都存在 snapFirst + data[] 结构，且 data 数组元素均为 {x, y, shape}。
 * 唯一差异: USTX YAML 写为 snake_case: snap_first
 */
export const PITCH_FIELD_MAP = Object.freeze({
  snapFirst: {
    wb: 'snapFirst',
    ux: 'snap_first',
    us: null,                // UST 无此概念，PBS 的 time 参数近似
    tx: 'bool',
    note: 'webUTAU: snapFirst !== false → true（默认 true）。USTX: bool snapFirst（默认 true）。导出: 仅当 false 时写入，true 省略以减小体积。',
  },
  data: {
    wb: 'data',
    ux: 'data',
    us: null,                // UST 使用 PBW/PBY/PBS/PBM 组合或 Pitches 数组
    tx: '=',
    note: 'PitchPoint 数组。两者字段名相同（data），UTAU 的 UPitch.data 直接对应。',
  },
})

/**
 * PitchPoint 元素字段映射
 *
 * 【关键对齐】shape 枚举双方完全一致，无需转换：
 *   OpenUtau C# PitchPointShape: io, l, i, o
 *   webUTAU normalizePitchShape():  io, l, i, o
 */
export const PITCH_POINT_FIELD_MAP = Object.freeze({
  x: {
    wb: 'x',
    ux: 'x',
    us: null,                // UST Mode2: PBW 数组中的间隔值
    tx: '=',
    note: '单位: 毫秒（ms），相对于 note 起始位置。webUTAU 与 USTX 完全一致。',
  },
  y: {
    wb: 'y',
    ux: 'y',
    us: null,                // UST Mode2: PBY 数组中的值
    tx: '=',
    note: '单位: 0.1 semitones（decicents）。注意: 1 semitone = 100 cents = 10 decicents。UST Mode2 PBY 单位也是 10 cents，完全一致。',
  },
  shape: {
    wb: 'shape',
    ux: 'shape',
    us: null,                // UST Mode2: PBM 数组
    tx: 'shape',
    note: 'webUTAU & USTX: "io"|"l"|"i"|"o"。UST Mode2 PBM: " "|"s"|"r"|"j"。UST 方向需要映射（见 shape-map.js）。',
  },
})

// ============================================================
// SECTION 3: Vibrato 字段映射
// ============================================================

/**
 * Vibrato 字段映射
 *
 * 【关键对齐】webUTAU 与 OpenUtau UVibrato 的 8 个字段语义与取值范围完全一致：
 *   - webUTAU createVibratoDocument(): { length, period, depth, in, out, shift, drift, volLink }
 *   - OpenUtau UVibrato:             { length, period, depth, in, out, shift, drift, volLink }
 *   - UST VBR:                       length,period,depth,in,out,shift,height,unused
 *
 * 差异仅在命名风格：
 *   USTX YAML: vol_link（蛇形命名）
 *   webUTAU:   volLink（驼峰命名）
 *   UST VBR:   height（第 7 位 = USTX/webutau 的 drift）
 */
export const VIBRATO_FIELD_MAP = Object.freeze({
  length:  { wb: 'length',  ux: 'length',  us_vbr_index: 0, tx: 'vibrato', unit: '% of note',         range: [0, 100] },
  period:  { wb: 'period',  ux: 'period',  us_vbr_index: 1, tx: '=',       unit: 'ms',              range: [5, 500] },
  depth:   { wb: 'depth',   ux: 'depth',   us_vbr_index: 2, tx: '=',       unit: 'cents',           range: [5, 200] },
  in:      { wb: 'in',      ux: 'in',      us_vbr_index: 3, tx: '=',       unit: '% of vibrato',    range: [0, 100], note: '与 out 互锁: in ≤ 100 − out' },
  out:     { wb: 'out',     ux: 'out',     us_vbr_index: 4, tx: '=',       unit: '% of vibrato',    range: [0, 100], note: '与 in 互锁: out ≤ 100 − in' },
  shift:   { wb: 'shift',   ux: 'shift',   us_vbr_index: 5, tx: '=',       unit: '% of period',     range: [0, 100] },
  drift:   { wb: 'drift',   ux: 'drift',   us_vbr_index: 6, tx: '=',       unit: 'cents',           range: [-100, 100], note: 'UST VBR 字段名 height' },
  volLink: { wb: 'volLink', ux: 'vol_link',us_vbr_index: null, tx: '=',    unit: 'percent',         range: [-100, 100], note: 'UST VBR 第 8 位为保留未使用字段' },
})

// ============================================================
// SECTION 4: Track 级别字段映射
// ============================================================

/**
 * Track 字段映射
 *
 * webUTAU Track 与 USTX UTrack + UVoicePart 的关系：
 *   - UTrack: 轨道的全局属性（singer, phonemizer, mute, solo, volume, pan）
 *   - UVoicePart: 音符容器（name, position, notes[], curves[]）
 *   - webUTAU Track: 平铺以上两者到单一 track 对象
 *   - 导出: webUTAU phrase[] → UVoicePart[]
 *   - 导入: UVoicePart[] + UTrack → webUTAU track.sourcePhrases[]
 */
export const TRACK_FIELD_MAP = Object.freeze({
  // ── 基础标识 ──
  name: {
    wb: 'name',
    ux_track: 'track_name',
    us: null,
    tx: '=',
    note: 'webUTAU: track.name。USTX: UTrack.TrackName（默认 "New Track"）。',
  },
  midiTrackIndex: {
    wb: 'midiTrackIndex',
    ux_track: 'track_no',
    us: null,
    tx: '=',
    note: 'webUTAU: 0-indexed。USTX: track_no 全局唯一编号。导入时按 track_no 排序重建 index。',
  },

  // ── 声库与语言 ──
  singerId: {
    wb: 'singerId',
    ux_track: 'singer',
    us: 'VoiceDir',          // UST [#SETTING] 中的全局声库路径
    tx: '=',
    note: 'webUTAU 当前 singerId 通常为 null（声库在后端管理）。导入 USTX 时保留 singer 字符串到 track._extensions。',
  },
  languageCode: {
    wb: 'languageCode',
    ux_track: 'phonemizer',
    us: null,
    tx: 'weak',
    note: '【弱映射】webUTAU languageCode 仅用于 UI 语言选择（ZH/JA）。USTX phonemizer 是完整类名（如 "OpenUtau.Plugin.Builtin.JapanesePhonemizer"）。导出: languageCode → 映射为已知 phonemizer；导入: phonemizer → 推断 languageCode。不可逆。',
  },

  // ── 播放控制 ──
  mute: {
    wb: 'playbackState.mute',
    ux_track: 'mute',
    us: null,
    tx: '=',
    note: '布尔值，直接映射。',
  },
  solo: {
    wb: 'playbackState.solo',
    ux_track: 'solo',
    us: null,
    tx: '=',
    note: '布尔值，直接映射。',
  },
  volume: {
    wb: 'playbackState.volume',
    ux_track: 'volume',
    us: null,
    tx: 'weak',
    note: '【单位可能不一致】webUTAU: 0–1 线性增益（DEFAULT_TRACK_VOLUME = 0.5）。USTX UTrack.Volume: double（含义依赖渲染器，通常为 dB）。导出映射为近似 dB，导入映射为近似 0–1。不可完美逆。',
  },

  // ── 轨道颜色 ──
  color: {
    wb: 'color',
    ux_track: 'track_color',
    us: null,
    tx: '=',
    note: '#RRGGBB 字符串。USTX 默认 "Blue"。',
  },
})

// ============================================================
// SECTION 5: Project 级别字段映射
// ============================================================

/**
 * Project / Song 级别的全局字段
 */
export const PROJECT_FIELD_MAP = Object.freeze({
  fileName: {
    wb: 'fileName',
    ux: 'name',
    us: null,
    tx: '=',
    note: 'USTX: project.name（默认 "New Project"）。webUTAU: project.fileName。',
  },
  ppq: {
    wb: 'ppq',
    ux: null,                // USTX 固定 480（resolution 属性，不序列化）
    us: null,                // UST 固定 480
    tx: '=',
    note: 'webUTAU 从 MIDI 继承 ppq（通常 480）。USTX 及 UST 均硬编码 480 ticks/quarter。如果 webUTAU ppq ≠ 480，导入导出时需做 tick 缩放。',
  },
})

// ============================================================
// SECTION 6: Tempo / TimeSignature 字段映射
// ============================================================

export const TEMPO_FIELD_MAP = Object.freeze({
  bpm:    { wb: 'bpm',      ux: 'bpm',     us: 'Tempo',   tx: '=', note: '三者语义完全一致，单位 BPM' },
  ticks:  { wb: 'ticks',    ux: 'position',us: null,       tx: '=', note: 'USTX UTempo.position。webUTAU tempo tick 为绝对 tick。' },
  time:   { wb: 'time',     ux: null,      us: null,       tx: 'derived', note: 'webUTAU 的 time 为秒，由 tick 计算。USTX 无此字段。' },
})

export const TIME_SIGNATURE_FIELD_MAP = Object.freeze({
  timeSignature: {
    wb: 'timeSignature',
    ux: ['beat_per_bar', 'beat_unit'],
    us: null,
    tx: 'timesig',
    note: 'webUTAU: [numerator, denominator] 数组。USTX: beatPerBar + beatUnit 分开的两个字段。',
  },
  ticks: {
    wb: 'ticks',
    ux: 'bar_position',
    us: null,
    tx: '=',
    note: 'USTX UTimeSignature.barPosition。webUTAU timeSignature.ticks 为绝对 tick。',
  },
})

// ============================================================
// SECTION 7: 孤儿字段（Orphan Fields）
// ============================================================

/**
 * 仅在 webUTAU 中存在，USTX/UST 无对应字段
 * 导出策略: 存入影子数据扩展槽，或直接丢弃（标记 discard）
 */
export const WEBUTAU_ORPHAN_FIELDS = Object.freeze({
  // ── Note 级别 ──
  'note.velocity': {
    category: 'note',
    ustxFate: 'convert-to-VEL-expression',
    ustFate: 'convert-to-Intensity',
    note: 'per-note velocity (0–1) → USTX VEL phoneme expression (0–200) → UST Intensity',
    lossiness: 'reversible',  // 如果只有单个 phoneme，可逆；多 phoneme 时丢失粒度
  },

  // ── Track 级别 ──
  'track.playbackState.guitarTone': {
    category: 'track',
    ustxFate: '_extensions.webutau_guitar_tone',
    ustFate: 'discard',
    note: 'webUTAU Amp Sim 吉他音色配置。USTX/UST 无此概念，通过扩展槽保留。',
    lossiness: 'preserved-in-ustx',
  },
  'track.playbackState.reverb': {
    category: 'track',
    ustxFate: '_extensions.webutau_reverb',
    ustFate: 'discard',
    note: 'webUTAU 轨道级混响配置（engineId, presetId, send, config）。USTX 中可部分映射为自定义表达式。通过扩展槽完整保留。',
    lossiness: 'preserved-in-ustx',
  },
  'track.playbackState.pan': {
    category: 'track',
    ustxFate: 'weak-map-to-UTrack.Pan',
    ustFate: 'discard',
    note: 'webUTAU pan (-1 to 1)。USTX UTrack.Pan 为 double（通常 -100 to 100 linear 或 dB）。单位可能不同。',
    lossiness: 'lossy',
  },
  'track.voiceConversionState': {
    category: 'track',
    ustxFate: '_extensions.webutau_voice_conversion',
    ustFate: 'discard',
    note: 'webUTAU 音色转换（SeedVC）状态。USTX 无此概念。',
    lossiness: 'preserved-in-ustx',
  },
  'track.voiceSnapshot': {
    category: 'track',
    ustxFate: '_meta.webutau_voice_snapshot',
    ustFate: 'discard',
    note: 'webUTAU AI 渲染产物（pitchData.pitchCurve 等密集采样）。OpenUtau 自身的 pitch curve 是渲染时实时计算的、不持久化；webUTAU 把它保存进 _meta 影子槽以实现自身闭环 round-trip，OpenUtau 端忽略。仅当 prepState=ready 且 pitchCurve 非空时写入。',
    lossiness: 'preserved-in-ustx',
  },
  'track.prepState': {
    category: 'track',
    ustxFate: '_meta.webutau_prep_state',
    ustFate: 'discard',
    note: 'webUTAU 音高预测状态机。与 voiceSnapshot 配对：prepState=ready 表示 voiceSnapshot.pitchData 有效。仅持久化 ready 状态，其余 idle/queued/predicting/error 一律不写。',
    lossiness: 'preserved-in-ustx',
  },
  'track.audioClip': {
    category: 'track',
    ustxFate: 'UWavePart',
    ustFate: 'discard',
    note: '音频轨道。USTX 有 UWavePart 对应。但 webUTAU 的 audioClip 结构（assetId+base64内嵌）与 USTX UWavePart（relative_path+file_duration_ms）不同。',
    lossiness: 'lossy',
  },
})

/**
 * 仅在 USTX 中存在，webUTAU 无对应字段
 * 导入策略: 存入 _extensions 影子数据，导出时原样缝合
 */
export const USTX_ORPHAN_FIELDS = Object.freeze({
  // ── Note 级别 ──
  'note.phoneme_expressions': {
    category: 'note',
    importFate: '_extensions.phonemeExpressions',
    note: '每个 phoneme 的表达式（DYN, PITD, VEL, VOL 等）。webUTAU 无音素级概念，整笔记入扩展槽。',
  },
  'note.phoneme_overrides': {
    category: 'note',
    importFate: '_extensions.phonemeOverrides',
    note: '音素级覆写（preutter, overlap, envelope）。webUTAU 无此概念。',
  },
  'note.phoneme_indexes': {
    category: 'note',
    importFate: '_extensions.phonemeIndexes',
    note: '音素在 part.phonemes 列表中的索引数组。',
  },

  // ── Part 级别 ──
  'voice_part.curves': {
    category: 'part',
    importFate: '_extensions.curves',
    note: 'UVoicePart 级别的表达式曲线（xs[], ys[]）。含 PITD, DYN 等。',
  },
  'voice_part.phonemes': {
    category: 'part',
    importFate: '_extensions.phonemes',
    note: 'UVoicePart 级别的音素列表（UPhoneme[]），G2p 结果。',
  },

  // ── Track 级别 ──
  'track.renderer_settings': {
    category: 'track',
    importFate: '_extensions.rendererSettings',
    note: 'UTrack.RendererSettings { renderer, resampler, wavtool }。webUTAU 由后端 DiffSinger 统一管理。',
  },
  'track.track_expressions': {
    category: 'track',
    importFate: '_extensions.trackExpressions',
    note: 'UTrack 级别的自定义表达式描述符。',
  },
  'track.voice_color_names': {
    category: 'track',
    importFate: '_extensions.voiceColorNames',
    note: '声库子库颜色名称列表。',
  },

  // ── Project 级别 ──
  'project.expressions': {
    category: 'project',
    importFate: '_extensions.expressions',
    note: 'UProject 级别的表达式描述符字典 { abbr: UExpressionDescriptor }。',
  },
  'project.comment': {
    category: 'project',
    importFate: '_extensions.comment',
    note: '工程备注字符串。',
  },
  'project.output_dir': {
    category: 'project',
    importFate: '_extensions.outputDir',
    note: '渲染输出目录路径。',
  },
  'project.cache_dir': {
    category: 'project',
    importFate: '_extensions.cacheDir',
    note: '缓存目录路径。',
  },
  'project.key': {
    category: 'project',
    importFate: '_extensions.key',
    note: '工程调性（0=C, 1=C#, ..., 11=B）。webUTAU 从 MIDI keySignatures 管理，与 USTX UProject.key 独立。',
  },
  'project.exp_selectors': {
    category: 'project',
    importFate: '_extensions.expSelectors',
    note: '主/次表达式选择器配置。',
  },
})

/**
 * 仅在 UST 中存在，webUTAU 无对应字段
 */
export const UST_ORPHAN_FIELDS = Object.freeze({
  'note.PreUtterance':  { importFate: '_extensions.preUtterance',  note: '先行发声 (ms)' },
  'note.VoiceOverlap':  { importFate: '_extensions.voiceOverlap',  note: '与前音符重叠 (ms)' },
  'note.StartPoint':    { importFate: '_extensions.startPoint',    note: '原音频偏移 (ms)' },
  'note.Flags':         { importFate: '_extensions.flags',         note: 'UTAU 重采样器 flags 字符串' },
  'note.Label':         { importFate: '_extensions.label',         note: '音符别名/Label' },
  'note.Envelope':      { importFate: '_extensions.envelope',      note: 'UTAU 音量包络字符串' },
  'note.PBType':        { importFate: '_extensions.pbType',        note: 'PitchBend 模式（5=OldData）' },
  'note.PBStart':       { importFate: '_extensions.pbStart',       note: 'PitchBend 起始偏移 (ms)' },
  'note.Pitches':       { importFate: '_extensions.pitches',       note: 'Mode1 PitchBend 密集数组。导入时转换为 pitch.data[]（稀疏点）。' },
  'note.Tempo':         { importFate: 'merge to tempo map',        note: 'Per-note Tempo 需合并入全局 tempo map' },
  'note.@preuttr':      { importFate: '_extensions.atPreuttr',     note: 'UTAU 只读预计算 preutterance' },
  'note.@overlap':      { importFate: '_extensions.atOverlap',     note: 'UTAU 只读预计算 overlap' },
  'note.@stpoint':      { importFate: '_extensions.atStpoint',     note: 'UTAU 只读预计算 start point' },
  'note.@filename':     { importFate: '_extensions.atFilename',    note: 'UTAU 只读原音频文件名' },
  'note.@alias':        { importFate: '_extensions.atAlias',       note: 'UTAU 只读 oto alias' },
  'note.@cache':        { importFate: '_extensions.atCache',       note: 'UTAU 只读缓存路径' },
  'setting.VoiceDir':   { importFate: '_extensions.voiceDir',      note: 'UTAU 全局声库路径' },
  'setting.CacheDir':   { importFate: '_extensions.ustCacheDir',   note: 'UTAU 全局缓存路径' },
})

// ============================================================
// SECTION 8: Null 语义对齐策略
// ============================================================

/**
 * Null 语义差异与处理规则
 *
 * ┌──────────────┬─────────────────────────┬───────────────────────────┐
 * │  字段         │  webUTAU                │  OpenUtau (USTX)          │
 * ├──────────────┼─────────────────────────┼───────────────────────────┤
 * │  pitch       │  null: 用户未设置/未生成  │  总是存在（UNote.Create() │
 * │              │  { snapFirst, data[] }:  │  创建空 UPitch {          │
 * │              │  已设置                  │    snapFirst: true,       │
 * │              │                         │    data: [] }             │
 * ├──────────────┼─────────────────────────┼───────────────────────────┤
 * │  vibrato     │  null: 用户未设置        │  总是存在（UNote.Create() │
 * │              │  { length,... }: 已设置   │  创建 8 字段全默认值）     │
 * ├──────────────┼─────────────────────────┼───────────────────────────┤
 * │  pitch.data  │  []: 空数组（flat pitch）│  [{x:0,y:0,shape:io},     │
 * │              │                         │   {x:start+length,y:0,    │
 * │              │                         │    shape:io}] (默认两点)   │
 * └──────────────┴─────────────────────────┴───────────────────────────┘
 *
 * 导出策略:
 *   - webUTAU pitch === null      → 不写 pitch 到 USTX YAML
 *   - webUTAU vibrato === null    → 不写 vibrato 到 USTX YAML
 *   - webUTAU pitch.data === []   → 写 pitch: { snap_first: true, data: [] }
 *     （与 OpenUtau 的 "空 pitch" 语义一致）
 *
 * 导入策略:
 *   - USTX 无 pitch 字段           → webUTAU pitch = null
 *   - USTX pitch.data 为空且无手动编辑痕迹 → webUTAU pitch = null
 *   - USTX pitch.data 有内容       → webUTAU pitch = createPitchDocument(...)
 *   - USTX vibrato.length === 0   → webUTAU vibrato = null
 *     （0 长度表示 vibrato 禁用，webUTAU 用 null 表示）
 *   - USTX vibrato.length > 0     → webUTAU vibrato = createVibratoDocument(...)
 */

/** 判断 USTX pitch 对象是否等效于 webUTAU 的 null */
export function isUstxPitchEffectivelyNull(pitch) {
  if (!pitch || typeof pitch !== 'object') return true
  // 没有 snap_first 且 data 为空 → 视为空
  const hasSnapFirst = typeof pitch.snap_first === 'boolean'
  const hasData = Array.isArray(pitch.data) && pitch.data.length > 0
  return !hasSnapFirst && !hasData
}

/** 判断 USTX vibrato 对象是否等效于 webUTAU 的 null */
export function isUstxVibratoEffectivelyNull(vibrato) {
  if (!vibrato || typeof vibrato !== 'object') return true
  // length 未设置或为 0 → 禁用 → null
  const length = vibrato.length
  return !Number.isFinite(length) || length <= 0
}

// ============================================================
// SECTION 9: 影子数据机制（Shadow Data / Extensions）
// ============================================================

/**
 * 影子数据键名常量
 *
 * 导入 USTX/UST 时，无法映射到 webUTAU 内部模型的字段存入 _extensions。
 * 导出时将这些扩展字段原样缝合回 YAML/INI，实现无损 Round-trip。
 *
 * 层级:
 *   project._extensions   → UProject 级独占字段
 *   track._extensions     → UTrack 级独占字段
 *   note._extensions      → UNote 级独占字段
 *   phrase._extensions    → UVoicePart 级独占字段
 */
export const EXTENSIONS_KEY = '_extensions'

/**
 * USTX YAML 输出时需从 _extensions 缝合到正确层级的映射表
 *
 * 格式: { extensionKey: 'yaml.path.to.field' }
 * 用于告知导出器哪些 _extensions 中的键对应 USTX 的哪个位置
 */
export const EXTENSION_TO_USTX_PATH = Object.freeze({
  // ── Note 级扩展 → UNote ──
  phonemeExpressions: 'note.phoneme_expressions',
  phonemeOverrides: 'note.phoneme_overrides',
  phonemeIndexes: 'note.phoneme_indexes',

  // ── Part 级扩展 → UVoicePart ──
  curves: 'voice_part.curves',
  phonemes: 'voice_part.phonemes',

  // ── Track 级扩展 → UTrack ──
  rendererSettings: 'track.renderer_settings',
  trackExpressions: 'track.track_expressions',
  voiceColorNames: 'track.voice_color_names',
  webutau_guitarTone: 'track._meta.webutau_guitar_tone',
  webutau_reverb: 'track._meta.webutau_reverb',
  webutau_voiceConversion: 'track._meta.webutau_voice_conversion',
  webutau_voiceSnapshot: 'track._meta.webutau_voice_snapshot',
  webutau_prepState: 'track._meta.webutau_prep_state',

  // ── Project 级扩展 → UProject ──
  comment: 'project.comment',
  outputDir: 'project.output_dir',
  cacheDir: 'project.cache_dir',
  expressions: 'project.expressions',
  key: 'project.key',
  expSelectors: 'project.exp_selectors',
})

/**
 * 创建带扩展槽的对象副本
 * 将源对象中不属于 knownKeys 的字段移到 _extensions
 */
export function extractUnknownFields(source, knownKeys) {
  if (!source || typeof source !== 'object') return { value: source, extensions: {} }
  const known = {}
  const extensions = {}
  for (const [key, value] of Object.entries(source)) {
    if (knownKeys.has(key)) {
      known[key] = value
    } else {
      extensions[key] = value
    }
  }
  return { value: known, extensions }
}

// ============================================================
// SECTION 10: 工具函数 — 命名转换
// ============================================================

/** 驼峰 → 蛇形: volLink → vol_link */
export function camelToSnakeCase(key) {
  return key.replace(/[A-Z]/g, (match) => '_' + match.toLowerCase())
}

/** 蛇形 → 驼峰: vol_link → volLink */
export function snakeToCamelCase(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

// 预计算的 vibrato key 映射（高频使用，避免重复字符串操作）
export const VIBRATO_CAMEL_TO_SNAKE = Object.freeze({
  length: 'length',
  period: 'period',
  depth: 'depth',
  in: 'in',
  out: 'out',
  shift: 'shift',
  drift: 'drift',
  volLink: 'vol_link',
})

export const VIBRATO_SNAKE_TO_CAMEL = Object.freeze({
  length: 'length',
  period: 'period',
  depth: 'depth',
  in: 'in',
  out: 'out',
  shift: 'shift',
  drift: 'drift',
  vol_link: 'volLink',
})

/** 将 webUTAU vibrato 对象转换为 USTX YAML 用的 snake_case 对象 */
export function toUstxVibrato(vibrato) {
  if (!vibrato || typeof vibrato !== 'object') return null
  return {
    length: vibrato.length,
    period: vibrato.period,
    depth: vibrato.depth,
    in: vibrato.in,
    out: vibrato.out,
    shift: vibrato.shift,
    drift: vibrato.drift,
    vol_link: vibrato.volLink,
  }
}

/** 将 USTX YAML 的 snake_case vibrato 对象转换为 webUTAU camelCase */
export function fromUstxVibrato(vibrato) {
  if (!vibrato || typeof vibrato !== 'object') return null
  return {
    length: vibrato.length,
    period: vibrato.period,
    depth: vibrato.depth,
    in: vibrato.in,
    out: vibrato.out,
    shift: vibrato.shift,
    drift: vibrato.drift,
    volLink: vibrato.vol_link,
  }
}

// ============================================================
// SECTION 11: voiceSnapshot / prepState 影子持久化
// ============================================================
//
// .webutau v2 工程文件持久化 AI 音高预测产物（voiceSnapshot.pitchData）+ prepState；
// USTX 没有对应字段，通过 _meta.webutau_voice_snapshot / _meta.webutau_prep_state
// 影子槽实现 webUTAU 端的闭环 round-trip。OpenUtau 解析 USTX 时 _meta 字段会被忽略，
// 不影响互通。
//
// 序列化策略与 host/project/projectFile.js#pruneVoiceSnapshot 对齐：
//   - 剔除 jobId / renderManifest（含 server-side 任务 ID，跨会话失效）
//   - 仅当 prepState='ready' 且 pitchData.pitchCurve 非空时才写
//   - prepState 写入时收敛到 { status: 'ready', progress: 100, error: null }，
//     不持久化 queued/predicting/error 等运行时态

/** 把 voiceSnapshot 剔成"可跨会话持久化"的子集；返回 null 表示不值得保存。 */
export function pruneVoiceSnapshotForUstx(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  // 先剥掉无法 YAML 序列化的字段（File / Blob 类），structuredClone 能拷它们，
  // 但 js-yaml.dump 会变成 {} 或抛 toJSON-related 错。手动构造纯 POJO 子集才稳。
  const pitchData = snapshot.pitchData
  if (!pitchData?.pitchCurve?.length) return null
  return {
    trackName: typeof snapshot.trackName === 'string' ? snapshot.trackName : '',
    trackIndex: Number.isFinite(snapshot.trackIndex) ? snapshot.trackIndex : null,
    languageCode: typeof snapshot.languageCode === 'string' ? snapshot.languageCode : null,
    bpm: Number.isFinite(snapshot.bpm) ? snapshot.bpm : null,
    tempoData: snapshot.tempoData ? structuredClone(snapshot.tempoData) : null,
    phraseCount: Number.isFinite(snapshot.phraseCount) ? snapshot.phraseCount : null,
    noteCount: Number.isFinite(snapshot.noteCount) ? snapshot.noteCount : null,
    duration: Number.isFinite(snapshot.duration) ? snapshot.duration : 0,
    pitchData: structuredClone(pitchData),
    // 显式不保留：
    //   jobId / renderManifest — server 侧任务引用，跨会话失效
    //   encodedMidi — File 对象，YAML 不能序列化；webUTAU 加载时按需用 phrases+tempoData 重建
    //   previewNotes / phrases — store 里已经有完整 sourcePhrases，重复保存浪费 YAML 体积
  }
}

/** 判断一对 (voiceSnapshot, prepState) 是否值得写入 USTX _meta 影子槽。 */
export function shouldPersistVoiceSnapshotToUstx(track) {
  if (!track || typeof track !== 'object') return false
  if (track.prepState?.status !== 'ready') return false
  return Boolean(track.voiceSnapshot?.pitchData?.pitchCurve?.length)
}

/**
 * 从 USTX _meta.webutau_voice_snapshot / webutau_prep_state 还原 webUTAU 状态。
 * 返回 { voiceSnapshot, prepState }，无效或不完整时返回 { voiceSnapshot: null, prepState: null }。
 * 校验逻辑跟 projectFile.js#normalizeLoadedTracks 一致——prep='ready' 必有 pitchCurve，
 * 否则降级到 idle 并丢掉 voiceSnapshot。
 */
export function restoreVoiceSnapshotFromUstx(meta) {
  if (!meta || typeof meta !== 'object') return { voiceSnapshot: null, prepState: null }
  const rawSnapshot = meta.webutau_voice_snapshot
  const rawPrep = meta.webutau_prep_state
  if (!rawSnapshot || typeof rawSnapshot !== 'object') return { voiceSnapshot: null, prepState: null }
  if (!rawSnapshot.pitchData?.pitchCurve?.length) return { voiceSnapshot: null, prepState: null }
  const prepStatus = typeof rawPrep?.status === 'string' ? rawPrep.status : null
  if (prepStatus !== 'ready') return { voiceSnapshot: null, prepState: null }
  return {
    voiceSnapshot: structuredClone(rawSnapshot),
    prepState: { status: 'ready', progress: 100, error: null },
  }
}
