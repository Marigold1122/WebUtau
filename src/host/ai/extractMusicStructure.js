// 把 voice runtime 的 snapshot（phrases × notes）转成 LLM 可读的"音乐结构描述"。
// 给 LLM 看的不是原始 MIDI——而是经过加工的高层信息：
//   - 总句数 / 总音节数
//   - 每句的音节数 / 节奏指示 / 大致音域
//
// 这一层是纯函数，无副作用，可以脱离浏览器单测

const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToNoteName(midi) {
  if (!Number.isFinite(midi)) return null
  const octave = Math.floor(midi / 12) - 1
  const name = MIDI_NOTE_NAMES[((midi % 12) + 12) % 12]
  return `${name}${octave}`
}

// 总秒数 → "快板/中板/慢板"等粗略节奏标签，给 LLM 一个情绪线索
function estimateTempo(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return '中速'
  if (bpm < 70) return '慢板'
  if (bpm < 95) return '中慢板'
  if (bpm < 120) return '中速'
  if (bpm < 145) return '中快板'
  return '快板'
}

// 每个音符的相对时长（相对该句最短音符）——粗分成"短/中/长"，让 LLM 感受节奏起伏
function classifyDuration(duration, minDuration) {
  if (!Number.isFinite(duration) || duration <= 0) return '短'
  if (!Number.isFinite(minDuration) || minDuration <= 0) return '短'
  const ratio = duration / minDuration
  if (ratio >= 4) return '长'
  if (ratio >= 2) return '中'
  return '短'
}

export function extractMusicStructure(snapshot) {
  const phrases = Array.isArray(snapshot?.phrases) ? snapshot.phrases : []
  const bpm = Number.isFinite(snapshot?.bpm) ? snapshot.bpm : 120

  // 全局聚合
  const allNotes = phrases.flatMap((p) => Array.isArray(p?.notes) ? p.notes : [])
  const totalNotes = allNotes.length
  const phraseCount = phrases.filter((p) => Array.isArray(p?.notes) && p.notes.length > 0).length
  const midiList = allNotes.map((n) => n?.midi).filter(Number.isFinite)
  const minMidi = midiList.length ? Math.min(...midiList) : null
  const maxMidi = midiList.length ? Math.max(...midiList) : null

  // 每句的描述
  const phraseSummaries = phrases
    .filter((p) => Array.isArray(p?.notes) && p.notes.length > 0)
    .map((phrase, index) => {
      const notes = phrase.notes
      const durations = notes.map((n) => n?.duration).filter(Number.isFinite)
      const minDuration = durations.length ? Math.min(...durations) : 0
      const noteMidis = notes.map((n) => n?.midi).filter(Number.isFinite)
      const phraseMin = noteMidis.length ? Math.min(...noteMidis) : null
      const phraseMax = noteMidis.length ? Math.max(...noteMidis) : null

      // 节奏图谱：短-中-长字符序列。LLM 看得懂"♪♪—♪—♩"这种感觉
      const rhythm = notes.map((n) => classifyDuration(n?.duration, minDuration))
      // 当前歌词（如果用户已经写了一部分，AI 知道延续语境）
      const existingLyrics = notes.map((n) => (typeof n?.lyric === 'string' && n.lyric !== 'a') ? n.lyric : '')
      const hasExistingLyrics = existingLyrics.some((s) => s !== '')

      return {
        index: index + 1,
        syllableCount: notes.length,
        rhythm, // ['短', '短', '中', ...]
        pitchLow: phraseMin != null ? midiToNoteName(phraseMin) : null,
        pitchHigh: phraseMax != null ? midiToNoteName(phraseMax) : null,
        existingLyrics: hasExistingLyrics ? existingLyrics : null,
      }
    })

  return {
    totalNotes,
    phraseCount,
    bpm,
    tempoLabel: estimateTempo(bpm),
    pitchLow: minMidi != null ? midiToNoteName(minMidi) : null,
    pitchHigh: maxMidi != null ? midiToNoteName(maxMidi) : null,
    phrases: phraseSummaries,
  }
}

// 把上面的结构对象翻译成"自然语言段落"，给 LLM 当 prompt 用
export function describeMusicForPrompt(structure) {
  if (!structure || !Array.isArray(structure.phrases) || structure.phrases.length === 0) {
    return '（音乐结构为空——请生成 1 句通用开场白歌词，约 8 字）'
  }
  const lines = []
  lines.push(`## 音乐结构概览`)
  lines.push(`- 速度：${structure.tempoLabel}（BPM ${structure.bpm}）`)
  lines.push(`- 共 ${structure.phraseCount} 句，${structure.totalNotes} 个音节`)
  if (structure.pitchLow && structure.pitchHigh) {
    lines.push(`- 整体音域：${structure.pitchLow} ~ ${structure.pitchHigh}`)
  }
  lines.push('')
  lines.push(`## 每句要求（字数硬性约束——可视占位框是几个就必须写几个字）`)
  structure.phrases.forEach((phrase) => {
    // 把字数渲染成"□ □ □ □"——LLM 把每个 □ 替换成一个汉字，视觉上一一对应不易数错
    const slots = '□ '.repeat(phrase.syllableCount).trim()
    // 当 rhythm / pitch 不是真实的逐句数据（如来自官方歌词的占位）时整段省略——
    // 不光省 input token，也避免给 LLM 误导信息（35 句全标"短 短 短"会让 LLM 怀疑结构）
    const rhythmPart = Array.isArray(phrase.rhythm) && phrase.rhythm.length > 0
      ? `节奏「${phrase.rhythm.join(' ')}」`
      : null
    const pitchPart = (phrase.pitchLow && phrase.pitchHigh)
      ? `音域 ${phrase.pitchLow}-${phrase.pitchHigh}`
      : null
    const detail = [rhythmPart, pitchPart].filter(Boolean).join('，')
    let line = `- 第 ${phrase.index} 句：必须正好 ${phrase.syllableCount} 个字 ${slots}`
    if (detail) line += `（${detail}）`
    if (Array.isArray(phrase.existingLyrics)) {
      // 用 _ 占位空字符，让 LLM 知道哪些字已写、哪些要补
      const filled = phrase.existingLyrics.map((s) => s || '_').join(' ')
      line += `，已有歌词「${filled}」（请保留已写的字）`
    }
    lines.push(line)
  })
  // 输出前自检 checklist——逼 LLM 在 JSON 之前先口算一遍字数
  lines.push('')
  lines.push(`## 输出前自检（必做）`)
  lines.push(`在写 JSON 前，请先逐句核对预期字数：`)
  structure.phrases.forEach((phrase) => {
    lines.push(`  - 第 ${phrase.index} 句：${phrase.syllableCount} 字`)
  })
  lines.push(`核对完毕、字数全部对得上，再输出 JSON。任何一句字数错就视为整次失败。`)
  return lines.join('\n')
}
