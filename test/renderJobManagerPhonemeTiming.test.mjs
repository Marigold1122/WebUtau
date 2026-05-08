import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RenderJobManager } from '../src/modules/RenderJobManager.js'
import renderCache from '../src/modules/RenderCache.js'
import phonemeTimingStore from '../src/modules/PhonemeTimingStore.js'

test('restartForPhonemeTimingEdit preserves unaffected completed phrases and fresh snapshot', () => {
  renderCache.clear()
  phonemeTimingStore.clear()
  phonemeTimingStore.setSnapshot({ revision: 'fresh', items: [] })
  renderCache.set(0, {}, 'h0')
  renderCache.set(1, {}, 'h1')
  renderCache.set(2, {}, 'h2')

  const manager = new RenderJobManager()
  manager._knownCompleted = new Set([0, 1, 2])
  manager._downloadsInFlight = new Map([[0, 'h0'], [1, 'h1'], [2, 'h2']])

  manager.restartForPhonemeTimingEdit({ affectedIndices: [1], phraseCount: 3 })

  assert.deepEqual([...manager._knownCompleted].sort((left, right) => left - right), [0, 2])
  assert.equal(manager._downloadsInFlight.has(0), true)
  assert.equal(manager._downloadsInFlight.has(1), false)
  assert.equal(manager._downloadsInFlight.has(2), true)
  assert.equal(phonemeTimingStore.hasSnapshot(), true)

  manager.stopPolling()
  renderCache.clear()
  phonemeTimingStore.clear()
})
