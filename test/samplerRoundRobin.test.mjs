import test from 'node:test'
import assert from 'node:assert/strict'

import { pickNextVariantIndex, SamplerPool } from '../src/host/audio/instruments/SamplerPool.js'

test('pickNextVariantIndex 退化到单变体时恒返回 0', () => {
  assert.equal(pickNextVariantIndex(1, -1), 0)
  assert.equal(pickNextVariantIndex(1, 0), 0)
  assert.equal(pickNextVariantIndex(0, -1), 0)
})

test('pickNextVariantIndex 不会选到 lastIndex（2 变体时严格交替）', () => {
  // 任何 random 输出 ∈ [0,1)，count=2 时都应得到 1-lastIndex
  assert.equal(pickNextVariantIndex(2, 0, () => 0), 1)
  assert.equal(pickNextVariantIndex(2, 0, () => 0.99), 1)
  assert.equal(pickNextVariantIndex(2, 1, () => 0), 0)
  assert.equal(pickNextVariantIndex(2, 1, () => 0.99), 0)
})

test('pickNextVariantIndex 3 变体时永远不等于 lastIndex', () => {
  for (let last = 0; last < 3; last++) {
    // 扫过 rand∈{0..0.99}，所有输出都 ≠ last
    for (let r = 0; r < 20; r++) {
      const rand = r / 20
      const next = pickNextVariantIndex(3, last, () => rand)
      assert.notEqual(next, last)
      assert.ok(next >= 0 && next < 3)
    }
  }
})

test('pickNextVariantIndex 初次调用（lastIndex<0）允许任一变体', () => {
  const seen = new Set()
  for (let r = 0; r < 20; r++) {
    seen.add(pickNextVariantIndex(3, -1, () => r / 20))
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2])
})

test('SamplerPool._pickReadySampler 连续触发永不连续命中同一变体', () => {
  const pool = new SamplerPool({ random: () => 0 }) // deterministic: always pick lowest remaining
  const slot = {
    variants: [
      { sampler: { id: 0 }, ready: true },
      { sampler: { id: 1 }, ready: true },
      { sampler: { id: 2 }, ready: true },
    ],
    lastVariantIndex: -1,
  }

  const sequence = []
  for (let i = 0; i < 10; i++) {
    sequence.push(pool._pickReadySampler(slot).id)
  }

  // 相邻两次不能是同一个变体
  for (let i = 1; i < sequence.length; i++) {
    assert.notEqual(sequence[i], sequence[i - 1], `连续重复: 第 ${i} 次`)
  }
  // 最终 lastVariantIndex 指向最后一次挑中的变体
  assert.equal(slot.lastVariantIndex, sequence[sequence.length - 1])
})

test('SamplerPool._pickReadySampler 在单 ready 变体时不再随机', () => {
  const pool = new SamplerPool()
  const slot = {
    variants: [
      { sampler: { id: 0 }, ready: false },
      { sampler: { id: 1 }, ready: true },
      { sampler: { id: 2 }, ready: false },
    ],
    lastVariantIndex: -1,
  }
  // 只有 index=1 ready；无论调多少次都返回它
  for (let i = 0; i < 5; i++) {
    assert.equal(pool._pickReadySampler(slot).id, 1)
  }
})

test('SamplerPool._pickReadySampler 跳过未就绪变体、保持不连续', () => {
  const pool = new SamplerPool({ random: () => 0 })
  const slot = {
    variants: [
      { sampler: { id: 0 }, ready: true },
      { sampler: { id: 1 }, ready: false }, // 未就绪，被跳过
      { sampler: { id: 2 }, ready: true },
    ],
    lastVariantIndex: -1,
  }
  const seen = new Set()
  for (let i = 0; i < 6; i++) {
    seen.add(pool._pickReadySampler(slot).id)
  }
  // 只应在 {0, 2} 间挑
  assert.ok(!seen.has(1))
  assert.deepEqual([...seen].sort(), [0, 2])
})

