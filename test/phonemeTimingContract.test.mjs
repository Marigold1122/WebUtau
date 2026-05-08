import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PHONEME_TIMING_EDIT_TYPES,
  assertValidPhonemeTimingEditRequest,
  buildPhonemeTimingEditRequest,
  normalizePhonemeTimingEditResponse,
  phonemeTimingEditTypeForHit,
  phonemeTimingResetEditTypeForHit,
} from '../src/shared/phonemeTimingContract.js'

const hit = {
  partIndex: 1,
  noteKey: 'part:1|note:3|pos:240|dur:120|tone:62',
  phonemeIndex: 4,
  phraseIndex: 9,
}

function preview(editType, value) {
  return {
    hit,
    editType,
    value,
    item: { envelopePoints: [{ xMs: 0, yPercent: 100 }] },
    screenX: 320,
  }
}

test('phoneme timing edit type mapping is frozen by hit kind', () => {
  assert.equal(phonemeTimingEditTypeForHit('position'), PHONEME_TIMING_EDIT_TYPES.OFFSET_TICK)
  assert.equal(phonemeTimingEditTypeForHit('preutter'), PHONEME_TIMING_EDIT_TYPES.PREUTTER_DELTA_MS)
  assert.equal(phonemeTimingEditTypeForHit('overlap'), PHONEME_TIMING_EDIT_TYPES.OVERLAP_DELTA_MS)
  assert.equal(phonemeTimingResetEditTypeForHit('position'), PHONEME_TIMING_EDIT_TYPES.RESET_OFFSET)
  assert.equal(phonemeTimingResetEditTypeForHit('preutter'), PHONEME_TIMING_EDIT_TYPES.RESET_PREUTTER)
  assert.equal(phonemeTimingResetEditTypeForHit('overlap'), PHONEME_TIMING_EDIT_TYPES.RESET_OVERLAP)
})

test('buildPhonemeTimingEditRequest emits only field-level DTO data', () => {
  const request = buildPhonemeTimingEditRequest(
    preview(PHONEME_TIMING_EDIT_TYPES.OVERLAP_DELTA_MS, 25.5),
    { revision: 'rev-2' },
  )

  assert.deepEqual(request, {
    partIndex: 1,
    noteKey: hit.noteKey,
    phonemeIndex: 4,
    editType: 'overlapDeltaMs',
    value: 25.5,
    clientRevision: 'rev-2',
  })
  assert.equal('item' in request, false)
  assert.equal('screenX' in request, false)
})

test('reset request value is always null', () => {
  for (const editType of ['resetOffset', 'resetPreutter', 'resetOverlap']) {
    assert.equal(buildPhonemeTimingEditRequest(preview(editType, null), { revision: 'r' }).value, null)
  }
})

test('invalid 4.1 request shapes are rejected before fetch', () => {
  assert.equal(buildPhonemeTimingEditRequest(preview('badType', 1), { revision: 'r' }), null)
  assert.equal(buildPhonemeTimingEditRequest(preview('offsetTick', 1.25), { revision: 'r' }), null)
  assert.equal(buildPhonemeTimingEditRequest(preview('preutterDeltaMs', '12'), { revision: 'r' }), null)
  assert.equal(buildPhonemeTimingEditRequest(preview('resetOffset', 0), { revision: 'r' }), null)
  assert.equal(buildPhonemeTimingEditRequest({ ...preview('offsetTick', 1), hit: { ...hit, noteKey: '' } }, { revision: 'r' }), null)
  assert.throws(() => assertValidPhonemeTimingEditRequest({ editType: 'offsetTick', value: 1 }), /Invalid/)
})

test('normalizePhonemeTimingEditResponse freezes success response shape', () => {
  const response = normalizePhonemeTimingEditResponse({
    ok: true,
    snapshot: { revision: 'next', items: [] },
    affectedIndices: [3, 1, 3, -1],
  })

  assert.deepEqual(response, {
    ok: true,
    snapshot: { revision: 'next', items: [] },
    affectedIndices: [1, 3],
  })
})

test('normalizePhonemeTimingEditResponse rejects malformed success payloads', () => {
  assert.throws(() => normalizePhonemeTimingEditResponse({ ok: false }), /Invalid/)
  assert.throws(() => normalizePhonemeTimingEditResponse({ ok: true, affectedIndices: [] }), /Invalid/)
  assert.throws(() => normalizePhonemeTimingEditResponse({ ok: true, snapshot: {}, affectedIndices: [], phrases: {} }), /Invalid/)
})
