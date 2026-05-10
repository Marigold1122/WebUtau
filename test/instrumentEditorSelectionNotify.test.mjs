// 验证 InstrumentEditorView 在每个选区变更点都会调 onInstrumentEditorSelectionChanged
//   - Cmd+A / Cmd+D / Cmd+V / Esc / Delete 后都要 emit
//   - emit 的 summary 在选区为空时 = null

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// 同 instrumentEditorUndoStack.test.mjs 的最小 stub
function setupDomStubs() {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      createElementNS: () => ({ setAttribute: () => {}, classList: { add: () => {} }, appendChild: () => {} }),
      createElement: () => ({
        classList: { add: () => {}, toggle: () => {}, remove: () => {} },
        appendChild: () => {},
        setAttribute: () => {},
        addEventListener: () => {},
        style: {},
        dataset: {},
      }),
    }
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      cancelAnimationFrame: clearTimeout,
    }
  }
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  }
  if (typeof globalThis.cancelAnimationFrame === 'undefined') {
    globalThis.cancelAnimationFrame = clearTimeout
  }
}
setupDomStubs()

const { InstrumentEditorView } = await import('../src/host/ui/InstrumentEditorView.js')

function createNote(id, tick, midi = 60, durationTicks = 240) {
  return {
    id, tick, durationTicks, midi,
    velocity: 0.8, lyric: 'a', tuning: 0,
    time: tick / 480 * 0.5,
    duration: durationTicks / 480 * 0.5,
  }
}

function makeView(handler) {
  const view = new InstrumentEditorView(null, { onInstrumentEditorSelectionChanged: handler })
  view.state.trackId = 'test-track'
  view.state.ppq = 480
  view.state.axis = {
    timeToTick: (t) => Math.round(t / 0.5 * 480),
    tickToTime: (tick) => tick / 480 * 0.5,
    xToTick: () => 0,
    timeToX: () => 0,
    totalTicks: 480 * 64,
  }
  view._renderMutableState = () => {}
  view._renderControls = () => {}
  view._renderNotes = () => {}
  view._touchNotes = () => {}
  view._syncDirtyState = () => {}
  view._ensureAxisForDraftNotes = () => false
  view._hideGhostNote = () => {}
  view._hideHoverGuide = () => {}
  view.setTool = (tool) => { view.state.tool = tool }
  return view
}

describe('InstrumentEditorView 选区变更通知', () => {
  let calls
  let view
  beforeEach(() => {
    calls = []
    view = makeView((s) => calls.push(s))
    view.state.notes = [createNote('a', 0, 60), createNote('b', 240, 64), createNote('c', 480, 67)]
    view.state.selectedIds = new Set()
  })

  it('Cmd+A 后 emit 一次：count=3、midi 60-67', () => {
    view._handleSelectAll()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { count: 3, midiLow: 60, midiHigh: 67, spanSec: 0.75 })
  })

  it('Esc / _clearSelection 后 emit null', () => {
    view._handleSelectAll()  // 选 3 个
    calls.length = 0
    view._clearSelection()
    assert.equal(calls.length, 1)
    assert.equal(calls[0], null)
  })

  it('Cmd+D 后 emit：选区是新复刻出的 note', () => {
    view.state.selectedIds = new Set(['a'])
    view._handleDuplicate()
    assert.ok(calls.length >= 1)
    const last = calls[calls.length - 1]
    assert.equal(last.count, 1)
    assert.equal(last.midiLow, 60)
  })

  it('Cmd+V（剪贴板有内容时）后 emit', async () => {
    const { setClipboard } = await import('../src/host/ui/instrumentEditorClipboard.js')
    setClipboard([{ tick: 0, durationTicks: 240, midi: 72, time: 0, duration: 0.5, velocity: 0.8, lyric: 'a' }])
    view._handlePaste()
    const last = calls[calls.length - 1]
    assert.ok(last)
    assert.equal(last.count, 1)
    assert.equal(last.midiLow, 72)
  })

  it('删除选中 note 后 emit null', () => {
    view.state.selectedIds = new Set(['a', 'b'])
    calls.length = 0
    view._deleteSelectedNotes()
    // _deleteSelectedNotes → _clearSelection → emit null
    // 然后 _applyNotesSnapshot → emit again（也是 null，因为 selectedIds 是空的）
    const lastNullEmit = calls[calls.length - 1]
    assert.equal(lastNullEmit, null)
  })

  it('selectedIds 含失效 id 时 summary 为 null（filter 掉所有）', () => {
    view.state.selectedIds = new Set(['nonexistent-1', 'nonexistent-2'])
    view._notifySelectionChanged()
    assert.equal(calls.length, 1)
    assert.equal(calls[0], null)
  })

  it('clear() 退出时也 emit null', () => {
    view.state.selectedIds = new Set(['a'])
    calls.length = 0
    view.clear()
    // clear 会先 _notifySelectionChanged（清掉选区前 / 后都通知一次为安全）
    // 关键：最后一次 emit 必须是 null
    const last = calls[calls.length - 1]
    assert.equal(last, null)
  })
})
