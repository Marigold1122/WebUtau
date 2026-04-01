/**
 * 日语汉字转假名回归测试
 *
 * 测试运行时转换逻辑：贪心最长匹配查表。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dict = JSON.parse(readFileSync(resolve(__dirname, '../src/host/util/kanjiReadings.json'), 'utf-8'))

// ── 复现运行时逻辑 ──

const HAS_KANJI = /[\u4e00-\u9fff]/
const MAX_WORD_LEN = 22

function katakanaToHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  )
}

function convertKanjiToKana(text) {
  if (!text) return text
  if (!HAS_KANJI.test(text)) return katakanaToHiragana(text)
  const chars = [...text]
  let result = '', i = 0
  while (i < chars.length) {
    if (HAS_KANJI.test(chars[i])) {
      let matched = false
      const maxLen = Math.min(chars.length - i, MAX_WORD_LEN)
      for (let len = maxLen; len >= 1; len--) {
        const word = chars.slice(i, i + len).join('')
        const reading = dict[word]
        if (reading !== undefined) {
          result += reading; i += len; matched = true; break
        }
      }
      if (!matched) { result += chars[i]; i++ }
    } else { result += chars[i]; i++ }
  }
  return katakanaToHiragana(result)
}

const COMBO_KANA = new Set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ')

function splitMorae(text) {
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

// ── 测试 ──

describe('字典完整性', () => {
  it('包含足够的词条', () => {
    assert.ok(Object.keys(dict).length > 200000)
  })

  it('常用单字词正确', () => {
    const expected = {
      '星': 'ほし', '風': 'かぜ', '花': 'はな', '海': 'うみ',
      '月': 'つき', '心': 'こころ', '空': 'そら', '雨': 'あめ',
      '声': 'こえ', '春': 'はる', '光': 'ひかり', '手': 'て',
      '目': 'め', '夢': 'ゆめ', '涙': 'なみだ',
    }
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(dict[k], v, `${k} 应为 ${v}`)
    }
  })
})

describe('convertKanjiToKana - 基础', () => {
  it('常用句子', () => {
    assert.equal(convertKanjiToKana('今日は天気が良い'), 'きょうはてんきがよい')
  })
  it('动词短语', () => {
    assert.equal(convertKanjiToKana('桜が咲く'), 'さくらがさく')
  })
  it('の连接', () => {
    assert.equal(convertKanjiToKana('夜空の星'), 'よぞらのほし')
  })
  it('が连接', () => {
    assert.equal(convertKanjiToKana('風が吹く'), 'かぜがふく')
  })
  it('流れる', () => {
    assert.equal(convertKanjiToKana('涙が流れる'), 'なみだがながれる')
  })
})

describe('convertKanjiToKana - 用户报告的问题用例', () => {
  it('渇いた心で駆け抜ける', () => {
    assert.equal(convertKanjiToKana('渇いた心で駆け抜ける'), 'かわいたこころでかけぬける')
  })
  it('痛みを分かち合うことさえ', () => {
    assert.equal(convertKanjiToKana('痛みを分かち合うことさえ'), 'いたみをわかちあうことさえ')
  })
  it('無垢に生きるため振り向かず', () => {
    assert.equal(convertKanjiToKana('無垢に生きるため振り向かず'), 'むくにいきるためふりむかず')
  })
  it('背中向けて去ってしまう', () => {
    assert.equal(convertKanjiToKana('背中向けて去ってしまう'), 'せなかむけてさってしまう')
  })
})

describe('convertKanjiToKana - 假名与边界', () => {
  it('平假名不变', () => {
    assert.equal(convertKanjiToKana('ひらがな'), 'ひらがな')
  })
  it('片假名转平假名', () => {
    assert.equal(convertKanjiToKana('カタカナ'), 'かたかな')
  })
  it('标点保留', () => {
    const r = convertKanjiToKana('春、夏。')
    assert.ok(r.includes('、') && r.includes('。'))
  })
  it('空字符串', () => assert.equal(convertKanjiToKana(''), ''))
  it('null', () => assert.equal(convertKanjiToKana(null), null))
  it('undefined', () => assert.equal(convertKanjiToKana(undefined), undefined))
})

describe('convertKanjiToKana - 输出无汉字', () => {
  const lyrics = [
    '今日は天気が良い', '渇いた心で駆け抜ける',
    '痛みを分かち合うことさえ', '無垢に生きるため振り向かず',
    '背中向けて去ってしまう', '夜空の星', '美しい花',
    '心の声が聞こえる', '夢を追いかけて走り出す',
  ]
  for (const line of lyrics) {
    it(line, () => {
      const result = convertKanjiToKana(line)
      assert.ok(!HAS_KANJI.test(result), `"${result}" 仍含汉字`)
    })
  }
})

describe('splitMorae - モーラ拆分', () => {
  it('拗音合并: きょ 为一拍', () => {
    assert.deepEqual(splitMorae('きょう'), ['きょ', 'う'])
  })
  it('拗音合并: しゃ', () => {
    assert.deepEqual(splitMorae('しゃべる'), ['しゃ', 'べ', 'る'])
  })
  it('拗音合并: ちゅ', () => {
    assert.deepEqual(splitMorae('ちゅうもん'), ['ちゅ', 'う', 'も', 'ん'])
  })
  it('拗音合并: りょ', () => {
    assert.deepEqual(splitMorae('りょこう'), ['りょ', 'こ', 'う'])
  })
  it('片假名拗音合并: キャ', () => {
    assert.deepEqual(splitMorae('キャラ'), ['キャ', 'ラ'])
  })
  it('促音独立一拍', () => {
    assert.deepEqual(splitMorae('がっこう'), ['が', 'っ', 'こ', 'う'])
  })
  it('无拗音时等同逐字', () => {
    assert.deepEqual(splitMorae('かわいた'), ['か', 'わ', 'い', 'た'])
  })
  it('非假名字符不受影响', () => {
    assert.deepEqual(splitMorae('abc'), ['a', 'b', 'c'])
  })
  it('转换+拆分端到端: 拍数 < 字符数', () => {
    const kana = convertKanjiToKana('今日は天気が良い')
    const chars = [...kana]
    const morae = splitMorae(kana)
    assert.ok(morae.length <= chars.length, `拍数(${morae.length})应 ≤ 字符数(${chars.length})`)
  })
})
