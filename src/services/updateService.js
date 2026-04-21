// 「检查更新」服务：调用 Rust 侧 check_for_updates 命令（见 src-tauri/src/updater.rs）。
// - Tauri 桌面端：走 invoke('check_for_updates')，从 R2 / GitHub latest.json 比对版本号
// - 浏览器端：没有自动更新概念，直接返回 unavailable
//
// 统一返回形状：
//   { available, currentVersion, latestVersion, updateAvailable, releaseUrl,
//     releaseNotes, downloadUrl, publishedAt, error }

function isTauriEnv() {
  if (typeof window === 'undefined') return false
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

async function tauriInvoke(cmd, args) {
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null
  if (internals && typeof internals.invoke === 'function') {
    return internals.invoke(cmd, args ?? {})
  }
  const legacyTauri = typeof window !== 'undefined' ? window.__TAURI__ : null
  if (legacyTauri?.core?.invoke) {
    return legacyTauri.core.invoke(cmd, args ?? {})
  }
  throw new Error('当前环境不支持 Tauri invoke')
}

const WEB_CURRENT_VERSION = 'web'

function webResult(extra = {}) {
  return {
    available: false,
    currentVersion: WEB_CURRENT_VERSION,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseNotes: null,
    downloadUrl: null,
    publishedAt: null,
    error: null,
    ...extra,
  }
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return webResult({
      available: true,
      currentVersion: '',
      error: '未收到有效响应',
    })
  }
  return {
    available: true,
    currentVersion: typeof raw.current_version === 'string' ? raw.current_version : '',
    latestVersion: typeof raw.latest_version === 'string' ? raw.latest_version : null,
    updateAvailable: raw.update_available === true,
    releaseUrl: typeof raw.release_url === 'string' ? raw.release_url : null,
    releaseNotes: typeof raw.release_notes === 'string' ? raw.release_notes : null,
    downloadUrl: typeof raw.download_url === 'string' ? raw.download_url : null,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    error: typeof raw.check_error === 'string' && raw.check_error ? raw.check_error : null,
  }
}

export function isUpdateCheckSupported() {
  return isTauriEnv()
}

export async function checkForUpdates() {
  if (!isTauriEnv()) {
    return webResult({ error: '网页版不支持应用更新检查' })
  }
  try {
    const raw = await tauriInvoke('check_for_updates')
    return normalizeResult(raw)
  } catch (err) {
    return {
      available: true,
      currentVersion: '',
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      downloadUrl: null,
      publishedAt: null,
      error: err?.message || String(err),
    }
  }
}
