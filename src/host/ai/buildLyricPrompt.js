// 构造给 LLM 的歌词生成请求。返回 OpenAI 兼容的 messages 数组——
// 适配 DeepSeek / 通义 / GLM / Kimi 等所有支持 chat completions JSON 格式的厂商
import { describeMusicForPrompt } from './extractMusicStructure.js'

const SYSTEM_PROMPT = `你是一位虚拟歌手 DAW 的歌词协作助手。用户会给你一段 MIDI 的音乐结构（句数 / 每句音节数 / 节奏 / 音域）和一个主题，你需要写出契合该音乐结构的中文歌词。

# 第一铁律：字数必须严格匹配
**这是判定成功 / 失败的唯一硬指标**。每句歌词的字数必须等于该句的"音节数"——
多一字、少一字、空一格、加一个标点，都视为整次失败、用户白等。
- 用户消息里每句会显示形如「□ □ □ □ □」的占位框——几个 □ 就写几个字，一一对应替换
- 写完每句立刻在心里数一遍 lyric 数组的长度，对照预期字数，不对就重写
- 宁可主题贴合度差一点也要保字数对——字数错=整次作废，主题略偏=可接受

# 其它要求（在保证字数严格匹配的前提下）
1. 默认中文：1 个汉字 = 1 个音节，标点不写、空格不写、英文不写
2. 韵脚：尽量在句末押韵或接近押韵；古风 / 流行 / 民谣等风格按用户指定调整
3. 节奏感：节奏图谱里"长"位置放语义重音字 / 韵脚字；"短"位置放虚词 / 助词
4. 音域：音域高的句子可以是情绪高潮；音域低的句子适合呢喃 / 低语
5. 内容：贴主题、有画面感、避免空洞口号；流行可口语化，古风用意象（月、风、灯、笛、桥、雨、山等）
6. 如果某句已有部分字（_ 表示空缺），保留已有字、只补 _ 处

# 输出格式
严格输出 JSON：
{
  "phrases": [
    { "index": 1, "lyric": ["字", "字", ...] },
    { "index": 2, "lyric": [...] }
  ]
}

phrases 数组按句序排列；每个 phrase.lyric **必须是字符数组**（不要写成整句字符串），
数组长度必须严格等于该句音节数。不要包含 markdown 代码块标记，直接返回纯 JSON 文本。
**只输出 lyric 字段，不要写 explanation / reason / note 等附加字段**——前端不读这些，
但每多写一个字段都会让生成时间显著变长（长歌词尤其明显）。`

export function buildLyricPrompt({ musicStructure, theme, style = '', extraInstruction = '' }) {
  if (!musicStructure) {
    throw new Error('buildLyricPrompt: musicStructure is required')
  }
  const safeTheme = (typeof theme === 'string' ? theme : '').trim() || '随性创作，自由发挥'
  const styleHint = (typeof style === 'string' ? style : '').trim()

  const userParts = []
  userParts.push(describeMusicForPrompt(musicStructure))
  userParts.push('')
  userParts.push('## 主题 / 情绪')
  userParts.push(safeTheme)
  if (styleHint) {
    userParts.push('')
    userParts.push('## 风格要求')
    userParts.push(styleHint)
  }
  if (extraInstruction && extraInstruction.trim()) {
    userParts.push('')
    userParts.push('## 额外要求')
    userParts.push(extraInstruction.trim())
  }
  userParts.push('')
  userParts.push('请按上述音乐结构生成歌词，输出 JSON。')

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') },
  ]
}

