import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PhonemeEditor } from '../src/modules/PhonemeEditor.js'

const lane = { left: 0, top: 0, width: 700, height: 76 }

function item() {
  return {
    phraseIndex: 0,
    partIndex: 0,
    noteKey: 'part:0|note:1|pos:480|dur:144|tone:60',
    phonemeIndex: 2,
    label: 'a',
    positionMs: 1000,
    endMs: 1300,
    positionTick: 480,
    endTick: 624,
    preutterMs: 80,
    overlapMs: 40,
    autoPreutterMs: 80,
    autoOverlapMs: 40,
    offsetTick: 0,
    envelopePoints: [
      { xMs: -80, yPercent: 0 },
      { xMs: 40, yPercent: 100 },
      { xMs: 100, yPercent: 100 },
      { xMs: 260, yPercent: 80 },
      { xMs: 300, yPercent: 0 },
    ],
  }
}

function storeWith(items) {
  let hover = null
  let preview = null
  return {
    getItems: () => items.map((entry) => ({ ...entry, envelopePoints: entry.envelopePoints.map((point) => ({ ...point })) })),
    getHover: () => hover,
    getPreview: () => preview,
    setHover: (next) => { hover = next },
    setPreview: (next) => { preview = next },
  }
}

test('phoneme pointer move updates preview without committing', () => {
  const commits = []
  const editor = new PhonemeEditor({
    store: storeWith([item()]),
    getLaneRect: () => lane,
    commitPreview: (preview) => {
      commits.push(preview)
      return Promise.resolve()
    },
  })

  assert.equal(editor.handlePointerDown({ clientX: 300, clientY: 48 }), true)
  assert.equal(editor.handlePointerMove({ clientX: 310, clientY: 48 }), true)
  assert.equal(commits.length, 0)

  assert.equal(editor.handlePointerUp(), true)
  assert.equal(commits.length, 1)
  assert.equal(commits[0].editType, 'offsetTick')
})
