// 单轨 insert 链（EQ4 + Comp）数据层契约测试
//   - 默认 disabled / 老工程零行为变化
//   - normalize / merge 边界 case
//   - 持久化 round-trip（structuredClone + JSON）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TRACK_INSERT_CHAIN,
  mergeTrackInsertChainSlot,
  normalizeTrackInsertChain,
} from '../src/host/project/trackInsertChainState.js'
import {
  createTrackPlaybackState,
  mergeTrackPlaybackState,
} from '../src/host/project/trackPlaybackState.js'

describe('DEFAULT_TRACK_INSERT_CHAIN', () => {
  it('两槽都 disabled —— 老工程加载零行为变化', () => {
    assert.equal(DEFAULT_TRACK_INSERT_CHAIN.eq4.enabled, false)
    assert.equal(DEFAULT_TRACK_INSERT_CHAIN.comp.enabled, false)
  })
  it('EQ4 默认 4 段', () => {
    assert.equal(DEFAULT_TRACK_INSERT_CHAIN.eq4.bands.length, 4)
    assert.equal(DEFAULT_TRACK_INSERT_CHAIN.eq4.bands[0].type, 'lowshelf')
    assert.equal(DEFAULT_TRACK_INSERT_CHAIN.eq4.bands[3].type, 'highshelf')
  })
  it('所有 EQ 段默认 gain=0（开启时也无效果，等用户调）', () => {
    DEFAULT_TRACK_INSERT_CHAIN.eq4.bands.forEach((band) => {
      assert.equal(band.gain, 0)
    })
  })
})

describe('normalizeTrackInsertChain', () => {
  it('空输入 / null → 默认链', () => {
    const a = normalizeTrackInsertChain({})
    assert.equal(a.eq4.enabled, false)
    assert.equal(a.comp.enabled, false)
    const b = normalizeTrackInsertChain(null)
    assert.deepEqual(b, a)
  })
  it('用户传值 → 接受 + clamp', () => {
    const out = normalizeTrackInsertChain({
      eq4: { enabled: true, bands: [{ gain: 99 }, {}, {}, {}] },
      comp: { enabled: true, threshold: -100, ratio: 999 },
    })
    assert.equal(out.eq4.enabled, true)
    assert.equal(out.eq4.bands[0].gain, 18)   // clamp 到 EQ_GAIN_MAX
    assert.equal(out.comp.enabled, true)
    assert.equal(out.comp.threshold, -60)     // clamp 到 threshold MIN
    assert.equal(out.comp.ratio, 20)          // clamp 到 ratio MAX
  })
})

describe('mergeTrackInsertChainSlot', () => {
  it('单段 EQ patch（bandIndex + band）', () => {
    const current = normalizeTrackInsertChain({})
    const next = mergeTrackInsertChainSlot(current, 'eq4', {
      bandIndex: 2, band: { gain: 4 },
    })
    assert.equal(next.eq4.bands[2].gain, 4)
    assert.equal(next.eq4.bands[0].gain, 0)   // 其它段不动
    // enabled 未传 → 保留原值
    assert.equal(next.eq4.enabled, false)
  })
  it('开启 EQ + patch 同时', () => {
    const current = normalizeTrackInsertChain({})
    const next = mergeTrackInsertChainSlot(current, 'eq4', {
      enabled: true, bandIndex: 0, band: { gain: -3 },
    })
    assert.equal(next.eq4.enabled, true)
    assert.equal(next.eq4.bands[0].gain, -3)
  })
  it('Comp 单参数 patch', () => {
    const current = normalizeTrackInsertChain({})
    const next = mergeTrackInsertChainSlot(current, 'comp', {
      enabled: true, threshold: -24,
    })
    assert.equal(next.comp.enabled, true)
    assert.equal(next.comp.threshold, -24)
    // ratio 等其它参数保留 default
    assert.equal(next.comp.ratio, 2)
  })
  it('未知 slot → 原值不动', () => {
    const current = normalizeTrackInsertChain({})
    const next = mergeTrackInsertChainSlot(current, 'unknown', { enabled: true })
    assert.deepEqual(next, current)
  })
})

describe('整合 trackPlaybackState', () => {
  it('createTrackPlaybackState({}) 包含默认 inserts', () => {
    const state = createTrackPlaybackState({})
    assert.ok(state.inserts)
    assert.equal(state.inserts.eq4.enabled, false)
    assert.equal(state.inserts.comp.enabled, false)
  })

  it('老工程 playbackState（无 inserts 字段）加载后 inserts 默认值', () => {
    const state = createTrackPlaybackState({
      // 老 playbackState 形状：有这些字段、没 inserts
      volume: 0.7, pan: -0.3, mute: false, solo: true, reverbSend: 0.4,
    })
    assert.equal(state.inserts.eq4.enabled, false)
    assert.equal(state.inserts.comp.enabled, false)
    assert.equal(state.volume, 0.7)
    assert.equal(state.pan, -0.3)
  })

  it('merge 单槽 patch（UI 常用接口）', () => {
    const before = createTrackPlaybackState({})
    const after = mergeTrackPlaybackState(before, {
      inserts: { slot: 'eq4', patch: { enabled: true, bandIndex: 1, band: { gain: 6 } } },
    })
    assert.equal(after.inserts.eq4.enabled, true)
    assert.equal(after.inserts.eq4.bands[1].gain, 6)
    // 不影响 comp
    assert.equal(after.inserts.comp.enabled, false)
    // 不影响其它 playbackState 字段
    assert.equal(after.volume, before.volume)
  })

  it('merge 整链替换', () => {
    const before = createTrackPlaybackState({})
    const after = mergeTrackPlaybackState(before, {
      inserts: { eq4: { enabled: true, bands: [{}, {}, {}, {}] }, comp: { enabled: true, ratio: 4 } },
    })
    assert.equal(after.inserts.eq4.enabled, true)
    assert.equal(after.inserts.comp.enabled, true)
    assert.equal(after.inserts.comp.ratio, 4)
  })

  it('JSON round-trip 保留所有 insert 字段', () => {
    const state = createTrackPlaybackState({
      inserts: {
        eq4: { enabled: true, bands: [
          { type: 'lowshelf', freq: 100, gain: 3, q: 0.7 },
          { type: 'peaking', freq: 500, gain: -2, q: 1.2 },
          { type: 'peaking', freq: 3000, gain: 4, q: 0.9 },
          { type: 'highshelf', freq: 12000, gain: 2, q: 0.7 },
        ] },
        comp: { enabled: true, threshold: -24, ratio: 4, attack: 0.01, release: 0.1, knee: 4, makeupGain: 2 },
      },
    })
    const round = JSON.parse(JSON.stringify(state))
    assert.equal(round.inserts.eq4.enabled, true)
    assert.equal(round.inserts.eq4.bands[1].gain, -2)
    assert.equal(round.inserts.comp.threshold, -24)
    assert.equal(round.inserts.comp.ratio, 4)
  })
})
