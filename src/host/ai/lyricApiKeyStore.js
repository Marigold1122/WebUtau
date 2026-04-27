// 用户自带 LLM API key 的本地存储——双层路由：
//
// 桌面版（Tauri）：走 OS Keychain（Rust 端 keyring crate）。Key 存在 OS 进程外的
//   隔离存储里，浏览器 JS / 浏览器扩展 / 同源 XSS 都碰不到，安全等级最高
// 网页版（浏览器）：走 AES-GCM 加密的 localStorage。安全等级"行业天花板"，
//   但不防本机木马 / 同源 XSS / 流氓浏览器扩展
//
// 上层调用方无需关心走哪条路——通过这一层统一 API 就行
//
// 旧版本 plaintext 数据迁移：开机时检测旧格式 → 自动加密迁移一次（用户无感）。
// API：
//   - getUserApiConfig()  Promise<{apiKey, baseUrl, model}>
//   - hasUserApiKey()     Promise<boolean>
//   - setUserApiConfig()  Promise<void>
//   - clearUserApiConfig() void
//   - getStorageKindLabel() 'desktop-keychain' | 'browser-encrypted-localstorage'

import {
  isDesktopVaultAvailable,
  vaultClearConfig,
  vaultGetConfig,
  vaultSaveConfig,
} from './desktopKeyVault.js'
import { decryptString, encryptString, isCryptoSupported } from './lyricKeyCipher.js'

const STORAGE_KEY = 'webutau:ai-lyric-config'
// 旧版本明文 storage 的字段名（用来兼容一次升级，迁移完就抛弃）
const LEGACY_PLAINTEXT_FIELDS = ['apiKey', 'baseUrl', 'model']

function safeReadRaw() {
  try {
    const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch (_e) { return null }
}

function safeWriteRaw(value) {
  try { globalThis.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(value || {})) }
  catch (_e) {}
}

// 单例缓存：同一会话多次读不要每次都 PBKDF2 + decrypt 一遍——又慢又烦
let cachedConfig = null
let cachedConfigPromise = null

async function readDecrypted() {
  const stored = safeReadRaw()
  if (!stored) return { apiKey: '', baseUrl: '', model: '' }

  // 兼容：旧版本写入的是 plaintext 三字段直接挂在根上
  const isLegacyPlaintext = LEGACY_PLAINTEXT_FIELDS.some((k) => typeof stored[k] === 'string')
    && !stored.encrypted
  if (isLegacyPlaintext) {
    const legacy = {
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
      model: typeof stored.model === 'string' ? stored.model : '',
    }
    // 把旧明文升级成加密格式——一次性
    if (legacy.apiKey && isCryptoSupported()) {
      try {
        await writeEncrypted(legacy)
      } catch (_e) { /* 加密失败也不影响读取，下次再试 */ }
    }
    return legacy
  }

  // 新版加密格式：{ encrypted: true, apiKey: {iv,ct}, baseUrl: '...', model: '...' }
  // baseUrl 和 model 不加密——它们不是敏感信息，方便直接看
  const encryptedKey = stored?.apiKey
  let apiKey = ''
  if (encryptedKey && typeof encryptedKey === 'object') {
    try { apiKey = await decryptString(encryptedKey) }
    catch (_e) { apiKey = '' }
  }
  return {
    apiKey,
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
    model: typeof stored.model === 'string' ? stored.model : '',
  }
}

async function writeEncrypted({ apiKey = '', baseUrl = '', model = '' } = {}) {
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const payload = {
    encrypted: true,
    apiKey: trimmedKey ? await encryptString(trimmedKey) : null,
    baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : '',
    model: typeof model === 'string' ? model.trim() : '',
  }
  safeWriteRaw(payload)
  return {
    apiKey: trimmedKey,
    baseUrl: payload.baseUrl,
    model: payload.model,
  }
}

export async function getUserApiConfig() {
  if (cachedConfig) return cachedConfig
  if (cachedConfigPromise) return cachedConfigPromise
  cachedConfigPromise = (async () => {
    // 桌面版优先走 OS keychain；vault 失败 / 非 Tauri 才落到 localStorage 加密
    if (isDesktopVaultAvailable()) {
      const v = await vaultGetConfig()
      if (v.ok) {
        const cfg = { apiKey: v.apiKey, baseUrl: v.baseUrl, model: v.model }
        cachedConfig = cfg
        cachedConfigPromise = null
        return cfg
      }
      // vault 异常（极少数情况）—— 不落到 web fallback，避免桌面版 key 被偷偷
      // 写到 localStorage。返回空让用户重填
      cachedConfig = { apiKey: '', baseUrl: '', model: '' }
      cachedConfigPromise = null
      return cachedConfig
    }
    const cfg = await readDecrypted()
    cachedConfig = cfg
    cachedConfigPromise = null
    return cfg
  })()
  return cachedConfigPromise
}

export async function hasUserApiKey() {
  const cfg = await getUserApiConfig()
  return Boolean(cfg.apiKey && cfg.apiKey.trim())
}

export async function setUserApiConfig(config) {
  // 桌面版直接走 keychain；vault 写失败抛异常让上层提示
  if (isDesktopVaultAvailable()) {
    const v = await vaultSaveConfig(config)
    if (!v.ok) {
      throw new Error(v.error || 'OS Keychain 写入失败')
    }
    const result = {
      apiKey: typeof config?.apiKey === 'string' ? config.apiKey.trim() : '',
      baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '',
      model: typeof config?.model === 'string' ? config.model.trim() : '',
    }
    cachedConfig = result
    return result
  }
  const result = await writeEncrypted(config)
  cachedConfig = result
  return result
}

export function clearUserApiConfig() {
  // 桌面版：异步清 keychain（不等结果，允许失败），同时清 localStorage 兜底
  // （万一以前在网页版填过迁移到桌面版，老的 localStorage 也得跟着清）
  if (isDesktopVaultAvailable()) {
    vaultClearConfig().catch(() => {})
  }
  try { globalThis.localStorage?.removeItem?.(STORAGE_KEY) } catch (_e) {}
  cachedConfig = { apiKey: '', baseUrl: '', model: '' }
  cachedConfigPromise = null
}

// UI 用：告知用户当前 key 存在哪里——桌面版用 OS keychain 是亮点要展示出来
export function getStorageKindLabel() {
  return isDesktopVaultAvailable() ? 'desktop-keychain' : 'browser-encrypted-localstorage'
}

// 给单测 / dev tools：清缓存让下次读重走 decrypt
export function _resetCacheForTests() {
  cachedConfig = null
  cachedConfigPromise = null
}
