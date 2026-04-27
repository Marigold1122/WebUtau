// 用户自带 LLM API key 的本地存储。
//
// 安全等级（诚实告知）：
//   ✓ AES-GCM (Web Crypto) 加密后存 localStorage
//   ✓ KDF 输入含 origin，跨域无法解密
//   ✓ key 永不进我们后端——只在浏览器里、调用 LLM 时直接发到厂商
//   ✗ 不防本机木马 / 同源 XSS / 流氓浏览器扩展（任何浏览器侧加密都做不到）
//   ✗ 真要绝对安全请用桌面版（OS keychain）
//
// 旧版本 plaintext 数据迁移：开机时检测旧格式 → 自动加密迁移一次（用户无感）。
// API：
//   - getUserApiConfig()  Promise<{apiKey, baseUrl, model}>
//   - hasUserApiKey()     Promise<boolean>
//   - setUserApiConfig()  Promise<void>
//   - clearUserApiConfig() void

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
  const result = await writeEncrypted(config)
  cachedConfig = result
  return result
}

export function clearUserApiConfig() {
  try { globalThis.localStorage?.removeItem?.(STORAGE_KEY) } catch (_e) {}
  cachedConfig = { apiKey: '', baseUrl: '', model: '' }
  cachedConfigPromise = null
}

// 给单测 / dev tools：清缓存让下次读重走 decrypt
export function _resetCacheForTests() {
  cachedConfig = null
  cachedConfigPromise = null
}
