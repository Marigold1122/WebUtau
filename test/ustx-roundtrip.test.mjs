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
console.log(`\n=== Results: ${checks} checks, ${failures} failures ===`)
if (failures > 0) process.exit(1)
