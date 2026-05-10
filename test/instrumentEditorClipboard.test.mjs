import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  clearClipboard,
  getClipboard,
  hasClipboard,
  setClipboard,
} from '../src/host/ui/instrumentEditorClipboard.js'

const sampleNote = (overrides = {}) => ({
  id: 'note-x',
  tick: 480,
  durationTicks: 240,
  midi: 60,
  velocity: 0.8,
  lyric: 'a',
  tuning: 0,
  pitch: { snapFirst: false, data: [{ x: 0, y: 0, shape: 'io' }] },
  vibrato: { length: 50, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, volLink: 0 },
  ...overrides,
})

describe('instrumentEditorClipboard', () => {
  beforeEach(() => clearClipboard())

  it('空 / 非数组 set 后剪贴板仍为空', () => {
    assert.equal(setClipboard([]), false)
    assert.equal(setClipboard(null), false)
    assert.equal(hasClipboard(), false)
    assert.equal(getClipboard(), null)
  })

  it('set 后 hasClipboard 为 true、getClipboard 返回深克隆', () => {
    const original = [sampleNote()]
    assert.equal(setClipboard(original), true)
    assert.equal(hasClipboard(), true)

    const fetched = getClipboard()
    assert.equal(fetched.notes.length, 1)
    // 深克隆：修改返回值不影响内部存储
    fetched.notes[0].midi = 120
    fetched.notes[0].pitch.data[0].x = 999
    const refetched = getClipboard()
    assert.equal(refetched.notes[0].midi, 60)
    assert.equal(refetched.notes[0].pitch.data[0].x, 0)
  })

  it('round-trip 保留 pitch / vibrato / tuning / velocity / lyric 全字段', () => {
    setClipboard([sampleNote()])
    const fetched = getClipboard()
    const got = fetched.notes[0]
    assert.equal(got.lyric, 'a')
    assert.equal(got.tuning, 0)
    assert.equal(got.velocity, 0.8)
    assert.deepEqual(got.pitch, { snapFirst: false, data: [{ x: 0, y: 0, shape: 'io' }] })
    assert.deepEqual(got.vibrato, {
      length: 50, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, volLink: 0,
    })
  })

  it('id 字段被剥掉（粘贴时由调用方分配新 id）', () => {
    setClipboard([sampleNote({ id: 'old-id' })])
    const got = getClipboard().notes[0]
    assert.equal(got.id, undefined)
  })

  it('多 note 时 tick 锚点对齐到 0', () => {
    setClipboard([
      sampleNote({ id: 'a', tick: 1000, midi: 60 }),
      sampleNote({ id: 'b', tick: 1240, midi: 64 }),
      sampleNote({ id: 'c', tick: 800, midi: 67 }),
    ])
    const ticks = getClipboard().notes.map((n) => n.tick).sort((a, b) => a - b)
    // 最小 tick 800 → 0；其它相对偏移保留：1000-800=200, 1240-800=440
    assert.deepEqual(ticks, [0, 200, 440])
  })

  it('clearClipboard 清掉', () => {
    setClipboard([sampleNote()])
    assert.equal(hasClipboard(), true)
    clearClipboard()
    assert.equal(hasClipboard(), false)
    assert.equal(getClipboard(), null)
  })
})
