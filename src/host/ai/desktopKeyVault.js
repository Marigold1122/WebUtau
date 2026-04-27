// 桌面版（Tauri）的 LLM API key 存储——走 OS Keychain（Rust 端 keyring crate）。
// 在浏览器 / 网页环境下，所有函数返回 { ok: false, reason: 'not-tauri' }，调用方据此降级到
// localStorage 加密路径（lyricApiKeyStore 的 web fallback）。
//
// IPC 命令对应 src-tauri/src/api_key_vault.rs：
//   - save_api_key_config(config: { apiKey, baseUrl, model })
//   - get_api_key_config() -> { apiKey, baseUrl, model }
//   - clear_api_key_config()

function isTauri() {
  if (typeof window === 'undefined') return false
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

async function tauriInvoke(cmd, args) {
  // Tauri 2 用 __TAURI_INTERNALS__；老的 1.x 用 __TAURI__.invoke——都兜一下
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null
  if (internals && typeof internals.invoke === 'function') {
    return internals.invoke(cmd, args)
  }
  const legacy = typeof window !== 'undefined' ? window.__TAURI__ : null
  if (legacy && typeof legacy.invoke === 'function') {
    return legacy.invoke(cmd, args)
  }
  throw new Error('Tauri invoke not available')
}

export function isDesktopVaultAvailable() {
  return isTauri()
}

// 三个 API 都是 async，签名跟 lyricApiKeyStore 的 web 版尽量对齐——方便上层无感切换
export async function vaultGetConfig() {
  if (!isTauri()) return { ok: false, reason: 'not-tauri' }
  try {
    const cfg = await tauriInvoke('get_api_key_config')
    return {
      ok: true,
      apiKey: typeof cfg?.apiKey === 'string' ? cfg.apiKey : '',
      baseUrl: typeof cfg?.baseUrl === 'string' ? cfg.baseUrl : '',
      model: typeof cfg?.model === 'string' ? cfg.model : '',
    }
  } catch (error) {
    return { ok: false, reason: 'invoke-error', error: error?.message || String(error) }
  }
}

export async function vaultSaveConfig({ apiKey = '', baseUrl = '', model = '' } = {}) {
  if (!isTauri()) return { ok: false, reason: 'not-tauri' }
  try {
    await tauriInvoke('save_api_key_config', {
      // Tauri 自动把 camelCase JS 字段映射到 Rust struct（serde rename 配合）
      config: {
        apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
        baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
        model: typeof model === 'string' ? model.trim() : '',
      },
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'invoke-error', error: error?.message || String(error) }
  }
}

export async function vaultClearConfig() {
  if (!isTauri()) return { ok: false, reason: 'not-tauri' }
  try {
    await tauriInvoke('clear_api_key_config')
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'invoke-error', error: error?.message || String(error) }
  }
}
