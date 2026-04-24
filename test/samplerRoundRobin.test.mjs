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
  // 懒加载：prepare 完成时只有 variant 0 的 5 个 Sampler；等后台加载跑完再验证 RR
  assert.equal(samplersCreated.length, 5, 'prepare 返回时只应有 variant 0 的 5 个 Sampler')
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))

  // bass: 5 层 × 3 变体 = 15 个 Sampler（variant 1/2 后台加载完成后）
  assert.equal(samplersCreated.length, 15, '后台加载完成后应共 15 个 Sampler')

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

test('懒加载：prepareTrackSources 只阻塞 variant 0，其余 variants 后台加载', async () => {
  // 用一个"variant 0 立即 resolve、variants 1+ 手动 resolve"的 FakeTone 验证阻塞边界。
  const samplersCreatedUrls = [] // 每个 Sampler 拿到的第一个 url
  const pendingResolvers = new Map() // url → resolve fn

  class FakeSampler {
    constructor(opts) {
      const firstUrl = Object.values(opts.urls)[0]?.url || Object.values(opts.urls)[0]
      samplersCreatedUrls.push(firstUrl)
    }
    connect() {}
    toDestination() {}
    triggerAttackRelease() {}
    releaseAll() {}
    dispose() {}
  }
  const fakeTone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: {
      load: (url) => {
        // bass 的 variant 0 文件名含 '_rr1.mp3'；variants 1+ 含 '_rr2.mp3' / '_rr3.mp3'
        if (/_rr1\.mp3$/.test(url)) return Promise.resolve({ url, loaded: true })
        return new Promise((resolve) => {
          pendingResolvers.set(url, () => resolve({ url, loaded: true }))
        })
      },
    },
    getContext: () => ({ name: 'ctx' }),
    start: async () => {},
  }
  const pool = new SamplerPool({ random: () => 0 })
  pool.tone = fakeTone

  // variant 0 的所有 note 文件都立即 resolve → prepare 应能返回
  await pool.prepareTrackSources([{ trackId: 't-bass', sourceId: 'bass' }])

  const entry = pool.entries.get('t-bass::bass')
  assert.ok(entry, '应建立 entry')
  assert.equal(entry.type, 'layered')
  assert.equal(entry.layers.length, 5, 'bass 5 个力度层')

  // 每层 variant 0 应为真 Sampler（ready=true），variants 1+ 应为 placeholder 或仍在加载
  for (const layer of entry.layers) {
    assert.equal(layer.variants.length, 3, 'bass 3 个变体')
    assert.equal(layer.variants[0].ready, true, 'variant 0 应就绪')
    // variants 1+ 不阻塞 prepare，此时 ready 必然是 false
    assert.equal(layer.variants[1].ready, false)
    assert.equal(layer.variants[2].ready, false)
  }

  // microtask 已允许 _scheduleDeferredVariantLoad 运行过 → 现在应该有 rr2/rr3 的 fetch 在进行
  // 让事件循环跑一下让 queueMicrotask 触发
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(
    pendingResolvers.size > 0,
    `后台加载应已启动 rr2/rr3 的 fetch，实际 pending=${pendingResolvers.size}`,
  )

  // 在 variants 1+ 未 ready 前调触发，_pickReadySampler 应只命中 variant 0
  const pickedSamplers = new Set()
  for (let i = 0; i < 5; i++) {
    const sampler = pool._resolveSampler(entry, 0.3)
    pickedSamplers.add(sampler)
  }
  assert.equal(pickedSamplers.size, 1, '未 ready 期间所有触发应落在 variant 0 单 Sampler 上')

  // 手动解锁所有 rr2/rr3 的 load，等待 variants 1+ 就绪
  pendingResolvers.forEach((fn) => fn())
  pendingResolvers.clear()
  // 等变体 readyPromise 走完（Promise.all 需要多个 microtask）
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))

  // 现在每层应各有 3 个就绪变体
  for (const layer of entry.layers) {
    for (const v of layer.variants) {
      assert.equal(v.ready, true, '所有变体最终都应就绪')
    }
  }
  // RR 现已生效：连续触发应命中多于 1 个 Sampler
  const rrPicked = new Set()
  for (let i = 0; i < 6; i++) {
    rrPicked.add(pool._resolveSampler(entry, 0.3))
  }
  assert.ok(rrPicked.size >= 2, 'variants 全就绪后应有 RR 效果')
})

test('懒加载：releaseTrack 阻止尚未启动的后台变体加载', async () => {
  const loadCalls = []
  class FakeSampler {
    constructor() {}
    connect() {}
    toDestination() {}
    releaseAll() {}
    dispose() {}
  }
  const fakeTone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: {
      load: (url) => { loadCalls.push(url); return Promise.resolve({ url }) },
    },
    getContext: () => ({}),
    start: async () => {},
  }
  const pool = new SamplerPool()
  pool.tone = fakeTone
  await pool.prepareTrackSources([{ trackId: 't', sourceId: 'bass' }])

  // 此刻 variant 0 的 95 个 URL 已被 load；variants 1+ 的 microtask 还未跑
  const baselineLoads = loadCalls.length
  pool.releaseTrack('t')

  // 让 microtask 执行：因为 entry._disposed 已置 true，后台不会再 createSamplerEntry
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(
    loadCalls.length,
    baselineLoads,
    'releaseTrack 后不应再触发任何新的 buffer load',
  )
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
