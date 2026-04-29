import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deserializeProject,
  serializeProject,
  WEBUTAU_PROJECT_VERSION,
} from '../src/host/project/projectFile.js'

// 测试用的最简 project + track 工厂——只放跟 prepState/voiceSnapshot 相关的字段
function makeReadyVocalTrack({ withPitch = true, extraSnapshotFields = {} } = {}) {
  return {
    id: 'track-1',
    name: '主弦律',
    midiTrackIndex: 0,
    contentType: 'midi',
    languageCode: 'zh',
    sourcePhrases: [],
    playbackState: { assignedSourceId: 'vocal' },
    prepState: { status: 'ready', progress: 100, error: null },
    voiceSnapshot: withPitch
      ? {
          trackId: 'track-1',
          languageCode: 'zh',
          phrases: [{ index: 0, notes: [] }],
          // pitchData 是预测结果——核心要持久化的内容
          pitchData: { pitchCurve: [60.5, 60.7, 61.0, 60.9], otherField: 'x' },
          // 这俩是 server-side / 临时引用，应该被 prune 掉
          jobId: 'job-stale-12345',
          renderManifest: { jobId: 'job-stale-12345', phraseStates: [] },
          ...extraSnapshotFields,
        }
      : null,
    // 这些都该被 prune
    jobRef: { jobId: 'job-stale-12345' },
    renderState: { status: 'rendering', completed: 3, total: 10 },
    vocalManifest: { jobId: 'job-stale-12345', phraseStates: [] },
    pendingVoiceEditState: null,
    revision: 5,
  }
}

function makeProject(tracks) {
  return {
    fileName: 'test.mid',
    ppq: 480,
    tempoData: { tempos: [{ bpm: 120, ticks: 0 }] },
    mixState: null,
    selectedTrackId: null,
    editorTrackId: null,
    tracks,
  }
}

function roundTrip(project) {
  const json = serializeProject({ project })
  const { project: restored, sourceVersion } = deserializeProject(json)
  return { restored, sourceVersion }
}

test('serializeProject - 版本号是 v2', () => {
  assert.equal(WEBUTAU_PROJECT_VERSION, 2)
  const json = serializeProject({ project: makeProject([]) })
  const parsed = JSON.parse(json)
  assert.equal(parsed.version, 2)
})

test('round-trip - 有预测结果的 vocal 轨：prepState + pitchCurve 都保留', () => {
  const project = makeProject([makeReadyVocalTrack()])
  const { restored } = roundTrip(project)
  const track = restored.tracks[0]
  assert.equal(track.prepState.status, 'ready')
  assert.deepEqual(track.voiceSnapshot.pitchData.pitchCurve, [60.5, 60.7, 61.0, 60.9])
  // 同时验证 server-side 引用被剥掉
  assert.equal(track.voiceSnapshot.jobId, undefined, 'jobId 必须被 prune')
  assert.equal(track.voiceSnapshot.renderManifest, undefined, 'renderManifest 必须被 prune')
})

test('round-trip - 运行时引用全部清掉（jobRef / renderState / vocalManifest 等）', () => {
  const project = makeProject([makeReadyVocalTrack()])
  const { restored } = roundTrip(project)
  const track = restored.tracks[0]
  assert.equal(track.jobRef, undefined)
  assert.equal(track.renderState, undefined)
  assert.equal(track.vocalManifest, undefined)
  assert.equal(track.pendingVoiceEditState, undefined)
  assert.equal(track.revision, undefined)
})

test('round-trip - prepState=idle 时不保存 voiceSnapshot（即使内存里有过时 pitchData）', () => {
  const track = makeReadyVocalTrack()
  // 模拟"用户编辑笔记后 prepState 被重置为 idle，但 voiceSnapshot 还有过时 pitchData"
  track.prepState = { status: 'idle', progress: 0, error: null }
  const project = makeProject([track])
  const { restored } = roundTrip(project)
  const restoredTrack = restored.tracks[0]
  assert.equal(restoredTrack.prepState.status, 'idle')
  assert.equal(restoredTrack.voiceSnapshot, null, '过时 pitchData 不应被持久化')
})

test('round-trip - prepState=ready 但无 pitchData → 加载后降级到 idle（一致性）', () => {
  const track = makeReadyVocalTrack({ withPitch: false })
  // prepState 说 ready 但 voiceSnapshot 没有——异常状态，应被规整
  const project = makeProject([track])
  const { restored } = roundTrip(project)
  const restoredTrack = restored.tracks[0]
  assert.equal(restoredTrack.prepState.status, 'idle', 'ready 但无 pitchData → 应回 idle')
  assert.equal(restoredTrack.voiceSnapshot, null)
})

