// 字 ↔ 音分配工具——QuickLyricPanel 的 _handleSave 把"用户输入的字"分配到
// "后端 phrase 切分的 notes"上时用。
//
// 核心数据形态：
//   - mergeFlags: bool[]，长度 = noteCount-1。flag[i]=true 表示 note[i+1] 与 note[i] 是
//     同一个字（拖腔延音），flag[i]=false 表示 note[i+1] 是新字的开始
//   - 字数 = noteCount - sum(mergeFlags)
//
// 没有"句结构"的概念了——句结构由用户在前端 textarea 输入的"官方歌词"行结构提供，
// 跟后端 phrase 切分完全独立

export const PHRASE_DEFAULT_SYLLABLE_LIMIT = 14
export const CONTINUATION_LYRIC = '+' // UTAU / DiffSinger 引擎约定的延音占位

// 默认 mergeFlags：全 false，一字一音
export function defaultMergeFlags(noteCount) {
  if (noteCount <= 1) return []
  return new Array(noteCount - 1).fill(false)
}

// 字数：noteCount 减去合音 flag 的个数（最少 1）
export function countSyllables(noteCount, mergeFlags) {
  if (noteCount <= 0) return 0
  if (!Array.isArray(mergeFlags) || mergeFlags.length === 0) return noteCount
  let merged = 0
  for (let i = 0; i < mergeFlags.length; i++) if (mergeFlags[i]) merged++
  return Math.max(1, noteCount - merged)
}

// 把 snapshot 的 phrases 拍平成一个 note 数组——按全局顺序（与后端 phrase 切分一致）
export function flattenSnapshotNotes(snapshotPhrases) {
  const out = []
  for (const p of (snapshotPhrases || [])) {
    if (!Array.isArray(p?.notes)) continue
    for (const n of p.notes) out.push(n)
  }
  return out
}

// AI 返回 N 个字、本句有 M 个 note（N <= M）。按 mergeFlags 把每个字组的"首音"取真字、
// 后续音取 '+' 延续标记。返回与 notes 等长的字符数组——直接覆盖到 note.lyric 即可
export function distributeLyricsToNotes(lyricChars, notes, mergeFlags) {
  if (!Array.isArray(notes) || notes.length === 0) return []
  if (!Array.isArray(lyricChars) || lyricChars.length === 0) {
    return notes.map(() => 'a')
  }
  const flags = mergeFlags || defaultMergeFlags(notes.length)
  // 计算每个字组的大小（首音 + 多少个延音）
  const groupSizes = []
  let cur = 1
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) cur++
    else { groupSizes.push(cur); cur = 1 }
  }
  groupSizes.push(cur)

  const out = new Array(notes.length).fill('a')
  let noteOffset = 0
  for (let g = 0; g < groupSizes.length; g++) {
    const size = groupSizes[g]
    const ch = lyricChars[g] != null ? String(lyricChars[g]) : 'a'
    out[noteOffset] = ch
    for (let k = 1; k < size; k++) out[noteOffset + k] = CONTINUATION_LYRIC
    noteOffset += size
  }
  return out
}

// 给定 notes 与目标字数 targetCount，自动选 (noteCount - targetCount) 个相邻位置标记为合音。
// 按"score 升序"贪婪选取，score = 相邻两音时长 + 间隔时长——短音 + 小间隔最像装饰音/拖腔，
// 优先合。用于 _handleSave 把 N 字塞到 M 音（N < M）时自动决定哪几个音是延音
export function autoMergeToTargetCount(notes, targetCount) {
  if (!Array.isArray(notes) || notes.length === 0) return []
  if (targetCount >= notes.length) return defaultMergeFlags(notes.length)
  if (targetCount <= 1) return new Array(notes.length - 1).fill(true)
  const flags = defaultMergeFlags(notes.length)
  const candidates = []
  for (let i = 0; i < flags.length; i++) {
    const a = notes[i]
    const b = notes[i + 1]
    const gap = (b?.time ?? 0) - ((a?.time ?? 0) + (a?.duration ?? 0))
    const score = (a?.duration || 0) + (b?.duration || 0) + Math.max(0, gap) * 0.5
    candidates.push({ index: i, score })
  }
  candidates.sort((x, y) => x.score - y.score)
  const toMerge = notes.length - targetCount
  for (let k = 0; k < toMerge; k++) {
    flags[candidates[k].index] = true
  }
  return flags
}
