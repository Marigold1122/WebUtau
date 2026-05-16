// 验证：USTX 携带 prepState=ready + pitchData 的轨道走 prediction gate 时，
// 即使因为缺 languageCode 弹了语言对话框，run() 也不会触发 startSynthesis
// 覆盖原 pitchData。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TrackPredictionGateController } from '../src/host/controllers/TrackPredictionGateController.js'

function makeFakeStore(track) {
  const project = {
    tracks: [track],
    tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
    ppq: 480,
  }
  return {
    project,
    getTrack: (id) => project.tracks.find((t) => t.id === id) || null,
    getProject: () => project,
    getEditorTrack: () => null,
    updateTrack: (id, patch) => {
      const t = project.tracks.find((x) => x.id === id)
      Object.assign(t, patch)
    },
    updateTrackPrepState: (id, state) => {
      const t = project.tracks.find((x) => x.id === id)
      t.prepState = state
    },
    updateTrackRenderState: (id, state) => {
      const t = project.tracks.find((x) => x.id === id)
      t.renderState = state
    },
    replaceVoiceSnapshot: (id, snap) => {
      const t = project.tracks.find((x) => x.id === id)
      t.voiceSnapshot = snap
    },
  }
}

function makeFakeImportService() {
  return {
    buildVoiceSnapshot: (track) => ({
      trackId: track.id,
      trackName: track.name,
      pitchData: track.voiceSnapshot?.pitchData || null,
      phrases: track.sourcePhrases || [],
    }),
  }
}

function makeFakeBridge(calls) {
  return {
    loadTrack: async (snap) => { calls.push(['loadTrack', snap.trackId]) },
    startSynthesis: async (opts) => { calls.push(['startSynthesis', opts]) },
    setEditorMode: async () => {},
  }
}

function makeFakeView() {
  return {
    promptTrackLanguage: async () => ({ languageCode: 'ZH', singerId: 'singer-1' }),
    showTrackSynthesisOverlay: () => {},
    updateTrackSynthesisOverlay: () => {},
    hideTrackSynthesisOverlay: () => {},
    setStatus: () => {},
    notifyRuntimeLayoutChanged: () => {},
    hidePlaybackToast: () => {},
  }
}

function makeFakeCoordinator(calls) {
  return {
    beginPrediction: (id) => calls.push(['beginPrediction', id]),
    setRuntimeTrack: (id) => calls.push(['setRuntimeTrack', id]),
    resetTrackTask: (id) => calls.push(['resetTrackTask', id]),
  }
}

function makePrepWaiters(resolveImmediately = true) {
  return {
    wait: async () => (resolveImmediately ? { ok: true } : null),
    resolve: () => {},
  }
}

