// ============================================================
// PitchPoint Shape 双向映射表
// ============================================================
//
// 三种格式的 shape 枚举：
//
//   webUTAU (normalizePitchShape, noteDocument.js):
//     "io" — S-curve (sine-in-out), 默认值
//     "l"  — linear
//     "i"  — sine-in  (缓入，起始慢末尾快)
//     "o"  — sine-out (缓出，起始快末尾慢)
//
//   OpenUtau C# (PitchPointShape enum, UNote.cs:426–443):
//     io — SineInOut
//     l  — Linear
//     i  — SineIn
//     o  — SineOut
//
//   UST Mode 2 (PBM 字段，每个字符对应一个区间):
//     " " (空格) — curve (S-curve, 默认)
//     "s" — straight (线性)
//     "r" — R-curve (起始快末尾慢 ≈ sine-in)
//     "j" — J-curve (起始慢末尾快 ≈ sine-out)
//
// 结论：webUTAU 与 OpenUtau C# 使用的枚举值完全一致（均源自 OpenUtau 生态）。
// Shape 映射主要在 UST PBM ↔ webUTAU/USTX 之间需要。
// ============================================================

// ============================================================
// 基础常量
// ============================================================

/** webUTAU / USTX 侧的有效 shape 值 */
export const SHAPE_IO = 'io'
export const SHAPE_LINEAR = 'l'
export const SHAPE_SINE_IN = 'i'
export const SHAPE_SINE_OUT = 'o'

/** UST PBM 侧的有效 shape 字符 */
export const PBM_CURVE = ' '
export const PBM_STRAIGHT = 's'
export const PBM_R_CURVE = 'r'
export const PBM_J_CURVE = 'j'

/** webUTAU / USTX 的有效 shape 集合 */
export const VALID_SHAPES = Object.freeze(new Set([
  SHAPE_IO,
  SHAPE_LINEAR,
  SHAPE_SINE_IN,
  SHAPE_SINE_OUT,
]))

// ============================================================
// 双向映射表
// ============================================================

/**
 * webUTAU/USTX shape → UST PBM 字符
 *
 * 导出 UST 时使用：将内部 shape 转为 PBM 字符串中对应位置的字符
 */
export const SHAPE_TO_PBM = Object.freeze({
  [SHAPE_IO]:        PBM_CURVE,     // io → " "  S曲线
  [SHAPE_LINEAR]:    PBM_STRAIGHT,  // l  → "s"  直线
  [SHAPE_SINE_IN]:   PBM_R_CURVE,   // i  → "r"  R曲线（近似）
  [SHAPE_SINE_OUT]:  PBM_J_CURVE,   // o  → "j"  J曲线（近似）
})

/**
 * UST PBM 字符 → webUTAU/USTX shape
 *
 * 导入 UST 时使用：将 PBM 每个字符映射回内部 shape
 */
export const PBM_TO_SHAPE = Object.freeze({
  [PBM_CURVE]:      SHAPE_IO,       // " " → io  S曲线
  [PBM_STRAIGHT]:   SHAPE_LINEAR,   // "s" → l   直线
  [PBM_R_CURVE]:    SHAPE_SINE_IN,  // "r" → i   缓入
  [PBM_J_CURVE]:    SHAPE_SINE_OUT, // "j" → o   缓出
})

// ============================================================
// 工具函数
// ============================================================

/**
 * 标准化 webUTAU / USTX 的 shape 值
 * 等价于 normalizePitchShape() 在 noteDocument.js 中的逻辑
 */
export function normalizeShape(shape) {
  return VALID_SHAPES.has(shape) ? shape : SHAPE_IO
}

/**
 * 将 shape 转为 PBM 字符
 */
export function shapeToPbm(shape) {
  return SHAPE_TO_PBM[normalizeShape(shape)] || PBM_CURVE
}

/**
 * 将 PBM 字符转为 shape
 */
export function pbmToShape(pbmChar) {
  return PBM_TO_SHAPE[pbmChar] || SHAPE_IO
}

/**
 * 将单个 shape 转为 USTX 可读的完整名称（调试/日志用）
 */
export function shapeToLabel(shape) {
  switch (normalizeShape(shape)) {
    case SHAPE_IO:        return 'sine_in_out'
    case SHAPE_LINEAR:    return 'linear'
    case SHAPE_SINE_IN:   return 'sine_in'
    case SHAPE_SINE_OUT:  return 'sine_out'
    default:              return 'sine_in_out'
  }
}

/**
 * 将 PitchPoint shape 数组转为 UST PBM 字符串
 *
 * UST PBM 格式：每个字符描述 pitch.data[i] 到 pitch.data[i+1] 之间的插值曲线形状。
 * 因此 PBM 字符串长度 = data.length - 1。
 *
 * @param {Array<{shape: string}>} data - pitch.data 点数组
 * @returns {string} PBM 字符串
 */
export function buildPbmString(data) {
  if (!Array.isArray(data) || data.length < 2) return ''
  const chars = []
  for (let i = 0; i < data.length - 1; i++) {
    chars.push(shapeToPbm(data[i]?.shape))
  }
  return chars.join('')
}

/**
 * 从 UST PBM 字符串解析 shape 并应用到 pitch.data 数组
 *
 * @param {Array<{x: number, y: number, shape?: string}>} data - pitch.data 点数组
 * @param {string} pbm - PBM 字符串
 * @returns {Array} 应用了 shape 的 data 副本
 */
export function applyPbmToData(data, pbm) {
  if (!Array.isArray(data) || data.length < 2) return data
  if (typeof pbm !== 'string' || pbm.length === 0) return data
  const result = data.map((point, idx) => ({
    ...point,
    shape: normalizeShape(point?.shape),
  }))
  for (let i = 0; i < Math.min(result.length - 1, pbm.length); i++) {
    result[i] = { ...result[i], shape: pbmToShape(pbm[i]) }
  }
  return result
}
