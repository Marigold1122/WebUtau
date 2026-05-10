// 验证 InstrumentEditorView 的 undo / redo 栈在连续 Cmd+D 后的行为：
//   每次 duplicate 应该 push 一条独立快照，单次 Cmd+Z 只回退一步
//
// 不依赖真实 DOM——直接调用 _handleDuplicate / undo / redo，断言 state.notes
// 的快照演化。如果用户报的"撤回多步"是真 bug，这里就会失败。

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// jsdom 环境 stub —— InstrumentEditorView 用了 document、window、SVG，
// 直接 import 会炸；这里只调用纯逻辑方法，所以最小 stub 即可
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
    time: tick / 480 * 0.5,           // 假设 120 BPM、ppq=480
    duration: durationTicks / 480 * 0.5,
  }
}

function makeView() {
  const view = new InstrumentEditorView(null)
  // 跳过 init / setTrack 的复杂初始化，直接喂一个最小 state
  view.state.trackId = 'test-track'
  view.state.ppq = 480
  view.state.tempoData = null
  view.state.axis = {
    timeToTick: (t) => Math.round(t / 0.5 * 480),
    tickToTime: (tick) => tick / 480 * 0.5,
    xToTick: () => 0,
    timeToX: () => 0,
    totalTicks: 480 * 64,
  }
  view._renderMutableState = () => {}      // 跳过 DOM 渲染
  view._renderControls = () => {}
  view._renderNotes = () => {}
  view._touchNotes = () => {}
  view._syncDirtyState = () => {}
  view._ensureAxisForDraftNotes = () => false
  view._hideGhostNote = () => {}
  view._hideHoverGuide = () => {}
  view.setTool = (tool) => { view.state.tool = tool }  // 不走 _renderControls
  return view
}

describe('InstrumentEditorView undo / redo 栈', () => {
  let view
  beforeEach(() => {
    view = makeView()
    view.state.notes = [createNote('a', 0)]
    view.state.selectedIds = new Set(['a'])
    view.undoStack = []
    view.redoStack = []
  })

  it('单次 Cmd+D 后 undoStack 有 1 条快照、Cmd+Z 后剩 1 个 note', () => {
    view._handleDuplicate()
    assert.equal(view.state.notes.length, 2, '复刻后应有 2 个 note')
    assert.equal(view.undoStack.length, 1, 'undoStack 应该有 1 条快照')

    view.undo()
    assert.equal(view.state.notes.length, 1, 'undo 后应回到 1 个 note')
    assert.equal(view.undoStack.length, 0)
    assert.equal(view.redoStack.length, 1, 'redoStack 应该有 1 条')
  })

  it('★ 关键回归：连续 Cmd+D 两次后 undoStack 应有 2 条独立快照', () => {
    view._handleDuplicate()
    assert.equal(view.state.notes.length, 2, '第 1 次复刻后 2 个 note')
    assert.equal(view.undoStack.length, 1, '第 1 次后应有 1 条快照')

    view._handleDuplicate()
    assert.equal(view.state.notes.length, 3, '第 2 次复刻后 3 个 note')
    assert.equal(view.undoStack.length, 2, '★ 第 2 次后应有 2 条快照（不能被 dedup 掉）')
  })

  it('★ 关键回归：连续 Cmd+D 两次 + 单次 Cmd+Z 应只回退最新的复刻', () => {
    view._handleDuplicate()  // [A, A']
    view._handleDuplicate()  // [A, A', A'']
    view.undo()              // 应该回到 [A, A']
    assert.equal(view.state.notes.length, 2,
      '★ 单次 undo 应只回退最近一次复刻——只剩 [A, A_dup]，而不是回到 [A]')
  })

  it('Cmd+Z 后 Cmd+Shift+Z 能 redo 回最新状态', () => {
    view._handleDuplicate()
    view._handleDuplicate()
    view.undo()
    assert.equal(view.state.notes.length, 2)
    view.redo()
    assert.equal(view.state.notes.length, 3, 'redo 后应回到 3 个 note')
    assert.equal(view.redoStack.length, 0)
  })

  it('redo 后再 undo 仍能回退一步', () => {
    view._handleDuplicate()
    view._handleDuplicate()
    view.undo()    // [A, A']
    view.redo()    // [A, A', A'']
    view.undo()    // [A, A']
    assert.equal(view.state.notes.length, 2)
  })

  it('redo 完后做新操作，redoStack 应被清空（不能再 redo 到旧分支）', () => {
    view._handleDuplicate()  // [A, A']
    view.undo()              // [A]
    assert.equal(view.redoStack.length, 1)
    view._handleDuplicate()  // [A, A''']（新分支）
    assert.equal(view.redoStack.length, 0, '新操作触发后 redoStack 必须清空')
  })
})
