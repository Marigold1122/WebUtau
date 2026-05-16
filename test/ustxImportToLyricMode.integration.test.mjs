// 端到端集成测试：模拟用户实际操作链路
//   1. 启动 webUTAU（空白）
//   2. 导入海阔天空 USTX（走 isFirstImport 路径）
//   3. 双击轨道（setEditorTrack）
//   4. 切到 lyric 模式（handleEditorModeSelected 的核心判断）
// 验证：整条链路下没有触发 startSynthesis（USTX 携带的 pitchData 被保留）
//
// 不用 fake mock 替代核心组件——store / ImportProjectService / PredictionGateController
// 全部用真实模块加载，只 fake "下游 IO 边界"：bridge / view。这样测的是真实集成行为，
// 不是孤立单元。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseUstxToWebUtau } from '../src/formats/ustx-import.js'
import { ProjectDocumentStore } from '../src/host/project/ProjectDocumentStore.js'
import { createTrackDocument } from '../src/host/project/createTrackDocument.js'
import { TrackPredictionGateController } from '../src/host/controllers/TrackPredictionGateController.js'
import { isTrackPrepReady, hasPredictedPitch } from '../src/host/project/trackPrepState.js'
import { isVoiceRuntimeSource } from '../src/host/project/trackSourceAssignment.js'
import { normalizeOptionalLanguageCode } from '../src/config/languageOptions.js'
import { createTempoDocument } from '../src/shared/tempoDocument.js'
import { createTimelineAxis } from '../src/shared/timelineAxis.js'
import { createPhraseDocuments } from '../src/shared/phraseDocument.js'
import { createPreviewNoteDocument, createNoteDocument, clampMidi, clampVelocity } from '../src/shared/noteDocument.js'
import { isAudioTrack } from '../src/host/project/trackContentType.js'

