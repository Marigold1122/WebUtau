import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatSpan,
  midiToNoteName,
  summarizeNotes,
} from '../src/shared/selectionSummary.js'

describe('summarizeNotes', () => {
  it('空 / null / 非数组 → null', () => {
    assert.equal(summarizeNotes([]), null)
    assert.equal(summarizeNotes(null), null)
    assert.equal(summarizeNotes(undefined), null)
    assert.equal(summarizeNotes('foo'), null)
  })

  it('单 note → count=1，音域上下相同', () => {
    const result = summarizeNotes([{ time: 0, duration: 0.5, midi: 60 }])
    assert.deepEqual(result, { count: 1, midiLow: 60, midiHigh: 60, spanSec: 0.5 })
  })

  it('多 note 同音高 → 音域上下相同', () => {
    const r = summarizeNotes([
      { time: 0, duration: 0.5, midi: 60 },
      { time: 1, duration: 0.5, midi: 60 },
    ])
    assert.equal(r.count, 2)
    assert.equal(r.midiLow, 60)
    assert.equal(r.midiHigh, 60)
    assert.equal(r.spanSec, 1.5)
  })

  it('多 note 跨音域 → 取 min/max', () => {
    const r = summarizeNotes([
      { time: 0, duration: 0.25, midi: 60 },  // C4
      { time: 0.5, duration: 0.25, midi: 67 }, // G4
      { time: 1.0, duration: 0.5, midi: 64 },  // E4
    ])
    assert.equal(r.count, 3)
    assert.equal(r.midiLow, 60)
    assert.equal(r.midiHigh, 67)
    assert.equal(r.spanSec, 1.5)  // 1.0 + 0.5 - 0
  })

  it('time 缺失（声乐 runtime 偶尔会传部分字段）→ 算 0 起点', () => {
    const r = summarizeNotes([
      { duration: 0.5, midi: 60 },  // 没有 time
      { time: 1, duration: 0.5, midi: 64 },
    ])
    assert.equal(r.count, 2)
    assert.equal(r.spanSec, 1.5)  // 0 → 1.5
  })

  it('全部 note midi 缺失 → null（什么都摘不出来）', () => {
    assert.equal(summarizeNotes([{ time: 0, duration: 0.5 }]), null)
  })

  it('部分 note midi 缺失 → 跳过坏的、用好的', () => {
    const r = summarizeNotes([
      { time: 0, duration: 0.5, midi: 60 },
      { time: 1, duration: 0.5 },  // 坏
      { time: 2, duration: 0.5, midi: 67 },
    ])
    assert.equal(r.count, 2)
    assert.equal(r.midiLow, 60)
    assert.equal(r.midiHigh, 67)
  })

  it('midi 是浮点 → 四舍五入', () => {
    const r = summarizeNotes([{ time: 0, duration: 0.1, midi: 59.7 }])
    assert.equal(r.midiLow, 60)
    assert.equal(r.midiHigh, 60)
  })

  it('负 time / 负 duration → clamp 到 0', () => {
    const r = summarizeNotes([{ time: -1, duration: -0.5, midi: 60 }])
    assert.equal(r.spanSec, 0)
  })
})

describe('midiToNoteName', () => {
  it('60 → C4', () => assert.equal(midiToNoteName(60), 'C4'))
  it('61 → C#4', () => assert.equal(midiToNoteName(61), 'C#4'))
  it('72 → C5', () => assert.equal(midiToNoteName(72), 'C5'))
  it('21 → A0（钢琴最低音）', () => assert.equal(midiToNoteName(21), 'A0'))
  it('108 → C8（钢琴最高音）', () => assert.equal(midiToNoteName(108), 'C8'))
  it('NaN / undefined → 空串', () => {
    assert.equal(midiToNoteName(NaN), '')
    assert.equal(midiToNoteName(undefined), '')
  })
  it('浮点四舍五入', () => assert.equal(midiToNoteName(60.4), 'C4'))
})

describe('formatSpan', () => {
  it('< 1s → 整数 ms', () => {
    assert.equal(formatSpan(0.24), '240ms')
    assert.equal(formatSpan(0), '0ms')
    assert.equal(formatSpan(0.001), '1ms')
  })
  it('1s ~ 60s → 两位小数 s', () => {
    assert.equal(formatSpan(1), '1.00s')
    assert.equal(formatSpan(2.345), '2.35s')
    assert.equal(formatSpan(59.999), '60.00s')  // 浮点 close-to-60 仍走 < 60 分支
  })
  it('>= 60s → m:ss.mmm', () => {
    assert.equal(formatSpan(60), '1:00.000')
    assert.equal(formatSpan(83.456), '1:23.456')
    assert.equal(formatSpan(125.78), '2:05.780')
  })
  it('负 / NaN → 0ms', () => {
    assert.equal(formatSpan(-1), '0ms')
    assert.equal(formatSpan(NaN), '0ms')
  })
})
