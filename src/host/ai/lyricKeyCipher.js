// 用户 LLM API key 的本地加密——Web Crypto API + AES-GCM。
//
// 诚实声明：浏览器侧加密的真实强度仅限于"防被 F12 一眼看到 key 明文"。
// 同源恶意脚本 / XSS / 浏览器扩展依然能解密——因为解密逻辑也跑在浏览器里。
// 真要绝对安全的钥匙库请用桌面版（macOS Keychain / Windows Credential Manager）。
//
// 但在 webview 同源安全模型下，这层加密：
// - ✓ F12 → Application → localStorage 看不到 key 明文（防止当面演示 / 截图泄露）
// - ✓ 别的网站通过 SOP 漏洞拿到 storage 也是密文（万一）
// - ✗ 不防 WebUtau 同源 JS（XSS / 同源恶意扩展）
// - ✗ 不防本机木马 / 浏览器内存 dump

const SALT = 'webutau-ai-lyric-salt-v1'
const KEY_MATERIAL_BASE = 'webutau-ai-lyric-key-v1'
const PBKDF2_ITERATIONS = 100_000

function bufToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToBuf(b64) {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

let cachedKeyPromise = null

async function deriveKey() {
  if (cachedKeyPromise) return cachedKeyPromise
  cachedKeyPromise = (async () => {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('Web Crypto API not available')
    const enc = new TextEncoder()
    // origin 进 KDF 输入：让 file://、不同域、prod / dev 互相算出不同 key。
    // 万一开发环境的 storage 被复制到生产，也无法解密——多一道防线
    const origin = (typeof globalThis.location?.origin === 'string')
      ? globalThis.location.origin
      : ''
    const material = await subtle.importKey(
      'raw',
      enc.encode(`${KEY_MATERIAL_BASE}|${origin}`),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    )
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(SALT),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  })()
  return cachedKeyPromise
}

export function isCryptoSupported() {
  return Boolean(globalThis.crypto?.subtle && globalThis.TextEncoder && globalThis.btoa)
}

// 加密单条字符串。返回 { iv, ct } 都是 base64
export async function encryptString(plaintext) {
  if (!plaintext) return null
  if (!isCryptoSupported()) throw new Error('Web Crypto not supported in this browser')
  const subtle = globalThis.crypto.subtle
  const key = await deriveKey()
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return { iv: bufToBase64(iv), ct: bufToBase64(ciphertext) }
}

export async function decryptString(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const { iv, ct } = payload
  if (typeof iv !== 'string' || typeof ct !== 'string') return ''
  if (!isCryptoSupported()) throw new Error('Web Crypto not supported in this browser')
  const subtle = globalThis.crypto.subtle
  const key = await deriveKey()
  const ivBuf = base64ToBuf(iv)
  const ctBuf = base64ToBuf(ct)
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ctBuf)
    return new TextDecoder().decode(plain)
  } catch (_e) {
    // 钥匙不对（origin 变 / salt 变）→ 当作没存
    return ''
  }
}

// 测试 hook：让单测可以注入 fake KDF / 复位 key 缓存
export function _resetKeyCacheForTests() {
  cachedKeyPromise = null
}
