import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import renderApi from '../src/api/RenderApi.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('applyPhonemeTimingEdit posts only to the phoneme timing endpoint', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ ok: true, snapshot: {}, affectedIndices: [] }) }
  }

  await renderApi.applyPhonemeTimingEdit('job-1', {
    partIndex: 0,
    noteKey: 'part:0|note:1|pos:0|dur:480|tone:60',
    phonemeIndex: 2,
    editType: 'offsetTick',
    value: 12,
    clientRevision: 'rev',
    screenX: 999,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/jobs/job-1/phoneme-timings')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    partIndex: 0,
    noteKey: 'part:0|note:1|pos:0|dur:480|tone:60',
    phonemeIndex: 2,
    editType: 'offsetTick',
    value: 12,
    clientRevision: 'rev',
  })
})

test('applyPhonemeTimingEdit rejects invalid local DTO before fetch', async () => {
  let called = false
  globalThis.fetch = async () => {
    called = true
    return { ok: true, json: async () => ({ ok: true }) }
  }

  await assert.rejects(
    () => renderApi.applyPhonemeTimingEdit('job-1', {
      partIndex: 0,
      noteKey: 'part:0|note:1|pos:0|dur:480|tone:60',
      phonemeIndex: 2,
      editType: 'resetOffset',
      value: 1,
      clientRevision: 'rev',
    }),
    /Invalid phoneme timing edit request/,
  )
  assert.equal(called, false)
})

test('applyPhonemeTimingEdit surfaces backend error code', async () => {
  const calls = []
  globalThis.fetch = async () => {
    calls.push('fetch')
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: 'snapshot_conflict' }),
    }
  }

  await assert.rejects(
    () => renderApi.applyPhonemeTimingEdit('job-1', {
      partIndex: 0,
      noteKey: 'part:0|note:1|pos:0|dur:480|tone:60',
      phonemeIndex: 2,
      editType: 'offsetTick',
      value: 12,
      clientRevision: 'rev',
    }),
    /snapshot_conflict/,
  )
  assert.equal(calls.length, 1)
})
