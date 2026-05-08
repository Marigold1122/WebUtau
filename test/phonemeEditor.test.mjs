import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hitTestPhonemeTiming,
  isPointInPhonemeTimingLane,
} from '../src/modules/PhonemeEditor.js'
import {
  buildPhonemeTimingPreviewEdit,
  buildPhonemeTimingResetEdit,
  createPhonemeTimingSession,
} from '../src/modules/PhonemeTimingPreview.js'
import { projectPhonemeTimingItem } from '../src/modules/PhonemeTimingProjection.js'

const lane = { left: 10, top: 20, width: 600, height: 76 }
const adapter = {
  pixelsPerSecond: 200,
  minPixelsPerSecond: 100,
  timeToX: (seconds) => seconds * 200,
  durationToWidth: (seconds) => seconds * 200,
  xToMs: (x) => x / 200 * 1000,
  xToPartTick: (_item, x) => x * 2.4,
}

function item(overrides = {}) {
  return {
    phraseIndex: 0,
    partIndex: 0,
    noteKey: 'part:0|note:1',
    phonemeIndex: 2,
    label: 'a',
    positionTick: 480,
    endTick: 624,
    positionMs: 1000,
    endMs: 1300,
    preutterMs: 90,
    overlapMs: 45,
    autoPreutterMs: 80,
    autoOverlapMs: 40,
    offsetTick: 2,
    preutterDeltaMs: 10,
    overlapDeltaMs: 5,
    envelopePoints: [
      { xMs: -80, yPercent: 0 },
      { xMs: 40, yPercent: 100 },
      { xMs: 100, yPercent: 50 },
      { xMs: 260, yPercent: 80 },
      { xMs: 300, yPercent: 0 },
    ],
    ...overrides,
  }
}

function previousItem(overrides = {}) {
  return item({
    noteKey: 'part:0|note:0',
    phonemeIndex: 1,
    positionTick: 336,
    endTick: 480,
    positionMs: 700,
    endMs: 1000,
    preutterMs: 40,
    overlapMs: 10,
    autoPreutterMs: 40,
    autoOverlapMs: 10,
    offsetTick: null,
    preutterDeltaMs: null,
    overlapDeltaMs: null,
    envelopePoints: [
      { xMs: -40, yPercent: 0 },
      { xMs: 5, yPercent: 100 },
      { xMs: 5, yPercent: 100 },
      { xMs: 265, yPercent: 80 },
      { xMs: 300, yPercent: 0 },
    ],
    ...overrides,
  })
}

function validatedPair() {
  return [
    previousItem({
      envelopePoints: [
        { xMs: -40, yPercent: 0 },
        { xMs: 5, yPercent: 100 },
        { xMs: 5, yPercent: 100 },
        { xMs: 210, yPercent: 80 },
        { xMs: 255, yPercent: 0 },
      ],
    }),
    item({
      envelopePoints: [
        { xMs: -90, yPercent: 0 },
        { xMs: -45, yPercent: 100 },
        { xMs: 0, yPercent: 50 },
        { xMs: 260, yPercent: 80 },
        { xMs: 300, yPercent: 0 },
      ],
    }),
  ]
}

const point = (x, y) => ({ x: lane.left + x, y: lane.top + y })
const px = (value) => Math.round(value)

test('lane gating rejects note canvas points', () => {
  assert.equal(isPointInPhonemeTimingLane({ x: 20, y: 10 }, lane), false)
  assert.equal(hitTestPhonemeTiming({ x: 20, y: 10 }, [item()], adapter, lane), null)
})

test('hit test detects position preutter overlap', () => {
  assert.equal(hitTestPhonemeTiming(point(200, 48), [item()], adapter, lane)?.kind, 'position')
  assert.equal(hitTestPhonemeTiming(point(184, 59.5), [item()], adapter, lane)?.kind, 'preutter')
  assert.equal(hitTestPhonemeTiming(point(208, 35.5), [item()], adapter, lane)?.kind, 'overlap')
})

test('hit test prioritizes preutter overlap before position like OpenUtau', () => {
  const source = item({ envelopePoints: [{ xMs: 0, yPercent: 50 }, { xMs: 40, yPercent: 100 }] })
  assert.equal(hitTestPhonemeTiming(point(200, 47.5), [source], adapter, lane)?.kind, 'preutter')
})

