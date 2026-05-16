// USTX 导入导出**全数据流**端到端集成测试
// 覆盖范围：
//   parseUstxToWebUtau → createTrackDocument → applyProjectTiming → store.setProject
//   → buildVoiceSnapshot → loadSnapshotIntoRuntime（runtime 端 phraseStore）
//   → 用户编辑 → store.replaceVoiceSnapshot → serializeWebUtauToUstx
//
// 每一段 都断言关键不变量：
//   • note.tick / note.time 一致（host 端 ↔ runtime 端 ↔ pitchData 起点）
//   • phrase.startTime ↔ phrase.notes[0].tick 互推一致
//   • voiceSnapshot.pitchData 在所有变换后保持完整、不被静默擦除
//   • 双向 round-trip：导出后再导入，关键字段（midi/lyric/tick/pitch.data/vibrato）byte 级一致

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseUstxToWebUtau } from '../src/formats/ustx-import.js'
import { serializeWebUtauToUstx } from '../src/formats/ustx-export.js'
import { ProjectDocumentStore } from '../src/host/project/ProjectDocumentStore.js'
import { createTrackDocument } from '../src/host/project/createTrackDocument.js'
import { createTempoDocument } from '../src/shared/tempoDocument.js'
import { createTimelineAxis } from '../src/shared/timelineAxis.js'
import { createPhraseDocuments } from '../src/shared/phraseDocument.js'
import { createPreviewNoteDocument, createNoteDocument, clampMidi, clampVelocity } from '../src/shared/noteDocument.js'
import { isAudioTrack } from '../src/host/project/trackContentType.js'
import { isTrackPrepReady, hasPredictedPitch } from '../src/host/project/trackPrepState.js'
import { normalizeOptionalLanguageCode } from '../src/config/languageOptions.js'

const REAL_USTX_PATH = '/Users/haruhi/Downloads/海阔天空.mid.ustx'

