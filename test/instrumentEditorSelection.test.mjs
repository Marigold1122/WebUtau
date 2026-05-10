import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  duplicateSelectedNotes,
  pasteClipboardAtTick,
  selectAllIds,
} from '../src/host/ui/instrumentEditorSelection.js'

const note = (id, tick, durationTicks = 120, midi = 60) => ({
  id, tick, durationTicks, midi, velocity: 0.8, lyric: 'a',
})

describe('selectAllIds', () => {
  it('空数组返回空 Set', () => {
    assert.equal(selectAllIds([]).size, 0)
  })

  it('返回所有 id', () => {
    const ids = selectAllIds([note('a', 0), note('b', 100), note('c', 200)])
    assert.deepEqual([...ids].sort(), ['a', 'b', 'c'])
  })

  it('忽略无 id 的 note', () => {
    const ids = selectAllIds([note('a', 0), { tick: 100, midi: 60 }])
    assert.deepEqual([...ids], ['a'])
  })
})

describe('pasteClipboardAtTick', () => {
  let counter = 0
  const allocator = () => `new-${++counter}`

  it('剪贴板空时不改动 existingNotes', () => {
    counter = 0
    const existing = [note('a', 0)]
    const { notes, newIds } = pasteClipboardAtTick(existing, [], 480, allocator)
    assert.equal(notes, existing)  // 同引用
    assert.equal(newIds.size, 0)
  })

  it('单 note 粘贴到 atTick', () => {
    counter = 0
    const existing = [note('a', 0)]
    const clipboard = [{ tick: 0, durationTicks: 240, midi: 64, velocity: 0.8, lyric: 'a' }]
    const { notes, newIds } = pasteClipboardAtTick(existing, clipboard, 480, allocator)
    assert.equal(notes.length, 2)
    assert.equal(newIds.size, 1)
    const pasted = notes[1]
    assert.equal(pasted.tick, 480)
    assert.equal(pasted.midi, 64)
    assert.equal(typeof pasted.id, 'string')
    assert.ok(newIds.has(pasted.id))
  })

  it('多 note 粘贴保留相对间距', () => {
    counter = 0
    const existing = []
    const clipboard = [
      { tick: 0, durationTicks: 120, midi: 60, velocity: 0.8, lyric: 'a' },
      { tick: 240, durationTicks: 120, midi: 64, velocity: 0.8, lyric: 'a' },
      { tick: 480, durationTicks: 120, midi: 67, velocity: 0.8, lyric: 'a' },
    ]
    const { notes } = pasteClipboardAtTick(existing, clipboard, 1000, allocator)
    assert.deepEqual(notes.map((n) => n.tick), [1000, 1240, 1480])
  })

  it('atTick 负数被 clamp 到 0', () => {
    counter = 0
    const clipboard = [{ tick: 0, durationTicks: 120, midi: 60 }]
    const { notes } = pasteClipboardAtTick([], clipboard, -500, allocator)
    assert.equal(notes[0].tick, 0)
  })

  it('idAllocator 不是函数时抛错', () => {
    assert.throws(() => pasteClipboardAtTick([], [{ tick: 0 }], 0, null))
  })
})

describe('duplicateSelectedNotes', () => {
  let counter = 0
  const allocator = () => `dup-${++counter}`

  it('选区为空时返回原数组', () => {
    counter = 0
    const existing = [note('a', 0)]
    const { notes, newIds } = duplicateSelectedNotes(existing, new Set(), allocator)
    assert.equal(notes, existing)
    assert.equal(newIds.size, 0)
  })

  it('选中 1 个 note → 紧贴右侧复刻', () => {
    counter = 0
    const existing = [note('a', 0, 240, 60)]
    const { notes, newIds } = duplicateSelectedNotes(existing, new Set(['a']), allocator)
    assert.equal(notes.length, 2)
    // offset = (0 + 240) - 0 = 240
    assert.equal(notes[1].tick, 240)
    assert.equal(notes[1].midi, 60)
    assert.equal(newIds.size, 1)
  })

  it('选中多 note → 整体紧贴右侧', () => {
    counter = 0
    const existing = [
      note('a', 0, 120, 60),
      note('b', 240, 240, 64),  // 末尾 = 480
      note('c', 600, 120, 67),  // 不选中
    ]
    const { notes, newIds } = duplicateSelectedNotes(existing, new Set(['a', 'b']), allocator)
    // offset = 480 - 0 = 480
    // 复刻出来的 a: tick 0+480=480；b: 240+480=720
    const newNotes = notes.filter((n) => newIds.has(n.id))
    assert.deepEqual(newNotes.map((n) => n.tick).sort((x, y) => x - y), [480, 720])
    assert.equal(notes.length, 5)  // 原 3 + 复刻 2
  })

  it('未选中的 note 不动', () => {
    counter = 0
    const existing = [note('a', 0), note('b', 1000)]
    const { notes } = duplicateSelectedNotes(existing, new Set(['a']), allocator)
    assert.equal(notes.find((n) => n.id === 'b').tick, 1000)
  })
})
