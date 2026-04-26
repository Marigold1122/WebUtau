import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MASTER_CHAIN,
  LOUDNESS_TARGET_DEFAULT,
  LOUDNESS_TARGET_MAX,
  LOUDNESS_TARGET_MIN,
  mergeMasterChain,
  normalizeMasterChain,
} from '../src/host/project/masterChainState.js'

test('normalizeMasterChain - 默认值含 loudnessTarget = -14', () => {
  const chain = normalizeMasterChain()
  assert.equal(chain.loudnessTarget, LOUDNESS_TARGET_DEFAULT)
  assert.equal(chain.loudnessTarget, -14)
  assert.equal(DEFAULT_MASTER_CHAIN.loudnessTarget, -14)
})

test('normalizeMasterChain - 数值落在范围内不变；越界被夹紧', () => {
  assert.equal(normalizeMasterChain({ loudnessTarget: -16 }).loudnessTarget, -16)
  assert.equal(normalizeMasterChain({ loudnessTarget: -23 }).loudnessTarget, -23)
  assert.equal(normalizeMasterChain({ loudnessTarget: 10 }).loudnessTarget, LOUDNESS_TARGET_MAX)
  assert.equal(normalizeMasterChain({ loudnessTarget: -100 }).loudnessTarget, LOUDNESS_TARGET_MIN)
})

test('normalizeMasterChain - 非数字类型回退到 fallback / 默认', () => {
  assert.equal(normalizeMasterChain({ loudnessTarget: 'abc' }).loudnessTarget, LOUDNESS_TARGET_DEFAULT)
  assert.equal(normalizeMasterChain({ loudnessTarget: NaN }).loudnessTarget, LOUDNESS_TARGET_DEFAULT)
  assert.equal(normalizeMasterChain({ loudnessTarget: null }).loudnessTarget, LOUDNESS_TARGET_DEFAULT)
})

test('mergeMasterChain - 改 loudnessTarget 不会让 presetId 失效', () => {
  // broadcast 预设 + 默认 -14；用户把 target 改到 -16，应该保留 presetId='broadcast'
  const initial = normalizeMasterChain({ presetId: 'broadcast' })
  assert.equal(initial.presetId, 'broadcast')
  const merged = mergeMasterChain(initial, { loudnessTarget: -16 })
  assert.equal(merged.loudnessTarget, -16)
  assert.equal(merged.presetId, 'broadcast') // ← 关键：仪表参考线变化不影响预设
})

test('mergeMasterChain - 改 EQ / compressor 仍然让 presetId 失效（行为不变）', () => {
  const initial = normalizeMasterChain({ presetId: 'broadcast' })
  const merged = mergeMasterChain(initial, { compressor: { threshold: -10 } })
  assert.equal(merged.presetId, null)
})

test('normalizeMasterChain - 已有 chain 中的 loudnessTarget 在 fallback 没传时仍保留', () => {
  // 模拟 project load：从存储读出来的 chain 含 loudnessTarget = -23
  const stored = { presetId: 'broadcast', loudnessTarget: -23, eq: { enabled: true, bands: [] } }
  const normalized = normalizeMasterChain(stored)
  assert.equal(normalized.loudnessTarget, -23)
})