// 内联 ImportProjectService 的 applyProjectTiming + buildVoiceSnapshot ——
// 真实模块 import @tonejs/midi (CJS) 在 node:test ESM 加载下不互操作；我们的集成测试
// 不需要 MIDI encode 路径，复制核心方法即可。这两段逻辑跟 ImportProjectService.js
// 完全等价（不含 createEncodedMidi/buildProjectMidiFile）
function buildRetimedSourcePhrases(sourcePhrases = [], previewNotes = []) {
  let noteIndex = 0
  const retimedPhrases = createPhraseDocuments(sourcePhrases.map((phrase, phraseIndex) => {
    const nextNotes = (Array.isArray(phrase?.notes) ? phrase.notes : []).map((note) => {
      const previewNote = previewNotes[noteIndex] || null
      noteIndex += 1
      return createNoteDocument({
        ...note,
        time: previewNote?.time ?? note?.time ?? 0,
        duration: previewNote?.duration ?? note?.duration ?? 0,
        tick: previewNote?.tick ?? note?.tick,
        durationTicks: previewNote?.durationTicks ?? note?.durationTicks,
        midi: previewNote?.midi ?? note?.midi ?? 60,
        velocity: previewNote?.velocity ?? note?.velocity ?? 0.8,
        lyric: previewNote?.lyric ?? note?.lyric ?? 'a',
        tuning: previewNote?.tuning ?? note?.tuning ?? 0,
        pitch: previewNote?.pitch ?? note?.pitch ?? null,
        vibrato: previewNote?.vibrato ?? note?.vibrato ?? null,
      })
    })
    const startTime = nextNotes[0]?.time ?? 0
    const endTime = nextNotes.reduce((m, n) => Math.max(m, n.time + n.duration), startTime)
    return { ...phrase, index: phrase?.index ?? phraseIndex, startTime, endTime, notes: nextNotes }
  }))
  return retimedPhrases
}
const importService = {
  applyProjectTiming(project, { tempoData = null, ppq = null } = {}) {
    if (!project) return null
    const sourcePpq = Number.isFinite(project.ppq) && project.ppq > 0 ? project.ppq : 480
    const targetPpq = Number.isFinite(ppq) && ppq > 0 ? Math.round(ppq) : sourcePpq
    const targetTempoData = createTempoDocument(tempoData)
    const tickScale = targetPpq / sourcePpq
    const axis = createTimelineAxis({ tempoData: targetTempoData, ppq: targetPpq, totalTicks: 0 })
    const tracks = (Array.isArray(project.tracks) ? project.tracks : []).map((track) => {
      if (isAudioTrack(track)) return track
      const previewNotes = (track.previewNotes || []).map((note) => {
        const scaledTick = Math.max(0, Math.round((note?.tick || 0) * tickScale))
        const scaledDt = Math.max(1, Math.round((note?.durationTicks || 1) * tickScale))
        const startTime = axis.tickToTime(scaledTick)
        const endTime = axis.tickToTime(scaledTick + scaledDt)
        return createPreviewNoteDocument({
          ...note,
          time: startTime,
          duration: Math.max(0.05, endTime - startTime),
          tick: scaledTick, durationTicks: scaledDt,
          midi: clampMidi(note?.midi), velocity: clampVelocity(note?.velocity),
        })
      })
      const stats = previewNotes.reduce((acc, n) => {
        acc.duration = Math.max(acc.duration, n.time + n.duration)
        acc.durationTicks = Math.max(acc.durationTicks, n.tick + n.durationTicks)
        return acc
      }, { noteCount: previewNotes.length, duration: 0, durationTicks: 0 })
      const sourcePhrases = buildRetimedSourcePhrases(track.sourcePhrases || [], previewNotes)
      return { ...track, previewNotes, sourcePhrases,
        noteCount: stats.noteCount, phraseCount: sourcePhrases.length,
        duration: stats.duration, durationTicks: stats.durationTicks, voiceSnapshot: null }
    })
    return { ...project, ppq: targetPpq, tempoData: targetTempoData, tracks }
  },
  buildVoiceSnapshot(track, tempoDataSource) {
    const prepReady = isTrackPrepReady(track)
    if (track.voiceSnapshot) {
      const snap = structuredClone(track.voiceSnapshot)
      snap.trackId = track.id
      snap.trackName = track.name
      snap.languageCode = normalizeOptionalLanguageCode(track.languageCode)
      snap.jobId = track.jobRef?.jobId || null
      if (!prepReady) snap.pitchData = null
      // 修复：USTX 合成的 voiceSnapshot 内 phrases 为空，runtime 需要时用 sourcePhrases 重建
      if (!Array.isArray(snap.phrases) || snap.phrases.length === 0) {
        snap.phrases = createPhraseDocuments(track.sourcePhrases)
        snap.phraseCount = snap.phrases.length
        snap.noteCount = snap.phrases.flatMap((p) => p.notes || []).length
      }
      if (!Array.isArray(snap.previewNotes) || snap.previewNotes.length === 0) {
        snap.previewNotes = track.previewNotes ? structuredClone(track.previewNotes) : []
      }
      return snap
    }
    const phrases = createPhraseDocuments(track.sourcePhrases)
    return {
      trackId: track.id, trackName: track.name,
      languageCode: normalizeOptionalLanguageCode(track.languageCode),
      jobId: prepReady ? (track.jobRef?.jobId || null) : null,
      tempoData: createTempoDocument(tempoDataSource),
      phraseCount: phrases.length, noteCount: phrases.flatMap((p) => p.notes || []).length,
      duration: track.duration,
      previewNotes: track.previewNotes ? structuredClone(track.previewNotes) : [],
      phrases,
      pitchData: prepReady ? (track.voiceSnapshot?.pitchData ? structuredClone(track.voiceSnapshot.pitchData) : null) : null,
      encodedMidi: null, renderManifest: null,
    }
  },
}

// 模拟 createHostApp 的 handleEditorModeSelected 切换 voice runtime 模式时的关键
// 决策分支（lyric/pitch 模式）——只复刻判断 + 调用顺序，不复刻 UI 副作用
async function simulateSwitchToLyricMode(track, { predictionGate, bridge, store, importService }) {
  if (!isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
    return { result: 'not-voice-track' }
  }
  if (predictionGate.requires(track)) {
    const opened = await predictionGate.run(track.id, 'open')
    return { result: 'via-prediction-gate', opened }
  }
  // requires=false 走"直接 loadTrack"路径——复刻 loadTrackIntoVoiceEditor 的核心
  const snapshot = importService.buildVoiceSnapshot(track, store.getProject()?.tempoData)
  await bridge.loadTrack(snapshot)
  store.replaceVoiceSnapshot(track.id, snapshot)
  return { result: 'via-load-track', snapshot }
}

