import { isKeyboardShortcutTargetEditable } from '../../shared/isKeyboardShortcutTargetEditable.js'

/**
 * 宿主窗口里的 H 键临时抓手中继。
 *
 * voice-runtime 运行在 iframe 里，keydown 只在焦点窗口派发。
 * 当焦点在宿主（比如用户刚点了某个宿主按钮又想拖卷帘视角）时，
 * iframe 收不到 keydown，H 按住就失效了。
 *
 * 这里：在宿主 document 监听 keydown/keyup，看到 H 就调 iframe 内的
 * window.__webutauSetVoicePanOverride（由 PianoRollInputController 暴露），
 * 实现"无论焦点在哪按 H 都能立即切抓手"。
 */

const FRAME_ID = 'voice-runtime-frame'

function getRuntimePanSetter() {
  const frame = document.getElementById(FRAME_ID)
  if (!frame || frame.hidden) return null
  const setter = frame.contentWindow?.__webutauSetVoicePanOverride
  return typeof setter === 'function' ? setter : null
}

export function installVoiceRuntimePanBridge() {
  function onKeyDown(event) {
    if (event.repeat) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key?.toLowerCase?.() !== 'h') return
    if (isKeyboardShortcutTargetEditable(event.target)) return
    const setter = getRuntimePanSetter()
    if (!setter) return
    setter(true)
    event.preventDefault()
  }

  function onKeyUp(event) {
    if (event.key?.toLowerCase?.() !== 'h') return
    const setter = getRuntimePanSetter()
    if (!setter) return
    setter(false)
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
}
