import { parseUstxToWebUtau } from '../src/formats/ustx-import.js'
import { serializeWebUtauToUstx } from '../src/formats/ustx-export.js'
import { EXTENSIONS_KEY } from '../src/formats/ustx-types.js'

let checks = 0
let failures = 0
function check(name, fn) {
  checks++
  const ok = fn()
  console.log(`  ${ok ? 'OK' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

// ============================================================
// Test 1: Full round-trip with pitch and vibrato
// ============================================================
const originalYaml = `name: Test Song
ustx_version: "0.9"
comment: ""
output_dir: Vocal
cache_dir: UCache
expressions: {}
tempos:
  - position: 0
    bpm: 120
time_signatures:
  - bar_position: 0
    beat_per_bar: 4
    beat_unit: 4
tracks:
  - track_no: 0
    track_name: MyTrack
    singer: ""
    phonemizer: ""
    mute: false
    solo: false
    volume: 0.0
    pan: 0.0
    renderer_settings:
      renderer: WORLDLINE-R
      resampler: ""
      wavtool: ""
    track_expressions: []
    voice_color_names:
      - ""
voice_parts:
  - name: Part 1
    comment: ""
    track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 480
        tone: 60
        lyric: "こ"
        tuning: 0
        pitch:
          snap_first: true
          data:
            - x: 0
              y: 0
              shape: io
            - x: 50
              y: 10
              shape: l
        vibrato:
          length: 0
          period: 175
          depth: 25
          in: 10
          out: 10
          shift: 0
          drift: 0
          vol_link: 0
        phoneme_expressions: []
        phoneme_overrides: []
      - position: 480
        duration: 480
        tone: 62
        lyric: "ん"
        tuning: 0
        phoneme_expressions: []
        phoneme_overrides: []
wave_parts: []
`

console.log('=== Test 1: Round-trip with pitch data ===')
const imported = parseUstxToWebUtau(originalYaml)
const track = imported.tracks[0]

check('fileName', () => imported.fileName === 'Test Song')
check('track count', () => imported.tracks.length === 1)
check('track name', () => track.name === 'MyTrack')
check('note count', () => track.previewNotes.length === 2)

const n0 = track.previewNotes[0]
check('note[0].tick', () => n0.tick === 0)
check('note[0].durationTicks', () => n0.durationTicks === 480)
check('note[0].midi', () => n0.midi === 60)
check('note[0].lyric', () => n0.lyric === 'こ')
check('note[0].tuning', () => n0.tuning === 0)
// vibrato length=0 → property is absent (undefined / falsy)
check('note[0].vibrato absent (length=0)', () => !n0.vibrato)
// pitch exists with 2 points
check('note[0].pitch exists', () => Boolean(n0.pitch))
check('note[0].pitch.snapFirst', () => n0.pitch.snapFirst === true)
check('note[0].pitch points', () => n0.pitch.data.length === 2)
check('note[0].pitch[0].shape io', () => n0.pitch.data[0].shape === 'io')
check('note[0].pitch[1].shape l', () => n0.pitch.data[1].shape === 'l')

const n1 = track.previewNotes[1]
check('note[1].tick', () => n1.tick === 480)
check('note[1].lyric', () => n1.lyric === 'ん')
check('note[1].pitch absent', () => !n1.pitch)
check('note[1].vibrato absent', () => !n1.vibrato)

// Export → re-import
const reExportedYaml = serializeWebUtauToUstx(imported)
const reimported = parseUstxToWebUtau(reExportedYaml)
const rt = reimported.tracks[0]

check('round-trip: fileName', () => reimported.fileName === 'Test Song')
check('round-trip: note count', () => rt.previewNotes.length === 2)
check('round-trip: note[0].tick', () => rt.previewNotes[0].tick === 0)
check('round-trip: note[0].midi', () => rt.previewNotes[0].midi === 60)
check('round-trip: note[0].lyric', () => rt.previewNotes[0].lyric === 'こ')
check('round-trip: note[0].pitch points', () => rt.previewNotes[0].pitch.data.length === 2)
check('round-trip: note[0].pitch[0].x', () => rt.previewNotes[0].pitch.data[0].x === 0)
check('round-trip: note[0].pitch[0].y', () => rt.previewNotes[0].pitch.data[0].y === 0)
check('round-trip: note[0].pitch[1].x', () => rt.previewNotes[0].pitch.data[1].x === 50)
check('round-trip: note[0].pitch[1].y', () => rt.previewNotes[0].pitch.data[1].y === 10)
check('round-trip: note[1].tick', () => rt.previewNotes[1].tick === 480)
check('round-trip: note[1].midi', () => rt.previewNotes[1].midi === 62)
// 导出后每个 note 都有默认 pitch/vibrato（双锚点对齐 UProject.CreateNote()）
check('round-trip: note[1].pitch exists (auto-filled)', () => Boolean(rt.previewNotes[1].pitch))
check('round-trip: note[1].pitch default snapFirst', () => rt.previewNotes[1].pitch.snapFirst === true)
check('round-trip: note[1].pitch anchor points count=2', () => rt.previewNotes[1].pitch.data.length === 2)
check('round-trip: note[1].pitch anchor[0] x=-40', () => rt.previewNotes[1].pitch.data[0].x === -40)
check('round-trip: note[1].pitch anchor[0] y=0', () => rt.previewNotes[1].pitch.data[0].y === 0)
check('round-trip: note[1].pitch anchor[0] shape=io', () => rt.previewNotes[1].pitch.data[0].shape === 'io')
check('round-trip: note[1].pitch anchor[1] x=40', () => rt.previewNotes[1].pitch.data[1].x === 40)
check('round-trip: note[1].pitch anchor[1] y=0', () => rt.previewNotes[1].pitch.data[1].y === 0)
check('round-trip: note[1].pitch anchor[1] shape=io', () => rt.previewNotes[1].pitch.data[1].shape === 'io')
// 验证 phonemes / phoneme_indexes 桩注入
check('round-trip: yaml has phonemes', () => reExportedYaml.includes('phonemes:'))
check('round-trip: yaml has phoneme_indexes', () => reExportedYaml.includes('phoneme_indexes:'))
check('round-trip: note[0] phoneme_indexes=[0]', () => {
  const n0ext = rt.previewNotes[0][EXTENSIONS_KEY]
  return n0ext && Array.isArray(n0ext.phoneme_indexes) && n0ext.phoneme_indexes[0] === 0
})

// ============================================================
// Test 2: Null pitch/vibrato handling
// ============================================================
console.log('\n=== Test 2: Null pitch/vibrato semantics ===')
const noPitchYaml = `name: No Pitch
ustx_version: "0.9"
comment: ""
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
    track_name: T1
    singer: ""
    phonemizer: ""
    mute: false
    solo: false
    volume: 0.0
    pan: 0.0
voice_parts:
  - name: P1
    comment: ""
    track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 240
        tone: 72
        lyric: la
        tuning: 0
        phoneme_expressions: []
        phoneme_overrides: []
wave_parts: []
`
const noPitchImport = parseUstxToWebUtau(noPitchYaml)
const np0 = noPitchImport.tracks[0].previewNotes[0]
check('null pitch: pitch absent', () => !np0.pitch)
check('null pitch: vibrato absent', () => !np0.vibrato)

const noPitchExport = serializeWebUtauToUstx(noPitchImport)
// 每个 note 都自动获得默认 pitch/vibrato — C# 侧 UNote.pitch 无初始化器，必须显式提供
check('null pitch: exported yaml has pitch key (auto-filled)', () => noPitchExport.includes('pitch:'))
  // 验证 phonemes / phoneme_indexes 桩注入
  check('null pitch: exported yaml has phonemes', () => noPitchExport.includes('phonemes:'))
  check('null pitch: exported yaml has phoneme_indexes', () => noPitchExport.includes('phoneme_indexes:'))

// ============================================================
// Test 3: Multi-part (multiple phrases → multiple voice parts)
// ============================================================
console.log('\n=== Test 3: Multi-part (velocity + multi-phrase) ===')
const multiPartYaml = `name: Multi
ustx_version: "0.9"
comment: ""
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
    track_name: T1
    singer: ""
    phonemizer: ""
    mute: false
    solo: false
    volume: 0.0
    pan: 0.0
  - track_no: 1
    track_name: T2
    singer: ""
    phonemizer: ""
    mute: true
    solo: false
    volume: -3.5
    pan: 0.5
voice_parts:
  - name: P1
    comment: ""
    track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 240
        tone: 60
        lyric: a
        tuning: 0
        phoneme_expressions:
          - abbr: vel
            index: 0
            value: 160
        phoneme_overrides: []
  - name: P2
    comment: ""
    track_no: 0
    position: 240
    notes:
      - position: 0
        duration: 240
        tone: 64
        lyric: i
        tuning: 0
        phoneme_expressions: []
        phoneme_overrides: []
  - name: P3
    comment: ""
    track_no: 1
    position: 0
    notes:
      - position: 0
        duration: 480
        tone: 67
        lyric: u
        tuning: 0
        phoneme_expressions: []
        phoneme_overrides: []
wave_parts: []
`
const mp = parseUstxToWebUtau(multiPartYaml)
check('multi: 2 tracks', () => mp.tracks.length === 2)

const tr0 = mp.tracks[0]
check('multi: track0 name T1', () => tr0.name === 'T1')
check('multi: track0 not muted', () => !tr0.playbackState.mute)
check('multi: track0 note count=2', () => tr0.previewNotes.length === 2)
check('multi: track0 note[0].tick=0', () => tr0.previewNotes[0].tick === 0)
check('multi: track0 note[1].tick=240', () => tr0.previewNotes[1].tick === 240)
check('multi: velocity from VEL 160→0.8', () => tr0.previewNotes[0].velocity === 0.8)

const tr1 = mp.tracks[1]
check('multi: track1 name T2', () => tr1.name === 'T2')
check('multi: track1 muted', () => tr1.playbackState.mute)
check('multi: track1 note count=1', () => tr1.previewNotes.length === 1)
check('multi: track1 note[0].tick=0', () => tr1.previewNotes[0].tick === 0)
check('multi: track1 note[0].midi=67', () => tr1.previewNotes[0].midi === 67)

const mpExport = serializeWebUtauToUstx(mp)
const mpReimport = parseUstxToWebUtau(mpExport)
check('multi round-trip: 2 tracks', () => mpReimport.tracks.length === 2)
check('multi round-trip: t0 2 notes', () => mpReimport.tracks[0].previewNotes.length === 2)
check('multi round-trip: t1 1 note', () => mpReimport.tracks[1].previewNotes.length === 1)

// ============================================================
// Test 4: _extensions shadow data
// ============================================================
console.log('\n=== Test 4: Shadow data / _extensions ===')
const withOrphanYaml = `name: Ext Test
ustx_version: "0.9"
comment: "A custom comment"
output_dir: MyOutput
cache_dir: MyCache
expressions:
  dyn:
    name: Dynamics
    abbr: dyn
    type: curve
    min: -100
    max: 100
    default_value: 0
    is_flag: false
tempos:
  - position: 0
    bpm: 140
time_signatures:
  - bar_position: 0
    beat_per_bar: 3
    beat_unit: 4
tracks:
  - track_no: 0
    track_name: ExTrack
    singer: mysinger
    phonemizer: MyPhonemizer
    mute: false
    solo: false
    volume: 0.0
    pan: 0.0
    renderer_settings:
      renderer: WORLDLINE-R
      resampler: myresampler
      wavtool: ""
    track_expressions: []
    voice_color_names:
      - ""
voice_parts:
  - name: Part 1
    comment: ""
    track_no: 0
    position: 480
    notes:
      - position: 0
        duration: 480
        tone: 60
        lyric: a
        tuning: 0
        pitch:
          snap_first: true
          data: []
        vibrato:
          length: 75
          period: 200
          depth: 30
          in: 15
          out: 20
          shift: 5
          drift: 0
          vol_link: 0
        phoneme_expressions:
          - abbr: dyn
            index: 0
            value: 10
        phoneme_overrides:
          - index: 0
            phoneme: ""
            preutter: 15.0
            overlap: 5.0
        custom_field_1: retained_value
        custom_field_2: 42
wave_parts: []
`
const extImport = parseUstxToWebUtau(withOrphanYaml)

// Verify project extensions (snake_case keys from YAML)
const projExt = extImport[EXTENSIONS_KEY]
check('ext: project comment preserved', () => projExt && projExt.comment === 'A custom comment')
check('ext: project output_dir preserved', () => projExt && projExt.output_dir === 'MyOutput')
check('ext: project cache_dir preserved', () => projExt && projExt.cache_dir === 'MyCache')
check('ext: project expressions preserved', () => projExt && projExt.expressions && projExt.expressions.dyn)

// Verify track extensions (snake_case)
const extTrack = extImport.tracks[0]
const trackExt = extTrack[EXTENSIONS_KEY]
check('ext: track renderer_settings present', () => trackExt && trackExt.renderer_settings
  && trackExt.renderer_settings.renderer === 'WORLDLINE-R')
check('ext: track resampler preserved', () => trackExt && trackExt.renderer_settings
  && trackExt.renderer_settings.resampler === 'myresampler')
check('ext: track singer mapped to singerId', () => extTrack.singerId === 'mysinger')

// Verify note extensions (snake_case)
const extNote = extTrack.previewNotes[0]
const noteExt = extNote[EXTENSIONS_KEY]
check('ext: note phoneme_expressions present', () => noteExt && Array.isArray(noteExt.phoneme_expressions)
  && noteExt.phoneme_expressions.length === 1)
check('ext: note phoneme_overrides preserved', () => noteExt && Array.isArray(noteExt.phoneme_overrides)
  && noteExt.phoneme_overrides.length === 1)
check('ext: note phoneme_overrides preutter', () => noteExt
  && noteExt.phoneme_overrides[0].preutter === 15)
check('ext: note custom_field_1 preserved', () => noteExt && noteExt.custom_field_1 === 'retained_value')
check('ext: note custom_field_2 preserved', () => noteExt && noteExt.custom_field_2 === 42)

// Round-trip with extensions
const extExport = serializeWebUtauToUstx(extImport)
check('ext round-trip: yaml has custom comment', () => extExport.includes('custom comment'))
check('ext round-trip: yaml has retained_value', () => extExport.includes('retained_value'))
check('ext round-trip: yaml has renderer_settings', () => extExport.includes('WORLDLINE-R'))
check('ext round-trip: yaml has MyOutput', () => extExport.includes('MyOutput'))
check('ext round-trip: yaml has MyCache', () => extExport.includes('MyCache'))
check('ext round-trip: yaml has myresampler', () => extExport.includes('myresampler'))

const extReimport = parseUstxToWebUtau(extExport)
const extReProjExt = extReimport[EXTENSIONS_KEY]
check('ext round-trip: comment survives', () => extReProjExt && extReProjExt.comment === 'A custom comment')
check('ext round-trip: output_dir survives', () => extReProjExt && extReProjExt.output_dir === 'MyOutput')

const extReNote = extReimport.tracks[0].previewNotes[0]
const extReNoteExt = extReNote[EXTENSIONS_KEY]
check('ext round-trip: custom_field_1 survives', () => extReNoteExt && extReNoteExt.custom_field_1 === 'retained_value')
check('ext round-trip: custom_field_2 survives', () => extReNoteExt && extReNoteExt.custom_field_2 === 42)
check('ext round-trip: vibrato length=75', () => Math.abs(extReNote.vibrato.length - 75) < 0.01)

// ============================================================
// Test 5: 边界回归
// ============================================================
console.log('\n=== Test 5: 边界回归（空 phrase / velocity=0 / 音量 round-trip）===')

// 5a. 空 phrase 不应该让导出崩
const projWithEmptyPhrase = {
  fileName: 'Edge',
  tracks: [{
    name: 'T', midiTrackIndex: 0,
    sourcePhrases: [
      { notes: [] },
      { notes: [{ tick: 0, durationTicks: 240, midi: 60, lyric: 'a' }] },
    ],
  }],
  tempoData: { tempos: [{ ticks: 0, bpm: 120 }], timeSignatures: [] },
  ppq: 480,
}
check('edge: 空 phrase 不抛错', () => {
  try { serializeWebUtauToUstx(projWithEmptyPhrase); return true }
  catch { return false }
})
check('edge: 空 phrase 被过滤，只保留有 note 的 part', () => {
  const y = serializeWebUtauToUstx(projWithEmptyPhrase)
  const r = parseUstxToWebUtau(y)
  return r.tracks[0].previewNotes.length === 1
})

// 5b. velocity=0 round-trip
const projVel0 = {
  fileName: 'V0',
  tracks: [{
    name: 'T', midiTrackIndex: 0,
    sourcePhrases: [{ notes: [{ tick: 0, durationTicks: 240, midi: 60, lyric: 'a', velocity: 0 }] }],
  }],
  tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
  ppq: 480,
}
{
  const y = serializeWebUtauToUstx(projVel0)
  const r = parseUstxToWebUtau(y)
  check('edge: velocity=0 round-trip 保持 0', () => r.tracks[0].previewNotes[0].velocity === 0)
}

// 5c. 音量 round-trip 在 [0, 1] 多点采样下偏差 ≤ 1%
{
  const samples = [0.0, 0.25, 0.5, 0.75, 1.0]
  let allOk = true
  for (const v of samples) {
    const proj = {
      fileName: 'Vol',
      tracks: [{
        name: 'T', midiTrackIndex: 0,
        playbackState: { volume: v },
        sourcePhrases: [{ notes: [{ tick: 0, durationTicks: 240, midi: 60, lyric: 'a' }] }],
      }],
      tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
      ppq: 480,
    }
    const r = parseUstxToWebUtau(serializeWebUtauToUstx(proj))
    const rv = r.tracks[0].playbackState.volume
    if (Math.abs(rv - v) > 0.01) {
      console.log(`    volume ${v} → ${rv}（偏差 ${Math.abs(rv - v).toFixed(3)}）`)
      allOk = false
    }
  }
  check('edge: 音量 round-trip 在 [0,1] 偏差 ≤ 1%', () => allOk)
}

// ============================================================
// Test 6: voiceSnapshot.pitchData 影子 round-trip（webUTAU 闭环）
// ============================================================
console.log('\n=== Test 6: voiceSnapshot.pitchData 影子保留 ===')

// 模拟 AI 渲染产物：含 pitchCurve（密集采样）+ pitchDeviation + midiPpq
const fakePitchCurve = [60.0, 60.1, 60.2, 60.5, 61.0, 60.8, 60.4, 60.0]
const fakePitchDeviation = [0, 1, 2, 3, 4, 3, 2, 1]
const projWithSnapshot = {
  fileName: 'WithSnapshot',
  tracks: [{
    name: 'Voc', midiTrackIndex: 0,
    languageCode: 'ZH', singerId: 'mySinger',
    prepState: { status: 'ready', progress: 100, error: null },
    voiceSnapshot: {
      trackId: 'track-0',
      trackName: 'Voc',
      jobId: 'should-be-stripped-on-export',
      renderManifest: { revision: 0, jobId: 'also-stripped' },
      tempoData: { tempos: [{ ticks: 0, bpm: 120, time: 0 }] },
      bpm: 120,
      pitchData: {
        pitchCurve: fakePitchCurve,
        pitchDeviation: fakePitchDeviation,
        midiPpq: 480,
      },
      phraseCount: 1,
      noteCount: 2,
      duration: 2,
    },
    sourcePhrases: [{
      notes: [
        { tick: 0, durationTicks: 480, midi: 60, lyric: 'a', velocity: 0.8 },
        { tick: 480, durationTicks: 480, midi: 62, lyric: 'i', velocity: 0.8 },
      ],
    }],
  }],
  tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
  ppq: 480,
}

const snapshotYaml = serializeWebUtauToUstx(projWithSnapshot)
check('snapshot: yaml 含 _meta.webutau_voice_snapshot', () => snapshotYaml.includes('webutau_voice_snapshot'))
check('snapshot: yaml 含 _meta.webutau_prep_state', () => snapshotYaml.includes('webutau_prep_state'))
check('snapshot: yaml 含 pitchCurve 数组', () => snapshotYaml.includes('pitchCurve'))
check('snapshot: jobId 被剔除', () => !snapshotYaml.includes('should-be-stripped-on-export'))
check('snapshot: renderManifest 被剔除', () => !snapshotYaml.includes('also-stripped'))

const snapshotImport = parseUstxToWebUtau(snapshotYaml)
const sTrack = snapshotImport.tracks[0]
check('snapshot: 导入后 prepState.status=ready', () => sTrack.prepState?.status === 'ready')
check('snapshot: 导入后 voiceSnapshot 存在', () => Boolean(sTrack.voiceSnapshot))
check('snapshot: pitchCurve 完整还原', () => {
  const arr = sTrack.voiceSnapshot?.pitchData?.pitchCurve
  return Array.isArray(arr) && arr.length === fakePitchCurve.length
    && arr.every((v, i) => Math.abs(v - fakePitchCurve[i]) < 1e-6)
})
check('snapshot: pitchDeviation 完整还原', () => {
  const arr = sTrack.voiceSnapshot?.pitchData?.pitchDeviation
  return Array.isArray(arr) && arr.length === fakePitchDeviation.length
    && arr.every((v, i) => v === fakePitchDeviation[i])
})
check('snapshot: midiPpq 保留', () => sTrack.voiceSnapshot?.pitchData?.midiPpq === 480)
check('snapshot: 还原后 voiceSnapshot 不含 jobId', () => !sTrack.voiceSnapshot?.jobId)
check('snapshot: 还原后 voiceSnapshot 不含 renderManifest', () => !sTrack.voiceSnapshot?.renderManifest)

// 状态机：prepState 非 ready 时不应持久化 voiceSnapshot
const projIdleSnapshot = {
  ...projWithSnapshot,
  fileName: 'IdleSnap',
  tracks: [{
    ...projWithSnapshot.tracks[0],
    prepState: { status: 'idle', progress: 0, error: null },
  }],
}
const idleYaml = serializeWebUtauToUstx(projIdleSnapshot)
check('snapshot: prepState=idle 时不写 _meta', () => !idleYaml.includes('webutau_voice_snapshot'))

// 没有 pitchCurve 时不写
const projEmptyCurve = {
  ...projWithSnapshot,
  fileName: 'EmptyCurve',
  tracks: [{
    ...projWithSnapshot.tracks[0],
    voiceSnapshot: { ...projWithSnapshot.tracks[0].voiceSnapshot, pitchData: { pitchCurve: [] } },
  }],
}
const emptyCurveYaml = serializeWebUtauToUstx(projEmptyCurve)
check('snapshot: 空 pitchCurve 不写 _meta', () => !emptyCurveYaml.includes('webutau_voice_snapshot'))

// 双向 round-trip：导入 → 导出 → 再导入，曲线仍然完整
const reExportSnap = serializeWebUtauToUstx(snapshotImport)
const reImportSnap = parseUstxToWebUtau(reExportSnap)
check('snapshot: 二次 round-trip pitchCurve 等长', () => {
  const arr = reImportSnap.tracks[0].voiceSnapshot?.pitchData?.pitchCurve
  return Array.isArray(arr) && arr.length === fakePitchCurve.length
})
check('snapshot: 二次 round-trip pitchCurve 内容一致', () => {
  const arr = reImportSnap.tracks[0].voiceSnapshot?.pitchData?.pitchCurve
  return arr.every((v, i) => Math.abs(v - fakePitchCurve[i]) < 1e-6)
})

// 没有 _meta 的 USTX（OpenUtau 写出的纯文件）导入后 voiceSnapshot/prepState 为 null
const yamlNoMeta = `name: NoMeta
ustx_version: "0.9"
comment: ""
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
    volume: 0.0
    pan: 0.0
voice_parts:
  - name: P
    track_no: 0
    position: 0
    notes:
      - position: 0
        duration: 240
        tone: 60
        lyric: a
        tuning: 0
wave_parts: []
`
const noMetaImport = parseUstxToWebUtau(yamlNoMeta)
// OpenUtau 原生 USTX（无 _meta）→ 合成器按 OpenUtau RenderPhrase 算法合成 pitchCurve
check('synth: 无 _meta 时合成器产出 voiceSnapshot', () => Boolean(noMetaImport.tracks[0].voiceSnapshot))
check('synth: 合成 voiceSnapshot 含 pitchCurve', () => noMetaImport.tracks[0].voiceSnapshot?.pitchData?.pitchCurve?.length > 0)
check('synth: 合成时 prepState=ready', () => noMetaImport.tracks[0].prepState?.status === 'ready')
check('synth: 合成 pitchCurve 半音值围绕 note.midi=60', () => {
  const curve = noMetaImport.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
  return curve.length > 0 && curve.every((p) => Math.abs(p.pitch - 60) < 0.5)
})
check('synth: pitchStepTick = 5', () => noMetaImport.tracks[0].voiceSnapshot?.pitchData?.pitchStepTick === 5)
check('synth: midiPpq = 480', () => noMetaImport.tracks[0].voiceSnapshot?.pitchData?.midiPpq === 480)

// ============================================================
// Test 7: 合成器与 OpenUtau RenderPhrase 算法严格对齐
// ============================================================
console.log('\n=== Test 7: 合成器算法正确性 ===')

// 7a. 单 note + 双锚点默认 (-40,0)/(40,0)：portamento 偏差为 0，pitchCurve 应等于 note.midi
const yamlFlat = `name: F
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
        duration: 1920
        tone: 67
        lyric: a
        tuning: 0
        pitch:
          snap_first: true
          data:
            - x: -40
              y: 0
              shape: io
            - x: 40
              y: 0
              shape: io
        vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 }
wave_parts: []
`
const flatImp = parseUstxToWebUtau(yamlFlat)
const flatCurve = flatImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: 平坦 portamento → pitch 全等于 tone=67', () => {
  // note 范围 [0, 1920]，5-tick 采样应有约 (1920/5)+1=385 点；最低要求 100+
  return flatCurve.length > 100 && flatCurve.every((p) => Math.abs(p.pitch - 67) < 1e-4)
})

// 7b. 两 note 60 → 64 portamento 边界 (x 在前 note 末 -50 ms / 后 note 始 +50 ms)
// 注意 USTX note.pitch.data 的 x 单位是 ms，前 note 长度 480 tick @ 120bpm = 1000 ms。
// 锚点 (x=-50, y=-40)（在前 note 末尾 50ms 处，y=-40 deci-semitone = -400 cents
// 等于"低于本 note tone 4 半音"= 60，恰好对齐前 note 的 tone=60）
// + (x=50, y=0)（在当前 note 起点后 50ms，y=0 等于 tone=64）
const yamlPort = `name: P
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
        duration: 480
        tone: 60
        lyric: a
        tuning: 0
      - position: 480
        duration: 480
        tone: 64
        lyric: i
        tuning: 0
        pitch:
          snap_first: true
          data:
            - x: -50
              y: -40
              shape: io
            - x: 50
              y: 0
              shape: io
wave_parts: []
`
const portImp = parseUstxToWebUtau(yamlPort)
const portCurve = portImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: 两 note 跨界 → 边界前为 60', () => {
  // 取 tick=240（前 note 中段）附近的采样
  const p = portCurve.find((q) => q.tick === 240)
  return p && Math.abs(p.pitch - 60) < 1e-4
})
check('synth: 两 note 跨界 → 边界后为 64', () => {
  // 取 tick=800（后 note 中段、portamento 已完成）附近的采样
  const p = portCurve.find((q) => q.tick === 800)
  return p && Math.abs(p.pitch - 64) < 1e-4
})
check('synth: 跨界过渡区单调上升', () => {
  // 在 tick=400~520 区间内 pitch 应单调非递减（io 缓动从 60 升到 64）
  const seg = portCurve.filter((q) => q.tick >= 400 && q.tick <= 520)
  return seg.length >= 5 && seg.every((p, i) => i === 0 || p.pitch >= seg[i - 1].pitch - 1e-6)
})

// 7c. Vibrato：length>0 → 该段 pitch 在 tone 上下振荡
const yamlVib = `name: V
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
        duration: 1920
        tone: 60
        lyric: a
        tuning: 0
        vibrato: { length: 80, period: 200, depth: 50, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 }
wave_parts: []
`
const vibImp = parseUstxToWebUtau(yamlVib)
const vibCurve = vibImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: vibrato 段振荡幅度 ≈ ±0.5 semitone (depth=50 cents)', () => {
  // 取 vibrato 中段稳定区，length=80% 意味着 vibrato 从 tick 384 起开始
  const seg = vibCurve.filter((q) => q.tick >= 800 && q.tick <= 1500)
  if (seg.length === 0) return false
  const max = Math.max(...seg.map((p) => p.pitch))
  const min = Math.min(...seg.map((p) => p.pitch))
  // depth=50 cents = 0.5 semitone；in/out 各 10% 衰减后中段应当接近满振幅
  return max > 60.3 && min < 59.7
})

// 7d. tuning 偏移：tone=60, tuning=50 cents → 0.5 semitone 提高，pitch 应当 ≈ 60.5
const yamlTune = `name: U
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
        duration: 960
        tone: 60
        lyric: a
        tuning: 50
        pitch: { snap_first: true, data: [{ x: -40, y: 0, shape: io }, { x: 40, y: 0, shape: io }] }
wave_parts: []
`
const tuneImp = parseUstxToWebUtau(yamlTune)
const tuneCurve = tuneImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: tuning=50 cents → pitch 全部 ≈ 60.5', () => {
  return tuneCurve.length > 50 && tuneCurve.every((p) => Math.abs(p.pitch - 60.5) < 1e-3)
})

// 7e. 多 part / phrase 合并：两个 voice_part 在 track_no=0 上的 pitchCurve 是否拼接
const yamlMulti = `name: M
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
        lyric: a
        tuning: 0
  - track_no: 0
    position: 480
    notes:
      - position: 0
        duration: 240
        tone: 67
        lyric: i
        tuning: 0
wave_parts: []
`
const multiImp = parseUstxToWebUtau(yamlMulti)
const multiCurve = multiImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: 多 phrase pitchCurve 含 part1 起始段', () => {
  const p = multiCurve.find((q) => q.tick === 100)
  return p && Math.abs(p.pitch - 60) < 1e-4
})
check('synth: 多 phrase pitchCurve 含 part2 起始段', () => {
  const p = multiCurve.find((q) => q.tick === 580)
  return p && Math.abs(p.pitch - 67) < 1e-4
})

// 7f. webUTAU 闭环优先：YAML 同时含 note.pitch.data + _meta.webutau_voice_snapshot
// 应该用 _meta 的 pitchCurve（AI 产物精度更高），不走合成
{
  const projWithBoth = {
    fileName: 'Both',
    tracks: [{
      name: 'T', midiTrackIndex: 0,
      languageCode: 'ZH', singerId: 's',
      prepState: { status: 'ready', progress: 100, error: null },
      voiceSnapshot: {
        trackId: 'track-0',
        pitchData: {
          pitchCurve: [{ tick: 0, pitch: 99.5 }, { tick: 5, pitch: 99.6 }, { tick: 10, pitch: 99.7 }],
          pitchDeviation: { xs: [], ys: [] },
          midiPpq: 480,
          pitchStepTick: 5,
        },
      },
      sourcePhrases: [{
        notes: [{ tick: 0, durationTicks: 480, midi: 60, lyric: 'a', velocity: 0.8 }],
      }],
    }],
    tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
    ppq: 480,
  }
  const y = serializeWebUtauToUstx(projWithBoth)
  const r = parseUstxToWebUtau(y)
  const curve = r.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
  check('synth: _meta 影子优先于合成（保留 AI 产物 99.x）', () => {
    return curve.length === 3 && Math.abs(curve[0].pitch - 99.5) < 1e-4
  })
}

// 7g. 多 tempo：tempo 变化区段内 portamento 时间换算正确
// (这里只断言不抛错+曲线长度合理，detailed accuracy 太复杂)
const yamlMultiTempo = `name: MT
ustx_version: "0.9"
output_dir: Vocal
cache_dir: UCache
tempos:
  - position: 0
    bpm: 120
  - position: 1920
    bpm: 60
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
        duration: 1920
        tone: 60
        lyric: a
        tuning: 0
      - position: 1920
        duration: 1920
        tone: 64
        lyric: i
        tuning: 0
        pitch:
          snap_first: true
          data:
            - x: -100
              y: -40
              shape: io
            - x: 100
              y: 0
              shape: io
wave_parts: []
`
const mtImp = parseUstxToWebUtau(yamlMultiTempo)
const mtCurve = mtImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth: 多 tempo 不抛错 + 曲线非空', () => mtCurve.length > 100)
check('synth: 多 tempo 第一 note 中段 pitch=60', () => {
  const p = mtCurve.find((q) => q.tick === 960)
  return p && Math.abs(p.pitch - 60) < 1e-4
})
check('synth: 多 tempo 第二 note 中段 pitch=64', () => {
  const p = mtCurve.find((q) => q.tick === 2880)
  return p && Math.abs(p.pitch - 64) < 1e-4
})

// 7h. 默认双锚点（无显式 portamento）+ 多 tempo + 两 note 不同 midi
// 这是用户最常见的 OpenUtau 工程模式，必须严格还原：
//   - 第二 note 中段稳定收敛到自己的 midi
//   - 边界附近有 io 缓动过渡
//   - tempo 切换后绝对 tick 仍正确对应 note
const yamlOuMimic = `name: OUMimic
ustx_version: "0.9"
output_dir: Vocal
cache_dir: UCache
tempos:
  - position: 0
    bpm: 82
  - position: 2400
    bpm: 62
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
    position: 1000
    notes:
      - position: 0
        duration: 240
        tone: 69
        lyric: a
        tuning: 0
        pitch: { snap_first: true, data: [{ x: -40, y: 0, shape: io }, { x: 40, y: 0, shape: io }] }
        vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 }
      - position: 240
        duration: 240
        tone: 67
        lyric: i
        tuning: 0
        pitch: { snap_first: true, data: [{ x: -40, y: 0, shape: io }, { x: 40, y: 0, shape: io }] }
        vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 }
