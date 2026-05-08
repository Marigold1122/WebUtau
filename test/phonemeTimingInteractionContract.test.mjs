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

const adapter = {
  pixelsPerSecond: 200,
  minPixelsPerSecond: 100,
  timeToX: (seconds) => seconds * 200,
  durationToWidth: (seconds) => seconds * 200,
  xToMs: (x) => x / 200 * 1000,
  xToPartTick: (_item, x) => x * 2.4,
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
    viewportAdapter: () => adapter,
  })

  assert.equal(editor.handlePointerDown({ clientX: 200, clientY: 48 }), true)
  assert.equal(editor.handlePointerMove({ clientX: 210, clientY: 48 }), true)
  assert.equal(editor.handlePointerMove({ clientX: 220, clientY: 48 }), true)
  assert.equal(editor.handlePointerMove({ clientX: 230, clientY: 48 }), true)
  assert.equal(commits.length, 0)

  assert.equal(editor.handlePointerUp(), true)
  assert.equal(commits.length, 1)
  assert.equal(commits[0].editType, 'offsetTick')
})

test('endpoint matrix: drag-and-release issues exactly one phoneme-timings POST and zero other writes', async () => {
  const fetchCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method || 'GET' })
    return new Response(JSON.stringify({
      ok: true,
      snapshot: { revision: 'after', items: [] },
      affectedIndices: [0],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const { default: renderApi } = await import('../src/api/RenderApi.js')
    const { commitPhonemeTimingPreview } = await import('../src/modules/PhonemeTimingCommit.js')

    const fakePreview = {
      hit: { partIndex: 0, noteKey: 'part:0|note:1|pos:480|dur:144|tone:60', phonemeIndex: 2, phraseIndex: 0 },
      editType: 'offsetTick',
      value: 24,
      items: [{ phraseIndex: 0 }],
    }
    const deps = {
      api: renderApi,
      audio: { cancelPhrases: () => {} },
      cache: { capture: () => [], restore: () => {}, clearIndices: () => {}, clearAbove: () => {} },
      jobs: { beginInteractiveEdit: () => null, endInteractiveEdit: () => {}, restartForEdit: () => {}, restartForPhonemeTimingEdit: () => {} },
      phraseStore: { getJobId: () => 'job-1', getPhrases: () => [{ index: 0 }], rebuildFromEdit: () => {} },
      store: { getSnapshot: () => ({ revision: 'rev-1', items: [] }), setSnapshot: () => {}, setPreview: () => {} },
    }

    await commitPhonemeTimingPreview(fakePreview, deps)

    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].method, 'POST')
    assert.match(fetchCalls[0].url, /\/api\/jobs\/job-1\/phoneme-timings$/)
    assert.equal(fetchCalls.filter((call) => /\/pitch$/.test(call.url)).length, 0)
    assert.equal(fetchCalls.filter((call) => /\/note-params$/.test(call.url)).length, 0)
    assert.equal(fetchCalls.filter((call) => /\/edit-notes$/.test(call.url)).length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
