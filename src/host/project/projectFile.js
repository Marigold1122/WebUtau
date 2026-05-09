// .webutau 工程文件的 schema、序列化和反序列化。
// 设计原则：
//   1. 纯 JSON，人类可读，便于调试 / 升级 / 版本控制
//   2. 顶层有 format + version，将来 schema 改动时能识别并迁移
//   3. 只保存"内容"，剔除一切运行时引用（任务 jobId、渲染缓存、bridge 句柄等），
//      防止旧文件里挂着已失效的 server-side ID 反而把状态搞乱
//   4. assets 内嵌用户导入的音频原始字节（base64），保证工程**自包含**——
//      在另一台电脑 / 另一份浏览器 profile 里打开，音频也能正常播
//
// v1 → v2（2026-04-30）：持久化音高预测结果（prepState + voiceSnapshot.pitchData）。
// 之前每次加载工程都要重新走一遍音高预测，体验差。现在保留预测，跨会话直接进编辑态。
// 仍然保留"运行时引用清零"原则——voiceSnapshot.jobId / renderManifest 这些 server
// 侧失效的部分照常剥掉，只持久化 pitchData 等真正可复用的"内容"

export const WEBUTAU_PROJECT_FORMAT = 'webutau-project'
export const WEBUTAU_PROJECT_VERSION = 2
export const WEBUTAU_PROJECT_EXTENSION = '.webutau'
export const WEBUTAU_PROJECT_MIME_TYPE = 'application/json'

// voiceSnapshot 持久化前的清洗：保留 pitchData / phrases / encodedMidi 等"基于 MIDI
// 计算出来的内容"，剔除 server-side jobId 和包含 jobId 的 renderManifest（跨会话失效）。
// 返回 null 表示"没有可保留的内容"——调用方据此决定是否同步把 prepState 拉回 idle
function pruneVoiceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const cloned = structuredClone(snapshot)
  delete cloned.jobId        // server 侧任务 ID，下次会话失效
  delete cloned.renderManifest // 与 track.vocalManifest 重叠 + 含 jobId 引用
  // pitchData 是这一层最珍贵的——预测出来的 pitchCurve 数组。没有它整个 snapshot 没意义
  if (!cloned.pitchData?.pitchCurve?.length) return null
  return cloned
}

// 凡是依赖运行时上下文（合成任务、渲染状态、bridge 句柄）的字段，加载时都得重置，
// 不能让旧文件里的过期引用污染新会话。
function pruneTrack(track) {
  if (!track) return null
  const cloned = structuredClone(track)
  delete cloned.jobRef
  delete cloned.renderState
  delete cloned.vocalManifest
  delete cloned.pendingVoiceEditState
  delete cloned.revision
  // 注意：track.officialLyrics 是用户在 Quick Lyric 的"📖 官方歌词"小窗里粘贴的
  // 真实歌词（按 \n 分隔的 string[]），用作 AI 写词的"行结构"权威来源——
  // 后端 phrase 切分（按音符间隔）跟真实歌词行对不上，必须靠前端这份数据告诉 AI
  // "该写几行、每行几字"。属于用户数据，跨会话有用，必须持久化。structuredClone
  // 默认就保留这字段；校验合法性放在加载侧（normalizeLoadedTracks）
  // prepState 与 voiceSnapshot 是一对：
  //   prepState 'ready' 才持久化 voiceSnapshot.pitchData——保证 pitchData 跟当前 notes 同步
  //   （编辑笔记会把 prepState 重置为 idle；这里以 prepState 状态为权威信号）
  //   其它情况 voiceSnapshot 一律丢弃，避免序列化过时 pitchData
  if (cloned.prepState?.status === 'ready') {
    cloned.voiceSnapshot = pruneVoiceSnapshot(cloned.voiceSnapshot)
    // 二次一致性校验：prepState 说 ready 但 pitchData 实际缺失（runtime 异常 / 数据丢了）
    // → 拉回 idle，让下次加载触发重测，比悬空状态安全
    if (!cloned.voiceSnapshot) {
      cloned.prepState = { status: 'idle', progress: 0, error: null }
    }
  } else {
    // prepState 非 ready：voiceSnapshot 不带跨会话价值，不存。
    // 同时把 'queued' / 'predicting' 这类"进行中"状态拉回 idle——它们依赖
    // 当前会话的 server 任务，下次加载没有任务在跑，悬空会让 UI 显示永不结束的进度
    cloned.prepState = { status: 'idle', progress: 0, error: null }
    cloned.voiceSnapshot = null
  }
  if (cloned.voiceConversionState) {
    cloned.voiceConversionState = pruneVoiceConversionState(cloned.voiceConversionState)
  }
  return cloned
}

