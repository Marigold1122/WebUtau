// 用 jsdom 风格 stub 验证 RealtimeStatusController 的 DOM 更新逻辑
//   - setProject / setPlayhead / setEditor 的 textContent 路径
//   - tempoData 变化时重建 bar-beat formatter
//   - 同一时间点重复 setPlayhead 不写 DOM（性能保护）

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// 极简 DOM stub —— 只满足 RealtimeStatusController 的需求
function createMockSpan() {
  const span = {
    nodeType: 1,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    appendChild(child) { this.children.push(child); return child },
    append(...nodes) { nodes.forEach((n) => this.children.push(n)) },
    set innerHTML(v) { if (v === '') this.children.length = 0 },
    get innerHTML() { return '' },
  }
  span.classList = {
    toggle(cls, force) {
      const present = (' ' + span.className + ' ').includes(' ' + cls + ' ')
      const want = typeof force === 'boolean' ? force : !present
      if (want && !present) {
        span.className = (span.className + ' ' + cls).trim()
      } else if (!want && present) {
        span.className = span.className.split(/\s+/).filter((c) => c !== cls).join(' ')
      }
    },
    add(cls) { this.toggle(cls, true) },
    remove(cls) { this.toggle(cls, false) },
    contains(cls) { return (' ' + span.className + ' ').includes(' ' + cls + ' ') },
  }
  return span
}
const mockDocument = {
  createElement: () => createMockSpan(),
}
globalThis.document = mockDocument

// stub i18n —— 直接返回 key，方便断言
const stubI18n = {
  t: (key) => `[${key}]`,
  onLocaleChange: () => {},
}

// 用动态 import 注入 stub，避开真实 i18n 依赖
const moduleUrl = new URL('../src/host/ui/RealtimeStatusController.js', import.meta.url)
const moduleSource = await import('node:fs').then((fs) => fs.promises.readFile(moduleUrl, 'utf8'))
// 替换 import { t } from '../../i18n/index.js' 为本地 stub —— 通过 vm/eval 实现略复杂；
// 简化策略：直接用真实 i18n（i18n/index.js 应该能在 Node 下加载），如果不行再 stub
const { RealtimeStatusController } = await import('../src/host/ui/RealtimeStatusController.js')

function makeRoot() {
  return createMockSpan()
}

