import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyPhonemeTimingCommitResponse,
  buildPhonemeTimingCommitRequest,
  collectPreviewPhraseIndices,
  commitPhonemeTimingPreview,
} from '../src/modules/PhonemeTimingCommit.js'

function preview(overrides = {}) {
  return {
    hit: { partIndex: 0, noteKey: 'part:0|note:1|pos:0|dur:480|tone:60', phonemeIndex: 2, phraseIndex: 3 },
    editType: 'overlapDeltaMs',
    value: 25.5,
    items: [{ phraseIndex: 2 }, { phraseIndex: 3 }],
    ...overrides,
  }
}

function deps(response = { ok: true, snapshot: { revision: 'next', items: [] }, affectedIndices: [2, 3] }) {
  const calls = []
  let storeSnapshot = { revision: 'rev-1', items: [] }
  const phrases = [
    { index: 0, notes: [{ tick: 0, durationTicks: 120, midi: 60 }], inputHash: 'h0|pitch:v1', baseInputHash: 'h0' },
    { index: 1, notes: [{ tick: 120, durationTicks: 120, midi: 61 }], inputHash: 'h1', baseInputHash: 'h1' },
    { index: 2, notes: [{ tick: 240, durationTicks: 120, midi: 62 }], inputHash: 'h2', baseInputHash: 'h2' },
    { index: 3, notes: [{ tick: 360, durationTicks: 120, midi: 63 }], inputHash: 'h3', baseInputHash: 'h3' },
    { index: 4, notes: [{ tick: 480, durationTicks: 120, midi: 64 }], inputHash: 'h4', baseInputHash: 'h4' },
    { index: 5, notes: [{ tick: 600, durationTicks: 120, midi: 65 }], inputHash: 'h5', baseInputHash: 'h5' },
  ]
  return {
    calls,
    api: {
      applyPhonemeTimingEdit: async (jobId, request) => {
        calls.push(['api', jobId, request])
        return response
      },
    },
    audio: { cancelPhrases: (indices) => calls.push(['cancel', indices]) },
    cache: {
      capture: (indices) => {
        calls.push(['capture', indices])
        return indices.map((phraseIndex) => ({ phraseIndex, existed: true, entry: { inputHash: `h${phraseIndex}` } }))
      },
      clearAbove: (count) => calls.push(['clearAbove', count]),
      clearIndices: (indices) => calls.push(['clear', indices]),
      restore: (snapshot) => calls.push(['restore', snapshot.map((entry) => entry.phraseIndex)]),
    },
    jobs: {
      beginInteractiveEdit: (indices) => {
        calls.push(['begin', indices])
        return 'edit-1'
      },
      endInteractiveEdit: (token) => calls.push(['end', token]),
      restartForEdit: (count) => calls.push(['restart', count]),
      restartForPhonemeTimingEdit: (options) => {
        calls.push(['restartPhoneme', options])
        // Simulate the real RenderJobManager behavior: when phrasesChanged it
        // delegates to restartForEdit, which clears phonemeTimingStore. The commit
        // flow must re-apply the snapshot afterwards (Bug 3 fix).
        if (options.phrasesChanged) {
          storeSnapshot = null
          calls.push(['storeClearedByRestart'])
        }
      },
    },
    phraseStore: {
      getJobId: () => 'job-1',
      getPhrases: () => phrases,
      rebuildFromEdit: (phrases) => calls.push(['phrases', phrases.length]),
    },
    store: {
      getSnapshot: () => storeSnapshot,
      setSnapshot: (snapshot) => {
        storeSnapshot = snapshot
        calls.push(['snapshot', snapshot.revision])
      },
      setPreview: (preview) => calls.push(['preview', preview]),
    },
    finalSnapshot: () => storeSnapshot,
  }
}

test('buildPhonemeTimingCommitRequest freezes field-level payload and revision', () => {
  assert.deepEqual(buildPhonemeTimingCommitRequest(preview(), { revision: 'rev-1' }), {
    partIndex: 0,
    noteKey: 'part:0|note:1|pos:0|dur:480|tone:60',
    phonemeIndex: 2,
    editType: 'overlapDeltaMs',
    value: 25.5,
    clientRevision: 'rev-1',
  })
})

test('collectPreviewPhraseIndices keeps current and linked phrase seeds unique', () => {
  assert.deepEqual(collectPreviewPhraseIndices(preview()), [2, 3])
})

test('commitPhonemeTimingPreview posts once and applies authoritative snapshot', async () => {
  const d = deps()
  await commitPhonemeTimingPreview(preview(), d)

  assert.equal(d.calls.filter((call) => call[0] === 'api').length, 1)
  assert.deepEqual(d.calls.find((call) => call[0] === 'clear')?.[1], [2, 3])
  assert.deepEqual(d.calls.find((call) => call[0] === 'cancel')?.[1], [2, 3])
  assert.deepEqual(d.calls.find((call) => call[0] === 'restartPhoneme')?.[1].affectedIndices, [2, 3])
  assert.deepEqual(d.calls.find((call) => call[0] === 'snapshot'), ['snapshot', 'next'])
  assert.deepEqual(d.calls.at(-1), ['end', 'edit-1'])
})