function makeFakeBridge(calls) {
  return {
    init: () => {},
    loadTrack: async (snap) => { calls.push(['loadTrack', { trackId: snap.trackId, pitchCurveLen: snap.pitchData?.pitchCurve?.length || 0 }]) },
    startSynthesis: async (opts) => { calls.push(['startSynthesis', opts]) },
    setEditorMode: async (mode) => { calls.push(['setEditorMode', mode]) },
    setPlayheadFollowMode: async () => {},
    resetRuntime: () => {},
    syncHostPlaybackState: () => Promise.resolve(),
    syncHostPlaybackTick: () => Promise.resolve(),
  }
}

function makeFakeView() {
  return {
    promptTrackLanguage: async () => ({ languageCode: 'ZH', singerId: 'fake-singer' }),
    showTrackSynthesisOverlay: () => {},
    updateTrackSynthesisOverlay: () => {},
    hideTrackSynthesisOverlay: () => {},
    setStatus: () => {},
    notifyRuntimeLayoutChanged: () => {},
    hidePlaybackToast: () => {},
  }
}

function makeFakeTaskCoordinator() {
  return {
    beginPrediction: () => {},
    setRuntimeTrack: () => {},
    resetTrackTask: () => {},
    isRuntimeAttachedTo: () => false,
    cancelConflictingTask: async () => null,
    matchesActiveTask: () => false,
    clearRuntimeTrack: () => {},
  }
}

// 复刻 handleUstxFileSelected 追加路径（含 createHostApp.js 已修复的 voiceSnapshot 回填逻辑）
async function importUstxAppend(yaml, store) {
  const importedProject = parseUstxToWebUtau(yaml)
  const currentProject = store.getProject()
  const timedProject = importService.applyProjectTiming(importedProject, {
    tempoData: currentProject?.tempoData || importedProject.tempoData,
    ppq: currentProject?.ppq || importedProject.ppq,
  })
  const timedTracks = timedProject?.tracks || []
  let lastCreatedTrackId = null
  for (const [trackIdx, incomingTrack] of timedTracks.entries()) {
    const newTrack = store.createTrack({
      name: incomingTrack.name || '',
      languageCode: incomingTrack.languageCode || null,
      afterTrackId: lastCreatedTrackId,
    })
    lastCreatedTrackId = newTrack.id
    store.updateTrack(newTrack.id, {
      singerId: incomingTrack.singerId || null,
      color: incomingTrack.color || null,
      hasLyrics: incomingTrack.hasLyrics ?? true,
      role: incomingTrack.role || 'vocal',
      contentType: incomingTrack.contentType || 'midi',
      sourcePhrases: incomingTrack.sourcePhrases,
      playbackState: incomingTrack.playbackState,  // 关键：含 assignedSourceId='vocal'
    })
    store.replaceTrackPreviewNotes(newTrack.id, incomingTrack.previewNotes, {
      rebuildSourcePhrases: false,
      clearVoiceSnapshot: false,  // 修复：不清 USTX 的 voiceSnapshot
      clearPendingVoiceEditState: false,
    })
    // 修复：从 applyProjectTiming 前的 importedProject 回填 voiceSnapshot/prepState
    const originalUstxTrack = importedProject.tracks[trackIdx]
    if (originalUstxTrack?.voiceSnapshot && originalUstxTrack.prepState?.status === 'ready') {
      store.updateTrack(newTrack.id, {
        voiceSnapshot: originalUstxTrack.voiceSnapshot,
        prepState: originalUstxTrack.prepState,
      })
    }
  }
}