test('hit test ignores envelope points 2 3 4', () => {
  assert.equal(hitTestPhonemeTiming(point(220, 47.5), [item()], adapter, lane), null)
})

test('hit test ignores hidden error and low zoom items', () => {
  assert.equal(hitTestPhonemeTiming(point(200, 48), [item({ hiddenReason: 'note_error' })], adapter, lane), null)
  assert.equal(hitTestPhonemeTiming(point(200, 48), [item({ error: 'phoneme_error' })], adapter, lane), null)
  assert.equal(hitTestPhonemeTiming(point(200, 48), [item()], { ...adapter, pixelsPerSecond: 80 }, lane), null)
})

test('position preview uses tick delta without mutating source item', () => {
  const source = item()
  const hit = hitTestPhonemeTiming(point(200, 48), [source], adapter, lane)
  const session = createPhonemeTimingSession(hit, point(200, 48), adapter, lane)
  const preview = buildPhonemeTimingPreviewEdit(session, point(210, 48), adapter)

  assert.equal(preview.editType, 'offsetTick')
  assert.equal(preview.value, 26)
  assert.equal(preview.item.positionTick, 504)
  assert.equal(preview.item.positionMs, 1050)
  assert.equal(preview.item.endTick, 624)
  assert.equal(preview.item.endMs, 1300)
  assert.equal(source.positionTick, 480)
})

test('position preview moves only points adjacent to the position line like OpenUtau', () => {
  const [previous, current] = validatedPair()
  const items = [previous, current]
  const hit = hitTestPhonemeTiming(point(200, 48), items, adapter, lane)
  const session = createPhonemeTimingSession(hit, point(200, 48), adapter, lane, items)
  const preview = buildPhonemeTimingPreviewEdit(session, point(210, 48), adapter)
  const previousPreview = preview.items.find((entry) => entry.noteKey === previous.noteKey)
  const previousProjection = projectPhonemeTimingItem(previousPreview, adapter, lane.height)
  const currentProjection = projectPhonemeTimingItem(preview.item, adapter, lane.height)

  assert.equal(preview.item.positionMs, 1050)
  assert.equal(previousPreview.endMs, 1050)
  assert.equal(px(previousProjection.points[0].x), 132)
  assert.equal(px(previousProjection.points[3].x), 192)
  assert.equal(px(previousProjection.points[4].x), 201)
  assert.equal(px(currentProjection.points[0].x), 192)
  assert.equal(px(currentProjection.points[1].x), 201)
  assert.equal(px(currentProjection.points[4].x), 260)
})

test('preutter preview clamps lower bound', () => {
  const hit = hitTestPhonemeTiming(point(184, 59.5), [item()], adapter, lane)
  const session = createPhonemeTimingSession(hit, point(184, 59.5), adapter, lane)
  const preview = buildPhonemeTimingPreviewEdit(session, point(260, 59.5), adapter)

  assert.equal(preview.editType, 'preutterDeltaMs')
  assert.equal(preview.value, -80)
  assert.equal(preview.item.preutterMs, 0)
  assert.equal(preview.item.envelopePoints[0].xMs, 0)
  assert.equal(preview.item.envelopePoints[1].xMs, 45)
  assert.equal(preview.item.envelopePoints[2].xMs, 45)
})

test('preutter preview keeps OpenUtau overlap span when previous phoneme overlaps', () => {
  const previous = previousItem()
  const current = item({ overlapDeltaMs: null })
  const items = [previous, current]
  const hit = hitTestPhonemeTiming(point(184, 59.5), items, adapter, lane)
  const session = createPhonemeTimingSession(hit, point(184, 59.5), adapter, lane, items)
  const preview = buildPhonemeTimingPreviewEdit(session, point(180, 59.5), adapter)

  assert.equal(preview.item.preutterMs, 100)
  assert.equal(preview.item.envelopePoints[0].xMs, -100)
  assert.equal(preview.item.envelopePoints[1].xMs, -55)
})