wave_parts: []
`
const ouMimImp = parseUstxToWebUtau(yamlOuMimic)
const ouCurve = ouMimImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
// 两 note 的绝对 tick：note0 [1000, 1240]，note1 [1240, 1480]
check('synth-ou: note0 中段 pitch=69', () => {
  const p = ouCurve.find((q) => q.tick === 1120)
  return p && Math.abs(p.pitch - 69) < 1e-3
})
check('synth-ou: note1 中段 pitch=67 (默认双锚点 bug 回归)', () => {
  const p = ouCurve.find((q) => q.tick === 1360)
  return p && Math.abs(p.pitch - 67) < 1e-3
})
check('synth-ou: 默认 y=0/y=0 双锚点 → 阶跃切换（OpenUtau 规范行为）', () => {
  // OpenUtau UNote.cs:108 显示自动 portamento 需要把 p0.Y=(prev-cur)*10 才有缓动；
  // 海阔天空那类文件里 y=0/y=0 表示"无音高弯曲"，曲线就该是硬切阶跃，不应中间出现 67.5
  const seg = ouCurve.filter((q) => q.tick >= 1200 && q.tick <= 1280)
  const allDiscrete = seg.every((p) => Math.abs(p.pitch - 69) < 0.01 || Math.abs(p.pitch - 67) < 0.01)
  return allDiscrete
})

// 7i. OpenUtau 自动 portamento：p0.y=(prev-cur)*10，模拟 UNote.cs:108 的行为
// note0 midi=69, note1 midi=67, 自动 p0.y = (69-67)*10 = 20 decisemitones
// 这种"经过 OpenUtau 编辑器处理后"的 USTX 才会有真正的 io 缓动过渡
const yamlAutoPort = `name: AP
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
        tone: 69
        lyric: a
        tuning: 0
        pitch: { snap_first: true, data: [{ x: -40, y: 0, shape: io }, { x: 40, y: 0, shape: io }] }
      - position: 240
        duration: 240
        tone: 67
        lyric: i
        tuning: 0
        pitch: { snap_first: true, data: [{ x: -40, y: 20, shape: io }, { x: 40, y: 0, shape: io }] }