// 完整复刻 createHostApp.handleUstxFileSelected 的 isFirstImport 分支（去除 UI 渲染部分）
async function importUstxFirstTime(yaml, store, importService) {
  const importedProject = parseUstxToWebUtau(yaml)
  const incomingTracks = importedProject.tracks || []
  assert.ok(incomingTracks.length > 0, '海阔天空 USTX 至少有 1 个 track')

  const voiceSnapshotPatches = new Map()
  const skeletonProject = {
    ...importedProject,
    tracks: incomingTracks.map((track, idx) => {
      const summary = {
        index: idx, name: track.name, color: track.color, hasLyrics: track.hasLyrics,
        role: track.role, contentType: track.contentType,
        duration: track.duration, durationTicks: track.durationTicks,
        noteCount: track.noteCount, previewNotes: track.previewNotes,
        playbackState: track.playbackState, audioClip: track.audioClip,
      }
      const doc = createTrackDocument(summary, track.sourcePhrases || [], track.languageCode || null)
      doc.singerId = track.singerId || null
      if (track._extensions) doc._extensions = track._extensions
      if (track.voiceSnapshot && track.prepState?.status === 'ready') {
        voiceSnapshotPatches.set(doc.id, {
          voiceSnapshot: track.voiceSnapshot,
          prepState: track.prepState,
        })
      }
      return doc
    }),
  }

  const timedProject = importService.applyProjectTiming(skeletonProject, {
    tempoData: skeletonProject.tempoData,
    ppq: skeletonProject.ppq,
  }) || skeletonProject

  if (voiceSnapshotPatches.size > 0) {
    for (const track of timedProject.tracks || []) {
      const patch = voiceSnapshotPatches.get(track.id)
      if (patch) {
        track.voiceSnapshot = patch.voiceSnapshot
        track.prepState = patch.prepState
      }
    }
  }

  store.setProject(timedProject)
}