// 让 LLM 把 JSON 写得规整很难——尤其长输出（30+ 句）末尾常出现：
//   - markdown ```代码块（有时还带前缀文本 "好的，下面是…"）
//   - trailing comma：`{...,}` / `[...,]`
//   - 智能引号 / 全角引号
//   - 截断（最后一个 `}` / `]` 缺失）
//   - C-style 注释 `// …` 或 `/* … */`
//   - 整体被包了一层 wrapper：`{"data":{"phrases":…}}` / `{"result":…}`
// 下面按"代价从低到高"逐层兜底；任一层 parse 成功就立刻返回，避免反复跑无谓的 regex
function tryRepairAndParse(rawText) {
  if (typeof rawText !== 'string') return null
  const body = rawText.trim()
  if (!body) return null

  // Layer 0：直接尝试——99% 的成功输出落这里
  try { return JSON.parse(body) } catch (_e) {}

  // Layer 1：剥 markdown 代码块（``` 可能不在开头，前面有寒暄文本）
  const fenceStart = body.indexOf('```')
  if (fenceStart >= 0) {
    let stripped = body.slice(fenceStart).replace(/^```(?:json|JSON)?\s*/i, '')
    const lastFence = stripped.lastIndexOf('```')
    if (lastFence >= 0) stripped = stripped.slice(0, lastFence)
    stripped = stripped.trim()
    if (stripped) {
      try { return JSON.parse(stripped) } catch (_e) {}
    }
  }

  // Layer 2：抽 `{ … }` 子串（用从第一个 { 到最后一个 } 的范围）。LLM 前后
  // 多塞几句话 / 多打几个 fence 都能兜住
  const firstBrace = body.indexOf('{')
  const lastBrace = body.lastIndexOf('}')
  let extracted = null
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    extracted = body.slice(firstBrace, lastBrace + 1)
    try { return JSON.parse(extracted) } catch (_e) {}
  }

  // 后续清洗都基于 extracted（如果有）或原文
  let cleaned = extracted ?? body

  // Layer 3：智能引号 / 全角引号 → ASCII 双引号（JSON 唯一合法的引号）
  cleaned = cleaned
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟＂]/g, '"')
    .replace(/[＇]/g, "'")

  // Layer 4：trailing comma —— `,` 紧跟 `]` 或 `}` 之前（含中间空白 / 换行）
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1')

  // Layer 5：C-style 注释（罕见但 LLM 偶尔加 `// 第 1 句` 之类）
  cleaned = cleaned
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1')
    // 注释行去完可能又产生新的 trailing comma，再扫一次
    .replace(/,(\s*[}\]])/g, '$1')

  try { return JSON.parse(cleaned) } catch (_e) {}

  // Layer 6：截断兜底——尾部缺 `]` 或 `}` 时按已读 phrases 推一个合法尾部
  // 只在能看到 "phrases":[ 但找不到对应右括号时启用，避免误改正常 JSON
  if (/"phrases"\s*:\s*\[/.test(cleaned)) {
    // 从尾部往前找最后一个完整的 phrase 对象（以 `}` 结束），把它之后的不完整
    // 内容截掉，然后补上 `]` 和 `}`。这里只做最朴素的"补足括号"，复杂的悬空
    // 字符串 / 转义不管——再失败就接受 invalid-json，让用户重试
    const phrasesStart = cleaned.search(/"phrases"\s*:\s*\[/)
    const tail = cleaned.slice(phrasesStart)
    // 在 phrases 数组里找到最后一个看起来完整的 `}`（后面只跟空白 / 逗号 / `]`）
    const lastCompleteObj = tail.search(/\}(?=\s*[,\]]|\s*$)(?![\s\S]*\}(?=\s*[,\]]|\s*$))/)
    if (lastCompleteObj > 0) {
      const cut = cleaned.slice(0, phrasesStart + lastCompleteObj + 1) + ']}'
      try { return JSON.parse(cut) } catch (_e) {}
    }
  }

  return null
}

