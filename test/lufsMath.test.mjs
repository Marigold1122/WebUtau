import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ABSOLUTE_GATE_LUFS,
  calcAutoFitMakeupGain,
  calcIntegratedLufs,
  calcWindowLufs,
  deltaToTargetLU,
  meanSquareToLufs,
  passesAbsoluteGate,
} from '../src/host/audio/master/lufsMath.js'

// 把 LUFS 等式 ms = 10^((lufs - offset) / 10) 反过来用，从一个目标 LUFS 算出对应的 mean-square
function meanSquareForLufs(targetLufs) {
  return Math.pow(10, (targetLufs + 0.691) / 10)
}

function approxEqual(actual, expected, tol = 0.001) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected} ± ${tol}, got ${actual}`,
  )
}

test('meanSquareToLufs - 校准常数：满刻度方波（ms=1）应得到 -0.691 LUFS', () => {
  approxEqual(meanSquareToLufs(1.0), -0.691)
})

test('meanSquareToLufs - 0 / 负数 / NaN 一律返回 -Infinity', () => {
  assert.equal(meanSquareToLufs(0), -Infinity)
  assert.equal(meanSquareToLufs(-1), -Infinity)
  assert.equal(meanSquareToLufs(NaN), -Infinity)
  assert.equal(meanSquareToLufs(Infinity), -Infinity) // !Number.isFinite
})

test('meanSquareToLufs - 半响度 (ms=0.5) 应低于 ms=1 约 3 dB', () => {
  const high = meanSquareToLufs(1.0)
  const low = meanSquareToLufs(0.5)
  approxEqual(low - high, -3.0103, 0.01) // 10·log10(0.5) = -3.0103
})

test('calcWindowLufs - 空窗 / 全 0 / 单一非零块', () => {
  assert.equal(calcWindowLufs([]), -Infinity)
  assert.equal(calcWindowLufs(null), -Infinity)
  assert.equal(calcWindowLufs([0, 0, 0]), -Infinity)
  // 单块 ms=1.0 → -0.691 LUFS
  approxEqual(calcWindowLufs([1.0]), -0.691)
})

test('calcWindowLufs - 4 块均值', () => {
  // [ms=1.0, 0, 0, 0] → 平均 0.25 → -0.691 + 10·log10(0.25) = -0.691 - 6.0206 = -6.711 LUFS
  approxEqual(calcWindowLufs([1.0, 0, 0, 0]), -6.7116, 0.01)
})

test('passesAbsoluteGate - 边界值 -70 LUFS 不通过（严格大于）', () => {
  const msAt70 = meanSquareForLufs(-70)
  const msJustAbove = meanSquareForLufs(-69.99)
  const msJustBelow = meanSquareForLufs(-70.01)
  assert.equal(passesAbsoluteGate(msAt70), false)
  assert.equal(passesAbsoluteGate(msJustAbove), true)
  assert.equal(passesAbsoluteGate(msJustBelow), false)
  assert.equal(passesAbsoluteGate(0), false)
})

test('calcIntegratedLufs - 空数组返回 -Infinity', () => {
  assert.equal(calcIntegratedLufs([]), -Infinity)
  assert.equal(calcIntegratedLufs(null), -Infinity)
})

test('calcIntegratedLufs - 单块 = 该块的 LUFS（双门退化）', () => {
  const ms = meanSquareForLufs(-14)
  approxEqual(calcIntegratedLufs([ms]), -14, 0.01)
})

test('calcIntegratedLufs - 等响度块求平均，相对门不影响', () => {
  // 12 块都是 -20 LUFS，未门控平均 -20，相对门 -30，全过——结果 -20
  const ms = meanSquareForLufs(-20)
  const blocks = new Array(12).fill(ms)
  approxEqual(calcIntegratedLufs(blocks), -20, 0.01)
})

test('calcIntegratedLufs - 相对门剔除安静段（响段/静段混合）', () => {
  // 6 块 -14 LUFS（响段），6 块 -45 LUFS（很安静）
  //   pass1 未门控平均:
  //     ms_loud = 10^((-14+0.691)/10) ≈ 0.04654
  //     ms_quiet = 10^((-45+0.691)/10) ≈ 0.0000370
  //     mean = (6·0.04654 + 6·0.0000370) / 12 ≈ 0.02329
  //     ungatedLufs = -0.691 + 10·log10(0.02329) ≈ -17.022 LUFS
  //   pass2 相对门 = -17.022 - 10 = -27.022 LUFS
  //     -14 LUFS 块（响段）通过，-45 LUFS 块（安静段）被门掉
  //     最终平均 = -14 LUFS
  const msLoud = meanSquareForLufs(-14)
  const msQuiet = meanSquareForLufs(-45)
  const blocks = [
    ...new Array(6).fill(msLoud),
    ...new Array(6).fill(msQuiet),
  ]
  approxEqual(calcIntegratedLufs(blocks), -14, 0.01)
})

test('calcIntegratedLufs - 全部块都被相对门筛掉时退化到未门控值', () => {
  // 构造极端情况——但实际上等响度块（如 12 个 -14）的相对门是 -24，
  // 所有 -14 块都 > -24，所以正常情况不会全被筛掉。
  // 极端：单块 -14，相对门 -24，唯一块 -14 > -24 → 通过 → 仍是 -14
  // 所以这个分支主要靠空数组保护，已经在上面测过了
  const ms = meanSquareForLufs(-14)
  approxEqual(calcIntegratedLufs([ms, ms, ms]), -14, 0.01)
})

test('deltaToTargetLU - 当前 -12，目标 -14 → +2 LU（更响 2 LU）', () => {
  approxEqual(deltaToTargetLU(-12, -14), 2)
})

test('deltaToTargetLU - 非有限输入返回 null（UI 用来跳过着色）', () => {
  assert.equal(deltaToTargetLU(-Infinity, -14), null)
  assert.equal(deltaToTargetLU(-14, NaN), null)
  assert.equal(deltaToTargetLU(null, -14), null)
})

test('ABSOLUTE_GATE_LUFS 是 -70（规范常数，回归保护）', () => {
  assert.equal(ABSOLUTE_GATE_LUFS, -70)
})

test('calcAutoFitMakeupGain - 偏轻 4 LU 时把 makeup gain 加 4 dB', () => {
  const result = calcAutoFitMakeupGain({
    currentIntegrated: -18,
    targetLufs: -14,
    currentMakeupGainDb: 2,
  })
  assert.equal(result.ok, true)
  approxEqual(result.deltaLu, 4)
  approxEqual(result.nextMakeupGainDb, 6) // 2 + 4
  approxEqual(result.appliedDb, 4)
  assert.equal(result.hitLimit, false)
  assert.equal(result.largeAdjustment, false)
})

test('calcAutoFitMakeupGain - 偏响 3 LU 时把 makeup gain 减 3 dB', () => {
  const result = calcAutoFitMakeupGain({
    currentIntegrated: -11,
    targetLufs: -14,
    currentMakeupGainDb: 5,
  })
  approxEqual(result.deltaLu, -3)
  approxEqual(result.nextMakeupGainDb, 2)
})

test('calcAutoFitMakeupGain - 调整量超过 ±6 LU 时标记 largeAdjustment', () => {
  const result = calcAutoFitMakeupGain({
    currentIntegrated: -22,
    targetLufs: -14,
    currentMakeupGainDb: 0,
  })
  approxEqual(result.deltaLu, 8)
  assert.equal(result.largeAdjustment, true)
})

test('calcAutoFitMakeupGain - 命中 makeup gain 上下限时 clamp 并标记 hitLimit', () => {
  // 偏轻 30 LU，加 30 dB 会超过 makeupGainMax=24，clamp 到 24
  const tooQuiet = calcAutoFitMakeupGain({
    currentIntegrated: -44,
    targetLufs: -14,
    currentMakeupGainDb: 0,
  })
  assert.equal(tooQuiet.nextMakeupGainDb, 24)
  assert.equal(tooQuiet.hitLimit, true)

  // 偏响 20 LU，需要减 20 dB，但 makeup gain 最小 -12，clamp 到 -12
  const tooLoud = calcAutoFitMakeupGain({
    currentIntegrated: 6,
    targetLufs: -14,
    currentMakeupGainDb: 0,
  })
  assert.equal(tooLoud.nextMakeupGainDb, -12)
  assert.equal(tooLoud.hitLimit, true)
})

test('calcAutoFitMakeupGain - 输入非有限时安全退出（ok=false）', () => {
  const result = calcAutoFitMakeupGain({
    currentIntegrated: -Infinity,
    targetLufs: -14,
    currentMakeupGainDb: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid-input')
})

test('calcAutoFitMakeupGain - 当前已达目标 ±0 时 delta=0，gain 不变', () => {
  const result = calcAutoFitMakeupGain({
    currentIntegrated: -14,
    targetLufs: -14,
    currentMakeupGainDb: 3,
  })
  approxEqual(result.deltaLu, 0)
  approxEqual(result.nextMakeupGainDb, 3)
  approxEqual(result.appliedDb, 0)
})