// 新语义说明：
// alreadyPredicted 分支保留 pitchData / 跳过 prepWaiters 等待，但仍调 startSynthesis——
// startSynthesis 不只是 pitch 预测，更重要的是"提交 MIDI 给后端做 phrase 音频渲染"。
// 跳过 = 无 WAV = 播放无声。webUTAU 架构下 pitch 是 backend 权威，前端 USTX 携带的
// pitch 只作"等渲染时的预览快照"，渲染完会被 backend 同款 pitch 替换。
describe('TrackPredictionGateController.run — 已 ready 时跳过等待但仍触发音频渲染', () => {
  it('prepState=ready + pitchData 完整 → 调 startSynthesis 但不等 prepWaiters', async () => {
    const track = {
      id: 'track-0',
      name: 'T',
      languageCode: 'ZH',
      singerId: 'singer-1',
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'ready', progress: 100, error: null },
      voiceSnapshot: {
        pitchData: { pitchCurve: [{ tick: 0, pitch: 60 }, { tick: 5, pitch: 60.1 }] },
      },
      sourcePhrases: [],
    }
    const store = makeFakeStore(track)
    const calls = []
    const bridge = makeFakeBridge(calls)
    const coordinator = makeFakeCoordinator(calls)
    const ctrl = new TrackPredictionGateController({
      store,
      view: makeFakeView(),
      bridge,
      importService: makeFakeImportService(),
      taskCoordinator: coordinator,
      prepWaiters: makePrepWaiters(),
      render: () => {},
      onEditorOpened: (id) => calls.push(['onEditorOpened', id]),
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    const ok = await ctrl.run('track-0', 'open')
    assert.equal(ok, true, 'run() 应返回 true')
    const loadTrackCalled = calls.some(([m]) => m === 'loadTrack')
    const synthCalled = calls.some(([m]) => m === 'startSynthesis')
    const beginPredictionCalled = calls.some(([m]) => m === 'beginPrediction')
    const editorOpened = calls.some(([m, id]) => m === 'onEditorOpened' && id === 'track-0')
    assert.equal(loadTrackCalled, true, '应调 bridge.loadTrack 推 snapshot 给 runtime')
    assert.equal(synthCalled, true, '应调 startSynthesis（音频渲染必需，跳过会无声）')
    // 关键：beginPrediction 必须调，让 taskCoordinator 后续能识别 backend 事件
    // （onRenderComplete / onRenderProgress 都用 matchesActiveTask 守卫，要求 jobRef.status='active'）
    assert.equal(beginPredictionCalled, true, 'beginPrediction 必调（否则 backend 事件被守卫拒绝、UI 卡渲染中）')
    assert.equal(editorOpened, true, 'open 意图应触发 editor opened')
    // prepState 保持 ready，没被改回 idle/queued
    assert.equal(track.prepState.status, 'ready', 'prepState 保持 ready')
    assert.ok(track.voiceSnapshot?.pitchData?.pitchCurve?.length > 0, 'pitchData 未被擦掉')
  })

  it('prepState=ready + 缺语言时弹窗选了新语言 → 仍调 startSynthesis 但保留 pitchData', async () => {
    const track = {
      id: 'track-0',
      name: 'T',
      languageCode: null,  // 缺语言！会触发弹窗
      singerId: null,
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'ready', progress: 100, error: null },
      voiceSnapshot: {
        pitchData: { pitchCurve: [{ tick: 0, pitch: 60 }, { tick: 5, pitch: 60.1 }] },
      },
      sourcePhrases: [],
    }
    const store = makeFakeStore(track)
    const calls = []
    const ctrl = new TrackPredictionGateController({
      store,
      view: makeFakeView(),  // 弹窗会返回 {languageCode:'ZH', singerId:'singer-1'}
      bridge: makeFakeBridge(calls),
      importService: makeFakeImportService(),
      taskCoordinator: makeFakeCoordinator(calls),
      prepWaiters: makePrepWaiters(),
      render: () => {},
      onEditorOpened: (id) => calls.push(['onEditorOpened', id]),
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    const ok = await ctrl.run('track-0', 'open')
    assert.equal(ok, true)
    assert.equal(track.languageCode, 'ZH', '弹窗选的语言被应用到 track')
    assert.equal(track.singerId, 'singer-1', '弹窗选的声库被应用')
    assert.equal(calls.some(([m]) => m === 'startSynthesis'), true, '应调 startSynthesis（音频渲染必需）')
    assert.equal(calls.some(([m]) => m === 'beginPrediction'), true, 'beginPrediction 必调让 jobRef.status=active')
    assert.equal(track.prepState.status, 'ready', 'prepState 保持 ready 没被作废')
    assert.ok(track.voiceSnapshot?.pitchData?.pitchCurve?.length > 0, 'USTX 的 pitchData 没被覆盖')
  })

  it('prepState=idle 时正常走完整 prediction 流程（不影响新轨道）', async () => {
    const track = {
      id: 'track-0',
      name: 'T',
      languageCode: 'ZH',
      singerId: 'singer-1',
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'idle', progress: 0, error: null },
      voiceSnapshot: null,
      sourcePhrases: [],
    }
    const store = makeFakeStore(track)
    const calls = []
    const ctrl = new TrackPredictionGateController({
      store,
      view: makeFakeView(),
      bridge: makeFakeBridge(calls),
      importService: makeFakeImportService(),
      taskCoordinator: makeFakeCoordinator(calls),
      prepWaiters: makePrepWaiters(),
      render: () => {},
      onEditorOpened: () => {},
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    const ok = await ctrl.run('track-0', 'open')
    assert.equal(ok, true)
    assert.equal(calls.some(([m]) => m === 'startSynthesis'), true, '没 pitchData 时仍要 startSynthesis')
    assert.equal(calls.some(([m]) => m === 'beginPrediction'), true)
  })
})
