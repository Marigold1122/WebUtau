import test from 'node:test'
import assert from 'node:assert/strict'

import { SourceSamplerRegistry } from '../src/host/audio/instruments/SourceSamplerRegistry.js'

test('source sampler registry reuses loaded buffers across sampler entries for the same source files', async () => {
  const samplerCalls = []
  let loadCallCount = 0

  class FakeSampler {
    constructor(options) {
      samplerCalls.push(options)
      Promise.resolve().then(() => options.onload?.())
    }

    connect(target) {
      this.connectedTarget = target
    }
  }

  const Tone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: {
      load: async (url) => {
        loadCallCount += 1
        return { url, loaded: true }
      },
    },
    getContext() {
      return { name: 'aligned-context' }
    },
  }

  const registry = new SourceSamplerRegistry()
  const first = registry.createSamplerEntry({
    Tone,
    config: { baseUrl: '/samples/', release: 0.8 },
    urls: { C4: 'piano-c4.mp3' },
    toneContext: Tone.getContext(),
  })
  const second = registry.createSamplerEntry({
    Tone,
    config: { baseUrl: '/samples/', release: 0.8 },
    urls: { C4: 'piano-c4.mp3' },
    toneContext: Tone.getContext(),
  })

  await Promise.all([first.readyPromise, second.readyPromise])

  assert.equal(loadCallCount, 1)
  assert.equal(samplerCalls.length, 2)
  assert.equal(samplerCalls[0].urls.C4.url, '/samples/piano-c4.mp3')
  assert.equal(samplerCalls[1].urls.C4.url, '/samples/piano-c4.mp3')
})