test('SamplerPool._pickReadySampler 兼容 single 结构（非 variants 数组）', () => {
  const pool = new SamplerPool()
  const slot = { sampler: { id: 'single' }, ready: true }
  assert.equal(pool._pickReadySampler(slot).id, 'single')
  slot.ready = false
  assert.equal(pool._pickReadySampler(slot), null)
})

test('SamplerPool 端到端：bass/guitar/drums 准备后连续触发会打到不同变体实例', async () => {
  // 按 sourceCatalog 的真实配置流程构造 Fake Tone，确认 Sampler 实例被正确创建、
  // 并且连续 triggerAttackRelease 落在不同实例上。
  const samplersCreated = []
  const triggerLog = [] // { samplerId, note, velocity }

  class FakeSampler {
    constructor(opts) {
      this.id = samplersCreated.length
      this.opts = opts
      samplersCreated.push(this)
    }
    connect() {}
    toDestination() {}
    triggerAttackRelease(note, dur, time, velocity) {
      triggerLog.push({ samplerId: this.id, note, dur, velocity })
    }
    releaseAll() {}
    dispose() {}
  }
  const fakeTone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: { load: async (url) => ({ url, loaded: true }) },
    getContext: () => ({ name: 'fake-ctx' }),
    start: async () => {},
    now: () => 0,
  }

  const pool = new SamplerPool({ random: () => 0 })
  pool.tone = fakeTone // 跳过 loadToneRuntime 的真实 dynamic import

  await pool.prepareTrackSources([{ trackId: 'track-bass', sourceId: 'bass' }])

  // bass: 5 层 × 3 变体 = 15 个 Sampler
  assert.equal(samplersCreated.length, 15, '应为每层每变体创建 1 个 Sampler')

  // 连续触发 8 次同一音符同一力度，应至少命中 2 个不同 Sampler 实例
  for (let i = 0; i < 8; i++) {
    pool.triggerAttackRelease('track-bass', 'bass', 36, 0.5, 0, 0.4) // layerVelocity 落在某中层
  }
  const uniqueSamplerIds = new Set(triggerLog.map((t) => t.samplerId))
  assert.ok(uniqueSamplerIds.size >= 2, `RR 应至少涉及 2 个变体，实际: ${uniqueSamplerIds.size}`)

  // 相邻两次触发绝不能落在同一实例
  for (let i = 1; i < triggerLog.length; i++) {
    assert.notEqual(
      triggerLog[i].samplerId,
      triggerLog[i - 1].samplerId,
      `第 ${i} 次触发和上一次落在同一变体 ${triggerLog[i].samplerId}`,
    )
  }
})

test('SamplerPool 端到端：piano（无变体）连续触发始终同一 Sampler', async () => {
  const samplersCreated = []
  const triggerLog = []
  class FakeSampler {
    constructor() { this.id = samplersCreated.length; samplersCreated.push(this) }
    connect() {}
    toDestination() {}
    triggerAttackRelease(note, dur, time, vel) { triggerLog.push({ id: this.id, note, vel }) }
    releaseAll() {}
    dispose() {}
  }
  const fakeTone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: { load: async (url) => ({ url }) },
    getContext: () => ({ name: 'ctx' }),
    start: async () => {},
  }
  const pool = new SamplerPool()
  pool.tone = fakeTone
  await pool.prepareTrackSources([{ trackId: 'track-piano', sourceId: 'piano' }])

  // piano: 8 层 × 1 变体 = 8 个 Sampler
  assert.equal(samplersCreated.length, 8)

  for (let i = 0; i < 5; i++) {
    pool.triggerAttackRelease('track-piano', 'piano', 60, 0.5, 0, 0.5)
  }
  const ids = new Set(triggerLog.map((t) => t.id))
  // 都落在同一力度层（同一 Sampler），没有"随机乱跳"
  assert.equal(ids.size, 1, '无变体乐器应始终命中同一 Sampler')
})
