// 主控母带链：EQ × 4 段 + Compressor + Limiter，全工程一份。
// 默认全部启用——用户什么都不动也能享受 limiter 防爆音兜底；
// 子模块各自有 bypass，让进阶用户能 A/B 对比每段的作用。
//
// 各参数单位与 Web Audio 节点保持一致：
//   - EQ gain：dB（BiquadFilter.gain.value 单位是 dB，仅对 lowshelf/highshelf/peaking 类型有效）
//   - EQ q  ：无量纲；lowshelf/highshelf 上 q 控制斜率，peaking 上 q 控制带宽
//   - 频率：Hz
//   - 压缩 threshold：dB（DynamicsCompressorNode.threshold.value）
//   - 压缩 ratio：x:1（>=1）
//   - 压缩 attack/release：秒
//   - 压缩 knee：dB
//   - makeupGain：dB（compressor 之后单独乘的增益）
//   - 限幅 threshold：dB

const HAS_OWN = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function pickNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

// ===== EQ 段 =====

export const EQ_BAND_TYPES = ['lowshelf', 'peaking', 'peaking', 'highshelf']

export const DEFAULT_EQ_BANDS = [
  { type: 'lowshelf', freq: 80,    gain: 0, q: 0.7 },
  { type: 'peaking',  freq: 400,   gain: 0, q: 1.0 },
  { type: 'peaking',  freq: 2500,  gain: 0, q: 1.0 },
  { type: 'highshelf',freq: 10000, gain: 0, q: 0.7 },
]

const EQ_BAND_RANGES = [
  { freqMin: 20,    freqMax: 320  },
  { freqMin: 80,    freqMax: 1600 },
  { freqMin: 600,   freqMax: 10000 },
  { freqMin: 2000,  freqMax: 22000 },
]

const EQ_GAIN_MIN = -18
const EQ_GAIN_MAX = 18
const EQ_Q_MIN = 0.1
const EQ_Q_MAX = 10

// 给单轨 insert（trackInsertChainState）复用
export const TRACK_INSERT_EQ_RANGES = EQ_BAND_RANGES
export const TRACK_INSERT_EQ_GAIN_MIN = EQ_GAIN_MIN
export const TRACK_INSERT_EQ_GAIN_MAX = EQ_GAIN_MAX
export const TRACK_INSERT_EQ_Q_MIN = EQ_Q_MIN
export const TRACK_INSERT_EQ_Q_MAX = EQ_Q_MAX
export { normalizeEqBand as normalizeEqBandShared }

function normalizeEqBand(band, fallback, range) {
  const baseline = fallback || DEFAULT_EQ_BANDS[0]
  const type = baseline.type // 类型固定不让用户改，避免 UI 复杂化
  const freq = clamp(pickNumber(band?.freq, baseline.freq), range?.freqMin ?? 20, range?.freqMax ?? 22000)
  const gain = clamp(pickNumber(band?.gain, baseline.gain), EQ_GAIN_MIN, EQ_GAIN_MAX)
  const q = clamp(pickNumber(band?.q, baseline.q), EQ_Q_MIN, EQ_Q_MAX)
  return { type, freq, gain, q }
}

function normalizeEq(input, fallback) {
  const fallbackEq = fallback || { enabled: true, bands: DEFAULT_EQ_BANDS }
  const enabled = HAS_OWN(input || {}, 'enabled') ? Boolean(input.enabled) : Boolean(fallbackEq.enabled)
  const inputBands = Array.isArray(input?.bands) ? input.bands : []
  const fallbackBands = Array.isArray(fallbackEq.bands) ? fallbackEq.bands : DEFAULT_EQ_BANDS
  const bands = DEFAULT_EQ_BANDS.map((_def, index) => {
    return normalizeEqBand(inputBands[index], fallbackBands[index] || DEFAULT_EQ_BANDS[index], EQ_BAND_RANGES[index])
  })
  return { enabled, bands }
}