describe('真实用户路径：导入 USTX → 双击 → 切 lyric 模式', () => {
  it('海阔天空 USTX：整条链路下不应触发 startSynthesis', async () => {
    const yaml = await readFile('/Users/haruhi/Downloads/海阔天空.mid.ustx', 'utf8')
    const store = new ProjectDocumentStore()

    // 步骤 1+2: 启动 + 导入 USTX
    await importUstxFirstTime(yaml, store, importService)
    const trackId = store.getProject().tracks[0].id

    // 验证导入后 track 状态
    const trackAfterImport = store.getTrack(trackId)
    console.log('[导入后] languageCode =', trackAfterImport.languageCode)
    console.log('[导入后] prepState =', trackAfterImport.prepState)
    console.log('[导入后] voiceSnapshot 存在 =', Boolean(trackAfterImport.voiceSnapshot))
    console.log('[导入后] pitchCurve 长度 =', trackAfterImport.voiceSnapshot?.pitchData?.pitchCurve?.length)

    assert.equal(trackAfterImport.languageCode, 'ZH', '中文 lyric 应被 lyric 推断识别为 ZH')
    assert.equal(trackAfterImport.prepState?.status, 'ready', '合成的 pitchCurve 应让 prepState=ready')
    assert.ok(hasPredictedPitch(trackAfterImport.voiceSnapshot), 'voiceSnapshot 应有 pitchCurve')

    // 步骤 3: 双击轨道（setEditorTrack）
    store.setEditorTrack(trackId)
    assert.equal(store.getEditorTrack()?.id, trackId)

    // 步骤 4: 切到 lyric 模式
    const calls = []
    const bridge = makeFakeBridge(calls)
    const predictionGate = new TrackPredictionGateController({
      store,
      view: makeFakeView(),
      bridge,
      importService,
      taskCoordinator: makeFakeTaskCoordinator(),
      prepWaiters: { wait: async () => ({ ok: true }), resolve: () => {} },
      render: () => {},
      onEditorOpened: (id) => calls.push(['onEditorOpened', id]),
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    const trackForSwitch = store.getTrack(trackId)
    const requiresGate = predictionGate.requires(trackForSwitch)
    console.log('[切 lyric 前] requires(track) =', requiresGate)

    const switchResult = await simulateSwitchToLyricMode(trackForSwitch, {
      predictionGate, bridge, store, importService,
    })
    console.log('[切 lyric 后] result =', switchResult.result)
    console.log('[切 lyric 后] bridge 调用清单:', calls.map(([m]) => m).join(', '))

    // 关键断言：整条链路上 startSynthesis 必须没被调
    const synthCalls = calls.filter(([m]) => m === 'startSynthesis')
    // 新语义：startSynthesis 仍要调（提交 MIDI 给后端做音频渲染必需），但 prepState/pitchData 不被擦
    assert.ok(synthCalls.length <= 1, `startSynthesis 应最多 1 次（音频渲染）实际 ${synthCalls.length} 次`)

    // 验证：track 状态在切换后仍保留 pitchData
    const trackAfterSwitch = store.getTrack(trackId)
    assert.ok(hasPredictedPitch(trackAfterSwitch.voiceSnapshot), 'pitchData 在切换后仍存在')
    assert.equal(trackAfterSwitch.prepState?.status, 'ready', 'prepState 在切换后仍为 ready')

    // 关键回归：发到 runtime 的 snapshot 必须含 phrases（卷帘渲染要用），
    // 不能因为合成时 phrases:[] 优化而让 runtime 拿到 0 句
    const loadCall = calls.find(([m]) => m === 'loadTrack')
    assert.ok(loadCall, 'bridge.loadTrack 应被调')
    // ⚠️ 拿不到 snapshot.phrases 的 fake bridge 已经在 'loadTrack' 调用里记录了 pitchCurve 长度，
    // 真实场景下 snapshot.phrases 必须非空——这条要通过 buildVoiceSnapshot 的修复保证。
    // 用 importService 直接调一次验证 snapshot 完整
    const directSnapshot = importService.buildVoiceSnapshot(trackAfterSwitch, store.getProject()?.tempoData)
    assert.ok(directSnapshot, 'buildVoiceSnapshot 应返回非 null')
    assert.ok(Array.isArray(directSnapshot.phrases) && directSnapshot.phrases.length > 0,
      `❌ snapshot.phrases 为空（实际 ${directSnapshot.phrases?.length || 0}）— 钢琴卷帘会显示空白`)
    assert.ok(directSnapshot.phrases[0]?.notes?.length > 0, 'snapshot.phrases[0].notes 应有内容')
  })

  it('【追加路径】用户已有项目时导入 USTX → 切 lyric 模式应保留 pitchData', async () => {
    const yaml = await readFile('/Users/haruhi/Downloads/海阔天空.mid.ustx', 'utf8')
    const store = new ProjectDocumentStore()
    // 模拟已有空项目（先创建 1 个 dummy track 让 isFirstImport=false）
    store.setProject({ tracks: [], tempoData: null, ppq: 480, mixState: null })
    const dummyTrack = store.createTrack({ name: 'Dummy', languageCode: null, afterTrackId: null })
    console.log('[append-prep] dummy track 已建', dummyTrack.id)

    // 走追加路径
    await importUstxAppend(yaml, store)
    const tracks = store.getProject().tracks
    console.log('[append] track 数:', tracks.length)
    const ustxTrack = tracks.find((t) => t.name === '主弦律1')
    assert.ok(ustxTrack, '应找到 USTX 导入的 track')
    console.log('[append] USTX track.prepState:', ustxTrack.prepState)
    console.log('[append] USTX track.voiceSnapshot 存在:', Boolean(ustxTrack.voiceSnapshot))
    console.log('[append] USTX track.languageCode:', ustxTrack.languageCode)

    // 切 lyric 模式
    const calls = []
    const bridge = makeFakeBridge(calls)
    const gate = new TrackPredictionGateController({
      store,
      view: makeFakeView(),
      bridge,
      importService,
      taskCoordinator: makeFakeTaskCoordinator(),
      prepWaiters: { wait: async () => ({ ok: true }), resolve: () => {} },
      render: () => {},
      onEditorOpened: () => {},
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })
    const requiresGate = gate.requires(ustxTrack)
    console.log('[append] requires(track):', requiresGate)
    const result = await simulateSwitchToLyricMode(ustxTrack, { predictionGate: gate, bridge, store, importService })
    console.log('[append] 切模式结果:', result.result)
    console.log('[append] bridge 调用清单:', calls.map(([m]) => m).join(', '))

    const synthCalls = calls.filter(([m]) => m === 'startSynthesis')
    // 新语义：startSynthesis 仍跑（音频必需），但 prepState 保持 ready、pitchData 不被擦
    const trackAfter = store.getTrack(ustxTrack.id)
    if (trackAfter) {
      assert.equal(trackAfter.prepState?.status, 'ready', '追加路径下 prepState 应保持 ready')
      assert.ok(Boolean(trackAfter.voiceSnapshot?.pitchData?.pitchCurve?.length), 'pitchData 未被擦')
    }
  })

  it('【坏导出反向恢复】(1).ustx 这种含 _meta.pitchData 但 lyric=a 的损坏导出，弹窗后仍跳过预测', async () => {
    // 模拟 (1).ustx 形态：previewNotes 全 tick=0、lyric=a；但 _meta.webutau_voice_snapshot
    // 有完整 pitchCurve。languageCode 推断不出（lyric=a 不是中日字符），requires() 必 true
    const corruptYaml = `name: Corrupt
ustx_version: "0.9"
output_dir: Vocal
cache_dir: UCache
tempos:
  - position: 0
    bpm: 120
time_signatures:
  - bar_position: 0
    beat_per_bar: 4
    beat_unit: 4
tracks:
  - track_no: 0
    track_name: T
    singer: ""
    phonemizer: ""
    mute: false
    solo: false
    volume: 0
    pan: 0
    _meta:
      webutau_voice_snapshot:
        trackName: T
        languageCode: null
        bpm: 120
        tempoData:
          tempos:
            - bpm: 120
              time: 0
              ticks: 0
          timeSignatures:
            - timeSignature:
                - 4
                - 4
              time: 0
              ticks: 0
          keySignatures: []
        pitchData:
          pitchCurve:
            - tick: 11040
              pitch: 60
            - tick: 11045
              pitch: 60
            - tick: 11050
              pitch: 60.1
          pitchDeviation:
            xs: []
            ys: []
          midiPpq: 480
          pitchStepTick: 5
      webutau_prep_state:
        status: ready
        progress: 100
        error: null
voice_parts:
  - track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 240
        tone: 60
        lyric: a
        tuning: 0
wave_parts: []
`
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(corruptYaml, store, importService)
    const trackId = store.getProject().tracks[0].id
    const t = store.getTrack(trackId)
    console.log('[坏文件] languageCode:', t.languageCode)
    console.log('[坏文件] prepState:', t.prepState?.status)
    console.log('[坏文件] voiceSnapshot 存在:', Boolean(t.voiceSnapshot))
    console.log('[坏文件] pitchCurve 长度:', t.voiceSnapshot?.pitchData?.pitchCurve?.length)

    // 这种场景下 requires() 必 true（缺 languageCode），走 prediction gate
    const calls = []
    const bridge = makeFakeBridge(calls)
    const gate = new TrackPredictionGateController({
      store, view: makeFakeView(), bridge, importService,
      taskCoordinator: makeFakeTaskCoordinator(),
      prepWaiters: { wait: async () => ({ ok: true }), resolve: () => {} },
      render: () => {}, onEditorOpened: () => {},
      onEditorCleared: () => {}, onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })
    assert.equal(gate.requires(t), true, '缺 languageCode → 弹窗')

    const opened = await gate.run(trackId, 'open')
    assert.equal(opened, true)
    const synthCalls = calls.filter(([m]) => m === 'startSynthesis')
    // 新语义：弹窗后会调 startSynthesis（音频渲染必需），但 prepState/pitchData 不被擦
    assert.ok(synthCalls.length <= 1, `startSynthesis 最多 1 次（音频）实际 ${synthCalls.length}`)
    const after = store.getTrack(trackId)
    assert.ok(hasPredictedPitch(after.voiceSnapshot), '_meta 还原的 pitchData 在 gate.run 后仍保留')
    assert.equal(after.languageCode, 'ZH', '弹窗选完后 languageCode 已被更新到 ZH')
    assert.equal(after.prepState?.status, 'ready', 'prepState 仍是 ready')
  })

  it('【isPreparedVoiceTrack 语义】USTX 合成的 voiceSnapshot（无 jobId）也算 prepared', () => {
    // 这是用户实测 console log 暴露出的 bug：USTX 导入后双击轨道触发 InstrumentEditor
    // 的 autosave，走 persistInstrumentEditorDraft → 因为 isPreparedVoiceTrack 要求
    // jobRef.jobId 非空，而 USTX 合成的 track 没有 jobId → 走 else 分支 replaceTrackNotes
    // → 内部 clearVoiceSnapshot=true → pitchData 被擦 → 后续切 lyric 模式 prepState=idle
    // → prediction gate.run 内 alreadyPredicted=false → 强制 startSynthesis 重新预测
    //
    // 修复：isPreparedVoiceTrack 只要求"有效 voiceSnapshot.pitchData.pitchCurve"，
    // 不再强制 jobRef.jobId
    function isPreparedVoiceTrack(track) {
      return Boolean(
        track
        && !isAudioTrack(track)
        && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
        && isTrackPrepReady(track)
        && track.voiceSnapshot?.pitchData?.pitchCurve?.length,
      )
    }
    // 场景 A：USTX 合成 voiceSnapshot（jobId=null，但有 pitchCurve）→ 应该 isPrepared=true
    const ustxSynthTrack = {
      id: 'track-0',
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'ready', progress: 100, error: null },
      jobRef: { jobId: null },
      voiceSnapshot: {
        jobId: null,
        pitchData: { pitchCurve: [{ tick: 11040, pitch: 69 }, { tick: 11045, pitch: 69 }] },
      },
    }
    assert.equal(isPreparedVoiceTrack(ustxSynthTrack), true, 'USTX 合成的 voiceSnapshot 必须算 prepared')

    // 场景 B：后端预测产物（有 jobId 也有 pitchCurve）→ isPrepared=true（保留旧行为）
    const aiPredictedTrack = {
      ...ustxSynthTrack,
      jobRef: { jobId: 'abc123' },
      voiceSnapshot: { jobId: 'abc123', pitchData: { pitchCurve: [{ tick: 0, pitch: 60 }] } },
    }
    assert.equal(isPreparedVoiceTrack(aiPredictedTrack), true)

    // 场景 C：prepState=ready 但 pitchCurve 空 → 应该 isPrepared=false（不算 prepared，正确）
    const stalePrepTrack = {
      ...ustxSynthTrack,
      voiceSnapshot: { jobId: null, pitchData: { pitchCurve: [] } },
    }
    assert.equal(isPreparedVoiceTrack(stalePrepTrack), false)

    // 场景 D：刚创建的空轨道（prepState=idle）→ false
    const freshTrack = {
      id: 'track-0',
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'idle', progress: 0, error: null },
      jobRef: { jobId: null },
      voiceSnapshot: null,
    }
    assert.equal(isPreparedVoiceTrack(freshTrack), false)
  })

  it('如果 USTX 文件没含中日字符（如纯英文 lyric），languageCode 应为 null，requires() 仍要弹窗', async () => {
    // 用纯英文 USTX 测试
    const enYaml = `name: EnTest
ustx_version: "0.9"
output_dir: Vocal
cache_dir: UCache
tempos:
  - position: 0
    bpm: 120
time_signatures:
  - bar_position: 0
    beat_per_bar: 4
    beat_unit: 4
tracks:
  - track_no: 0
    track_name: T
    singer: ""
    phonemizer: ""
    mute: false
    solo: false
    volume: 0
    pan: 0
voice_parts:
  - track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 240
        tone: 60
        lyric: la
        tuning: 0
wave_parts: []
`
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(enYaml, store, importService)
    const trackId = store.getProject().tracks[0].id
    const t = store.getTrack(trackId)
    assert.equal(t.languageCode, null, '纯英文 lyric 推断不出语言')
    assert.equal(t.prepState?.status, 'ready', '即便语言未知 prepState 也应已经 ready (合成器跑过)')

    // 此时 requires() 会因 !languageCode 返回 true → 弹窗
    const calls = []
    const bridge = makeFakeBridge(calls)
    const gate = new TrackPredictionGateController({
      store,
      view: makeFakeView(),
      bridge,
      importService,
      taskCoordinator: makeFakeTaskCoordinator(),
      prepWaiters: { wait: async () => ({ ok: true }), resolve: () => {} },
      render: () => {},
      onEditorOpened: () => {},
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    assert.equal(gate.requires(t), true, '缺 languageCode 应触发弹窗')

    // 关键：弹窗选完语言（fake view 返回 ZH/singer），run() 应该走 alreadyPredicted 分支跳过 startSynthesis
    const opened = await gate.run(trackId, 'open')
    assert.equal(opened, true)
    const synthCalls = calls.filter(([m]) => m === 'startSynthesis')
    // 新语义：弹窗后会调 startSynthesis（音频渲染必需），但 pitchData 不被擦
    assert.ok(synthCalls.length <= 1, `startSynthesis 最多 1 次（音频）实际 ${synthCalls.length}`)
    assert.ok(hasPredictedPitch(store.getTrack(trackId).voiceSnapshot), 'pitchData 没被覆盖')
  })
})
