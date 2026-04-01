/**
 * 从 kuromoji 的 IPAdic 字典中提取汉字→假名读音映射，生成静态 JSON 文件。
 *
 * 数据源：
 *   tid.dat.gz     — 词条元数据（left_id, right_id, word_cost, pos_offset）
 *   tid_pos.dat.gz — 词条特征串（表层形,品詞,...,読み,発音）
 *
 * 同一表层形有多个词条时，取 word_cost 最小（最常用）的读音。
 *
 * 用法：node scripts/build-reading-dict.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DICT_DIR = resolve(__dirname, '../node_modules/@sglkc/kuromoji/dict')
const OUTPUT = resolve(__dirname, '../src/host/util/kanjiReadings.json')

const HAS_KANJI = /[\u4e00-\u9fff]/

// 片假名 → 平假名
function toHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  )
}

// 读取并解压字典文件
const tidBuf = gunzipSync(readFileSync(resolve(DICT_DIR, 'tid.dat.gz')))
const posBuf = gunzipSync(readFileSync(resolve(DICT_DIR, 'tid_pos.dat.gz')))
const decoder = new TextDecoder('utf-8')

// tid.dat 每条记录 10 字节（小端序）：left_id(2) + right_id(2) + word_cost(2) + pos_offset(4)
const RECORD_SIZE = 10
const recordCount = tidBuf.length / RECORD_SIZE

// 用 Map 暂存：surface → { reading, cost }，保留最低 cost 的读音
const bestReading = new Map()

for (let r = 0; r < recordCount; r++) {
  const off = r * RECORD_SIZE
  const wordCost = tidBuf.readInt16LE(off + 4)
  const posOffset = tidBuf.readInt32LE(off + 6)

  // 从 pos buffer 读空字节结尾的字符串
  let end = posOffset
  while (end < posBuf.length && posBuf[end] !== 0) end++
  const str = decoder.decode(posBuf.subarray(posOffset, end))
  const fields = str.split(',')

  if (fields.length < 9) continue
  const surface = fields[0]
  const reading = fields[8]
  if (!HAS_KANJI.test(surface) || !reading || reading === '*') continue

  const existing = bestReading.get(surface)
  if (!existing || wordCost < existing.cost) {
    bestReading.set(surface, { reading: toHiragana(reading), cost: wordCost })
  }
}

// 输出为平铺 JSON
const dict = Object.create(null)
for (const [surface, { reading }] of bestReading) {
  dict[surface] = reading
}

const json = JSON.stringify(dict, null, 0)
writeFileSync(OUTPUT, json, 'utf-8')

const entries = bestReading.size
const sizeKB = (json.length / 1024).toFixed(0)
console.log(`✓ 生成 ${entries} 条读音映射 → ${OUTPUT}`)
console.log(`  大小: ${sizeKB} KB (gzip 约 ${(json.length / 1024 / 3).toFixed(0)} KB)`)