// LLM 返回的 JSON 字符串 → 解析 + 校验出每句的字数对不对
// 严格校验：句数必须匹配，每句字数必须匹配，否则返回 { ok: false, reason }
export function parseLyricResponse(rawText, musicStructure) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, reason: 'empty-response' }
  }
  const parsed = tryRepairAndParse(rawText)
  if (parsed === null) {
    return { ok: false, reason: 'invalid-json', raw: rawText }
  }
  // 容错 wrapper：有些 LLM 把 phrases 套在 data / result / payload 下
  const phrases = Array.isArray(parsed?.phrases) ? parsed.phrases
    : Array.isArray(parsed?.data?.phrases) ? parsed.data.phrases
    : Array.isArray(parsed?.result?.phrases) ? parsed.result.phrases
    : Array.isArray(parsed?.payload?.phrases) ? parsed.payload.phrases
    // 极端情况：直接返回 phrases 数组、没外层 object
    : (Array.isArray(parsed) && parsed[0] && (Array.isArray(parsed[0]?.lyric) || typeof parsed[0]?.lyric === 'string'))
      ? parsed
      : null
  if (!phrases) return { ok: false, reason: 'missing-phrases', raw: rawText }
  const expected = Array.isArray(musicStructure?.phrases) ? musicStructure.phrases : []
  if (phrases.length !== expected.length) {
    return {
      ok: false,
      reason: 'phrase-count-mismatch',
      expected: expected.length,
      actual: phrases.length,
    }
  }
  // 把每句字数核对一遍。LLM 偶尔数错（长输出尤其常见）——这里只收集**所有**
  // 错位句子，让上层（QuickLyricPanel）决定是否触发局部重写。
  // parsedPhrases 保留 LLM 原始 lyric 数组（即使字数错），供 retry 时给 LLM 看
  // "你上次错的是这几句、其余写得不错"，保持上下文连贯
  const parsedPhrases = []
  const corrections = []
  for (let i = 0; i < expected.length; i++) {
    const wantSyllables = expected[i].syllableCount
    const got = phrases[i]
    const lyricArr = Array.isArray(got?.lyric)
      ? got.lyric.map((s) => String(s).trim())
      : (typeof got?.lyric === 'string' ? [...got.lyric.trim()] : null)
    if (!lyricArr) {
      return { ok: false, reason: 'phrase-shape', phraseIndex: i + 1 }
    }
    parsedPhrases.push({
      index: i + 1,
      lyric: lyricArr,
      explanation: typeof got?.explanation === 'string' ? got.explanation : '',
    })
    if (lyricArr.length !== wantSyllables) {
      corrections.push({
        phraseIndex: i + 1,
        expected: wantSyllables,
        actual: lyricArr.length,
      })
    }
  }
  if (corrections.length > 0) {
    const first = corrections[0]
    return {
      ok: false,
      reason: 'syllable-mismatch',
      phraseIndex: first.phraseIndex,
      expected: first.expected,
      actual: first.actual,
      corrections,        // 全部错位句（给上层判断要不要 retry）
      parsedPhrases,      // LLM 原始输出（含错句），保留供 retry 上下文用
    }
  }
  // 拍平成单字数组——与 QuickLyricPanel._handleSave 里 charIndex 流程对齐
  const flatChars = parsedPhrases.flatMap((p) => p.lyric)
  return { ok: true, phrases: parsedPhrases, flatChars }
}

