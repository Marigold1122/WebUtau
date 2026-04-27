import test from 'node:test'
import assert from 'node:assert/strict'

// 这里只测前端"探测 + IPC 桥接层"的逻辑——真正的 keyring 操作只能在 Tauri 进程里测。
// 用 mock window.__TAURI_INTERNALS__ 模拟桌面环境

import {
  isDesktopVaultAvailable,
  vaultClearConfig,
  vaultGetConfig,
  vaultSaveConfig,
} from '../src/host/ai/desktopKeyVault.js'

function setupTauriMock(invokeImpl) {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: invokeImpl,
    },
  }
}

function teardownTauri() {
  globalThis.window = {}
}

test('isDesktopVaultAvailable - 网页环境返回 false', () => {
  teardownTauri()
  assert.equal(isDesktopVaultAvailable(), false)
})

test('isDesktopVaultAvailable - Tauri 环境返回 true', () => {
  setupTauriMock(async () => ({}))
  assert.equal(isDesktopVaultAvailable(), true)
  teardownTauri()
})

test('vaultGetConfig - 网页环境返回 not-tauri 让上层降级', async () => {
  teardownTauri()
  const result = await vaultGetConfig()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-tauri')
})

test('vaultGetConfig - Tauri 环境正常解析 IPC 返回值', async () => {
  setupTauriMock(async (cmd) => {
    assert.equal(cmd, 'get_api_key_config')
    return { apiKey: 'sk-test', baseUrl: 'https://api.example.com', model: 'gpt-x' }
  })
  const result = await vaultGetConfig()
  assert.equal(result.ok, true)
  assert.equal(result.apiKey, 'sk-test')
  assert.equal(result.baseUrl, 'https://api.example.com')
  assert.equal(result.model, 'gpt-x')
  teardownTauri()
})

test('vaultGetConfig - Tauri 环境字段类型错误时安全兜底为空串', async () => {
  setupTauriMock(async () => ({ apiKey: null, baseUrl: 123, model: undefined }))
  const result = await vaultGetConfig()
  assert.equal(result.ok, true)
  assert.equal(result.apiKey, '')
  assert.equal(result.baseUrl, '')
  assert.equal(result.model, '')
  teardownTauri()
})

test('vaultGetConfig - IPC 抛异常返回 invoke-error', async () => {
  setupTauriMock(async () => { throw new Error('keychain locked') })
  const result = await vaultGetConfig()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invoke-error')
  assert.match(result.error, /keychain locked/)
  teardownTauri()
})

test('vaultSaveConfig - 把 camelCase 字段透传给 Rust', async () => {
  let receivedArgs = null
  setupTauriMock(async (cmd, args) => {
    assert.equal(cmd, 'save_api_key_config')
    receivedArgs = args
  })
  const result = await vaultSaveConfig({
    apiKey: '  sk-trim  ',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(receivedArgs, {
    config: {
      apiKey: 'sk-trim',  // 自动 trim
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
  })
  teardownTauri()
})

test('vaultSaveConfig - 网页环境直接降级', async () => {
  teardownTauri()
  const result = await vaultSaveConfig({ apiKey: 'sk-x' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-tauri')
})

test('vaultClearConfig - 调对命令', async () => {
  let calledCmd = null
  setupTauriMock(async (cmd) => {
    calledCmd = cmd
  })
  const result = await vaultClearConfig()
  assert.equal(result.ok, true)
  assert.equal(calledCmd, 'clear_api_key_config')
  teardownTauri()
})