describe('RealtimeStatusController', () => {
  let root
  let ctrl

  beforeEach(() => {
    root = makeRoot()
    ctrl = new RealtimeStatusController(root)
  })

  it('实例化后 root 包含 5 个字段 + 4 个分隔符', () => {
    // 5 个 item（project / bpm / playhead / editor / selection）+ 4 个 divider = 9 个 children
    assert.equal(root.children.length, 9)
    const items = root.children.filter((c) => c.dataset?.field)
    assert.deepEqual(items.map((c) => c.dataset.field), ['project', 'bpm', 'playhead', 'editor', 'selection'])
  })

  it('selection 字段默认隐藏（无选区时不占位）', () => {
    const items = root.children.filter((c) => c.dataset?.field)
    const selectionItem = items.find((c) => c.dataset.field === 'selection')
    assert.match(selectionItem.className, /is-hidden/)
  })

  it('setProject 更新项目名 + BPM', () => {
    ctrl.setProject({
      name: 'Test Song',
      tempoData: { tempos: [{ bpm: 140 }] },
      ppq: 480,
    })
    const items = root.children.filter((c) => c.dataset?.field)
    const projectItem = items.find((c) => c.dataset.field === 'project')
    const bpmItem = items.find((c) => c.dataset.field === 'bpm')
    const projectValue = projectItem.children.find((c) => c.className.includes('value'))
    const bpmValue = bpmItem.children.find((c) => c.className.includes('value'))
    assert.equal(projectValue.textContent, 'Test Song')
    assert.equal(bpmValue.textContent, '140')
  })

  it('setProject 空 name 时显示"untitled" i18n', () => {
    ctrl.setProject({ name: null, tempoData: null, ppq: 480 })
    const items = root.children.filter((c) => c.dataset?.field)
    const projectItem = items.find((c) => c.dataset.field === 'project')
    const projectValue = projectItem.children.find((c) => c.className.includes('value'))
    // 当真实 i18n 加载时返回 i18n value（如 "未命名"）；当 i18n 未加载时返回 i18n key
    // 两种都接受—— 关键是不为空字符串
    assert.notEqual(projectValue.textContent, '')
  })

  it('setPlayhead 0 秒 → 1.1.0000 · 0:00.000', () => {
    ctrl.setProject({ name: 'X', tempoData: null, ppq: 480 })
    ctrl.setPlayhead(0)
    const items = root.children.filter((c) => c.dataset?.field)
    const ph = items.find((c) => c.dataset.field === 'playhead')
    const phValue = ph.children.find((c) => c.className.includes('value'))
    assert.equal(phValue.textContent, '1.1.0000 · 0:00.000')
  })

  it('setPlayhead 0.5 秒（120 BPM 4/4）→ 1.2.0000 · 0:00.500', () => {
    ctrl.setProject({ name: 'X', tempoData: null, ppq: 480 })
    ctrl.setPlayhead(0.5)
    const items = root.children.filter((c) => c.dataset?.field)
    const ph = items.find((c) => c.dataset.field === 'playhead')
    const phValue = ph.children.find((c) => c.className.includes('value'))
    assert.equal(phValue.textContent, '1.2.0000 · 0:00.500')
  })

  it('同一时间点重复 setPlayhead 不重复写 DOM', () => {
    ctrl.setProject({ name: 'X', tempoData: null, ppq: 480 })
    ctrl.setPlayhead(1.0)
    const items = root.children.filter((c) => c.dataset?.field)
    const ph = items.find((c) => c.dataset.field === 'playhead')
    const phValue = ph.children.find((c) => c.className.includes('value'))
    const before = phValue.textContent
    // 模拟"DOM 写入计数"——重置为标记，再调一次相同时间，应该没被覆盖
    phValue.textContent = '__INTACT__'
    ctrl.setPlayhead(1.0)
    assert.equal(phValue.textContent, '__INTACT__', '同时间点不该再写 DOM')
    // 不同时间点会写
    ctrl.setPlayhead(2.0)
    assert.notEqual(phValue.textContent, '__INTACT__')
    assert.notEqual(phValue.textContent, before)
  })

  it('tempoData 变化时 bar-beat 重新计算', () => {
    ctrl.setProject({ name: 'X', tempoData: null, ppq: 480 })
    ctrl.setPlayhead(1.5)
    const items = root.children.filter((c) => c.dataset?.field)
    const ph = items.find((c) => c.dataset.field === 'playhead')
    const phValue = ph.children.find((c) => c.className.includes('value'))
    // 4/4 拍下 1.5s = 第 1 小节第 4 拍
    assert.match(phValue.textContent, /^1\.4\./)

    // 切到 3/4 拍
    ctrl.setProject({
      name: 'X',
      tempoData: {
        tempos: [{ bpm: 120, time: 0, ticks: 0 }],
        timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }],
      },
      ppq: 480,
    })
    // 同样的 1.5s 现在应该是第 2 小节第 1 拍
    ctrl.setPlayhead(1.5)
    assert.match(phValue.textContent, /^2\.1\./)
  })

  it('setEditor mode 为 null 显示 idle', () => {
    ctrl.setEditor({ mode: null, trackName: null })
    const items = root.children.filter((c) => c.dataset?.field)
    const editor = items.find((c) => c.dataset.field === 'editor')
    const editorValue = editor.children.find((c) => c.className.includes('value'))
    assert.notEqual(editorValue.textContent, '')
  })

  it('setEditor 同时有 mode 和 trackName 时合并显示', () => {
    ctrl.setEditor({ mode: 'note', trackName: 'Vocal Lead' })
    const items = root.children.filter((c) => c.dataset?.field)
    const editor = items.find((c) => c.dataset.field === 'editor')
    const editorValue = editor.children.find((c) => c.className.includes('value'))
    assert.match(editorValue.textContent, /Vocal Lead/)
  })

  // ── 选区字段 ────────────────────────────────
  function findSelectionRefs() {
    const items = root.children.filter((c) => c.dataset?.field)
    const item = items.find((c) => c.dataset.field === 'selection')
    return {
      item,
      value: item.children.find((c) => c.className.includes('value')),
      // editor 字段后那个 divider 就是 selection 的"前置分隔符"
      editorDivider: (() => {
        const editorIdx = root.children.findIndex((c) => c.dataset?.field === 'editor')
        return root.children[editorIdx + 1]  // 下一个就是 divider
      })(),
    }
  }

  it('setSelection(null) → 字段隐藏 + 前置 divider 隐藏', () => {
    ctrl.setSelection(null)
    const { item, editorDivider } = findSelectionRefs()
    assert.match(item.className, /is-hidden/)
    assert.match(editorDivider.className, /is-hidden/)
  })

  it('setSelection({ count: 0 }) → 字段隐藏', () => {
    ctrl.setSelection({ count: 0, midiLow: 0, midiHigh: 0, spanSec: 0 })
    const { item } = findSelectionRefs()
    assert.match(item.className, /is-hidden/)
  })

  it('setSelection 单 note → "1 ... · C4 · ..."', () => {
    ctrl.setSelection({ count: 1, midiLow: 60, midiHigh: 60, spanSec: 0.5 })
    const { item, value, editorDivider } = findSelectionRefs()
    assert.doesNotMatch(item.className, /is-hidden/)
    assert.doesNotMatch(editorDivider.className, /is-hidden/)
    // 不限制 i18n 文本的精确文案，只看格式：含 C4、含 500ms
    assert.match(value.textContent, /C4/)
    assert.match(value.textContent, /500ms/)
  })

  it('setSelection 多 note 跨音域 → 用 en dash 分隔', () => {
    ctrl.setSelection({ count: 5, midiLow: 60, midiHigh: 67, spanSec: 2.34 })
    const { value } = findSelectionRefs()
    assert.match(value.textContent, /C4–G4/)  // 注意是 en dash 不是连字符
    assert.match(value.textContent, /2\.34s/)
  })

  it('从有选区到 null → 字段重新隐藏', () => {
    ctrl.setSelection({ count: 3, midiLow: 60, midiHigh: 64, spanSec: 1.0 })
    let { item } = findSelectionRefs()
    assert.doesNotMatch(item.className, /is-hidden/)
    ctrl.setSelection(null)
    ;({ item } = findSelectionRefs())
    assert.match(item.className, /is-hidden/)
  })
})
