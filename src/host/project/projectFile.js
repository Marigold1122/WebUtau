// .webutau 工程文件的 schema、序列化和反序列化。
// 设计原则：
//   1. 纯 JSON，人类可读，便于调试 / 升级 / 版本控制
//   2. 顶层有 format + version，将来 schema 改动时能识别并迁移
//   3. 只保存"内容"，剔除一切运行时引用（任务 jobId、渲染缓存、bridge 句柄等），
//      防止旧文件里挂着已失效的 server-side ID 反而把状态搞乱
//   4. assets 内嵌用户导入的音频原始字节（base64），保证工程**自包含**——
//      在另一台电脑 / 另一份浏览器 profile 里打开，音频也能正常播

export const WEBUTAU_PROJECT_FORMAT = 'webutau-project'
export const WEBUTAU_PROJECT_VERSION = 1
export const WEBUTAU_PROJECT_EXTENSION = '.webutau'
export const WEBUTAU_PROJECT_MIME_TYPE = 'application/json'

// 凡是依赖运行时上下文（合成任务、渲染状态、bridge 句柄）的字段，加载时都得重置，
// 不能让旧文件里的过期引用污染新会话。
function pruneTrack(track) {
  if (!track) return null
  const cloned = structuredClone(track)
  delete cloned.jobRef
  delete cloned.prepState
  delete cloned.renderState
  delete cloned.vocalManifest
  delete cloned.voiceSnapshot
  delete cloned.pendingVoiceEditState
  delete cloned.revision
  if (cloned.voiceConversionState) {
    cloned.voiceConversionState = pruneVoiceConversionState(cloned.voiceConversionState)
  }
  return cloned
}

function pruneVoiceConversionState(state) {
  if (!state || typeof state !== 'object') return state
  const cloned = structuredClone(state)
  // 用户填的转换参数（reference 文件名、扩散步数等）保留；
  // 但 server 侧的 jobId / assetUrl / 临时上传记录在新会话里都失效了，必须清掉
  delete cloned.jobId
  delete cloned.assetUrl
  delete cloned.draftAsset
  delete cloned.activeJob
  delete cloned.lastError
  return cloned
}

function pruneProject(project) {
  if (!project) return null
  return {
    fileName: typeof project.fileName === 'string' ? project.fileName : '',
    ppq: Number.isFinite(project.ppq) ? project.ppq : null,
    tempoData: project.tempoData ? structuredClone(project.tempoData) : null,
    mixState: project.mixState ? structuredClone(project.mixState) : null,
    selectedTrackId: project.selectedTrackId ?? null,
    // editorTrackId 是"当前打开了哪条轨道的钢琴卷帘"——纯 UI 状态，不持久化
    editorTrackId: null,
    tracks: Array.isArray(project.tracks) ? project.tracks.map(pruneTrack).filter(Boolean) : [],
  }
}

// 大 ArrayBuffer 转 base64：用 0x8000 字节为单位分块拼接，
// 否则一次性 fromCharCode.apply 大数组会爆 JS 调用栈
function arrayBufferToBase64(buffer) {
  if (!buffer || !buffer.byteLength) return ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64) {
  if (typeof base64 !== 'string' || !base64) return new ArrayBuffer(0)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// 仅打包当前工程实际引用到的音频资产——即 contentType === 'audio' 的轨道
// 通过 audioClip.assetId 引到的那些。其它"已注册但没被任何轨道引用"的孤儿资产不打包，
// 防止文件里塞用户已经删除的旧素材
function collectReferencedAssetIds(project) {
  const ids = new Set()
  for (const track of project?.tracks || []) {
    const id = track?.audioClip?.assetId
    if (typeof id === 'string' && id) ids.add(id)
  }
  return ids
}

function buildAssetsPayload(project, audioAssets) {
  if (!Array.isArray(audioAssets) || audioAssets.length === 0) return {}
  const referenced = collectReferencedAssetIds(project)
  const out = {}
  for (const asset of audioAssets) {
    if (!asset?.assetId || !referenced.has(asset.assetId)) continue
    if (!(asset.rawBytes instanceof ArrayBuffer) || asset.rawBytes.byteLength === 0) continue
    out[asset.assetId] = {
      fileName: asset.fileName || '',
      mimeType: asset.mimeType || '',
      duration: Number.isFinite(asset.duration) ? asset.duration : 0,
      waveformPeaks: Array.isArray(asset.waveformPeaks) ? asset.waveformPeaks : [],
      dataBase64: arrayBufferToBase64(asset.rawBytes),
    }
  }
  return out
}

function parseAssetsPayload(rawAssets) {
  if (!rawAssets || typeof rawAssets !== 'object') return {}
  const out = {}
  for (const [assetId, raw] of Object.entries(rawAssets)) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.dataBase64 !== 'string' || !raw.dataBase64) continue
    out[assetId] = {
      assetId,
      fileName: typeof raw.fileName === 'string' ? raw.fileName : '',
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
      duration: Number.isFinite(raw.duration) ? raw.duration : 0,
      waveformPeaks: Array.isArray(raw.waveformPeaks) ? raw.waveformPeaks : [],
      rawBytes: base64ToArrayBuffer(raw.dataBase64),
    }
  }
  return out
}

export function serializeProject({ project, projectName = null, audioAssets = [] } = {}) {
  if (!project) throw new Error('serializeProject: 缺少 project')
  const payload = {
    format: WEBUTAU_PROJECT_FORMAT,
    version: WEBUTAU_PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    projectName: typeof projectName === 'string' ? projectName : null,
    project: pruneProject(project),
    assets: buildAssetsPayload(project, audioAssets),
  }
  return JSON.stringify(payload, null, 2)
}

export function deserializeProject(jsonString) {
  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (error) {
    throw new Error('工程文件格式损坏：不是有效的 JSON', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('工程文件格式异常：根节点不是对象')
  }
  if (parsed.format !== WEBUTAU_PROJECT_FORMAT) {
    throw new Error('该文件不是 WebUtau 工程文件')
  }
  if (typeof parsed.version !== 'number' || parsed.version < 1) {
    throw new Error('工程文件版本无效')
  }
  if (parsed.version > WEBUTAU_PROJECT_VERSION) {
    throw new Error(
      `不支持的工程文件版本 v${parsed.version}（本程序最高支持 v${WEBUTAU_PROJECT_VERSION}），请升级 WebUtau`,
    )
  }
  if (!parsed.project || typeof parsed.project !== 'object') {
    throw new Error('工程文件不完整：缺少 project 数据')
  }
  return {
    project: parsed.project,
    projectName: typeof parsed.projectName === 'string' ? parsed.projectName : null,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    sourceVersion: parsed.version,
    audioAssets: parseAssetsPayload(parsed.assets),
  }
}

// 从工程文件名/项目内 fileName/导入文件名等里挑出最合适的"展示名"
export function resolveDisplayProjectName({ fileHandleName = null, projectName = null, project = null } = {}) {
  if (typeof fileHandleName === 'string' && fileHandleName.trim()) {
    return stripExtension(fileHandleName)
  }
  if (typeof projectName === 'string' && projectName.trim()) {
    return projectName
  }
  if (project && typeof project.fileName === 'string' && project.fileName.trim()) {
    return stripExtension(project.fileName)
  }
  return null
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '').trim() || name
}