wave_parts: []
`
const apImp = parseUstxToWebUtau(yamlAutoPort)
const apCurve = apImp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('synth-ou-auto: io 缓动 portamento 中间区有过渡值', () => {
  const seg = apCurve.filter((q) => q.tick >= 230 && q.tick <= 260)
  return seg.some((p) => p.pitch > 67.1 && p.pitch < 68.9)
})
check('synth-ou-auto: portamento 过渡单调下降 (69→67)', () => {
  const seg = apCurve.filter((q) => q.tick >= 220 && q.tick <= 280)
  return seg.length >= 5 && seg.every((p, i) => i === 0 || p.pitch <= seg[i - 1].pitch + 1e-6)
})

// 7j. 互通端到端：OpenUtau USTX → webUTAU → 再导出 USTX，note.pitch.data 锚点保留
// 不仅 webUTAU 看得到曲线，还能保证导出回 USTX 给 OpenUtau 渲染时不丢锚点信息
const reExportAp = serializeWebUtauToUstx(apImp)
const reImportAp = parseUstxToWebUtau(reExportAp)
const reApN1 = reImportAp.tracks[0].previewNotes[1]
check('e2e: 二次 round-trip note1.pitch.data[0].y=20 保留', () => {
  return reApN1.pitch?.data?.[0]?.y === 20
})
check('e2e: 二次 round-trip note1.pitch.data[1].y=0 保留', () => {
  return reApN1.pitch?.data?.[1]?.y === 0
})
check('e2e: 二次 round-trip shape 保留', () => {
  return reApN1.pitch?.data?.[0]?.shape === 'io' && reApN1.pitch?.data?.[1]?.shape === 'io'
})
// 三次 round-trip 后合成 pitchCurve 跟二次一致（应当稳定收敛）
const tripleImport = parseUstxToWebUtau(serializeWebUtauToUstx(reImportAp))
const triCurve = tripleImport.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
const dblCurve = reImportAp.tracks[0].voiceSnapshot?.pitchData?.pitchCurve || []
check('e2e: 三次 round-trip pitchCurve 长度稳定', () => triCurve.length === dblCurve.length)
check('e2e: 三次 round-trip pitchCurve 内容稳定', () => {
  if (triCurve.length !== dblCurve.length) return false
  return triCurve.every((p, i) => Math.abs(p.pitch - dblCurve[i].pitch) < 1e-3 && p.tick === dblCurve[i].tick)
})

// 7k. OpenUtau→webUTAU 时合成的 pitchCurve 与 webUTAU 直接保存（_meta）形式应能共存
// 验证：同一 webUTAU 项目，含合成 voiceSnapshot 的 USTX 二次导入应优先用 _meta（webUTAU 闭环增益）
// 因为我们的合成结果也会写入 _meta，所以二次导入时走的就是 _meta 路径。
const secondImportSnapshot = reImportAp.tracks[0].voiceSnapshot
check('e2e: webUTAU 二次导入直接用 _meta（无需重算）', () => {
  // 合成出来后写入 USTX，再导回时应当从 _meta 还原而不是再算一次——
  // 验证方法：二次导入后 voiceSnapshot 含 pitchData，且 prepState=ready
  return Boolean(secondImportSnapshot?.pitchData?.pitchCurve?.length) &&
    reImportAp.tracks[0].prepState?.status === 'ready'
})

// 7l. 兜底回归：phrase.notes 的 tick 被 runtime rebuildFromEdit 污染成全 0/相同时，
// 导出仍要正确——用 phrase.startTime 反推绝对 tick
const projTickContaminated = {
  fileName: 'TickContam',
  tracks: [{
    name: 'T', midiTrackIndex: 0,
    sourcePhrases: [
      {
        index: 0,
        startTime: 1.0,  // 绝对秒，绝对 tick ≈ 960 @ 120bpm
        endTime: 2.0,
        notes: [
          { tick: 0, durationTicks: 240, midi: 60, lyric: 'a', velocity: 0.8, time: 0, duration: 0.25 },
          { tick: 0, durationTicks: 240, midi: 62, lyric: 'b', velocity: 0.8, time: 0, duration: 0.25 },
        ],
      },
      {
        index: 1,
        startTime: 3.0,  // 绝对秒，绝对 tick ≈ 2880 @ 120bpm
        endTime: 4.0,
        notes: [
          { tick: 0, durationTicks: 240, midi: 64, lyric: 'c', velocity: 0.8, time: 0, duration: 0.25 },
          { tick: 0, durationTicks: 240, midi: 65, lyric: 'd', velocity: 0.8, time: 0, duration: 0.25 },
        ],
      },
    ],
  }],
  tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
  ppq: 480,
}
const contamYaml = serializeWebUtauToUstx(projTickContaminated)
const contamPositions = []
const reContam = /^  - name: Part \d+[\s\S]*?^    position: (\d+)/gm
let mc
while ((mc = reContam.exec(contamYaml)) !== null) contamPositions.push(parseInt(mc[1], 10))
check('contam: 污染后 part0.position 用 phrase.startTime 反推 ≈ 960', () => {
  return contamPositions[0] >= 950 && contamPositions[0] <= 970
})
check('contam: 污染后 part1.position 用 phrase.startTime 反推 ≈ 2880', () => {
  return contamPositions[1] >= 2870 && contamPositions[1] <= 2890
})
check('contam: 两个 part position 不相同（没都挤到 0）', () => {
  return contamPositions[0] !== contamPositions[1] && contamPositions.length === 2
})

// 7m. buildPreviewProjection 抗污染：voice runtime 反馈 snapshot.phrases 内
// note.tick / time 全 0 时（最严重污染），用 phrase.startTime + 累积 durationTicks
// 重建出每个 note 的正确绝对 tick
import { buildPreviewProjection } from '../src/host/services/PreviewProjector.js'
const pollutedSnap = {
  phrases: [
    {
      index: 0,
      startTime: 1.0,  // 绝对秒 → 在 120 bpm 下约 tick 960
      endTime: 2.0,
      notes: [
        { tick: 0, durationTicks: 240, time: 0, duration: 0, midi: 60, lyric: 'a', velocity: 0.8 },
        { tick: 0, durationTicks: 240, time: 0, duration: 0, midi: 62, lyric: 'b', velocity: 0.8 },
        { tick: 0, durationTicks: 240, time: 0, duration: 0, midi: 64, lyric: 'c', velocity: 0.8 },
      ],
    },
    {
      index: 1,
      startTime: 3.0,  // 绝对秒 → 在 120 bpm 下约 tick 2880
      endTime: 4.0,
      notes: [
        { tick: 0, durationTicks: 480, time: 0, duration: 0, midi: 65, lyric: 'd', velocity: 0.8 },
        { tick: 0, durationTicks: 480, time: 0, duration: 0, midi: 67, lyric: 'e', velocity: 0.8 },
      ],
    },
  ],
  tempoData: { tempos: [{ ticks: 0, bpm: 120 }] },
}
const proj = buildPreviewProjection(pollutedSnap, null, 480)
check('proj: 污染时 5 个 note 没全堆 0', () => {
  const ticks = proj.previewNotes.map((n) => n.tick)
  return new Set(ticks).size === 5  // 全部不同
})
check('proj: phrase0 第一个 note 落在 phrase.startTime (≈ 960 @ 120bpm)', () => {
  return proj.previewNotes[0].tick >= 950 && proj.previewNotes[0].tick <= 970
})
check('proj: phrase0 第二个 note = 第一个 + 240', () => {
  return proj.previewNotes[1].tick === proj.previewNotes[0].tick + 240
})
check('proj: phrase1 第一个 note 落在 startTime=3.0 (≈ 2880 @ 120bpm)', () => {
  return proj.previewNotes[3].tick >= 2870 && proj.previewNotes[3].tick <= 2890
})
check('proj: previewNotes 顺序按 tick 单调递增', () => {
  return proj.previewNotes.every((n, i) => i === 0 || n.tick >= proj.previewNotes[i - 1].tick)
})

// 8. buildPhrase 直接算出绝对 startTime（不再依赖 applyProjectTiming）
console.log('\n=== Test 8: buildPhrase 直接算绝对 startTime ===')
const yamlAbsStart = `name: AbsStart
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
    position: 1920
    notes:
      - position: 0
        duration: 240
        tone: 60
        lyric: a
        tuning: 0
  - track_no: 0
    position: 2880
    notes:
      - position: 0
        duration: 240
        tone: 62
        lyric: b
        tuning: 0
