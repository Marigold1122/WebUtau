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
  const phrases = [
    { index: 0, notes: [{ tick: 0, durationTicks: 120, midi: 60 }], inputHash: 'h0|pitch:v1', baseInputHash: 'h0' },
    { index: 1, notes: [{ tick: 120, durationTicks: 120, midi: 61 }], inputHash: 'h1', baseInputHash: 'h1' },
    { index: 2, notes: [{ tick: 240, durationTicks: 120, midi: 62 }], inputHash: 'h2', baseInputHash: 'h2' },
    { index: 3, notes: [{ tick: 360, durationTicks: 120, midi: 63 }], inputHash: 'h3', baseInputHash: 'h3' },
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
      restartForPhonemeTimingEdit: (options) => calls.push(['restartPhoneme', options]),
    },
    phraseStore: {
      getJobId: () => 'job-1',
      getPhrases: () => phrases,
      applyBackendPhraseTimingMetadata: (nextPhrases) => {
        calls.push(['timingMetadata', nextPhrases.length])
        return true
      },
      rebuildFromEdit: (phrases) => calls.push(['phrases', phrases.length]),
    },
    store: {
      getSnapshot: () => ({ revision: 'rev-1', items: [] }),
      setSnapshot: (snapshot) => calls.push(['snapshot', snapshot.revision]),
      setPreview: (preview) => calls.push(['preview', preview]),
    },
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

test('response phrases with same note shape update metadata without rebuilding hashes', () => {
  const d = deps()
  applyPhonemeTimingCommitResponse({
    ok: true,
    snapshot: { revision: 'after-phrases' },
    affectedIndices: [1],
    phrases: [
      { index: 0, startMs: 0, durationMs: 250, notes: [{ position: 0, duration: 120, tone: 60 }] },
      { index: 1, startMs: 250, durationMs: 250, notes: [{ position: 120, duration: 120, tone: 61 }] },
      { index: 2, startMs: 500, durationMs: 250, notes: [{ position: 240, duration: 120, tone: 62 }] },
      { index: 3, startMs: 750, durationMs: 250, notes: [{ position: 360, duration: 120, tone: 63 }] },
    ],
  }, preview(), d)

  assert.equal(d.calls.some((call) => call[0] === 'phrases'), false)
  assert.deepEqual(d.calls.find((call) => call[0] === 'timingMetadata'), ['timingMetadata', 4])
  assert.deepEqual(d.calls.find((call) => call[0] === 'restartPhoneme')?.[1], {
    affectedIndices: [1],
    phraseCount: 4,
    phrasesChanged: false,
    snapshot: { revision: 'after-phrases' },
  })
})

test('response phrases with changed note shape rebuild and use wide restart', () => {
  const d = deps()
  applyPhonemeTimingCommitResponse({
    ok: true,
    snapshot: { revision: 'after-structure' },
    affectedIndices: [1],
    phrases: [{ index: 0, notes: [{ position: 999, duration: 120, tone: 60 }] }],
  }, preview(), d)

  assert.deepEqual(d.calls.find((call) => call[0] === 'phrases'), ['phrases', 1])
  assert.equal(d.calls.find((call) => call[0] === 'restartPhoneme')?.[1].phrasesChanged, true)
})
