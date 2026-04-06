import test from 'node:test'
import assert from 'node:assert/strict'

import { SourceSamplerRegistry } from '../src/host/audio/instruments/SourceSamplerRegistry.js'

test('source sampler registry instantiates Tone.Sampler with the aligned tone context', async () => {
  const samplerCalls = []
  const samplerInstances = []
  const destination = { name: 'track-input' }
  const toneContext = { name: 'aligned-context' }

  class FakeSampler {
    constructor(options) {
      samplerCalls.push(options)
      samplerInstances.push(this)
    }

    connect(target) {
      this.connectedTarget = target
    }
  }

  const Tone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: {
      load: async () => ({ id: 'buffer' }),
    },
    getContext() {
      return { name: 'fallback-context' }
    },
  }

  const registry = new SourceSamplerRegistry()
  const entry = registry.createSamplerEntry({
    Tone,
    config: {
      baseUrl: '/samples',
      release: 0.8,
    },
    urls: {
      C4: 'piano-c4.mp3',
    },
    destination,
    toneContext,
  })

  await entry.readyPromise

  assert.equal(entry.ready, true)
  assert.equal(entry.error, null)
  assert.equal(samplerCalls.length, 1)
  assert.equal(samplerCalls[0].context, toneContext)
  assert.equal(samplerCalls[0].release, 0.8)
  assert.deepEqual(Object.keys(samplerCalls[0].urls), ['C4'])
  assert.equal(samplerInstances[0].connectedTarget, destination)
})
