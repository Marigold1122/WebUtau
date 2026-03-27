/**
 * 歌词拆分工具 — 参考 OpenUtau SplitLyrics.cs
 *
 * 规则：
 * 1. 空格/换行是分隔符（拉丁文按空格分词）
 * 2. 中日韩字符逐字拆分（每个字独立成一个 lyric）
 * 3. 双引号包裹的内容保持完整（"hello world" → 一个 lyric）
 */

// CJK Unicode 范围
const CJK_REGEX = /[\u3000-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/

export function splitLyrics(text) {
  if (!text || text.trim().length === 0) return []

  const result = []
  let i = 0
  const chars = [...text]  // 正确处理 Unicode

  while (i < chars.length) {
    const ch = chars[i]

    // 跳过空白
    if (/\s/.test(ch)) {
      i++
      continue
    }

    // 双引号包裹：保持完整
    if (ch === '"' || ch === '\u201c') {
      const closeQuote = ch === '"' ? '"' : '\u201d'
      let word = ''
      i++  // 跳过开引号
      while (i < chars.length && chars[i] !== closeQuote) {
        word += chars[i]
        i++
      }
      if (i < chars.length) i++  // 跳过闭引号
      if (word.length > 0) result.push(word)
      continue
    }

    // CJK 字符：逐字拆分
    if (CJK_REGEX.test(ch)) {
      result.push(ch)
      i++
      continue
    }

    // 拉丁/其他字符：按空格分词
    let word = ''
    while (i < chars.length && !/\s/.test(chars[i]) && !CJK_REGEX.test(chars[i])) {
      word += chars[i]
      i++
    }
    if (word.length > 0) result.push(word)
  }

  return result
}