test('round-trip - prepState=predicting 也按 idle 处理（不持久化中间态）', () => {
  const track = makeReadyVocalTrack()
  track.prepState = { status: 'predicting', progress: 45, error: null }
  const project = makeProject([track])
  const { restored } = roundTrip(project)
  // predicting 不是 ready → voiceSnapshot 不存
  assert.equal(restored.tracks[0].voiceSnapshot, null)
  // prepState 本身保留了 predicting 状态——加载逻辑会把它当未就绪处理
  // （isTrackPrepReady 只在 'ready' 时返回 true）
})

test('反序列化兼容：v1 老文件没有 prepState/voiceSnapshot 字段 → 给 idle 兜底', () => {
  // 手工构造一个 v1 文件——track 完全没有 prepState 和 voiceSnapshot
  const v1Json = JSON.stringify({
    format: 'webutau-project',
    version: 1,
    savedAt: '2026-01-01T00:00:00Z',
    projectName: 'old',
    project: {
      fileName: 'old.mid',
      tracks: [{
        id: 'track-1',
        name: 'old vocal',
        contentType: 'midi',
        languageCode: 'zh',
        playbackState: { assignedSourceId: 'vocal' },
        // 注意：没有 prepState，没有 voiceSnapshot
      }],
    },
    assets: {},
  })
  const { project, sourceVersion } = deserializeProject(v1Json)
  assert.equal(sourceVersion, 1)
  const track = project.tracks[0]
  // 兜底：补出 idle 的 prepState
  assert.deepEqual(track.prepState, { status: 'idle', progress: 0, error: null })
  assert.equal(track.voiceSnapshot, null)
})

test('反序列化防御：手改 JSON 让 prepState=ready 但 pitchCurve 缺失 → 降级', () => {
  // 模拟有人手动编辑了 .webutau JSON
  const malformedJson = JSON.stringify({
    format: 'webutau-project',
    version: 2,
    project: {
      tracks: [{
        id: 'track-1',
        prepState: { status: 'ready', progress: 100, error: null },
        // 关键：手动注入的 voiceSnapshot 没有真正的 pitchCurve
        voiceSnapshot: { pitchData: { pitchCurve: [] } },
        playbackState: { assignedSourceId: 'vocal' },
      }],
    },
    assets: {},
  })
  const { project } = deserializeProject(malformedJson)
  assert.equal(project.tracks[0].prepState.status, 'idle', '空 pitchCurve 应被识别为无效，降级')
  assert.equal(project.tracks[0].voiceSnapshot, null)
})

test('反序列化防御：prepState=idle 但有 pitchCurve（异常残留）→ 丢弃 voiceSnapshot', () => {
  const malformedJson = JSON.stringify({
    format: 'webutau-project',
    version: 2,
    project: {
      tracks: [{
        prepState: { status: 'idle', progress: 0, error: null },
        voiceSnapshot: { pitchData: { pitchCurve: [60, 61] } },
      }],
    },
    assets: {},
  })
  const { project } = deserializeProject(malformedJson)
  // pitchCurve 存在但 prepState 说 idle → 丢 voiceSnapshot，下次会重测覆盖
  assert.equal(project.tracks[0].voiceSnapshot, null)
  assert.equal(project.tracks[0].prepState.status, 'idle')
})

test('反序列化拒绝：版本号 > 当前支持的最大版本', () => {
  const futureJson = JSON.stringify({
    format: 'webutau-project',
    version: 99,
    project: { tracks: [] },
  })
  assert.throws(() => deserializeProject(futureJson), /不支持的工程文件版本/)
})

test('反序列化容错：voiceConversionState 仍走原有 prune（jobId / draftAsset 等）', () => {
  const track = makeReadyVocalTrack()
  track.voiceConversionState = {
    referenceFileName: 'ref.wav',
    diffusionSteps: 28,
    jobId: 'vc-job-stale',
    assetUrl: '/tmp/old',
    draftAsset: { id: 'd' },
    activeJob: { id: 'a' },
    lastError: 'old err',
  }
  const { restored } = roundTrip(makeProject([track]))
  const vc = restored.tracks[0].voiceConversionState
  // 用户参数保留
  assert.equal(vc.referenceFileName, 'ref.wav')
  assert.equal(vc.diffusionSteps, 28)
  // server-side 引用清掉
  assert.equal(vc.jobId, undefined)
  assert.equal(vc.assetUrl, undefined)
  assert.equal(vc.draftAsset, undefined)
  assert.equal(vc.activeJob, undefined)
})
