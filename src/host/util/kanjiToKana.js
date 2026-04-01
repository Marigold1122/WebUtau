/**
 * 日语汉字 → 平假名转换模块
 *
 * 使用构建时从 IPAdic 提取的静态读音字典，贪心最长匹配查表。
 * 无运行时 fetch，无外部依赖。字典随本模块一起打包，由 QuickLyricPanel
 * 的 dynamic import 触发延迟加载。
 */

import dict from './kanjiReadings.json'

const HAS_KANJI = /[\u4e00-\u9fff]/
const MAX_WORD_LEN = 22 // 字典最长词条 21 字符，留 1 余量

// 片假名 → 平假名（标准 Unicode 偏移）
function katakanaToHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  )
}

/** 将文本中的汉字转换为平假名 */
export function convertKanjiToKana(text) {
  if (!text) return text
  if (!HAS_KANJI.test(text)) return katakanaToHiragana(text)

  const chars = [...text]
  let result = ''
  let i = 0

  while (i < chars.length) {
    if (HAS_KANJI.test(chars[i])) {
      // 贪心最长匹配：从最长子串开始尝试查字典
      let matched = false
      const maxLen = Math.min(chars.length - i, MAX_WORD_LEN)
      for (let len = maxLen; len >= 1; len--) {
        const word = chars.slice(i, i + len).join('')
        const reading = dict[word]
        if (reading !== undefined) {
          result += reading
          i += len
          matched = true
          break
        }
      }
      if (!matched) {
        result += chars[i]
        i++
      }
    } else {
      result += chars[i]
      i++
    }
  }

  return katakanaToHiragana(result)
}

// 拗音小假名——跟随前一假名合为一拍
const COMBO_KANA = new Set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ')

/**
 * 按日语拍（モーラ）拆分假名文本。
 * 拗音小假名（ゃゅょ等）与前一假名合为一个单位，
 * 使拍数而非字符数与音符数对齐。
 *
 * 例: "きょう" → ["きょ","う"]（2 拍，非 3 字符）
 */
export function splitMorae(text) {
  const chars = [...text]
  const morae = []
  let i = 0
  while (i < chars.length) {
    let mora = chars[i]
    if (i + 1 < chars.length && COMBO_KANA.has(chars[i + 1])) {
      mora += chars[i + 1]
      i += 2
    } else {
      i++
    }
    morae.push(mora)
  }
  return morae
}