test('failed phoneme timing commit restores cache and clears preview', async () => {
  const d = deps()
  d.api.applyPhonemeTimingEdit = async () => { throw new Error('snapshot_conflict') }

  await assert.rejects(() => commitPhonemeTimingPreview(preview(), d), /snapshot_conflict/)
  assert.deepEqual(d.calls.map((call) => call[0]), ['capture', 'begin', 'clear', 'cancel', 'restore', 'preview', 'end'])
})

test('invalid preview is rejected before applyPhonemeTimingEdit', async () => {
  const d = deps()

  await assert.rejects(() => commitPhonemeTimingPreview(preview({ value: '25.5' }), d), /Invalid/)
  assert.equal(d.calls.length, 0)
})

test('malformed success response is rejected before cache side effects', () => {
  const d = deps()

  assert.throws(
    () => applyPhonemeTimingCommitResponse({ ok: true, snapshot: {}, phrases: [] }, preview(), d),
    /Invalid phoneme timing edit response/,
  )
  assert.equal(d.calls.length, 0)
})

test('response without phrases skips rebuild and uses stable timing path', () => {
  const d = deps()
  applyPhonemeTimingCommitResponse({
    ok: true,
    snapshot: { revision: 'after-stable' },
    affectedIndices: [1, 2],
  }, preview(), d)

  assert.equal(d.calls.some((call) => call[0] === 'phrases'), false)
  const restart = d.calls.find((call) => call[0] === 'restartPhoneme')?.[1]
  assert.equal(restart.phrasesChanged, false)
  assert.deepEqual(restart.affectedIndices, [1, 2])
})

test('response with phrases always rebuilds phraseStore and restores snapshot', () => {
  const d = deps()
  applyPhonemeTimingCommitResponse({
    ok: true,
    snapshot: { revision: 'after-structure' },
    affectedIndices: [1],
    phrases: [
      { index: 0, startMs: 0, durationMs: 250, notes: [{ position: 0, duration: 120, tone: 60 }] },
      { index: 1, startMs: 250, durationMs: 250, notes: [{ position: 120, duration: 120, tone: 61 }] },
    ],
  }, preview(), d)

  assert.deepEqual(d.calls.find((call) => call[0] === 'phrases'), ['phrases', 2])
  const restart = d.calls.find((call) => call[0] === 'restartPhoneme')?.[1]
  assert.equal(restart.phrasesChanged, true)
  // Bug 3 fix: even though restartForPhonemeTimingEdit clears the store internally
  // when phrasesChanged, the commit flow re-applies the authoritative snapshot.
  assert.equal(d.finalSnapshot()?.revision, 'after-structure')
})

test('large affected list with phrasesChanged=false falls back to wide restart', () => {
  const d = deps()
  applyPhonemeTimingCommitResponse({
    ok: true,
    snapshot: { revision: 'after-anomaly' },
    affectedIndices: [0, 1, 2, 3, 4, 5],
  }, preview(), d)

  // 6 phrases total, affected = 6 > phraseCount/2 and >4 threshold,
  // treated as anomalous structure change.
  const restart = d.calls.find((call) => call[0] === 'restartPhoneme')?.[1]
  assert.equal(restart.phrasesChanged, true)
  assert.equal(d.finalSnapshot()?.revision, 'after-anomaly')
})

test('cross-phrase response invalidates phrases beyond the optimistic seed', async () => {
  const d = deps({
    ok: true,
    snapshot: { revision: 'cross-phrase' },
    affectedIndices: [1, 2, 3], // backend reports prev (1) + seeded (2,3)
  })
  // Seed only contains the directly-hit phrase; backend tells us a neighbor is also dirty.
  const previewWithSinglePhrase = { ...preview(), items: [{ phraseIndex: 3 }], hit: { ...preview().hit, phraseIndex: 3 } }

  await commitPhonemeTimingPreview(previewWithSinglePhrase, d)

  // Initial seed clear: only phrase 3.
  assert.deepEqual(d.calls.find((call) => call[0] === 'clear')?.[1], [3])
  // After response: phrases 1 and 2 (affected − seed) get cleared and audio cancelled.
  const clears = d.calls.filter((call) => call[0] === 'clear')
  assert.deepEqual(clears.at(-1)?.[1], [1, 2])
  const cancels = d.calls.filter((call) => call[0] === 'cancel')
  assert.deepEqual(cancels.at(-1)?.[1], [1, 2])
})

test('commit failure does not trigger any other write endpoints', async () => {
  const d = deps()
  const otherEndpointCalls = []
  d.api = {
    applyPhonemeTimingEdit: async () => { throw new Error('snapshot_conflict') },
    applyPitchDeviation: () => otherEndpointCalls.push('pitch'),
    applyNoteParams: () => otherEndpointCalls.push('note-params'),
    editNotes: () => otherEndpointCalls.push('edit-notes'),
  }

  await assert.rejects(() => commitPhonemeTimingPreview(preview(), d), /snapshot_conflict/)
  assert.deepEqual(otherEndpointCalls, [])
})