// ===== Compressor =====

export const DEFAULT_COMPRESSOR = {
  enabled: true,
  threshold: -18,
  ratio: 2,
  attack: 0.030,
  release: 0.200,
  knee: 6,
  makeupGain: 0,
}

const COMPRESSOR_RANGES = {
  threshold:  { min: -60,  max: 0    },
  ratio:      { min: 1,    max: 20   },
  attack:     { min: 0,    max: 1    },
  release:    { min: 0.01, max: 1    },
  knee:       { min: 0,    max: 40   },
  makeupGain: { min: -12,  max: 24   },
}

export const TRACK_INSERT_COMPRESSOR_RANGES = COMPRESSOR_RANGES
export { normalizeCompressor as normalizeCompressorShared }

function normalizeCompressor(input, fallback) {
  const baseline = fallback || DEFAULT_COMPRESSOR
  return {
    enabled: HAS_OWN(input || {}, 'enabled') ? Boolean(input.enabled) : Boolean(baseline.enabled),
    threshold:  clamp(pickNumber(input?.threshold,  baseline.threshold),  COMPRESSOR_RANGES.threshold.min,  COMPRESSOR_RANGES.threshold.max),
    ratio:      clamp(pickNumber(input?.ratio,      baseline.ratio),      COMPRESSOR_RANGES.ratio.min,      COMPRESSOR_RANGES.ratio.max),
    attack:     clamp(pickNumber(input?.attack,     baseline.attack),     COMPRESSOR_RANGES.attack.min,     COMPRESSOR_RANGES.attack.max),
    release:    clamp(pickNumber(input?.release,    baseline.release),    COMPRESSOR_RANGES.release.min,    COMPRESSOR_RANGES.release.max),
    knee:       clamp(pickNumber(input?.knee,       baseline.knee),       COMPRESSOR_RANGES.knee.min,       COMPRESSOR_RANGES.knee.max),
    makeupGain: clamp(pickNumber(input?.makeupGain, baseline.makeupGain), COMPRESSOR_RANGES.makeupGain.min, COMPRESSOR_RANGES.makeupGain.max),
  }
}

// ===== Limiter =====

export const DEFAULT_LIMITER = {
  enabled: true,
  threshold: -0.3,
}

const LIMITER_RANGES = {
  threshold: { min: -12, max: 0 },
}

// 限幅器除 threshold 外其它参数固定为"砖墙"：高 ratio + 极快 attack + 短 release。
// 这是商业母带 limiter 的标准组态——用户不需要也不应该看到这些
export const LIMITER_FIXED_PARAMS = Object.freeze({
  ratio: 20,
  attack: 0.001,
  release: 0.050,
  knee: 0,
})

function normalizeLimiter(input, fallback) {
  const baseline = fallback || DEFAULT_LIMITER
  return {
    enabled: HAS_OWN(input || {}, 'enabled') ? Boolean(input.enabled) : Boolean(baseline.enabled),
    threshold: clamp(pickNumber(input?.threshold, baseline.threshold), LIMITER_RANGES.threshold.min, LIMITER_RANGES.threshold.max),
  }
}

// ===== 组合 =====

// presetId 跟 masterChain 同阶——记录"用户上次选了哪个预设"。
// 默认 'flat'，因为 DEFAULT_MASTER_CHAIN 各参数恰好等于 Flat 预设的 config
//
// loudnessTarget：用户期望的"成品响度目标"，单位 LUFS。默认 -14（Spotify / B站 / YouTube
// 等流媒体的发布响度），用户可在 UI 改成 -16（Apple Music）或 -23（EBU R128 广播）等。
// 不参与音频处理，纯是给 LUFS 表着色 / 提示用户"还差几 LU 到达目标"用的参考线
export const LOUDNESS_TARGET_MIN = -36
export const LOUDNESS_TARGET_MAX = -6
export const LOUDNESS_TARGET_DEFAULT = -14

