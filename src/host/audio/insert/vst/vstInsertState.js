// VST 插件 insert 在 track 上的状态形态。
// 设计要点：
//   - 与现有"内置 insert（amp-sim3 / nam-bass）"是两条独立通路，不挤进 trackInsertCatalog
//   - 字段对工程文件持久化友好：路径 + uid + chunk 必须能跨机器、跨重装解析回来
//   - chunkB64 是插件自身导出的二进制状态（VST3 IComponent::getState），仅作不透明字节使用
//   - instanceId 是工程内稳定 ID，加载工程时与 host 实例的 handle 解耦——
//     真正的 host handle 只在运行时存在；instanceId 用于 UI 列表稳定性、跨保存重启不变
//
// 任意时刻 track 至多一个 VST insert。多 VST 串联留到后续阶段，先把单插件链路打通。

export const VST_INSERT_FORMATS = Object.freeze({
  VST3: 'vst3',
})

const SUPPORTED_FORMATS = new Set(Object.values(VST_INSERT_FORMATS))

function safeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function safeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  return fallback
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback
}

function safeBase64Chunk(value) {
  if (typeof value !== 'string') return ''
  // 简单格式校验：base64 字符集 + 长度 4 的倍数。失败一律视作空 chunk
  // 不做完整解码——chunk 可能很大，避免一次保存就触发解码再编码
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length % 4 !== 0) return ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return ''
  return trimmed
}

function normalizeFormat(format) {
  const safe = safeString(format).toLowerCase()
  return SUPPORTED_FORMATS.has(safe) ? safe : VST_INSERT_FORMATS.VST3
}

// 生成工程内稳定的 instanceId。crypto.randomUUID 在所有现代浏览器 + Tauri webview 都有；
// 没有时退化到时间戳 + 随机数（hex），冲突概率足够低
function generateInstanceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `vst-${crypto.randomUUID()}`
  }
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0xffffffff).toString(36)
  return `vst-${t}-${r}`
}

// 给定一个 raw object（来自工程文件、UI 表单或 host 返回的元数据），归一成稳定形态。
// 关键不变量：
//   - 没有 pluginPath → 视为无效，返回 null（持久化时被 prune）
//   - instanceId 缺失 → 现场补一个；同一工程内多次 normalize 同一对象会保留它
//   - bypass 默认 false；displayName 缺失时用 path 的 basename 兜底
export function normalizeVstInsertState(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pluginPath = safeString(raw.pluginPath)
  if (!pluginPath) return null

  const displayName = safeString(raw.displayName) || derivePluginNameFromPath(pluginPath)
  return Object.freeze({
    instanceId: safeString(raw.instanceId) || generateInstanceId(),
    format: normalizeFormat(raw.format),
    pluginPath,
    pluginUid: safeString(raw.pluginUid),
    displayName,
    bypass: safeBoolean(raw.bypass),
    chunkB64: safeBase64Chunk(raw.chunkB64),
    programIndex: Math.max(0, Math.floor(safeNumber(raw.programIndex, 0))),
  })
}

function derivePluginNameFromPath(pluginPath) {
  const segments = pluginPath.split(/[\\/]/)
  const basename = segments[segments.length - 1] || pluginPath
  return basename.replace(/\.(vst3|component|dll)$/i, '') || pluginPath
}

// 用户改了一个字段（bypass 切换、chunk 更新、改名等）：合并并重归一化
export function mergeVstInsertState(current, patch = {}) {
  const base = normalizeVstInsertState(current) || {}
  const merged = { ...base, ...patch }
  return normalizeVstInsertState(merged)
}

// 比较两个状态是否在"音频通路相关"的字段上等价。
// chunkB64 与 programIndex 影响输出，bypass 也影响——所有这些都参与比较。
// instanceId 不参与（同一逻辑插件不同 ID 视为相同）；displayName 不参与（仅展示）
export function isSameVstAudioState(left, right) {
  const a = normalizeVstInsertState(left)
  const b = normalizeVstInsertState(right)
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.format === b.format
    && a.pluginPath === b.pluginPath
    && a.pluginUid === b.pluginUid
    && a.bypass === b.bypass
    && a.chunkB64 === b.chunkB64
    && a.programIndex === b.programIndex
  )
}

// 序列化到工程文件的纯对象（去掉 frozen）。chunkB64 体积可能较大，调用方决定是否打包
export function serializeVstInsertState(state) {
  const normalized = normalizeVstInsertState(state)
  if (!normalized) return null
  return {
    instanceId: normalized.instanceId,
    format: normalized.format,
    pluginPath: normalized.pluginPath,
    pluginUid: normalized.pluginUid,
    displayName: normalized.displayName,
    bypass: normalized.bypass,
    chunkB64: normalized.chunkB64,
    programIndex: normalized.programIndex,
  }
}

// 创建一个全新的 VST insert 状态（用户刚通过文件选择器选完插件、host 还没回元数据时用）
export function createPendingVstInsertState({ pluginPath, displayName = '', format = VST_INSERT_FORMATS.VST3 } = {}) {
  return normalizeVstInsertState({
    instanceId: generateInstanceId(),
    pluginPath,
    displayName,
    format,
  })
}
