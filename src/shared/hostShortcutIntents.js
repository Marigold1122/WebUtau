import { isKeyboardShortcutTargetEditable } from './isKeyboardShortcutTargetEditable.js'

export const HOST_SHORTCUT_INTENTS = {
  TOGGLE_PLAYBACK: 'toggle-playback',
  TOGGLE_SOLO: 'toggle-solo',
  TOGGLE_MUTE: 'toggle-mute',
}

export function getHostShortcutIntent(event) {
  if (!event || event.repeat) return null
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (isKeyboardShortcutTargetEditable(event.target)) return null

  if (event.code === 'Space') return HOST_SHORTCUT_INTENTS.TOGGLE_PLAYBACK
  if (event.code === 'KeyS') return HOST_SHORTCUT_INTENTS.TOGGLE_SOLO
  if (event.code === 'KeyM') return HOST_SHORTCUT_INTENTS.TOGGLE_MUTE
  return null
}