export const DEFAULT_MASTER_CHAIN = Object.freeze({
  presetId: 'flat',
  enabled: true,
  eq: { enabled: true, bands: DEFAULT_EQ_BANDS },
  compressor: DEFAULT_COMPRESSOR,
  limiter: DEFAULT_LIMITER,
  loudnessTarget: LOUDNESS_TARGET_DEFAULT,
})

function normalizePresetId(value, fallback) {
  if (value === null) return null
  if (typeof value === 'string' && value) return value
  return fallback ?? null
}

function normalizeLoudnessTarget(value, fallback) {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : LOUDNESS_TARGET_DEFAULT
  return clamp(value, LOUDNESS_TARGET_MIN, LOUDNESS_TARGET_MAX)
}

export function normalizeMasterChain(input, fallback = null) {
  const baseline = fallback || DEFAULT_MASTER_CHAIN
  return {
    presetId: HAS_OWN(input || {}, 'presetId') ? normalizePresetId(input.presetId, baseline.presetId) : (baseline.presetId ?? null),
    enabled: HAS_OWN(input || {}, 'enabled') ? Boolean(input.enabled) : Boolean(baseline.enabled),
    eq: normalizeEq(input?.eq, baseline.eq),
    compressor: normalizeCompressor(input?.compressor, baseline.compressor),
    limiter: normalizeLimiter(input?.limiter, baseline.limiter),
    loudnessTarget: normalizeLoudnessTarget(
      HAS_OWN(input || {}, 'loudnessTarget') ? input.loudnessTarget : baseline.loudnessTarget,
      baseline.loudnessTarget,
    ),
  }
}

export function mergeMasterChain(currentState, changes = {}) {
  const current = normalizeMasterChain(currentState)
  // 任何手动调参（eq / compressor / limiter）都让 presetId 失效退回"自定义"——
  // 除非 changes 里显式带了 presetId（来自 setMasterChainPreset 的整体应用）
  const explicitPresetId = HAS_OWN(changes, 'presetId')
  const hasParamChange = HAS_OWN(changes, 'eq') || HAS_OWN(changes, 'compressor') || HAS_OWN(changes, 'limiter')
  const nextPresetId = explicitPresetId
    ? normalizePresetId(changes.presetId, null)
    : (hasParamChange ? null : current.presetId)
  const next = {
    presetId: nextPresetId,
    enabled: HAS_OWN(changes, 'enabled') ? Boolean(changes.enabled) : current.enabled,
    eq: HAS_OWN(changes, 'eq')
      ? normalizeEq({ ...current.eq, ...(changes.eq || {}), bands: changes.eq?.bands ?? current.eq.bands }, current.eq)
      : current.eq,
    compressor: HAS_OWN(changes, 'compressor')
      ? normalizeCompressor({ ...current.compressor, ...(changes.compressor || {}) }, current.compressor)
      : current.compressor,
    limiter: HAS_OWN(changes, 'limiter')
      ? normalizeLimiter({ ...current.limiter, ...(changes.limiter || {}) }, current.limiter)
      : current.limiter,
    // loudnessTarget 是仪表参考线，不算"音频处理参数"——所以改它不会让 presetId 失效。
    // 用户在 broadcast 预设下把目标从 -14 改到 -16，预设名仍保留
    loudnessTarget: HAS_OWN(changes, 'loudnessTarget')
      ? normalizeLoudnessTarget(changes.loudnessTarget, current.loudnessTarget)
      : current.loudnessTarget,
  }
  return next
}

// 单独的 helper：合并某一段 EQ 的部分参数（band index 决定哪段）
export function mergeEqBand(currentState, bandIndex, patch = {}) {
  const current = normalizeMasterChain(currentState)
  const bands = current.eq.bands.map((band, index) => {
    if (index !== bandIndex) return band
    return normalizeEqBand({ ...band, ...patch }, band, EQ_BAND_RANGES[index])
  })
  // 改单段 EQ → 退回自定义
  return {
    ...current,
    presetId: null,
    eq: { ...current.eq, bands },
  }
}

