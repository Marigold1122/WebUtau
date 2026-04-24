import test from 'node:test'
import assert from 'node:assert/strict'

import { SamplerPool } from '../src/host/audio/instruments/SamplerPool.js'

function createFakeTone({ loadResolver = null } = {}) {
  /**
   * FakeTone: 给单元测试一个可控的 Sampler/Buffer 运行时。
   * - Sampler.add(note, buffer) 会记录到 addedNotes
   * - ToneAudioBuffer.load(url) 默认同步 resolve；或由 loadResolver 决定 pending/complete
   */
  const allSamplers = []
  const bufferLoadCalls = []
  const pendingLoads = new Map()

  class FakeSampler {
    constructor(opts) {
      this.opts = opts
      this.addedNotes = []
      this._initialUrls = { ...(opts?.urls || {}) }
      allSamplers.push(this)
    }
    connect() {}
    toDestination() {}
    triggerAttackRelease() {}
    releaseAll() {}
    dispose() {}
    add(note, buffer) {
      this.addedNotes.push({ note, buffer })
    }
  }

  const fakeTone = {
    Sampler: FakeSampler,
    ToneAudioBuffer: {
      load: (url) => {
        bufferLoadCalls.push(url)
        if (loadResolver) {
          const result = loadResolver(url)
          if (result === 'pending') {
            return new Promise((resolve) => {
              pendingLoads.set(url, () => resolve({ url, loaded: true }))
            })
          }
          return result
        }
        return Promise.resolve({ url, loaded: true })
      },
    },
    getContext: () => ({ name: 'fake-ctx' }),
    start: async () => {},
    now: () => 0,
  }

  return { fakeTone, allSamplers, bufferLoadCalls, pendingLoads }
}

async function drainEventLoop(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

test('prepareChunkedPlaybackPlan: 只阻塞当前 chunk 的 variant 0 URL', async () => {
  // bass: 5 层 × 3 变体；plan 指定 2 个 chunk，currentChunkIndex=0
  // chunk 0 里 MIDI={38(D2)}，chunk 1 里 MIDI={47(B2)}，二者都在 bass catalog 里
  const { fakeTone, allSamplers, bufferLoadCalls } = createFakeTone()

  const plan = {
    chunkMidisByIndex: new Map([
      [0, new Set([38])],
      [1, new Set([47])],
    ]),
    triggeredCatalogMidis: new Set([38, 47]),
    currentChunkIndex: 0,
    chunkDurationSec: 6,
  }

  const pool = new SamplerPool()
  pool.tone = fakeTone

  await pool.prepareChunkedPlaybackPlan([{
    trackId: 't-bass',
    sourceId: 'bass',
    playbackPlan: plan,
  }])

  // prepare 返回时：应有 5 个 Sampler（每层 variant 0）
  assert.equal(allSamplers.length, 5, '返回时只应有 variant 0 × 5 层 = 5 个 Sampler')

  // 初始 URL 集合应只含 MIDI 38 对应的键（D2）
  const initialKeys = Object.keys(allSamplers[0]._initialUrls)
  assert.deepEqual(initialKeys, ['D2'])

  // 当前 chunk 应已登记为就绪
  assert.equal(pool.isChunkReady('t-bass', 'bass', 0), true)
  assert.equal(pool.isChunkReady('t-bass', 'bass', 1), false)

  // 等后台任务跑完：chunk 1 的 URL 应通过 sampler.add 加到每个 variant 0 Sampler 上
  await drainEventLoop(10)
  assert.equal(pool.isChunkReady('t-bass', 'bass', 1), true)
  for (const s of allSamplers.slice(0, 5)) {
    assert.ok(
      s.addedNotes.some((x) => x.note === 'B2'),
      `variant 0 Sampler 应已 add B2，实际 added: ${s.addedNotes.map((x) => x.note).join(',')}`,
    )
  }
  // 仍然只加载了实际触发的 MIDI（相比全量 19 个/层 × 5 层 × 3 变体 = 285 次）
  assert.ok(bufferLoadCalls.length >= 10, `预期 ≥ 10 次 load（variant 0 × 2 MIDI × 5 层），实际 ${bufferLoadCalls.length}`)
  assert.ok(bufferLoadCalls.length < 100, `应远小于全量 285，实际 ${bufferLoadCalls.length}`)
})

test('prepareChunkedPlaybackPlan: 当前 chunk 阻塞，后台 chunk 稍后就绪', async () => {
  // 让"当前 chunk variant 0"立即 resolve，其它 pending → 验证 prepare 不阻塞其他 chunk
  const { fakeTone, pendingLoads } = createFakeTone({
    loadResolver: (url) => {
      // chunk 0 MIDI 38 (D2) + variant 0 (_rr1)
      if (url.includes('D2_') && url.includes('_rr1.mp3')) {
        return Promise.resolve({ url, loaded: true })
      }
      return 'pending'
    },
  })

  const plan = {
    chunkMidisByIndex: new Map([
      [0, new Set([38])],
      [1, new Set([47])],
    ]),
    triggeredCatalogMidis: new Set([38, 47]),
    currentChunkIndex: 0,
    chunkDurationSec: 6,
  }
  const pool = new SamplerPool()
  pool.tone = fakeTone

  await pool.prepareChunkedPlaybackPlan([{
    trackId: 't-bass',
    sourceId: 'bass',
    playbackPlan: plan,
  }])

  // prepare 应已返回（当前 chunk 就绪）但 chunk 1 未就绪
  assert.equal(pool.isChunkReady('t-bass', 'bass', 0), true)
  assert.equal(pool.isChunkReady('t-bass', 'bass', 1), false)
  // 后台加载 chunk 1 的 fetches 在 pending 队列里
  await drainEventLoop(4)
  assert.ok(pendingLoads.size > 0, '后台加载应已启动但未完成')

  // 手动 resolve 全部 pending
  for (const resolve of pendingLoads.values()) resolve()
  pendingLoads.clear()
  await drainEventLoop(10)
  assert.equal(pool.isChunkReady('t-bass', 'bass', 1), true)
})

test('reportMissingChunk 广播给 onMissingSample 监听者', () => {
  const pool = new SamplerPool()
  const events = []
  pool.onMissingSample((info) => events.push(info))
  pool.reportMissingChunk({ trackId: 't', sourceId: 'bass', chunkIndex: 2, songTimeSec: 12 })
  assert.equal(events.length, 1)
  assert.equal(events[0].trackId, 't')
  assert.equal(events[0].chunkIndex, 2)
  assert.equal(events[0].songTimeSec, 12)
})

test('releaseTrack 清理 chunkReadinessByKey', async () => {
  const { fakeTone } = createFakeTone()
  const pool = new SamplerPool()
  pool.tone = fakeTone
  await pool.prepareChunkedPlaybackPlan([{
    trackId: 't',
    sourceId: 'bass',
    playbackPlan: {
      chunkMidisByIndex: new Map([[0, new Set([40])]]),
      triggeredCatalogMidis: new Set([40]),
      currentChunkIndex: 0,
      chunkDurationSec: 6,
    },
  }])
  assert.equal(pool.isChunkReady('t', 'bass', 0), true)
  pool.releaseTrack('t')
  assert.equal(pool.isChunkReady('t', 'bass', 0), false, '释放后就绪记录应清掉')
})
