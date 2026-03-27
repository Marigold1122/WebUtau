const ASCII_ONLY_PATTERN = /^[\x00-\x7F]*$/
const CJK_PATTERN = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/
const MOJIBAKE_PATTERN = /[\u0080-\u009FÃÂÅÄÆÇÉÈÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßãâåäæçéèêëìíîïðñòóôõöøùúûüýþÿ]/
const DECODER_ENCODINGS = ['utf-8', 'gb18030', 'shift_jis', 'big5']

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
    if (/[\u0080-\u00FF]/.test(char)) return score - 2
    return score
  }, 0)
}

export function decodeMidiText(rawText) {
  const raw = String(rawText || '')
  if (!raw || ASCII_ONLY_PATTERN.test(raw) || CJK_PATTERN.test(raw)) return raw
  if (!MOJIBAKE_PATTERN.test(raw)) return raw

  const bytes = toByteArray(raw)
  const baseScore = scoreText(raw)
  const utf8Text = tryDecode(bytes, 'utf-8')

  if (utf8Text && utf8Text !== raw) {
    if (CJK_PATTERN.test(utf8Text)) return utf8Text
    if (scoreText(utf8Text) > baseScore) return utf8Text
  }

  let bestText = raw
  let bestScore = baseScore

  DECODER_ENCODINGS
    .filter((encoding) => encoding !== 'utf-8')
    .forEach((encoding) => {
    const decoded = tryDecode(bytes, encoding)
    if (!decoded || decoded === raw) return
    const decodedScore = scoreText(decoded)
    if (decodedScore <= bestScore || !CJK_PATTERN.test(decoded)) return
    bestText = decoded
    bestScore = decodedScore
    })

  return bestScore > baseScore ? bestText : raw
}
