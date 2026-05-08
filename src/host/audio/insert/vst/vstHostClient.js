// Tauri invoke 命令的薄包装。所有命令名集中在这里——
// 真实命令实现在 src-tauri/src/vst_host.rs。
//
// 设计：
//   - web 模式（非 Tauri 环境）下，所有命令返回"未启用"错误而非抛栈
//   - 与项目其他模块（desktopKeyVault / updateService）一样直接读 window.__TAURI_INTERNALS__，
//     避免引入 @tauri-apps/api 这个 npm 依赖

function getTauriInternals() {
  if (typeof window === 'undefined') return null
  return window.__TAURI_INTERNALS__ || null
}

function getTauriLegacy() {
  if (typeof window === 'undefined') return null
  return window.__TAURI__ || null
}

export function isVstHostAvailable() {
  const internals = getTauriInternals()
  if (internals && typeof internals.invoke === 'function') return true
  const legacy = getTauriLegacy()
  return Boolean(legacy && typeof legacy.invoke === 'function')
}

async function invokeCommand(name, payload = {}) {
  const internals = getTauriInternals()
  if (internals && typeof internals.invoke === 'function') {
    return internals.invoke(name, payload)
  }
  const legacy = getTauriLegacy()
  if (legacy && typeof legacy.invoke === 'function') {
    return legacy.invoke(name, payload)
  }
  const error = new Error('vst_host_unavailable')
  error.code = 'vst_host_unavailable'
  throw error
}

// 列出本机已扫描到的 VST3 插件元数据（不会重新扫描；扫描需用 vstScanDirs）
export function vstListPlugins() {
  return invokeCommand('vst_list_plugins')
}

// 扫描指定目录（绝对路径数组）。rescan=true 时强制重扫缓存
export function vstScanDirs({ paths, rescan = false } = {}) {
  return invokeCommand('vst_scan_dirs', { paths: Array.isArray(paths) ? paths : [], rescan })
}

// 加载插件实例。返回 { handle, channels: { in, out }, parameters: [...], hasEditor, latencySamples, displayName, pluginUid }
export function vstLoad({ pluginPath, sampleRate, blockSize }) {
  return invokeCommand('vst_load', {
    pluginPath: String(pluginPath || ''),
    sampleRate: Math.max(8000, Math.floor(Number(sampleRate) || 44100)),
    blockSize: Math.max(16, Math.floor(Number(blockSize) || 256)),
  })
}

export function vstUnload({ handle }) {
  return invokeCommand('vst_unload', { handle: String(handle || '') })
}

export function vstShowEditor({ handle, x = null, y = null }) {
  return invokeCommand('vst_show_editor', {
    handle: String(handle || ''),
    x: Number.isFinite(x) ? Number(x) : null,
    y: Number.isFinite(y) ? Number(y) : null,
  })
}

export function vstHideEditor({ handle }) {
  return invokeCommand('vst_hide_editor', { handle: String(handle || '') })
}

export function vstSetParam({ handle, index, value }) {
  return invokeCommand('vst_set_param', {
    handle: String(handle || ''),
    index: Math.max(0, Math.floor(Number(index) || 0)),
    value: Number(value),
  })
}

export function vstGetParam({ handle, index }) {
  return invokeCommand('vst_get_param', {
    handle: String(handle || ''),
    index: Math.max(0, Math.floor(Number(index) || 0)),
  })
}

export function vstGetState({ handle }) {
  return invokeCommand('vst_get_state', { handle: String(handle || '') })
}

export function vstSetState({ handle, chunkB64 }) {
  return invokeCommand('vst_set_state', {
    handle: String(handle || ''),
    chunkB64: typeof chunkB64 === 'string' ? chunkB64 : '',
  })
}

// 离线处理：把整段 PCM（以 base64 ArrayBuffer 形式上传）经插件处理后返回。
// 适合导出链路使用——避免实时音频 IPC 抖动
export function vstProcessOffline({ handle, sampleRate, blockSize, pcmBase64, channelCount }) {
  return invokeCommand('vst_process_offline', {
    handle: String(handle || ''),
    sampleRate: Math.max(8000, Math.floor(Number(sampleRate) || 44100)),
    blockSize: Math.max(16, Math.floor(Number(blockSize) || 256)),
    channelCount: Math.max(1, Math.min(2, Math.floor(Number(channelCount) || 2))),
    pcmBase64: typeof pcmBase64 === 'string' ? pcmBase64 : '',
  })
}

// 取得 host 的实时数据面 WebSocket 端点（host 启动时分配端口写回 Rust）
export async function vstGetWsEndpoint() {
  return invokeCommand('vst_get_ws_endpoint')
}

// 订阅 host 事件（参数变化、编辑器关闭、实例崩溃）
// 返回退订函数；Tauri 的 event 接口在 webview 里通过 __TAURI_INTERNALS__ 暴露
export async function subscribeVstEvents(handler) {
  const internals = getTauriInternals()
  if (!internals?.metadata?.plugins) {
    // legacy 路径不暴露 listen，直接退化为空订阅
    return () => {}
  }
  // Tauri v2：通过 ipc-bridge 注册一个 listener 的标准做法
  // 由于不引入 @tauri-apps/api，这里调用底层 invoke('plugin:event|listen', ...) 的封装
  // 简化实现：交给上层在桌面侧才订阅；web 静默
  // 这里给一个最小可用的订阅：__TAURI_INTERNALS__.event.listen 在 v2 里直接挂在 internals 上
  const eventApi = internals.event || internals
  if (typeof eventApi.listen !== 'function') return () => {}
  try {
    const unlisten = await eventApi.listen('vst://event', (event) => {
      try { handler?.(event?.payload || null) }
      catch (_e) {}
    })
    return typeof unlisten === 'function' ? unlisten : () => {}
  } catch (_e) {
    return () => {}
  }
}

// 给文件选择器用：调出 Tauri 原生 dialog，返回选中的 .vst3 路径或 null。
// dialog 插件的 IPC 命令名形如 'plugin:dialog|open'
export async function pickVst3PluginFile() {
  const internals = getTauriInternals()
  if (!internals || typeof internals.invoke !== 'function') {
    const error = new Error('vst_host_unavailable')
    error.code = 'vst_host_unavailable'
    throw error
  }
  try {
    const result = await internals.invoke('plugin:dialog|open', {
      options: {
        multiple: false,
        directory: false,
        title: 'Select VST3 plugin',
        filters: [{ name: 'VST3', extensions: ['vst3'] }],
      },
    })
    if (typeof result === 'string' && result) return result
    if (Array.isArray(result) && result.length > 0) return String(result[0])
    return null
  } catch (_error) {
    // dialog 插件未启用——退到 Rust 自己实现的命令
    return invokeCommand('vst_pick_plugin_file')
  }
}
