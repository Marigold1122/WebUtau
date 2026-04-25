import { isKeyboardShortcutTargetEditable } from './isKeyboardShortcutTargetEditable.js'

export const HOST_SHORTCUT_INTENTS = {
  TOGGLE_PLAYBACK: 'toggle-playback',
  TOGGLE_SOLO: 'toggle-solo',
  TOGGLE_MUTE: 'toggle-mute',
  SAVE_PROJECT: 'save-project',
  SAVE_PROJECT_AS: 'save-project-as',
  OPEN_PROJECT: 'open-project',
}

// 工程文件级快捷键独立判定：跟 Pr / Word / VSCode 一致——
// 即使用户当前焦点在输入框 / contenteditable 里，Cmd+S 也照样触发保存。
// 反之播放 / Solo / Mute 是单字母键，必须在非编辑态才能用，否则会跟键入冲突。
function getFileShortcutIntent(event) {
  const mod = event.metaKey || event.ctrlKey
  if (!mod || event.altKey) return null
  const key = (event.key || '').toLowerCase()
  if (key === 's') {
    return event.shiftKey
      ? HOST_SHORTCUT_INTENTS.SAVE_PROJECT_AS
      : HOST_SHORTCUT_INTENTS.SAVE_PROJECT
  }
  if (key === 'o' && !event.shiftKey) return HOST_SHORTCUT_INTENTS.OPEN_PROJECT
  return null
}

export function getHostShortcutIntent(event) {
  if (!event || event.repeat) return null
  // 文件级快捷键先判：带修饰键，跟"输入态屏蔽"无关
  const fileIntent = getFileShortcutIntent(event)
  if (fileIntent) return fileIntent
  // 播放级快捷键：必须无修饰键、必须不在编辑态
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (isKeyboardShortcutTargetEditable(event.target)) return null
  if (event.code === 'Space') return HOST_SHORTCUT_INTENTS.TOGGLE_PLAYBACK
  if (event.code === 'KeyS') return HOST_SHORTCUT_INTENTS.TOGGLE_SOLO
  if (event.code === 'KeyM') return HOST_SHORTCUT_INTENTS.TOGGLE_MUTE
  return null
}