test('overlap preview uses current preutter reference', () => {
  const hit = hitTestPhonemeTiming(point(208, 35.5), [item()], adapter, lane)
  const session = createPhonemeTimingSession(hit, point(208, 35.5), adapter, lane)
  const preview = buildPhonemeTimingPreviewEdit(session, point(220, 35.5), adapter)

  assert.equal(preview.editType, 'overlapDeltaMs')
  assert.equal(preview.value, 150)
  assert.equal(preview.item.overlapMs, 190)
  assert.equal(preview.item.envelopePoints[1].xMs, 100)
})

test('overlap preview value follows pointer left while envelope point clamps like OpenUtau', () => {
  const hit = hitTestPhonemeTiming(point(208, 35.5), [item()], adapter, lane)
  const session = createPhonemeTimingSession(hit, point(208, 35.5), adapter, lane)
  const preview = buildPhonemeTimingPreviewEdit(session, point(180, 35.5), adapter)
  const projection = projectPhonemeTimingItem(preview.item, adapter, lane.height)

  assert.equal(preview.editType, 'overlapDeltaMs')
  assert.equal(preview.value, -50)
  assert.equal(preview.item.overlapMs, -10)
  assert.equal(preview.item.envelopePoints[0].xMs, -90)
  assert.equal(preview.item.envelopePoints[1].xMs, -85)
  assert.equal(projection.points[0].x, 182)
  assert.equal(projection.points[1].x, 183)
})

test('overlap preview left drag compresses previous tail after point clamp', () => {
  const previous = previousItem()
  const current = item()
  const items = [previous, current]
  const hit = hitTestPhonemeTiming(point(208, 35.5), items, adapter, lane)
  const session = createPhonemeTimingSession(hit, point(208, 35.5), adapter, lane, items)
  const preview = buildPhonemeTimingPreviewEdit(session, point(180, 35.5), adapter)
  const previousPreview = preview.items.find((entry) => entry.noteKey === previous.noteKey)
  const previousProjection = projectPhonemeTimingItem(previousPreview, adapter, lane.height)
  const currentProjection = projectPhonemeTimingItem(preview.item, adapter, lane.height)

  assert.equal(preview.value, -50)
  assert.equal(preview.item.envelopePoints[1].xMs, -85)
  assert.equal(previousPreview.envelopePoints[3].xMs, 165)
  assert.equal(previousPreview.envelopePoints[4].xMs, 200)
  assert.equal(previousProjection.points[4].x, 180)
  assert.equal(currentProjection.points[1].x, 183)
})

test('overlap preview extends previous phoneme tail like OpenUtau validate', () => {
  const previous = previousItem()
  const current = item()
  const items = [previous, current]
  const hit = hitTestPhonemeTiming(point(208, 35.5), items, adapter, lane)
  const session = createPhonemeTimingSession(hit, point(208, 35.5), adapter, lane, items)
  const preview = buildPhonemeTimingPreviewEdit(session, point(270, 35.5), adapter)
  const previousPreview = preview.items.find((entry) => entry.noteKey === previous.noteKey)
  const previousProjection = projectPhonemeTimingItem(previousPreview, adapter, lane.height)
  const currentProjection = projectPhonemeTimingItem(preview.item, adapter, lane.height)

  assert.equal(preview.value, 400)
  assert.equal(preview.item.overlapMs, 440)
  assert.equal(preview.item.envelopePoints[1].xMs, 350)
  assert.equal(previousPreview.envelopePoints[3].xMs, 210)
  assert.equal(previousPreview.envelopePoints[4].xMs, 650)
  assert.equal(previousProjection.points[4].x, 270)
  assert.equal(currentProjection.points[1].x, 270)
})

test('projection draws OpenUtau-style position line and envelope points', () => {
  const projection = projectPhonemeTimingItem(item(), adapter, lane.height)
  assert.equal(projection.positionX, 200)
  assert.equal(projection.points[0].x, 184)
  assert.equal(projection.points[0].y, 59.5)
  assert.equal(projection.points[1].x, 208)
  assert.equal(projection.points[1].y, 35.5)
})

test('reset intent contains enum and null value', () => {
  const reset = buildPhonemeTimingResetEdit({ kind: 'preutter', noteKey: 'n', phonemeIndex: 1 })
  assert.deepEqual(reset, {
    hit: { kind: 'preutter', noteKey: 'n', phonemeIndex: 1, partIndex: undefined, phraseIndex: undefined },
    editType: 'resetPreutter',
    value: null,
  })
})
