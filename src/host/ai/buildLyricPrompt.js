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
    { "index": 1, "lyric": ["字", "字", ...], "explanation": "为什么这么写（一句话，可省）" },
    { "index": 2, "lyric": [...], "explanation": "..." }
  ]
}

phrases 数组按句序排列；每个 phrase.lyric **必须是字符数组**（不要写成整句字符串），
数组长度必须严格等于该句音节数。不要包含 markdown 代码块标记，直接返回纯 JSON 文本。`

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

// LLM 返回的 JSON 字符串 → 解析 + 校验出每句的字数对不对
// 严格校验：句数必须匹配，每句字数必须匹配，否则返回 { ok: false, reason }
export function parseLyricResponse(rawText, musicStructure) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, reason: 'empty-response' }
  }
  // 容忍 LLM 偶尔包 markdown 代码块的情况
  let body = rawText.trim()
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (_e) {
    return { ok: false, reason: 'invalid-json', raw: rawText }
  }
  const phrases = Array.isArray(parsed?.phrases) ? parsed.phrases : null
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
  // 把每句字数核对一遍
  const merged = []
  for (let i = 0; i < expected.length; i++) {
    const wantSyllables = expected[i].syllableCount
    const got = phrases[i]
    const lyricArr = Array.isArray(got?.lyric)
      ? got.lyric.map((s) => String(s).trim())
      : (typeof got?.lyric === 'string' ? [...got.lyric.trim()] : null)
    if (!lyricArr) {
      return { ok: false, reason: 'phrase-shape', phraseIndex: i + 1 }
    }
    if (lyricArr.length !== wantSyllables) {
      return {
        ok: false,
        reason: 'syllable-mismatch',
        phraseIndex: i + 1,
        expected: wantSyllables,
        actual: lyricArr.length,
      }
    }
    merged.push({
      index: i + 1,
      lyric: lyricArr,
      explanation: typeof got?.explanation === 'string' ? got.explanation : '',
    })
  }
  // 拍平成单字数组——与 QuickLyricPanel._handleSave 里 charIndex 流程对齐
  const flatChars = merged.flatMap((p) => p.lyric)
  return { ok: true, phrases: merged, flatChars }
}