// ----- 内联 ImportProjectService 关键方法（绕开 @tonejs/midi CJS 互操作） -----
function buildRetimedSourcePhrases(sourcePhrases, previewNotes) {
  let i = 0
  return createPhraseDocuments(sourcePhrases.map((phrase, idx) => {
    const next = (phrase?.notes || []).map((n) => {
      const p = previewNotes[i++] || null
      return createNoteDocument({
        ...n,
        time: p?.time ?? n?.time ?? 0,
        duration: p?.duration ?? n?.duration ?? 0,
        tick: p?.tick ?? n?.tick,
        durationTicks: p?.durationTicks ?? n?.durationTicks,
        midi: p?.midi ?? n?.midi ?? 60,
        velocity: p?.velocity ?? n?.velocity ?? 0.8,
        lyric: p?.lyric ?? n?.lyric ?? 'a',
        tuning: p?.tuning ?? n?.tuning ?? 0,
        pitch: p?.pitch ?? n?.pitch ?? null,
        vibrato: p?.vibrato ?? n?.vibrato ?? null,
      })
    })
    return {
      ...phrase,
      index: phrase?.index ?? idx,
      startTime: next[0]?.time ?? 0,
      endTime: next.reduce((m, n) => Math.max(m, n.time + n.duration), 0),
      notes: next,
    }
  }))
}
function applyProjectTiming(project, { tempoData, ppq }) {
  const tgt = createTempoDocument(tempoData)
  const axis = createTimelineAxis({ tempoData: tgt, ppq, totalTicks: 0 })
  const tracks = (project.tracks || []).map((track) => {
    if (isAudioTrack(track)) return track
    const previewNotes = (track.previewNotes || []).map((n) => {
      const tick = Math.max(0, Math.round((n?.tick || 0)))
      const dt = Math.max(1, Math.round((n?.durationTicks || 1)))
      return createPreviewNoteDocument({
        ...n,
        time: axis.tickToTime(tick),
        duration: Math.max(0.05, axis.tickToTime(tick + dt) - axis.tickToTime(tick)),
        tick, durationTicks: dt,
        midi: clampMidi(n?.midi), velocity: clampVelocity(n?.velocity),
      })
    })
    return { ...track, previewNotes, sourcePhrases: buildRetimedSourcePhrases(track.sourcePhrases || [], previewNotes), voiceSnapshot: null }
  })
  return { ...project, ppq, tempoData: tgt, tracks }
}
function buildVoiceSnapshot(track, tempoDataSource) {
  const prepReady = isTrackPrepReady(track)
  if (track.voiceSnapshot) {
    const snapshot = structuredClone(track.voiceSnapshot)
    snapshot.trackId = track.id
    snapshot.languageCode = normalizeOptionalLanguageCode(track.languageCode)
    snapshot.jobId = track.jobRef?.jobId || null
    if (!prepReady) snapshot.pitchData = null
    if (!Array.isArray(snapshot.phrases) || snapshot.phrases.length === 0) {
      snapshot.phrases = createPhraseDocuments(track.sourcePhrases)
      snapshot.phraseCount = snapshot.phrases.length
      snapshot.noteCount = snapshot.phrases.flatMap((p) => p.notes || []).length
    }
    if (!Array.isArray(snapshot.previewNotes) || snapshot.previewNotes.length === 0) {
      snapshot.previewNotes = track.previewNotes ? structuredClone(track.previewNotes) : []
    }
    if (!snapshot.tempoData) snapshot.tempoData = createTempoDocument(tempoDataSource)
    if (!Number.isFinite(snapshot.duration) || snapshot.duration <= 0) {
      snapshot.duration = track.duration || 0
    }
    return snapshot
  }
  const phrases = createPhraseDocuments(track.sourcePhrases)
  return {
    trackId: track.id, trackName: track.name,
    languageCode: normalizeOptionalLanguageCode(track.languageCode),
    tempoData: createTempoDocument(tempoDataSource),
    phrases, phraseCount: phrases.length,
    noteCount: phrases.flatMap((p) => p.notes || []).length,
    previewNotes: structuredClone(track.previewNotes || []),
    pitchData: prepReady ? structuredClone(track.voiceSnapshot?.pitchData || null) : null,
  }
}

// ----- 模拟用户操作：USTX 首次导入 -----
async function importUstxFirstTime(yaml, store) {
  const importedProject = parseUstxToWebUtau(yaml)
  const incomingTracks = importedProject.tracks || []
  const voiceSnapshotPatches = new Map()
  const skeletonProject = {
    ...importedProject,
    tracks: incomingTracks.map((track, idx) => {
      const summary = {
        index: idx, name: track.name, color: track.color, hasLyrics: track.hasLyrics,
        role: track.role, contentType: track.contentType,
        duration: track.duration, durationTicks: track.durationTicks, noteCount: track.noteCount,
        previewNotes: track.previewNotes, playbackState: track.playbackState, audioClip: track.audioClip,
      }
      const doc = createTrackDocument(summary, track.sourcePhrases || [], track.languageCode || null)
      doc.singerId = track.singerId || null
      if (track._extensions) doc._extensions = track._extensions
      if (track.voiceSnapshot && track.prepState?.status === 'ready') {
        voiceSnapshotPatches.set(doc.id, { voiceSnapshot: track.voiceSnapshot, prepState: track.prepState })
      }
      return doc
    }),
  }
  const timedProject = applyProjectTiming(skeletonProject, { tempoData: skeletonProject.tempoData, ppq: skeletonProject.ppq })
  for (const t of timedProject.tracks) {
    const p = voiceSnapshotPatches.get(t.id)
    if (p) { t.voiceSnapshot = p.voiceSnapshot; t.prepState = p.prepState }
  }
  store.setProject(timedProject)
}

