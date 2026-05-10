/**
 * 跨平台快捷键文本格式化——所有用户可见的快捷键提示都从这里走，
 * 保证 macOS 和 Windows / Linux 用户看到的是各自习惯的写法。
 *
 * macOS：⌘C、⇧⌘Z、⌥⌘V（无加号、用符号）
 * Windows / Linux：Ctrl+C、Ctrl+Shift+Z、Ctrl+Alt+V
 *
 * 用法：
 *   formatShortcut('C')                          → '⌘C' / 'Ctrl+C'
 *   formatShortcut('Z', { shift: true })         → '⇧⌘Z' / 'Ctrl+Shift+Z'
 *   formatShortcut('V', { alt: true })           → '⌥⌘V' / 'Ctrl+Alt+V'
 *   formatShortcut('Delete', { mod: false })     → 'Delete' / 'Delete'
 *
 * 平台检测的 fallback：navigator.platform 已被部分浏览器废弃，所以同时看
 * userAgent；都没有时（SSR / Node 测试）默认 Windows 习惯（更安全：⌘ 渲染
 * 在非 Mac 字体里可能丢失）
 */

export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  const probe = (navigator.platform || '') + ' ' + (navigator.userAgent || '')
  return /Mac|iPhone|iPad|iPod/i.test(probe)
}

/**
 * @param {string} key  字母键写大写（'C'）；功能键直接写名（'Delete' / 'Enter'）
 * @param {object} [options]
 * @param {boolean} [options.mod=true]    带 Cmd / Ctrl
 * @param {boolean} [options.shift=false] 带 Shift / ⇧
 * @param {boolean} [options.alt=false]   带 Alt / ⌥
 * @returns {string}
 */
export function formatShortcut(key, options = {}) {
  const { mod = true, shift = false, alt = false } = options
  const mac = isMacPlatform()
  if (mac) {
    const parts = []
    if (alt) parts.push('⌥')
    if (shift) parts.push('⇧')
    if (mod) parts.push('⌘')
    parts.push(key)
    return parts.join('')
  }
  const parts = []
  if (mod) parts.push('Ctrl')
  if (shift) parts.push('Shift')
  if (alt) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}
