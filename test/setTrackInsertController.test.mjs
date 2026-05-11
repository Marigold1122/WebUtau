// 验证 TrackMonitorController.setTrackInsert 的 commit/realtime 语义
//   - commit:false → 写 store + audioGraph，不 render、不 saveProject
//   - commit:true → 写 store + audioGraph + render + saveProject
//   - 未知 slot → 拒绝
//   - 值没变 + 非 commit → 跳过
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { TrackMonitorController } from '../src/host/monitor/TrackMonitorController.js'
import { createTrackPlaybackState } from '../src/host/project/trackPlaybackState.js'

function buildHarness() {
  const calls = { audioGraph: [], render: [], save: [] }
  const trackState = createTrackPlaybackState({})
  const track = { id: 't1', name: 'Track 1', playbackState: trackState }

  const store = {
    getTrack(id) { return id === 't1' ? track : null },
    getProject() { return { tracks: [track] } },
    updateTrackPlaybackState(_id, patch) {
      // 单测里简化为 shallow 标记，不实际 merge —— 我们重点验证 controller 调用 audioGraph / render / save，
      // store 内部 merge 逻辑由 trackInsertChainState.test.mjs 覆盖
      track.playbackState._lastPatch = patch
    },
  }
  const transportCoordinator = {
    setTrackInserts(id, inserts) { calls.audioGraph.push({ id, inserts }) },
  }
  const persistence = {
    saveProject(p) { calls.save.push(Boolean(p)) },
  }
  const view = { setStatus() {} }
  const render = (reason) => calls.render.push(reason)

  const controller = new TrackMonitorController({
    store, transportCoordinator, persistence, view, render,
    sessionStore: { hasFocusSoloTrack: () => false, shouldClearFocusSoloOnEditorClose: () => false, clearFocusSoloTrack: () => {} },
    refreshProjectPlayback: () => Promise.resolve(),
  })
  return { controller, calls, track }
}

describe('TrackMonitorController.setTrackInsert', () => {
  it('未知 slot → false', async () => {
    const { controller } = buildHarness()
    assert.equal(await controller.setTrackInsert('t1', 'unknown', {}), false)
  })

  it('未知 trackId → false', async () => {
    const { controller } = buildHarness()
    assert.equal(await controller.setTrackInsert('nonexistent', 'eq4', { enabled: true }), false)
  })

  it('commit:true → audioGraph + render + saveProject 全调', async () => {
    const { controller, calls } = buildHarness()
    await controller.setTrackInsert('t1', 'eq4', { enabled: true, bandIndex: 0, band: { gain: 4 } })
    assert.equal(calls.audioGraph.length, 1)
    assert.equal(calls.audioGraph[0].id, 't1')
    assert.equal(calls.audioGraph[0].inserts.eq4.enabled, true)
    assert.equal(calls.audioGraph[0].inserts.eq4.bands[0].gain, 4)
    assert.equal(calls.render.length, 1)
    assert.equal(calls.render[0], 'track-insert-changed')
    assert.equal(calls.save.length, 1)
  })

  it('commit:false → audioGraph 调，render / save 都不调', async () => {
    const { controller, calls } = buildHarness()
    await controller.setTrackInsert('t1', 'eq4', { enabled: true, bandIndex: 0, band: { gain: 6 } }, { commit: false })
    assert.equal(calls.audioGraph.length, 1)
    assert.equal(calls.render.length, 0, 'realtime 不发 render')
    assert.equal(calls.save.length, 0, 'realtime 不存盘')
  })

  it('Comp 单参数 patch', async () => {
    const { controller, calls } = buildHarness()
    await controller.setTrackInsert('t1', 'comp', { enabled: true, threshold: -22 })
    const sent = calls.audioGraph[0].inserts
    assert.equal(sent.comp.enabled, true)
    assert.equal(sent.comp.threshold, -22)
    // 其它 comp 参数走 default
    assert.equal(sent.comp.ratio, 2)
  })
})
