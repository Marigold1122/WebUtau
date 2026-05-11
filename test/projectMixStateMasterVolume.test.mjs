// 验证 mixState.masterVolume 字段的持久化 round-trip
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MASTER_VOLUME,
  MAX_MASTER_GAIN,
  createProjectMixState,
  mergeProjectMixState,
  normalizeMasterVolume,
  resolveMasterGain,
} from '../src/host/project/projectMixState.js'

describe('masterVolume 默认值与归一化', () => {
  it('DEFAULT_MASTER_VOLUME = 0.5 (与 master gain 1.0 等价 / 历史行为不变)', () => {
    assert.equal(DEFAULT_MASTER_VOLUME, 0.5)
    assert.equal(resolveMasterGain(0.5), 1.0)
  })
  it('MAX_MASTER_GAIN = 2 (与 track gain 上限对齐 / unity 在 50% fader)', () => {
    assert.equal(MAX_MASTER_GAIN, 2)
  })
  it('normalize 处理无效输入', () => {
    assert.equal(normalizeMasterVolume(undefined), 0.5)
    assert.equal(normalizeMasterVolume(null), 0.5)
    assert.equal(normalizeMasterVolume(NaN), 0.5)
    assert.equal(normalizeMasterVolume(-1), 0)
    assert.equal(normalizeMasterVolume(1.5), 1)
    assert.equal(normalizeMasterVolume(0.7), 0.7)
  })
  it('resolveMasterGain 三个关键位置', () => {
    assert.equal(resolveMasterGain(0), 0)
    assert.equal(resolveMasterGain(0.5), 1.0)
    assert.equal(resolveMasterGain(1.0), 2.0)
  })
})

describe('createProjectMixState 对老工程兼容', () => {
  it('空对象 / null → masterVolume 默认 0.5（老工程 mixState 没此字段时不破）', () => {
    assert.equal(createProjectMixState({}).masterVolume, 0.5)
    assert.equal(createProjectMixState(null).masterVolume, 0.5)
    assert.equal(createProjectMixState().masterVolume, 0.5)
  })
  it('明确传值 → 保留', () => {
    assert.equal(createProjectMixState({ masterVolume: 0.7 }).masterVolume, 0.7)
  })
  it('与其他字段共存', () => {
    const state = createProjectMixState({
      masterVolume: 0.8,
      reverbPresetId: 'standard-room',
    })
    assert.equal(state.masterVolume, 0.8)
    assert.ok(state.reverbPresetId)
    assert.ok(state.masterChain)
    assert.ok(state.reverb)
  })
})

describe('mergeProjectMixState 对 masterVolume 的合并', () => {
  it('未传 masterVolume → 保留 current', () => {
    const before = createProjectMixState({ masterVolume: 0.8 })
    const after = mergeProjectMixState(before, { reverb: { wet: 0.5 } })
    assert.equal(after.masterVolume, 0.8)
  })
  it('传 masterVolume → 覆盖（且归一化）', () => {
    const before = createProjectMixState({ masterVolume: 0.3 })
    const after = mergeProjectMixState(before, { masterVolume: 0.9 })
    assert.equal(after.masterVolume, 0.9)
  })
  it('改 masterChain 不影响 masterVolume', () => {
    const before = createProjectMixState({ masterVolume: 0.6 })
    const after = mergeProjectMixState(before, { masterChain: { enabled: true } })
    assert.equal(after.masterVolume, 0.6)
  })
  it('round-trip：save → load → 值保留', () => {
    // 模拟 projectFile.js 的 structuredClone 持久化路径
    const state = createProjectMixState({ masterVolume: 0.75 })
    const serialized = structuredClone(state)
    const restored = createProjectMixState(serialized)
    assert.equal(restored.masterVolume, 0.75)
  })
})
