import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTrackInsertProfile,
  getTrackInsertProfile,
  normalizeTrackGuitarToneConfig,
  normalizeTrackInsertId,
  resolveInstrumentTrackInsertId,
} from '../src/host/audio/insert/trackInsertCatalog.js'
import { ProjectAudioGraph } from '../src/host/audio/ProjectAudioGraph.js'
import { createTrackPlaybackState, mergeTrackPlaybackState } from '../src/host/project/trackPlaybackState.js'

test('only guitar and bass resolve to dedicated insert ids', () => {
  assert.equal(resolveInstrumentTrackInsertId('guitar'), 'amp-sim3-clean-and-warm')
  assert.equal(resolveInstrumentTrackInsertId('bass'), 'nam-bass-ampeg-svt-2-pro')
  assert.equal(resolveInstrumentTrackInsertId('piano'), null)
  assert.equal(resolveInstrumentTrackInsertId('violin'), null)
  assert.equal(resolveInstrumentTrackInsertId('vocal'), null)
})

test('insert profile lookup is keyed by explicit insert id', () => {
  const guitarProfile = getTrackInsertProfile('amp-sim3-clean-and-warm')
  const bassProfile = getTrackInsertProfile('nam-bass-ampeg-svt-2-pro')
  assert.ok(guitarProfile)
  assert.ok(bassProfile)
  assert.equal(guitarProfile.derivedFromPreset, 'Clean and Warm')
  assert.equal(bassProfile.label, 'Ampeg SVT-2 Pro')
  assert.equal(bassProfile.engine, 'nam-bass')
  assert.equal(bassProfile.license, 'cc-by')
  assert.equal(bassProfile.gear, 'full-rig')
  assert.equal(normalizeTrackInsertId('amp-sim3-clean-and-warm'), 'amp-sim3-clean-and-warm')
  assert.equal(normalizeTrackInsertId('nam-bass-ampeg-svt-2-pro'), 'nam-bass-ampeg-svt-2-pro')
  assert.equal(normalizeTrackInsertId('unknown-insert'), null)
})

test('guitar tone config resolves against the amp-sim3 profile without mutating catalog defaults', () => {
  const baseProfile = getTrackInsertProfile('amp-sim3-clean-and-warm')
  const resolvedProfile = buildTrackInsertProfile('amp-sim3-clean-and-warm', {
    guitarToneConfig: {
      treble: 8.4,
      cabinetMix: 0.42,
      eq3500: -4.5,
    },
  })

  assert.equal(resolvedProfile.tone.treble, 8.4)
  assert.equal(resolvedProfile.cabinet.mix, 0.42)
  assert.equal(resolvedProfile.graphicEq[4], -4.5)
  assert.equal(baseProfile.tone.treble, 3.2)
  assert.equal(baseProfile.cabinet.mix, 0.88)
  assert.equal(baseProfile.graphicEq[4], 16)
})

test('track playback state preserves merged guitar tone settings', () => {
  const first = createTrackPlaybackState({
    assignedSourceId: 'guitar',
  })
  const next = mergeTrackPlaybackState(first, {
    guitarTone: {
      bass: 4.2,
      eq1000: -3.5,
    },
  })

  const normalizedDefault = normalizeTrackGuitarToneConfig()
  assert.equal(next.guitarTone.bass, 4.2)
  assert.equal(next.guitarTone.eq1000, -3.5)
  assert.equal(next.guitarTone.treble, normalizedDefault.treble)
})

test('project audio graph can explicitly clear an insert instead of inheriting old source state', () => {
  const graph = new ProjectAudioGraph()
  const firstState = graph.syncTrackState('track-1', {
    insertId: resolveInstrumentTrackInsertId('guitar'),
  })
  assert.equal(firstState.insertId, 'amp-sim3-clean-and-warm')

  const clearedState = graph.syncTrackState('track-1', {
    insertId: null,
  })
  assert.equal(clearedState.insertId, null)
})

test('project audio graph stores normalized guitar tone state for live amp updates', () => {
  const graph = new ProjectAudioGraph()
  const state = graph.syncTrackState('track-2', {
    insertId: resolveInstrumentTrackInsertId('guitar'),
    guitarTone: {
      presence: 9.1,
      eq60: 2.5,
    },
  })

  assert.equal(state.guitarTone.presence, 9.1)
  assert.equal(state.guitarTone.eq60, 2.5)
  assert.equal(state.guitarTone.mid, normalizeTrackGuitarToneConfig().mid)
})