// 局部重写的 prompt：只让 LLM 重写错位的那几句，但同时给它看完整上下文
// 保持连贯。badCorrections 里的 phraseIndex 是 1-based 在 originalMusicStructure
// 里的索引
export function buildPartialRetryPrompt({
  originalMusicStructure,
  parsedPhrases,
  corrections,
  theme,
  style = '',
  extraInstruction = '',
}) {
  if (!originalMusicStructure || !Array.isArray(corrections) || corrections.length === 0) {
    throw new Error('buildPartialRetryPrompt: missing originalMusicStructure / corrections')
  }
  const badIdxSet = new Set(corrections.map((c) => c.phraseIndex))
  const goodLines = parsedPhrases
    .filter((p) => !badIdxSet.has(p.index))
    .map((p) => `第 ${p.index} 句（${p.lyric.length} 字）：${p.lyric.join('')}`)
  const badRequests = corrections.map((c) => {
    const original = parsedPhrases.find((p) => p.index === c.phraseIndex)
    const originalText = original ? original.lyric.join('') : '(空)'
    const slots = '□ '.repeat(c.expected).trim()
    return `- 第 ${c.phraseIndex} 句：必须正好 ${c.expected} 个字 ${slots}（你上次写了 "${originalText}" 是 ${c.actual} 字）`
  })
  const userParts = []
  userParts.push('## 任务：局部修订')
  userParts.push('你上次给这首歌写的歌词整体不错，但有几句字数对不上。请只重写下面这几句，**保持跟已写好的上下文的语境 / 风格 / 押韵连贯**。')
  userParts.push('')
  userParts.push('## 已写好的部分（保持连贯，但不要重写这些）')
  userParts.push(goodLines.length > 0 ? goodLines.join('\n') : '（无）')
  userParts.push('')
  userParts.push('## 需要重写的句子（字数严格按下面要求）')
  userParts.push(badRequests.join('\n'))
  userParts.push('')
  userParts.push(`## 主题 / 情绪`)
  userParts.push((typeof theme === 'string' ? theme : '').trim() || '随性创作')
  if (typeof style === 'string' && style.trim()) {
    userParts.push('')
    userParts.push('## 风格要求')
    userParts.push(style.trim())
  }
  if (typeof extraInstruction === 'string' && extraInstruction.trim()) {
    userParts.push('')
    userParts.push('## 额外要求')
    userParts.push(extraInstruction.trim())
  }
  userParts.push('')
  userParts.push('## 输出格式')
  userParts.push(`严格输出 JSON，**只包含需要重写的句子**，保持每句 index 与上面一致：`)
  userParts.push(`{ "phrases": [${corrections.map((c) => `{ "index": ${c.phraseIndex}, "lyric": [...] }`).join(', ')}] }`)
  userParts.push(`每个 phrase.lyric **必须是字符数组**且长度严格等于该句要求字数。不要 markdown 代码块标记，纯 JSON。`)

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') },
  ]
}

// 把 LLM 局部重写返回的 phrases 合回原 parsedPhrases 的对应位置。
// retryPhrases 已经在调用方被 parseLyricResponse 验证过字数（按 subMusicStructure），
// 这里只做位置合并 + 总体兜底字数复核
export function mergePartialRetryResponse({ retryPhrases, parsedPhrases, corrections, originalMusicStructure }) {
  if (!Array.isArray(retryPhrases) || !Array.isArray(parsedPhrases) || !Array.isArray(corrections)) {
    return { ok: false, reason: 'invalid-args' }
  }
  const merged = parsedPhrases.map((p) => ({ ...p }))
  retryPhrases.forEach((retryPhrase, i) => {
    const targetIndex = corrections[i]?.phraseIndex - 1
    if (Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < merged.length) {
      merged[targetIndex] = { ...retryPhrase, index: targetIndex + 1 }
    }
  })
  // 防御性复核：retryPhrases 理论上字数已对，但万一 LLM 在 retry 里也错位、
  // 或我们对位错了，整个合并结果再扫一遍
  const expected = Array.isArray(originalMusicStructure?.phrases) ? originalMusicStructure.phrases : []
  for (let i = 0; i < expected.length; i++) {
    if ((merged[i]?.lyric?.length || 0) !== (expected[i]?.syllableCount || 0)) {
      return {
        ok: false,
        reason: 'syllable-mismatch',
        phraseIndex: i + 1,
        expected: expected[i].syllableCount,
        actual: merged[i]?.lyric?.length || 0,
      }
    }
  }
  const flatChars = merged.flatMap((p) => p.lyric)
  return { ok: true, phrases: merged, flatChars }
}
