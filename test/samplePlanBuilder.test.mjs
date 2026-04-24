import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlaybackSamplePlan,
  sortChunksByPlaybackPriority,
  timeToChunkIndex,
  DEFAULT_CHUNK_DURATION_SEC,
} from '../src/host/audio/instruments/samplePlanBuilder.js'
import {
  getSourceCatalogMidis,
  findClosestCatalogMidi,
  noteNameToMidi,
} from '../src/host/audio/instruments/sourceCatalog.js'

test('noteNameToMidi 基本映射', () => {
  assert.equal(noteNameToMidi('C4'), 60)
  assert.equal(noteNameToMidi('A0'), 21)
  assert.equal(noteNameToMidi('C8'), 108)
  assert.equal(noteNameToMidi('F#3'), 54)
  assert.equal(noteNameToMidi('Db5'), 73)
  assert.ok(Number.isNaN(noteNameToMidi('invalid')))
  assert.ok(Number.isNaN(noteNameToMidi(null)))
})

test('getSourceCatalogMidis 覆盖各乐器', () => {
  // piano 30 个（每小三度），A0=21..C8=108
  const piano = getSourceCatalogMidis('piano')
  assert.equal(piano.size, 30)
  assert.ok(piano.has(21))
  assert.ok(piano.has(60))
  assert.ok(piano.has(108))
  // drums 13 件
  assert.equal(getSourceCatalogMidis('drums').size, 13)
  // violin 15 个
  assert.equal(getSourceCatalogMidis('violin').size, 15)
})

test('findClosestCatalogMidi 精确命中 / 就近选择', () => {
  // piano 有 A4(69)、C5(72)、D#5(75)。MIDI 67 最近的是 66(F#4)
  assert.equal(findClosestCatalogMidi('piano', 66), 66)
  assert.equal(findClosestCatalogMidi('piano', 67), 66) // G4 → F#4
  assert.equal(findClosestCatalogMidi('piano', 68), 69) // G#4 → A4
  // drums kick=36 精确命中
  assert.equal(findClosestCatalogMidi('drums', 36), 36)
})

test('buildPlaybackSamplePlan：基本场景——4 轨各自独立的 chunk 统计', () => {
  const tracks = [
    {
      id: 't-piano',
      playbackState: { assignedSourceId: 'piano' },
      previewNotes: [
        { time: 0.5, midi: 60, duration: 1 },   // chunk 0
        { time: 3.0, midi: 67, duration: 1 },   // chunk 0，67→catalog 66
        { time: 8.0, midi: 72, duration: 1 },   // chunk 1
        { time: 20.0, midi: 60, duration: 1 },  // chunk 3
      ],
    },
    {
      id: 't-bass',
      playbackState: { assignedSourceId: 'bass' },
      previewNotes: [
        { time: 1, midi: 40, duration: 0.5 }, // chunk 0
      ],
    },
    {
      id: 't-muted',
      playbackState: { assignedSourceId: 'piano', mute: true }, // 不计入 audible
      previewNotes: [{ time: 0, midi: 60, duration: 1 }],
    },
    {
      id: 't-nothing',
      playbackState: { assignedSourceId: 'violin' },
      previewNotes: [], // 无 note → 不生成 trackPlan
    },
  ]
  const audibleTrackIds = new Set(['t-piano', 't-bass', 't-nothing'])
  const plan = buildPlaybackSamplePlan({
    tracks,
    audibleTrackIds,
    fromTimeSec: 0,
    chunkDurationSec: 6,
  })

  assert.equal(plan.currentChunkIndex, 0)
  assert.equal(plan.chunkDurationSec, 6)
  assert.equal(plan.trackPlans.length, 2, '只有 2 条可听有 note 的轨')

  const pianoPlan = plan.trackPlans.find((p) => p.trackId === 't-piano')
  assert.ok(pianoPlan)
  assert.equal(pianoPlan.sourceId, 'piano')
  // 触发 catalog MIDI 集：60 (C4 精确), 66 (G4 就近 F#4), 72 (C5 精确)
  assert.deepEqual([...pianoPlan.triggeredCatalogMidis].sort((a, b) => a - b), [60, 66, 72])
  // chunk 0 含 60、66；chunk 1 含 72；chunk 3 含 60
  assert.deepEqual([...pianoPlan.chunkMidisByIndex.get(0)].sort((a, b) => a - b), [60, 66])
  assert.deepEqual([...pianoPlan.chunkMidisByIndex.get(1)], [72])
  assert.deepEqual([...pianoPlan.chunkMidisByIndex.get(3)], [60])

  const bassPlan = plan.trackPlans.find((p) => p.trackId === 't-bass')
  assert.ok(bassPlan)
  assert.equal(bassPlan.sourceId, 'bass')
})

test('buildPlaybackSamplePlan：fromTimeSec 使得早于该时刻的 note 被跳过', () => {
  const tracks = [{
    id: 't',
    playbackState: { assignedSourceId: 'piano' },
    previewNotes: [
      { time: 0.5, midi: 60, duration: 1 }, // 结束于 1.5，<5 → 跳过
      { time: 4, midi: 60, duration: 1 },   // 结束于 5，<5 边界 → 跳过
      { time: 4.9, midi: 60, duration: 0.3 }, // 结束于 5.2，>5 → 保留，chunk=0
      { time: 10, midi: 60, duration: 1 },  // chunk 1
    ],
  }]
  const plan = buildPlaybackSamplePlan({
    tracks,
    audibleTrackIds: new Set(['t']),
    fromTimeSec: 5,
    chunkDurationSec: 6,
  })
  assert.equal(plan.currentChunkIndex, 0)
  const trackPlan = plan.trackPlans[0]
  assert.equal(trackPlan.chunkMidisByIndex.get(0).size, 1)
  assert.equal(trackPlan.chunkMidisByIndex.get(1).size, 1)
})

test('sortChunksByPlaybackPriority：当前→前向→后向', () => {
  assert.deepEqual(
    sortChunksByPlaybackPriority([0, 1, 2, 3, 4, 5], 2),
    [2, 3, 4, 5, 1, 0],
  )
  assert.deepEqual(
    sortChunksByPlaybackPriority([5, 3, 1, 7, 2, 0], 2),
    [2, 3, 5, 7, 1, 0],
  )
  assert.deepEqual(sortChunksByPlaybackPriority([5, 4, 3], 10), [5, 4, 3])
})

test('timeToChunkIndex 边界', () => {
  assert.equal(timeToChunkIndex(0), 0)
  assert.equal(timeToChunkIndex(5.9), 0)
  assert.equal(timeToChunkIndex(6.0), 1)
  assert.equal(timeToChunkIndex(-1), 0)
  assert.equal(timeToChunkIndex(Infinity), 0) // 非有限输入安全退化到 0
})