function pruneVoiceConversionState(state) {
  if (!state || typeof state !== 'object') return state
  const cloned = structuredClone(state)
  // 用户填的转换参数（params / referenceAudioName 等）保留作为"上次配置"提示；
  // 但 server 侧的 jobId / assetUrl / 临时上传记录在新会话里都失效了，必须清掉
  delete cloned.jobId
  delete cloned.assetUrl
  delete cloned.draftAsset
  delete cloned.activeJob
  delete cloned.lastError
  // sourceJobId 与 resultAssetKey / resultAssetUrl 都是 server 端任务产物的引用，
  // 跨会话失效。VocalPlaybackResolver 依赖 resultAssetUrl 播放转换后的音频，
  // 留着会指向失效 URL → 显式置 null，并把状态降级到"未转换"，要求用户重新跑
  cloned.sourceJobId = null
  cloned.resultAssetKey = null
  cloned.resultAssetUrl = null
  cloned.status = 'idle'
  cloned.appliedVariant = 'original'
  cloned.stale = false
  cloned.error = null
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
  // 反序列化后再做一次"防御性归一化"——保证读到 prepState='ready' 时一定有 pitchData，
  // 不让损坏 / 手改过的 JSON 让运行时陷入悬空状态。同时给 v1（无 prepState）兜底
  normalizeLoadedTracks(parsed.project)
  return {
    project: parsed.project,
    projectName: typeof parsed.projectName === 'string' ? parsed.projectName : null,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    sourceVersion: parsed.version,
    audioAssets: parseAssetsPayload(parsed.assets),
  }
}

// 加载时归一化每条 track 的 prep / voiceSnapshot 状态——
// 容忍 v1 老文件（这两字段都没）+ v2 自身可能被手改 / 部分腐烂的边界
function normalizeLoadedTracks(project) {
  if (!project || !Array.isArray(project.tracks)) return
  for (const track of project.tracks) {
    if (!track || typeof track !== 'object') continue
    const prep = track.prepState
    const validPrep = prep && typeof prep === 'object' && typeof prep.status === 'string'
    const hasPitchCurve = Boolean(
      track.voiceSnapshot?.pitchData?.pitchCurve?.length,
    )
    // v1 文件 / 字段缺失 → 给 idle 默认值
    if (!validPrep) {
      track.prepState = { status: 'idle', progress: 0, error: null }
      track.voiceSnapshot = null
      continue
    }
    // 一致性：prepState 'ready' 必有 pitchCurve，否则降级
    if (prep.status === 'ready' && !hasPitchCurve) {
      track.prepState = { status: 'idle', progress: 0, error: null }
      track.voiceSnapshot = null
      continue
    }
    // 反过来：prepState 非 ready 但 voiceSnapshot 有 pitchCurve（异常，理应被 prune 掉）
    // → 丢弃 voiceSnapshot，让重测覆盖
    if (prep.status !== 'ready' && hasPitchCurve) {
      track.voiceSnapshot = null
    }
    // 兜底：保存侧已经把非 ready 状态归一到 idle，但手改过的 JSON / v1 老文件
    // 可能仍带着 'queued' / 'predicting' / 'error' 这类需要运行时上下文的状态
    // → 一律拉回 idle，避免 UI 显示永不结束的进度
    if (prep.status !== 'ready' && prep.status !== 'idle') {
      track.prepState = { status: 'idle', progress: 0, error: null }
    }
    // officialLyrics：用户在 Quick Lyric 的"📖 官方歌词"小窗里粘贴的真实歌词
    // （string[]，每行一句）。形状不对就丢弃为 null——下次用户打开重填
    if (track.officialLyrics !== undefined && track.officialLyrics !== null) {
      if (!Array.isArray(track.officialLyrics)
          || !track.officialLyrics.every((s) => typeof s === 'string')) {
        track.officialLyrics = null
      }
    }
    // 旧字段（v2 早期版本可能写过）→ 直接清掉，避免占空间
    if ('aiLyricLines' in track) delete track.aiLyricLines
    if ('aiLyricPhrases' in track) delete track.aiLyricPhrases
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