export {
  EQ_BAND_RANGES,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  EQ_Q_MIN,
  EQ_Q_MAX,
  COMPRESSOR_RANGES,
  LIMITER_RANGES,
}

// ===== 预设：实用且不会出错的常见出品风格 =====
// 每个预设都让用户"打开就能用"，参数都在中庸偏温和的范围里——
// 极端预设（高 ratio 重压缩、激进 EQ 等）容易出怪声，留给进阶用户自调
function buildEqBands(gains) {
  return DEFAULT_EQ_BANDS.map((band, index) => ({ ...band, gain: Number.isFinite(gains[index]) ? gains[index] : 0 }))
}

export const MASTER_CHAIN_PRESETS = [
  {
    id: 'flat',
    name: 'Flat / 原声',
    description: '透明无染色，仅保留限幅器防爆音兜底。追求原始合成声的首选。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([0, 0, 0, 0]) },
      compressor: { ...DEFAULT_COMPRESSOR, enabled: false },
      limiter: { enabled: true, threshold: -0.3 },
    },
  },
  {
    id: 'vocal-bright',
    name: 'Vocal Bright / 人声明亮',
    description: '提亮中高频让人声更通透 + 温和压缩贴脸感。最适合 DiffSinger 合成人声。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([-0.5, 0, 2.5, 1.5]) },
      compressor: { enabled: true, threshold: -16, ratio: 2.5, attack: 0.020, release: 0.180, knee: 6, makeupGain: 1.5 },
      limiter: { enabled: true, threshold: -0.3 },
    },
  },
  {
    id: 'warm',
    name: 'Warm / 温暖',
    description: '低频暖意 + 高频柔化，模拟模拟磁带的"圆润"质感。适合 ballad、抒情。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([1.5, 0.5, 0, -1.5]) },
      compressor: { enabled: true, threshold: -18, ratio: 2, attack: 0.040, release: 0.250, knee: 8, makeupGain: 1 },
      limiter: { enabled: true, threshold: -0.3 },
    },
  },
  {
    id: 'punchy',
    name: 'Punchy / 饱满有冲击',
    description: '中频冲击力 + 较强压缩，适合流行 / 摇滚等需要"贴脸"和"前置感"的曲风。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([0.5, 2, 0, 1]) },
      compressor: { enabled: true, threshold: -22, ratio: 3, attack: 0.005, release: 0.120, knee: 4, makeupGain: 3 },
      limiter: { enabled: true, threshold: -0.3 },
    },
  },
  {
    id: 'broadcast',
    name: 'Broadcast / 直播流媒体',
    description: '响度对齐 Spotify / B 站标准（约 -14 LUFS），整体平衡偏前。发布前首选。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([-0.5, 0, 1, 1.5]) },
      compressor: { enabled: true, threshold: -22, ratio: 3, attack: 0.010, release: 0.150, knee: 6, makeupGain: 3 },
      limiter: { enabled: true, threshold: -1 },
    },
  },
  {
    id: 'electronic',
    name: 'Electronic / 电子',
    description: '低频厚 + 高频清亮，快攻击重压缩。适合 EDM / Future Bass 等电子曲风。',
    config: {
      enabled: true,
      eq: { enabled: true, bands: buildEqBands([2.5, -0.5, 0, 2]) },
      compressor: { enabled: true, threshold: -20, ratio: 4, attack: 0.003, release: 0.100, knee: 4, makeupGain: 2.5 },
      limiter: { enabled: true, threshold: -0.5 },
    },
  },
]

export function getMasterChainPreset(id) {
  return MASTER_CHAIN_PRESETS.find((preset) => preset.id === id) || null
}
