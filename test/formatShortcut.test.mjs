import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { formatShortcut, isMacPlatform } from '../src/shared/formatShortcut.js'

// 通过覆盖 globalThis.navigator 模拟两个平台
function mockNavigator(platform, userAgent = '') {
  globalThis.navigator = { platform, userAgent }
}
function clearNavigator() {
  delete globalThis.navigator
}

describe('isMacPlatform', () => {
  afterEach(clearNavigator)

  it('navigator 缺失时返回 false（SSR / Node 测试场景）', () => {
    clearNavigator()
    assert.equal(isMacPlatform(), false)
  })
  it('macOS platform 返回 true', () => {
    mockNavigator('MacIntel')
    assert.equal(isMacPlatform(), true)
  })
  it('iPad userAgent 返回 true（iPadOS 上 platform 已不可靠）', () => {
    mockNavigator('', 'Mozilla/5.0 (iPad; CPU OS 17_0)')
    assert.equal(isMacPlatform(), true)
  })
  it('Windows platform 返回 false', () => {
    mockNavigator('Win32')
    assert.equal(isMacPlatform(), false)
  })
  it('Linux platform 返回 false', () => {
    mockNavigator('Linux x86_64')
    assert.equal(isMacPlatform(), false)
  })
})

describe('formatShortcut（macOS 风格）', () => {
  beforeEach(() => mockNavigator('MacIntel'))
  afterEach(clearNavigator)

  it('单纯 Cmd+字母', () => {
    assert.equal(formatShortcut('C'), '⌘C')
    assert.equal(formatShortcut('V'), '⌘V')
  })
  it('Shift 修饰', () => {
    assert.equal(formatShortcut('Z', { shift: true }), '⇧⌘Z')
  })
  it('Alt 修饰', () => {
    assert.equal(formatShortcut('V', { alt: true }), '⌥⌘V')
  })
  it('Alt+Shift 同时', () => {
    assert.equal(formatShortcut('Z', { alt: true, shift: true }), '⌥⇧⌘Z')
  })
  it('mod=false 时不带 Cmd', () => {
    assert.equal(formatShortcut('Delete', { mod: false }), 'Delete')
  })
})

describe('formatShortcut（Windows / Linux 风格）', () => {
  beforeEach(() => mockNavigator('Win32'))
  afterEach(clearNavigator)

  it('Ctrl+字母', () => {
    assert.equal(formatShortcut('C'), 'Ctrl+C')
    assert.equal(formatShortcut('V'), 'Ctrl+V')
  })
  it('Shift 修饰', () => {
    assert.equal(formatShortcut('Z', { shift: true }), 'Ctrl+Shift+Z')
  })
  it('Alt 修饰', () => {
    assert.equal(formatShortcut('V', { alt: true }), 'Ctrl+Alt+V')
  })
  it('mod=false 时不带 Ctrl', () => {
    assert.equal(formatShortcut('Delete', { mod: false }), 'Delete')
  })
})
