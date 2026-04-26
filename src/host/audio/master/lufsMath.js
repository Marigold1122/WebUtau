// ITU-R BS.1770-4 响度计算的纯算式部分。
// 把"K 加权后的样本均方"作为输入（K 加权 / 通道求和那一段在 LufsMeter 里用 Web Audio 节点完成），
// 这一层只做：均方 → LUFS、4 跳一块、绝对门 / 相对门、滑动窗均值。
// 拆成纯函数是为了能在 node:test 里直接喂数验证，不依赖 AudioContext。

// BS.1770 的校准常数；对纯正弦 -3 dBFS 的 RMS 信号应得出约 -3 LKFS
export const LUFS_CALIBRATION_OFFSET = -0.691

// 100ms 一跳，4 跳合 400ms（= 一个"门控块"），30 跳合 3 秒（短时窗）
export const HOP_INTERVAL_MS = 100
export const MOMENTARY_HOPS = 4
export const SHORT_TERM_HOPS = 30

// BS.1770-4 §5.1 / §5.2：绝对门 -70 LUFS，相对门 = 一次未门控积分值 - 10 LU
export const ABSOLUTE_GATE_LUFS = -70
export const RELATIVE_GATE_OFFSET_LU = -10

// 给立体声输出的通道权重（BS.1770 表1：L=1.0, R=1.0；环绕声 LS/RS = 1.41 这里用不到）
export const STEREO_CHANNEL_WEIGHT = 1.0

// 极小数：避免 log10(0) → -Infinity 触发后续 NaN；按 -200 dB 截止
const MIN_MEAN_SQUARE = 1e-20

export function meanSquareToLufs(meanSquare) {
  if (!Number.isFinite(meanSquare) || meanSquare <= MIN_MEAN_SQUARE) return -Infinity
  return LUFS_CALIBRATION_OFFSET + 10 * Math.log10(meanSquare)
}

// 滑动窗（momentary 400ms / short-term 3s）= 各跳均方的算术平均，再换算 LUFS
export function calcWindowLufs(hopMeanSquares) {
  if (!Array.isArray(hopMeanSquares) || hopMeanSquares.length === 0) return -Infinity
  let sum = 0
  for (const ms of hopMeanSquares) {
    if (!Number.isFinite(ms) || ms < 0) return -Infinity
    sum += ms
  }
  return meanSquareToLufs(sum / hopMeanSquares.length)
}

// Integrated：两遍门控
//   pass1：用绝对门（-70 LUFS）筛过的块，求未门控均值 ungatedLufs
//   pass2：再用 (ungatedLufs - 10) 作相对门，筛剩下的块求最终均值
// 入参 gatedBlocks 已经是绝对门通过的块（LufsMeter 入存时筛过），这里只做相对门
export function calcIntegratedLufs(absoluteGatedBlocks) {
  if (!Array.isArray(absoluteGatedBlocks) || absoluteGatedBlocks.length === 0) return -Infinity

  let absSum = 0
  for (const ms of absoluteGatedBlocks) {
    if (!Number.isFinite(ms) || ms < 0) return -Infinity
    absSum += ms
  }
  const ungatedMean = absSum / absoluteGatedBlocks.length
  const ungatedLufs = meanSquareToLufs(ungatedMean)
  if (!Number.isFinite(ungatedLufs)) return -Infinity

  const relativeGate = ungatedLufs + RELATIVE_GATE_OFFSET_LU

  let relSum = 0
  let relCount = 0
  for (const ms of absoluteGatedBlocks) {
    const blockLufs = meanSquareToLufs(ms)
    if (Number.isFinite(blockLufs) && blockLufs > relativeGate) {
      relSum += ms
      relCount++
    }
  }
  // 极端情况：相对门把所有块都筛掉了——按规范退化到未门控值（不返回 -Infinity）
  if (relCount === 0) return ungatedLufs
  return meanSquareToLufs(relSum / relCount)
}

// 块入门：BS.1770 §5.2 step 4——绝对门 -70 LUFS 是入门准入条件
export function passesAbsoluteGate(blockMeanSquare) {
  return meanSquareToLufs(blockMeanSquare) > ABSOLUTE_GATE_LUFS
}

// 帮 UI 决定颜色用的：当前响度相对目标的偏差 LU 值
export function deltaToTargetLU(currentLufs, targetLufs) {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return null
  return currentLufs - targetLufs
}

// 自动达标：根据当前 integrated LUFS、目标 LUFS、当前 makeup gain (dB)，
// 算出"应当把 makeup gain 调到多少 dB"。线性近似：要响 4 LU 就把 gain 加 4 dB。
//
// 限幅器位于 makeupGain 之后——makeupGain 推大会触发限幅多挤压几个峰，导致
// 实测 integrated 上涨小于线性预期（响度战的根因）。所以这函数只做"第一次估算"，
// 用户播放验证后再点一次还能继续修正
export function calcAutoFitMakeupGain({
  currentIntegrated,
  targetLufs,
  currentMakeupGainDb,
  makeupGainMin = -12,
  makeupGainMax = 24,
}) {
  if (!Number.isFinite(currentIntegrated) || !Number.isFinite(targetLufs) || !Number.isFinite(currentMakeupGainDb)) {
    return { ok: false, reason: 'invalid-input', nextMakeupGainDb: currentMakeupGainDb, deltaLu: null }
  }
  const deltaLu = targetLufs - currentIntegrated
  const desired = currentMakeupGainDb + deltaLu
  const clamped = Math.max(makeupGainMin, Math.min(makeupGainMax, desired))
  const hitLimit = clamped !== desired
  // 调整量太大也警示——超过 ±6 dB 听感会变化明显（压缩 / 限幅工作量陡增）
  const largeAdjustment = Math.abs(deltaLu) > 6
  return {
    ok: true,
    nextMakeupGainDb: clamped,
    deltaLu,
    appliedDb: clamped - currentMakeupGainDb,
    hitLimit,
    largeAdjustment,
  }
}
