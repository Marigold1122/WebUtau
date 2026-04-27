import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { PhonemeTimingStore } from '../src/modules/PhonemeTimingStore.js'

let store

beforeEach(() => {
  store = new PhonemeTimingStore()
})

test('PhonemeTimingStore stores normalized snapshot data without mutating source objects', () => {
  const source = {
    jobId: 'job-1',
    midiPpq: 480,
    revision: 'rev-1',
    items: [{
      phraseIndex: 2,
      partIndex: 0,
      noteKey: 'part:0|note:1|pos:240|dur:120|tone:60',
      phonemeIndex: 3,
      label: 'a',
      rawLabel: 'a',
      positionTick: 240,
      endTick: 360,
      positionMs: 500,
      endMs: 750,
      preutterMs: 80,
      overlapMs: 40,
      envelopePoints: [
        { xMs: -80, yPercent: 0 },
        { xMs: 0, yPercent: 100 },
      ],
    }],
  }

  store.setSnapshot(source)
  source.items[0].label = 'mutated'
  source.items[0].envelopePoints[0].xMs = 999

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.jobId, 'job-1')
  assert.equal(snapshot.midiPpq, 480)
  assert.equal(snapshot.revision, 'rev-1')
  assert.equal(snapshot.items[0].label, 'a')
  assert.equal(snapshot.items[0].envelopePoints[0].xMs, -80)
})

test('PhonemeTimingStore returns copies to keep callers from editing internal state', () => {
  store.setSnapshot({
    items: [{
      noteKey: 'n',
      positionMs: 0,
      endMs: 100,
      envelopePoints: [{ xMs: 0, yPercent: 100 }],
    }],
  })

  const items = store.getItems()
  items[0].label = 'changed'
  items[0].envelopePoints[0].yPercent = 0

  const nextItems = store.getItems()
  assert.equal(nextItems[0].label, '')
  assert.equal(nextItems[0].envelopePoints[0].yPercent, 100)
})

test('PhonemeTimingStore isolates hover and preview from snapshot state', () => {
  store.setSnapshot({
    items: [{
      noteKey: 'n',
      label: 'a',
      positionMs: 0,
      endMs: 100,
      envelopePoints: [{ xMs: 0, yPercent: 100 }],
    }],
  })

  const item = store.getItems()[0]
  store.setHover({ noteKey: item.noteKey, phonemeIndex: item.phonemeIndex })
  store.setPreview({ item, items: [item], editType: 'offsetTick', value: 12 })

  const preview = store.getPreview()
  preview.item.label = 'preview-mutated'
  preview.items[0].label = 'items-mutated'

  assert.deepEqual(store.getHover(), { noteKey: 'n', phonemeIndex: -1 })
  assert.equal(store.getItems()[0].label, 'a')
  assert.equal(store.getPreview().item.label, 'a')
  assert.equal(store.getPreview().items[0].label, 'a')
})

test('PhonemeTimingStore notifies subscribers on snapshot changes and clear', () => {
  let calls = 0
  const unsubscribe = store.subscribe(() => { calls += 1 })

  store.setSnapshot({ items: [{ noteKey: 'n', positionMs: 0, endMs: 100 }] })
  store.clear()
  unsubscribe()
  store.setSnapshot({ items: [{ noteKey: 'm', positionMs: 0, endMs: 100 }] })

  assert.equal(calls, 2)
  assert.equal(store.hasSnapshot(), true)
})

test('PhonemeTimingStore falls back safely for invalid numeric fields', () => {
  store.setSnapshot({
    jobId: 'job-invalid',
    midiPpq: 'not-a-number',
    revision: 123,
    items: [{
      phraseIndex: 'bad',
      partIndex: 1.4,
      phonemeIndex: undefined,
      positionTick: 10.8,
      endTick: Number.NaN,
      positionMs: 'oops',
      endMs: 250,
      preutterMs: Number.POSITIVE_INFINITY,
      overlapMs: -12,
      autoPreutterMs: null,
      autoOverlapMs: '44.5',
      offsetTick: 'not-a-number',
      preutterDeltaMs: '3.25',
      overlapDeltaMs: undefined,
      envelopePoints: [
        { xMs: '0', yPercent: '100' },
        { xMs: 'bad', yPercent: 50 },
      ],
      error: '',
      hiddenReason: 'note_error',
    }],
  })

  const snapshot = store.getSnapshot()
  const item = snapshot.items[0]
  assert.equal(snapshot.jobId, 'job-invalid')
  assert.equal(snapshot.midiPpq, 480)
  assert.equal(snapshot.revision, '')
  assert.equal(item.phraseIndex, -1)
  assert.equal(item.partIndex, 1)
  assert.equal(item.phonemeIndex, -1)
  assert.equal(item.positionTick, 11)
  assert.equal(item.endTick, 0)
  assert.equal(item.positionMs, null)
  assert.equal(item.endMs, 250)
  assert.equal(item.preutterMs, 0)
  assert.equal(item.overlapMs, -12)
  assert.equal(item.autoPreutterMs, 0)
  assert.equal(item.autoOverlapMs, 44.5)
  assert.equal(item.offsetTick, null)
  assert.equal(item.preutterDeltaMs, 3.25)
  assert.equal(item.overlapDeltaMs, null)
  assert.deepEqual(item.envelopePoints, [{ xMs: 0, yPercent: 100 }])
  assert.equal(item.error, null)
  assert.equal(item.hiddenReason, 'note_error')
})
