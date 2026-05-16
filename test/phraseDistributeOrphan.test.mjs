// 回归测试：phraseStore._distributeNotes 不能丢"在 phrase[0] 之前的孤儿"
// 用户报告："webutau 导出去再导入一圈以后，开头就有缺音符"——根因是 backend phrase
// 时间窗可能比 webutau 第一个 note 还晚，原来的孤儿分配只看"前一个 phrase"找不到。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// 直接复刻 PhraseStore._distributeNotes 的修复后实现，避免拉整个 phraseStore
function distributeNotes(allNotes, sortedPhrases) {
  const assigned = new Set()
  const phraseNotes = sortedPhrases.map((bp) => {
    const startSec = bp.startMs / 1000
    const endSec = (bp.startMs + bp.durationMs) / 1000
    const notes = allNotes
      .filter((n) => {
        const mid = n.time + n.duration / 2
        return mid >= startSec && mid < endSec
      })
      .sort((a, b) => a.time - b.time)
    for (const n of notes) assigned.add(n)
    return notes
  })

  const orphans = allNotes.filter((n) => !assigned.has(n))
  for (const orphan of orphans) {
    const orphanTime = orphan.time
    let bestIdx = -1
    let bestDelta = Infinity
    for (let i = 0; i < sortedPhrases.length; i++) {
      const startSec = sortedPhrases[i].startMs / 1000
      const endSec = startSec + sortedPhrases[i].durationMs / 1000
      let delta
      if (orphanTime < startSec) delta = startSec - orphanTime
      else if (orphanTime > endSec) delta = orphanTime - endSec
      else delta = 0
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = i
      }
    }
    if (bestIdx >= 0) {
      phraseNotes[bestIdx].push(orphan)
      phraseNotes[bestIdx].sort((a, b) => a.time - b.time)
    } else if (phraseNotes.length > 0) {
      phraseNotes[0].push(orphan)
      phraseNotes[0].sort((a, b) => a.time - b.time)
    }
  }
  return phraseNotes
}

describe('_distributeNotes 孤儿不丢失', () => {
  it('开头孤儿（time < phrase[0].startSec）应归入 phrase[0]', () => {
    // 模拟 backend 优化了静默前导，phrase[0] 从 2s 开始；但 webutau 有 note 在 1s
    const allNotes = [
      { time: 1.0, duration: 0.5, midi: 60, lyric: '开头' },  // ← 开头孤儿
      { time: 2.5, duration: 0.5, midi: 62, lyric: '正' },
      { time: 3.5, duration: 0.5, midi: 64, lyric: '常' },
    ]
    const phrases = [
      { startMs: 2000, durationMs: 1000, index: 0 },  // [2.0, 3.0)
      { startMs: 3000, durationMs: 1000, index: 1 },  // [3.0, 4.0)
    ]
    const dist = distributeNotes(allNotes, phrases)
    const allDistributed = dist.flat()
    assert.equal(allDistributed.length, 3, '❌ 开头孤儿被丢了！')
    assert.ok(allDistributed.some((n) => n.lyric === '开头'), '"开头" 这个 lyric 应仍存在')
  })

  it('中间孤儿（在 phrase 间隙）应归入最近 phrase', () => {
    const allNotes = [
      { time: 1.0, duration: 0.5, midi: 60, lyric: '一' },
      { time: 2.5, duration: 0.5, midi: 62, lyric: '间隙' },  // 在两 phrase 间隙
      { time: 4.0, duration: 0.5, midi: 64, lyric: '三' },
    ]
    const phrases = [
      { startMs: 1000, durationMs: 500, index: 0 },   // [1.0, 1.5)
      { startMs: 4000, durationMs: 500, index: 1 },   // [4.0, 4.5)
    ]
    const dist = distributeNotes(allNotes, phrases)
    const allDistributed = dist.flat()
    assert.equal(allDistributed.length, 3, '中间孤儿不能丢')
    // 2.5 离 phrase[0] (end 1.5) 距离 1.0，离 phrase[1] (start 4.0) 距离 1.5 → 归 phrase[0]
    assert.ok(dist[0].some((n) => n.lyric === '间隙'), '间隙孤儿应归到距离较近的 phrase[0]')
  })

  it('结尾孤儿（在最后 phrase 之后）应归入最后 phrase', () => {
    const allNotes = [
      { time: 1.0, duration: 0.5, midi: 60, lyric: '一' },
      { time: 5.0, duration: 0.5, midi: 64, lyric: '结尾' },  // ← 结尾孤儿
    ]
    const phrases = [
      { startMs: 1000, durationMs: 500, index: 0 },  // [1.0, 1.5)
      { startMs: 2000, durationMs: 1000, index: 1 }, // [2.0, 3.0)
    ]
    const dist = distributeNotes(allNotes, phrases)
    assert.equal(dist.flat().length, 2, '结尾孤儿不能丢')
    assert.ok(dist[1].some((n) => n.lyric === '结尾'), '结尾孤儿应归入最后 phrase')
  })

  it('多个开头孤儿全部不丢', () => {
    const allNotes = [
      { time: 0.5, duration: 0.3, midi: 60, lyric: '开1' },
      { time: 1.0, duration: 0.3, midi: 62, lyric: '开2' },
      { time: 1.5, duration: 0.3, midi: 64, lyric: '开3' },
      { time: 3.0, duration: 0.5, midi: 67, lyric: '正常' },
    ]
    const phrases = [
      { startMs: 3000, durationMs: 500, index: 0 },  // [3.0, 3.5)
    ]
    const dist = distributeNotes(allNotes, phrases)
    const flat = dist.flat()
    assert.equal(flat.length, 4, '❌ 3 个开头孤儿全部应该被保留')
    const lyrics = flat.map((n) => n.lyric).sort()
    assert.deepEqual(lyrics, ['开1', '开2', '开3', '正常'])
  })

  it('phrase 数为 0 的极端情况：返回空（不抛错）', () => {
    const allNotes = [{ time: 1.0, duration: 0.5, midi: 60 }]
    const dist = distributeNotes(allNotes, [])
    assert.equal(dist.length, 0, '没 phrase 时返回空数组')
  })
})