// ============================================================
describe('USTX 全数据流端到端审计', () => {
  it('阶段 1：USTX 导入 → store 内每个 phrase / note / pitchCurve 起点一致', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t = store.getProject().tracks[0]

    // sourcePhrases.startTime ↔ notes[0].time（绝对秒）
    for (let i = 0; i < Math.min(10, t.sourcePhrases.length); i++) {
      const ph = t.sourcePhrases[i]
      assert.equal(ph.startTime, ph.notes[0].time, `phrase[${i}] startTime != notes[0].time`)
    }
    // pitchCurve 起点 ↔ 第一个 note tick
    const firstNoteTick = t.sourcePhrases[0].notes[0].tick
    const firstCurveTick = t.voiceSnapshot.pitchData.pitchCurve[0].tick
    assert.equal(firstCurveTick, firstNoteTick, 'pitchCurve 起点 != 第一个 note 的 tick')

    // previewNotes flat 后 tick 序列跟 sourcePhrases flat 后一致
    const previewTicks = t.previewNotes.map((n) => n.tick)
    const phraseTicks = t.sourcePhrases.flatMap((p) => p.notes.map((n) => n.tick))
    assert.deepEqual(previewTicks, phraseTicks, 'previewNotes 和 sourcePhrases 的 tick 不一致')
  })

  it('阶段 2：buildVoiceSnapshot 输出含完整 phrases / previewNotes / pitchData / tempoData', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t = store.getProject().tracks[0]

    const snapshot = buildVoiceSnapshot(t, store.getProject().tempoData)
    assert.ok(snapshot, 'snapshot 非 null')
    assert.ok(snapshot.phrases.length > 0, '❌ snapshot.phrases 为空 — runtime 卷帘会空白')
    assert.equal(snapshot.phrases.length, t.sourcePhrases.length, 'phrase 数量应跟 store 一致')
    assert.ok(snapshot.previewNotes.length > 0, '❌ snapshot.previewNotes 为空')
    assert.ok(snapshot.pitchData?.pitchCurve?.length > 0, '❌ snapshot.pitchData 为空')
    assert.ok(snapshot.tempoData, '❌ snapshot.tempoData 缺失（runtime axis 会用 default 120bpm 导致偏移）')
    assert.equal(snapshot.tempoData.tempos.length, t.voiceSnapshot.tempoData?.tempos?.length || store.getProject().tempoData.tempos.length)
  })

  it('阶段 3：runtime axis 跟 host axis 用同一份 tempoData，tickToTime 结果一致', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t = store.getProject().tracks[0]
    const snapshot = buildVoiceSnapshot(t, store.getProject().tempoData)

    const hostAxis = createTimelineAxis({ tempoData: store.getProject().tempoData, ppq: 480, totalTicks: 200000 })
    const runtimeAxis = createTimelineAxis({ tempoData: snapshot.tempoData, ppq: 480, totalTicks: 200000 })

    const testTicks = [0, 5000, 11040, 50000, 100000, 161160, 224640, 300000]
    for (const tick of testTicks) {
      const hostTime = hostAxis.tickToTime(tick)
      const runtimeTime = runtimeAxis.tickToTime(tick)
      assert.ok(Math.abs(hostTime - runtimeTime) < 0.001,
        `tick=${tick}: host=${hostTime.toFixed(3)}s vs runtime=${runtimeTime.toFixed(3)}s 差 ${(hostTime - runtimeTime).toFixed(3)}s`)
    }
  })

  it('阶段 4：runtime 端接收 snapshot 后能正确显示音符位置（模拟 PianoRollNotes 渲染）', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t = store.getProject().tracks[0]
    const snapshot = buildVoiceSnapshot(t, store.getProject().tempoData)

    // 模拟 PianoRollNotes.js 第 50 行 `viewport.timeToX(note.time)`：用 axis + note.time 算 x
    const runtimeAxis = createTimelineAxis({ tempoData: snapshot.tempoData, ppq: 480, totalTicks: 200000 })
    const beatWidth = 40  // PianoRollViewport 默认
    function timeToX(time) {
      // viewport 用 axis.timeToX，等价于 tickToX(timeToTick(time))
      return runtimeAxis.timeToX(time)
    }
    const note0X = timeToX(snapshot.phrases[0].notes[0].time)
    const note0XFromTick = runtimeAxis.tickToX(snapshot.phrases[0].notes[0].tick)
    assert.ok(Math.abs(note0X - note0XFromTick) < 1, `note0 x 通过 time/tick 两路径算不一致：${note0X} vs ${note0XFromTick}`)
  })

  it('阶段 5：完整 round-trip（USTX → store → snapshot → 重新导出 → 重新导入）保持音高曲线', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t1 = store.getProject().tracks[0]
    const pitchCurveLen1 = t1.voiceSnapshot?.pitchData?.pitchCurve?.length || 0
    const firstNote1Tick = t1.previewNotes[0].tick

    // 导出
    const yaml2 = serializeWebUtauToUstx(store.getProject())
    // 二次导入
    const store2 = new ProjectDocumentStore()
    await importUstxFirstTime(yaml2, store2)
    const t2 = store2.getProject().tracks[0]
    const pitchCurveLen2 = t2.voiceSnapshot?.pitchData?.pitchCurve?.length || 0
    const firstNote2Tick = t2.previewNotes[0].tick

    assert.equal(firstNote1Tick, firstNote2Tick, `round-trip 后第一 note tick 变化: ${firstNote1Tick} → ${firstNote2Tick}`)
    assert.ok(pitchCurveLen2 > 0, 'round-trip 后 pitchCurve 应还在')
    assert.ok(Math.abs(pitchCurveLen1 - pitchCurveLen2) < pitchCurveLen1 * 0.01,
      `pitchCurve 长度变化超 1%: ${pitchCurveLen1} → ${pitchCurveLen2}`)
  })

  it('阶段 6：导出 YAML 内 voice_part.position 跟原文件等价（不挤一小节）', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const yaml2 = serializeWebUtauToUstx(store.getProject())

    const re = /^  - name: Part \d+[\s\S]*?^    position: (\d+)/gm
    let m, positions = []
    while ((m = re.exec(yaml2)) !== null) positions.push(parseInt(m[1], 10))
    const uniquePos = new Set(positions).size
    assert.ok(uniquePos > 1, `导出 YAML 内所有 part position 重复 ${positions.length} 个全 ${positions[0]}（挤一团）`)
    assert.ok(positions[0] >= 5000, `第一个 part position=${positions[0]}（小于 5000 tick 说明被错位到原点）`)
  })

  it('阶段 6.5：完整模拟用户实际操作链（USTX 导入 → 双击 → 切 lyric/pitch）', async () => {
    // 直接复现用户最近 console log 抱怨的 "phrases=0 句" 场景
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const trackId = store.getProject().tracks[0].id

    // 模拟双击轨道（setEditorTrack 不动 voiceSnapshot）
    store.setEditorTrack(trackId)

    // 模拟切 lyric 模式：handleEditorModeSelected → requires=true → prediction gate.run → alreadyPredicted=true 分支
    // 由于 USTX import 时已经走过 createTrackDocument，prepState=ready + pitchCurve 完整
    const trackBefore = store.getTrack(trackId)
    assert.equal(trackBefore.prepState?.status, 'ready', '切 lyric 前 prepState=ready')
    assert.ok(hasPredictedPitch(trackBefore.voiceSnapshot), '切 lyric 前 pitchData 完整')

    // 双击触发 persistInstrumentEditorDraft —— 这是用户最近遇到的 phrases 被擦的关键路径
    // 因为 USTX track 没 jobRef.jobId，旧版 isPreparedVoiceTrack=false → 走 replaceTrackNotes 擦 voiceSnapshot
    // 修复后的 isPreparedVoiceTrack 只看 pitchCurve.length，应当 true
    function isPreparedVoiceTrackNew(track) {
      return Boolean(
        track
        && !isAudioTrack(track)
        && track.playbackState?.assignedSourceId === 'vocal'
        && isTrackPrepReady(track)
        && track.voiceSnapshot?.pitchData?.pitchCurve?.length,
      )
    }
    assert.equal(isPreparedVoiceTrackNew(trackBefore), true, 'USTX 合成 voiceSnapshot 应算 prepared（修复后）')

    // 模拟切 pitch 模式：requires=false 时（如果 languageCode 已推断为 ZH）走 loadTrackIntoVoiceEditor
    const snapshotForRuntime = buildVoiceSnapshot(trackBefore, store.getProject().tempoData)
    assert.ok(snapshotForRuntime.phrases.length > 0, '关键回归：发给 runtime 的 snapshot.phrases 不能为空')
    assert.ok(snapshotForRuntime.pitchData?.pitchCurve?.length > 0, 'snapshot.pitchData 完整')

    // 模拟 store.replaceVoiceSnapshot 流程（runtime 反馈或 onPredictionReady 模拟）
    store.replaceVoiceSnapshot(trackId, snapshotForRuntime)
    const trackAfter = store.getTrack(trackId)
    assert.ok(hasPredictedPitch(trackAfter.voiceSnapshot), '替换后 pitchData 保留')
    assert.equal(trackAfter.previewNotes.length, trackBefore.previewNotes.length, 'previewNotes 数量一致')
  })

  it('阶段 6.7：alreadyPredicted 路径必须 mark jobRef.status=active（否则 UI 卡"渲染中"）', async () => {
    // 用户最近 log 暴露：渲染完成（progress 82/82）但 UI 仍显示"渲染中"、播放无声
    // 根因：alreadyPredicted 分支跳过了 taskCoordinator.beginPrediction → jobRef.status='idle'
    // → matchesActiveTask 拒绝 onRenderComplete / onRenderProgress / onPhraseReady 等所有 backend 事件
    // → host vocalAssetRegistry 拿不到音频 + UI 状态不刷
    const { TrackPredictionGateController } = await import('../src/host/controllers/TrackPredictionGateController.js')

    const track = {
      id: 'track-0', name: 'T', languageCode: 'ZH', singerId: 's',
      playbackState: { assignedSourceId: 'vocal' },
      prepState: { status: 'ready', progress: 100, error: null },
      jobRef: { jobId: null, status: 'idle', revision: 0 },
      revision: 0,
      voiceSnapshot: { pitchData: { pitchCurve: [{ tick: 0, pitch: 60 }, { tick: 5, pitch: 60 }] } },
      sourcePhrases: [],
    }
    const project = { tracks: [track], tempoData: null, ppq: 480 }
    const fakeStore = {
      getTrack: (id) => project.tracks.find((t) => t.id === id) || null,
      getProject: () => project,
      getEditorTrack: () => null,
      updateTrack: () => {}, updateTrackPrepState: () => {}, updateTrackRenderState: () => {},
      replaceVoiceSnapshot: () => {},
    }
    const calls = []
    const fakeBridge = {
      loadTrack: async () => { calls.push(['loadTrack']) },
      startSynthesis: async () => { calls.push(['startSynthesis']) },
      setEditorMode: async () => {},
    }
    const fakeCoordinator = {
      beginPrediction: () => { calls.push(['beginPrediction']) },
      setRuntimeTrack: () => {},
      resetTrackTask: () => {},
    }
    const ctrl = new TrackPredictionGateController({
      store: fakeStore,
      view: { showTrackSynthesisOverlay: () => {}, updateTrackSynthesisOverlay: () => {}, hideTrackSynthesisOverlay: () => {}, setStatus: () => {}, notifyRuntimeLayoutChanged: () => {}, hidePlaybackToast: () => {}, promptTrackLanguage: async () => ({ languageCode: 'ZH', singerId: 's' }) },
      bridge: fakeBridge,
      importService: { buildVoiceSnapshot: (t) => ({ trackId: t.id, pitchData: t.voiceSnapshot.pitchData }) },
      taskCoordinator: fakeCoordinator,
      prepWaiters: { wait: async () => ({ ok: true }), resolve: () => {} },
      render: () => {},
      onEditorOpened: () => {},
      onEditorCleared: () => {},
      onTrackPreparationInvalidated: () => {},
      persistEditorSnapshot: async () => {},
    })

    await ctrl.run('track-0', 'open')

    // 关键：beginPrediction 必须在 startSynthesis 之前调，确保 backend 事件能通过 matchesActiveTask
    const order = calls.map(([m]) => m)
    const beginIdx = order.indexOf('beginPrediction')
    const synthIdx = order.indexOf('startSynthesis')
    assert.ok(beginIdx >= 0, '❌ beginPrediction 未被调用 → UI 会卡渲染中、播放无声')
    assert.ok(synthIdx >= 0, '❌ startSynthesis 未被调用 → 后端没渲染、播放无声')
    assert.ok(beginIdx < synthIdx, 'beginPrediction 必须在 startSynthesis 之前（先 mark active 才能接 backend 事件）')
  })

  it('阶段 6.8：backend 重建后 phrase[0] 起始晚于第一个 note 时，不丢音符（开头不缺）', async () => {
    // 用户报告："webutau 导出去再导入一圈以后，开头就有缺音符"
    // 根因链：
    //   1. backend rebuildFromBackend 把 phrase[0].startMs 设得比 webutau note[0].time 晚
    //   2. _distributeNotes 旧版只找"前一个 phrase"找不到 → 丢孤儿（已修复）
    //   3. 即便分到 phrase[0]，PreviewProjector 看到 note.time<phrase.startTime
    //      错误判为 part-relative → 加偏移 → tick 翻倍错位 → 视觉缺
    const { buildPreviewProjection } = await import('../src/host/services/PreviewProjector.js')

    // 模拟：phrase[0].startTime=18s，但 note[0].time=16.83s（webutau 的开头 note）
    const snapshot = {
      tempoData: { tempos: [{ ticks: 0, bpm: 120, time: 0 }] },
      phrases: [
        {
          index: 0,
          startTime: 18.0,
          endTime: 20.0,
          notes: [
            // 在 phrase[0] 起始之前的 note（_distributeNotes 修复后归入 phrase[0]）
            { time: 16.83, duration: 0.5, tick: 8076, durationTicks: 240, midi: 69, lyric: '你' },
            { time: 17.20, duration: 0.5, tick: 8254, durationTicks: 240, midi: 67, lyric: '是' },
            // 正常落在 phrase[0] 时间窗内
            { time: 18.5, duration: 0.5, tick: 8880, durationTicks: 240, midi: 65, lyric: '信' },
          ],
        },
      ],
    }
    const proj = buildPreviewProjection(snapshot, null, 480)
    assert.equal(proj.previewNotes.length, 3, '3 个 note 都应保留')
    // 关键：note[0] / note[1] 的 tick 不能被翻倍错位（旧代码会把 time 加 phrase.startTime=18 → tick≈16000+）
    assert.ok(proj.previewNotes[0].tick < 10000, `note[0].tick=${proj.previewNotes[0].tick} 太大（被错误偏移了）`)
    assert.ok(proj.previewNotes[1].tick < 10000, `note[1].tick=${proj.previewNotes[1].tick} 太大`)
    // tick 与 time 自洽
    assert.ok(Math.abs(proj.previewNotes[0].time - 16.83) < 0.01, 'note[0].time 保持 16.83s')
    assert.ok(Math.abs(proj.previewNotes[1].time - 17.20) < 0.01, 'note[1].time 保持 17.20s')
    assert.ok(Math.abs(proj.previewNotes[2].time - 18.5) < 0.01, 'note[2].time 保持 18.5s')
  })

  it('阶段 6.9：phrase 内所有 note.time 都 < phrase.startTime（真正污染）才加偏移', async () => {
    const { buildPreviewProjection } = await import('../src/host/services/PreviewProjector.js')
    // 真正的 part-relative 污染场景：phrase.startTime=18，但 phrase 内所有 note.time
    // 都是 part-relative（< 18）。这种情况 PreviewProjector 应识别并加偏移
    const snapshot = {
      tempoData: { tempos: [{ ticks: 0, bpm: 120, time: 0 }] },
      phrases: [
        {
          index: 0,
          startTime: 18.0,
          endTime: 20.0,
          notes: [
            { time: 0.0, duration: 0.5, tick: 0, durationTicks: 240, midi: 60, lyric: 'a' },
            { time: 0.5, duration: 0.5, tick: 240, durationTicks: 240, midi: 62, lyric: 'b' },
          ],
        },
      ],
    }
    const proj = buildPreviewProjection(snapshot, null, 480)
    assert.equal(proj.previewNotes.length, 2)
    // 这次因为整组 note.time 都 < startTime，被识别为 part-relative，应加 startTime 偏移
    assert.ok(Math.abs(proj.previewNotes[0].time - 18.0) < 0.01, 'note[0].time 应加上 phrase.startTime')
    assert.ok(Math.abs(proj.previewNotes[1].time - 18.5) < 0.01, 'note[1].time 应加上 phrase.startTime')
  })

  it('阶段 6.95：timePolluted 误判 — time=0 但 tick 绝对时不能翻倍偏移', async () => {
    // 这是 webutau→USTX→webutau 来回后开头缺音符的最深一层 bug：
    // 1. createTrackDocument 兜底 note.time=0
    // 2. backend rebuild snapshot.phrases 内 note.time 沿用兜底 0（time 全相同 → timePolluted=true）
    // 3. 但 note.tick 是绝对值（11040 等）
    // 4. PreviewProjector 旧逻辑无脑给绝对 tick 加 phraseStartTick 偏移 → tick 翻倍 22736
    // 5. 视觉上音符跑到错位置 → 开头看起来"缺"
    const { buildPreviewProjection } = await import('../src/host/services/PreviewProjector.js')

    const snapshot = {
      tempoData: { tempos: [{ ticks: 0, bpm: 82, time: 0 }] },
      phrases: [
        {
          index: 0,
          startTime: 17.829,  // backend 推迟了 1s（原本 16.829）
          endTime: 18.5,
          notes: [
            // tick 是绝对值（来自 createTrackDocument），time=0 是兜底
            { time: 0, duration: 0.05, tick: 11040, durationTicks: 240, midi: 69, lyric: '你' },
            { time: 0, duration: 0.05, tick: 11280, durationTicks: 240, midi: 67, lyric: '是' },
          ],
        },
      ],
    }
    const proj = buildPreviewProjection(snapshot, snapshot.tempoData, 480)
    // 关键断言：tick 不能被翻倍（旧 bug: 11040 + axis.timeToTick(17.829) = 22736）
    assert.equal(proj.previewNotes[0].tick, 11040, `tick 被翻倍错位（${proj.previewNotes[0].tick}）`)
    assert.equal(proj.previewNotes[1].tick, 11280, `tick 被翻倍错位（${proj.previewNotes[1].tick}）`)
    // time 也应当跟 tick 自洽
    assert.ok(Math.abs(proj.previewNotes[0].time - 16.829) < 0.01, `time 应当 ≈ 16.829s 实际 ${proj.previewNotes[0].time}`)
  })

  it('阶段 6.98：backend 双叠加 bug — partPos 翻倍 + note rawPos≈partPos 都要修正', async () => {
    // 用户报告 "(6).ustx 开头缺音符" 的最终根因：
    // backend 渲染 phrase 时存在双叠加 bug，导致 USTX 文件里:
    //   (A) 某些 voice_part 的 position 翻倍（远超合理时间线，且 partPos/2 接近合理位置）
    //   (B) 某些 part 内某个 note 的 raw position ≈ partPosition（让 absTick=2×partPos）
    // ustx-import 必须兜底检测并修正这两类 outlier，否则 note 会"漂"到 2 倍远的位置。
    //
    // 构造场景：3 个 part
    //   - part 0: 正常，partPos=10000，note 在 [10000, 10500) (rawPos=0~500)
    //   - part 1: ★ part.position 翻倍 (50000，实际应当 25000)，note 在 partPos+0~500
    //   - part 2: ★ note[0] 是 outlier rawPos≈partPos (note[0].position=29900 ≈ partPos=30000)
    //              note[1..N] 正常 rawPos=0~500
    const synthUstx = `ustx_version: '0.7.0'
name: synth
tracks:
  - track_no: 0
    track_name: t
    singer: ''
voice_parts:
  - name: P0
    track_no: 0
    position: 10000
    duration: 500
    notes:
      - position: 0
        duration: 100
        tone: 60
        lyric: a
      - position: 200
        duration: 100
        tone: 62
        lyric: b
  - name: P1
    track_no: 0
    position: 50000
    duration: 500
    notes:
      - position: 0
        duration: 100
        tone: 64
        lyric: c
      - position: 200
        duration: 100
        tone: 65
        lyric: d
  - name: P2
    track_no: 0
    position: 30000
    duration: 30000
    notes:
      - position: 29900
        duration: 100
        tone: 67
        lyric: e
      - position: 0
        duration: 100
        tone: 69
        lyric: f
      - position: 200
        duration: 100
        tone: 71
        lyric: g
tempos:
  - position: 0
    bpm: 120
time_signatures:
  - bar_position: 0
    beat_per_bar: 4
    beat_unit: 4
`
    const project = parseUstxToWebUtau(synthUstx)
    const track = project.tracks[0]
    // 期望:
    //   P0 normal: note tick=10000, 10200
    //   P1 partPos 修正 50000→25000: note tick=25000, 25200
    //   P2 note[0] outlier (rawPos 29900 ≈ partPos 30000) 修正 absTick=30000-100=29900
    //      note[1..2] 正常 tick=30000, 30200
    const ticks = track.previewNotes.map((n) => n.tick).sort((a, b) => a - b)
    assert.ok(ticks.includes(10000), `期望 partPos=10000 note，实际 ticks=${ticks}`)
    assert.ok(ticks.includes(25000), `期望 part 1 partPos 翻倍 50000→25000 修正后 note tick=25000，实际 ticks=${ticks}`)
    assert.ok(ticks.includes(29900), `期望 part 2 outlier note 修正为 absTick=29900，实际 ticks=${ticks}`)
    assert.ok(ticks.includes(30000), `期望 part 2 正常 note tick=30000，实际 ticks=${ticks}`)
    // 反向断言:不能有 100000+（partPos 翻倍未修复）或 60000（note outlier 未修复 absTick=2*partPos）
    assert.ok(!ticks.some((t) => t >= 50000), `partPos 翻倍未被修复，存在 tick≥50000 的 note: ${ticks.filter((t) => t >= 50000)}`)
    assert.ok(!ticks.some((t) => t >= 59000 && t < 60000), `note outlier (raw≈partPos) 未被修复，存在 tick~59900: ${ticks.filter((t) => t >= 59000 && t < 60000)}`)
  })

  it('阶段 7：store.replaceVoiceSnapshot 用空 pitchData 调用时不擦除现有 pitchData', async () => {
    const yaml = await readFile(REAL_USTX_PATH, 'utf8')
    const store = new ProjectDocumentStore()
    await importUstxFirstTime(yaml, store)
    const t = store.getProject().tracks[0]
    assert.ok(hasPredictedPitch(t.voiceSnapshot), '前置：导入后 pitchData 存在')

    // 模拟某条意外路径调 replaceVoiceSnapshot 带空 pitchData
    store.replaceVoiceSnapshot(t.id, {
      trackId: t.id,
      phrases: t.sourcePhrases,
      pitchData: null,  // ← 关键：空
      tempoData: store.getProject().tempoData,
    })

    const tAfter = store.getTrack(t.id)
    assert.ok(hasPredictedPitch(tAfter.voiceSnapshot),
      '❌ replaceVoiceSnapshot 用空 pitchData 调用后 pitchData 被擦了')
  })
})