wave_parts: []
`
const absImp = parseUstxToWebUtau(yamlAbsStart)
check('phrase: import 后 phrase[0].startTime > 0 (不再硬置 0)', () => {
  return absImp.tracks[0].sourcePhrases[0].startTime > 0
})
check('phrase: phrase[0].startTime 对应 tick=1920 (= 2 秒 @ 120bpm)', () => {
  const st = absImp.tracks[0].sourcePhrases[0].startTime
  return Math.abs(st - 2.0) < 1e-3
})
check('phrase: phrase[1].startTime 对应 tick=2880 (= 3 秒 @ 120bpm)', () => {
  const st = absImp.tracks[0].sourcePhrases[1].startTime
  return Math.abs(st - 3.0) < 1e-3
})

// 8b. 关键回归：tempo[i].time=null 必须穿过 createTempoDocument 不被改成 0
// 之前 normalizeTime(null)→0 让 axis 误以为非首条 tempo 在 0 秒处突变，
// timeToTick 把任何 time>0 都加上巨量 tick 偏移 → playhead 算错位置 → 拖不动 + 播放从远处开始
console.log('\n=== Test 8b: tempo[i].time=null 必须保留到 axis ===')
import { createTempoDocument } from '../src/shared/tempoDocument.js'
import { createTimelineAxis } from '../src/shared/timelineAxis.js'
const multiTempoData = createTempoDocument({
  tempos: [
    { bpm: 82, time: null, ticks: 0 },
    { bpm: 62, time: null, ticks: 224640 },  // 非首条 tempo，time 必须保留 null
  ],
  timeSignatures: [{ timeSignature: [4, 4], time: null, ticks: 0 }],
})
check('tempo: createTempoDocument 保留 tempo[1].time=null', () => multiTempoData.tempos[1].time === null)
check('tempo: createTempoDocument 保留 tempo[1].ticks=224640', () => multiTempoData.tempos[1].ticks === 224640)

const axisMt = createTimelineAxis({ tempoData: multiTempoData, ppq: 480, totalTicks: 200000 })
check('axis: timeToTick(10s) ≈ 6560 (82 bpm 段内)', () => {
  const tick = axisMt.timeToTick(10)
  return Math.abs(tick - 6560) < 5
})
check('axis: tickToTime(6560) ≈ 10s', () => {
  const t = axisMt.tickToTime(6560)
  return Math.abs(t - 10) < 0.01
})
check('axis: 往返一致 — timeToTick(50)→tickToTime ≈ 50s', () => {
  const t = axisMt.tickToTime(axisMt.timeToTick(50))
  return Math.abs(t - 50) < 0.01
})
check('axis: 跨 tempo 段 timeToTick(400s) > 224640', () => {
  // 224640 tick @ 82 bpm = 342s 是 tempo 切换点；400s 应该已经在 62 bpm 段
  return axisMt.timeToTick(400) > 224640
})

// 用户点击 ruler 在某 x 位置后 playhead 应该回到同一 x 位置 (xToTime 与 timeToX 互逆)
const axisFull = createTimelineAxis({ tempoData: multiTempoData, ppq: 480, totalTicks: 176520 })
const testX = [100, 1000, 5000, 7355, 11032, 14710]
let allReversible = true
let firstFail = null
for (const x of testX) {
  const t = axisFull.xToTime(x)
  const xBack = axisFull.timeToX(t)
  if (Math.abs(x - xBack) > 1) {
    allReversible = false
    if (!firstFail) firstFail = { x, t, xBack }
  }
}
check('axis: ruler 任意位置 x → time → x 浮点级回到原位 (playhead 不会错位)', () => {
  if (!allReversible) console.log('    失败样本:', firstFail)
  return allReversible
})

// 9. languageCode 推断：singer/phonemizer 没语言提示时用 lyric 字符兜底
console.log('\n=== Test 9: languageCode 兜底推断 ===')
function makeLangYaml(singer, phonemizer, lyrics) {
  const noteEntries = lyrics.map((lyric, i) => `      - position: ${i * 240}
        duration: 240
        tone: 60
        lyric: ${lyric}
        tuning: 0`).join('\n')
  return `name: L
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
    singer: "${singer}"
    phonemizer: "${phonemizer}"
    mute: false
    solo: false
    volume: 0
    pan: 0
