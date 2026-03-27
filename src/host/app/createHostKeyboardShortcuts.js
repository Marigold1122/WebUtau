import { isKeyboardShortcutTargetEditable } from '../../shared/isKeyboardShortcutTargetEditable.js'

function shouldHandlePlaybackShortcut(event) {
  if (event.code !== 'Space') return false
  if (event.repeat) return false
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  return !isKeyboardShortcutTargetEditable(event.target)
}

export function createHostKeyboardShortcuts(handlers = {}) {
  function handleKeydown(event) {
    if (!shouldHandlePlaybackShortcut(event)) return
    event.preventDefault()
    handlers.onTogglePlayback?.()
  }

  return {
    init() {
      document.addEventListener('keydown', handleKeydown)
    },
  }
}
