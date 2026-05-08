import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VocalManifestController } from '../src/host/controllers/VocalManifestController.js'
import { createVocalRenderManifest } from '../src/host/vocal/VocalRenderManifest.js'

function createStore(track) {
  return {
    track,
    getTrack(trackId) {
      return this.track?.id === trackId ? this.track : null
    },
    replaceTrackVocalManifest(trackId, manifest) {
      if (this.track?.id === trackId) this.track = { ...this.track, vocalManifest: manifest }
    },
  }
}

test('handlePhraseReady downloads a new asset when an available phrase gets a new inputHash', async () => {
  const track = {
    id: 'track-1',
    revision: 0,
    vocalManifest: {
      ...createVocalRenderManifest(),
      jobId: 'job-1',
      status: 'rendering',
      phraseStates: [
        {
          phraseIndex: 0,
          inputHash: 'h0',
          status: 'available',
          startMs: 0,
          durationMs: 500,
        },
      ],
    },
  }
  const store = createStore(track)
  const calls = []
  const controller = new VocalManifestController({
    store,
    assetRegistry: {
      ensurePhraseAsset: async (ref) => {
        calls.push(ref)
        return {
          ...ref,
          startMs: ref.startMs,
          durationMs: ref.durationMs,
          buffer: {},
        }
      },
    },
  })

  const changed = await controller.handlePhraseReady({
    trackId: 'track-1',
    jobId: 'job-1',
    phraseIndex: 0,
    inputHash: 'h0|phoneme:v2',
    startMs: 0,
    durationMs: 500,
  })

  assert.equal(changed, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].inputHash, 'h0|phoneme:v2')
  assert.equal(store.track.vocalManifest.phraseStates[0].inputHash, 'h0|phoneme:v2')
  assert.equal(store.track.vocalManifest.phraseStates[0].status, 'available')
})