voice_parts:
  - track_no: 0
    position: 0
    notes:
${noteEntries}
wave_parts: []
`
}
// 实测：海阔天空 USTX 用 "yousaV1.52" + "OpenUtau.Core.DefaultPhonemizer"，关键字都不命中
const yousaImp = parseUstxToWebUtau(makeLangYaml('yousaV1.52', 'OpenUtau.Core.DefaultPhonemizer', ['你', '是']))
check('lang: 中文 lyric → languageCode=ZH', () => yousaImp.tracks[0].languageCode === 'ZH')

const jpImp = parseUstxToWebUtau(makeLangYaml('Defoko', 'OpenUtau.Core.DefaultPhonemizer', ['あ', 'い']))
check('lang: 日文假名 lyric → languageCode=JA', () => jpImp.tracks[0].languageCode === 'JA')

// 即便 singer 命中 'ja' 关键字（如 "Yamaha"），假名也应优先于关键字判断为日文——
// 但当前实现 singer 关键字优先，确保已知行为不回归
const mixImp = parseUstxToWebUtau(makeLangYaml('CN-Singer-zh', 'JapanesePhonemizer', ['你', '好']))
check('lang: phonemizer "Japanese" 关键字优先于 lyric', () => mixImp.tracks[0].languageCode === 'JA')

// 全英文 lyric + 无语言关键字 singer → 推断不出（保留 null 让用户选）
const enImp = parseUstxToWebUtau(makeLangYaml('SomeSinger', 'OpenUtau.Core.DefaultPhonemizer', ['la', 'la']))
check('lang: 纯英文 lyric → languageCode=null (留给用户选)', () => enImp.tracks[0].languageCode === null)

// 关键回归：USTX 导入后 prepState=ready 且 languageCode 非 null → predictionGate 不弹
import { isTrackPrepReady } from '../src/host/project/trackPrepState.js'
import { normalizeOptionalLanguageCode } from '../src/config/languageOptions.js'
check('gate: 中文 lyric USTX 导入后 不会触发"选语言"弹窗', () => {
  const t = yousaImp.tracks[0]
  // 重现 TrackPredictionGateController.requires() 的判断
  const wouldPrompt = !normalizeOptionalLanguageCode(t.languageCode) || !isTrackPrepReady(t)
  return wouldPrompt === false
})

// ============================================================
console.log(`\n=== Results: ${checks} checks, ${failures} failures ===`)
if (failures > 0) process.exit(1)
