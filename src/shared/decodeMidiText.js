const ASCII_ONLY_PATTERN = /^[\x00-\x7F]*$/
const CJK_PATTERN = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/
const MOJIBAKE_PATTERN = /[\u0080-\u009FÃÂÅÄÆÇÉÈÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßãâåäæçéèêëìíîïðñòóôõöøùúûüýþÿ]/
const DECODER_ENCODINGS = ['utf-8', 'gb18030', 'shift_jis', 'big5']
const LEGACY_ENCODINGS = ['gb18030', 'shift_jis', 'big5']

function toByteArray(text) {
  return Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0) & 0xff))
}

function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function scoreText(text) {
  return Array.from(text).reduce((score, char) => {
    if (CJK_PATTERN.test(char)) return score + 4
    if (/[\u0020-\u007E]/.test(char)) return score + 1
    if (/\s/.test(char)) return score + 0.5
    if (char === '\uFFFD' || /[\u0000-\u001F]/.test(char)) return score - 6
    if (MOJIBAKE_PATTERN.test(char)) return score - 3
    if (/[\u0080-\u00FF]/.test(char)) return score - 2
    return score
  }, 0)
}

function decodeBest(bytes, encodings, baselineText) {
  const baseScore = scoreText(baselineText)
  let bestText = baselineText
  let bestScore = baseScore

  encodings.forEach((encoding) => {
    const decoded = tryDecode(bytes, encoding)
    if (!decoded || decoded === baselineText) return
    const decodedScore = scoreText(decoded)
    if (decodedScore <= bestScore) return
    bestText = decoded
    bestScore = decodedScore
  })

  return { text: bestText, score: bestScore }
}

export function decodeMidiText(rawText) {
  const raw = String(rawText || '')
  if (!raw || ASCII_ONLY_PATTERN.test(raw) || CJK_PATTERN.test(raw)) return raw
  if (!MOJIBAKE_PATTERN.test(raw)) return raw

  const bytes = toByteArray(raw)
  const baseScore = scoreText(raw)
  const utf8Text = tryDecode(bytes, 'utf-8')

  if (utf8Text && utf8Text !== raw) {
    const utf8Score = scoreText(utf8Text)
    if (CJK_PATTERN.test(utf8Text)) return utf8Text

    if (MOJIBAKE_PATTERN.test(utf8Text)) {
      const nested = decodeBest(toByteArray(utf8Text), LEGACY_ENCODINGS, utf8Text)
      if (nested.text !== utf8Text && nested.score > utf8Score && CJK_PATTERN.test(nested.text)) {
        return nested.text
      }
    }

    if (utf8Score > baseScore) return utf8Text
    return raw
  }

  const direct = decodeBest(bytes, DECODER_ENCODINGS.filter((encoding) => encoding !== 'utf-8'), raw)
  return direct.score > baseScore ? direct.text : raw
}
