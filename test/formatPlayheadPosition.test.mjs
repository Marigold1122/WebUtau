import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createBarBeatFormatter,
  formatTimecode,
} from '../src/shared/formatPlayheadPosition.js'

describe('formatTimecode', () => {
  it('0 秒 = "0:00.000"', () => {
    assert.equal(formatTimecode(0), '0:00.000')
  })
  it('小数秒补 0', () => {
    assert.equal(formatTimecode(1.234), '0:01.234')
    assert.equal(formatTimecode(1.2), '0:01.200')
  })
  it('分钟 + 秒', () => {
    assert.equal(formatTimecode(83.456), '1:23.456')
    assert.equal(formatTimecode(60), '1:00.000')
  })
  it('1 小时以上切换到 hh:mm:ss', () => {
    assert.equal(formatTimecode(3661.789), '1:01:01.789')
  })
  it('负数 / 非数字 → 0:00.000', () => {
    assert.equal(formatTimecode(-1), '0:00.000')
    assert.equal(formatTimecode(NaN), '0:00.000')
    assert.equal(formatTimecode(undefined), '0:00.000')
  })
})

describe('createBarBeatFormatter（默认 4/4 拍 120 BPM）', () => {
  const fmt = createBarBeatFormatter({ tempoData: null, ppq: 480 })

  it('0 秒 = 1.1.0000', () => {
    assert.equal(fmt(0), '1.1.0000')
  })
  it('120 BPM 下 0.5 秒 = 第 1 小节第 2 拍（4/4 拍每拍 0.5s）', () => {
    assert.equal(fmt(0.5), '1.2.0000')
  })
  it('2 秒（4 拍 = 1 小节）= 第 2 小节第 1 拍', () => {
    assert.equal(fmt(2.0), '2.1.0000')
  })
  it('tickInBeat 4 位 0 padding', () => {
    // 0.25 秒 = 0.5 拍 = 240 tick offset within beat 1
    const out = fmt(0.25)
    assert.match(out, /^1\.1\.\d{4}$/)
  })
})

describe('createBarBeatFormatter（3/4 拍）', () => {
  const tempoData = {
    tempos: [{ bpm: 120, time: 0, ticks: 0 }],
    timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }],
  }
  const fmt = createBarBeatFormatter({ tempoData, ppq: 480 })

  it('120 BPM 下 1.5 秒（3 拍）= 第 2 小节第 1 拍', () => {
    assert.equal(fmt(1.5), '2.1.0000')
  })
  it('120 BPM 下 1 秒 = 第 1 小节第 3 拍', () => {
    assert.equal(fmt(1.0), '1.3.0000')
  })
})

describe('createBarBeatFormatter（拍号变化）', () => {
  // 第 0 ticks: 4/4；第 1920 ticks (480*4 = 1 个 4/4 小节末尾) 起切到 3/4
  const tempoData = {
    tempos: [{ bpm: 120, time: 0, ticks: 0 }],
    timeSignatures: [
      { ticks: 0, timeSignature: [4, 4] },
      { ticks: 1920, timeSignature: [3, 4] },
    ],
  }
  const fmt = createBarBeatFormatter({ tempoData, ppq: 480 })

  it('1 个 4/4 小节末尾刚好是 第 2 小节第 1 拍（拍号切换边界）', () => {
    // 1920 ticks at 120 BPM = 1920 / 480 / 2 = 2 秒
    assert.equal(fmt(2.0), '2.1.0000')
  })
  it('切换后第 3 拍 = 第 2 小节第 3 拍（3/4 拍内）', () => {
    // 1920 + 480*2 = 2880 ticks = 3 秒
    assert.equal(fmt(3.0), '2.3.0000')
  })
  it('3/4 拍下 3 拍 = 第 3 小节第 1 拍', () => {
    // 1920 + 480*3 = 3360 ticks = 3.5 秒
    assert.equal(fmt(3.5), '3.1.0000')
  })
})

describe('createBarBeatFormatter（ppq 不为 480）', () => {
  const fmt = createBarBeatFormatter({ tempoData: null, ppq: 960 })
  it('960 ppq 下 4/4、120 BPM、2 秒 = 第 2 小节第 1 拍', () => {
    assert.equal(fmt(2.0), '2.1.0000')
  })
})

describe('createBarBeatFormatter（变速曲）', () => {
  // 0~2s = 60 BPM；2s 之后 = 120 BPM
  const tempoData = {
    tempos: [
      { bpm: 60, time: 0, ticks: 0 },
      { bpm: 120, time: 2, ticks: 60 / 60 * 480 * 2 },  // 60 BPM × 2s = 960 ticks
    ],
  }
  const fmt = createBarBeatFormatter({ tempoData, ppq: 480 })

  it('0 秒还是第 1 小节第 1 拍', () => {
    assert.equal(fmt(0), '1.1.0000')
  })
  it('60 BPM 下 1 秒 = 第 1 小节第 2 拍', () => {
    assert.equal(fmt(1.0), '1.2.0000')
  })
  it('60 BPM 下 2 秒切换点 = 第 1 小节第 3 拍', () => {
    assert.equal(fmt(2.0), '1.3.0000')
  })
})
