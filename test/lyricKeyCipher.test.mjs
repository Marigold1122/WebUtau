import test from 'node:test'
import assert from 'node:assert/strict'

import {
  _resetKeyCacheForTests,
  decryptString,
  encryptString,
  isCryptoSupported,
} from '../src/host/ai/lyricKeyCipher.js'

// node 测试环境没有 window.location；模拟一个让 deriveKey 里的 origin 拼接有值
if (!globalThis.location) {
  globalThis.location = { origin: 'http://test.example' }
}

test('isCryptoSupported - node 24+ 自带 Web Crypto', () => {
  assert.equal(isCryptoSupported(), true)
})

test('encryptString → decryptString 完整 round-trip', async () => {
  _resetKeyCacheForTests()
  const original = 'sk-deadbeef1234567890fakekey'
  const enc = await encryptString(original)
  assert.ok(enc, '加密结果不应为空')
  assert.equal(typeof enc.iv, 'string')
  assert.equal(typeof enc.ct, 'string')
  // 密文不能跟明文一样（连肉眼看都能识别 sk- 前缀就出大问题）
  assert.notEqual(enc.ct, original)
  assert.ok(!enc.ct.includes('sk-'))

  const decrypted = await decryptString(enc)
  assert.equal(decrypted, original)
})

test('每次加密的 iv 不同（随机性保护重放）', async () => {
  _resetKeyCacheForTests()
  const a = await encryptString('same-input')
  const b = await encryptString('same-input')
  assert.notEqual(a.iv, b.iv)
  // 同一明文加密两次，密文也应不同（因为 iv 不同）
  assert.notEqual(a.ct, b.ct)
})

test('encryptString - 空字符串 / null 返回 null（约定）', async () => {
  assert.equal(await encryptString(''), null)
  assert.equal(await encryptString(null), null)
  assert.equal(await encryptString(undefined), null)
})

test('decryptString - 无效 / 缺字段输入安全返回空串', async () => {
  assert.equal(await decryptString(null), '')
  assert.equal(await decryptString({}), '')
  assert.equal(await decryptString({ iv: 'x' }), '')
  assert.equal(await decryptString({ ct: 'x' }), '')
  assert.equal(await decryptString({ iv: 'invalid', ct: 'invalid' }), '')
})

test('decryptString - 篡改密文也安全失败（GCM 自带 auth tag）', async () => {
  _resetKeyCacheForTests()
  const enc = await encryptString('secret')
  // 篡改密文一个字符——AES-GCM 验证失败应该返回空串而不是 throw / 返回乱码
  const tampered = { iv: enc.iv, ct: enc.ct.slice(0, -2) + 'XX' }
  const result = await decryptString(tampered)
  assert.equal(result, '')
})

test('decryptString - origin 改变后无法解密（多一道防线）', async () => {
  _resetKeyCacheForTests()
  globalThis.location.origin = 'http://origin-a.example'
  const enc = await encryptString('secret-from-A')

  // 模拟把数据搬到另一个 origin
  _resetKeyCacheForTests()
  globalThis.location.origin = 'http://origin-b.example'
  const decrypted = await decryptString(enc)
  assert.equal(decrypted, '')

  // 还原
  _resetKeyCacheForTests()
  globalThis.location.origin = 'http://test.example'
})
