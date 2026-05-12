// 全局 ESC 栈式调度：按优先级关闭最顶层"高于多轨主背景"的浮层 / 面板。
//
// 设计要点：
//   1. 已经自带 ESC 处理器的浮层（InlinePopover / MixerInsertPopover /
//      OfficialLyricsDialog / LyricAIKeyDialog / About 面板）由它们自己关闭。
//      本调度在那些 surface 打开期间主动让步，避免一次 ESC 同时关掉两层。
//      —— 自身已 preventDefault 的事件（如 InstrumentEditorView / piano roll
//      处理后的 ESC，或者 inlineRenameEdit 的取消重命名）通过
//      event.defaultPrevented 判定，避免冲突。
//   2. IME 输入合成中（event.isComposing）让步——ESC 是输入法的"取消候选"，
//      不应顺手关掉外层面板。不对普通 textarea / input 做"编辑态屏蔽"：在
//      Quick Lyric 这种浮窗里输入歌词时按 ESC 还应该能关掉浮窗（现代 UX 一致）。
//   3. 同源 iframe（voice-runtime-frame）也挂同一份处理，让在子窗口里按 ESC
//      也能关闭外层 dock / 编辑器。
//   4. 优先级链从顶层向底层走，找到第一个"正在打开"的就关掉并停止派发。

const VOICE_RUNTIME_FRAME_ID = 'voice-runtime-frame'

// 已自带 ESC 处理的 surface 检测——它们在打开期间我们什么都不做
function isSelfHandledSurfaceOpen() {
  if (document.body.classList.contains('inline-popover-active')) return true
  if (document.querySelector('.mixer-insert-popover')) return true
  if (document.querySelector('.official-lyrics-overlay.is-visible')) return true
  if (document.querySelector('.lyric-ai-key-overlay.visible')) return true
  const about = document.getElementById('inspector-tab-about')
  if (about && !about.hidden) return true
  return false
}

// 标准 modal-overlay 一组：找 cancel/discard 按钮所在的、当前打开的那个并触发点击。
// 走 cancel 按钮而不是直接改 class——因为各 modal 的 close() 还有 Promise resolve、
// modal-open body 类移除等内部清理，绕过按钮容易漏掉清理步骤。
function tryCloseTopmostModal() {
  const cancelIds = [
    'btn-track-language-cancel',
    'btn-project-timing-cancel',
    'btn-export-audio-cancel',
    'btn-ustx-export-cancel',
  ]
  for (const id of cancelIds) {
    const btn = document.getElementById(id)
    if (!btn) continue
    const overlay = btn.closest('.modal-overlay')
    if (!overlay) continue
    if (overlay.classList.contains('is-open') || overlay.classList.contains('visible')) {
      btn.click()
      return true
    }
  }
  return false
}

function tryCloseQuickLyricPanel() {
  const btn = document.querySelector('.quick-lyric-panel .quick-lyric-close')
  if (!btn) return false
  btn.click()
  return true
}

function tryCloseTrackContextMenu() {
  const menu = document.querySelector('.track-context-menu.visible')
  if (!menu) return false
  menu.classList.remove('visible')
  return true
}

function tryCloseFileMenu() {
  const menu = document.querySelector('.file-menu.visible')
  if (!menu) return false
  menu.classList.remove('visible')
  return true
}

// 底部 Mixer / Reverb dock：tabbar 是否可见即代表 dock 整体是否打开
function tryCloseBottomDock() {
  const tabbar = document.getElementById('bottom-dock-tabbar')
  if (!tabbar || tabbar.classList.contains('hidden')) return false
  const closeBtn = document.getElementById('bottom-dock-close')
  if (!closeBtn) return false
  closeBtn.click()
  return true
}

// 底部钢琴卷帘（声部 / 乐器编辑器）：editor-panel 没被 hidden 就视为打开
function tryCloseEditorPanel() {
  const editor = document.getElementById('editor-panel')
  if (!editor || editor.classList.contains('hidden')) return false
  const btn = document.getElementById('btn-close-editor')
  if (!btn) return false
  btn.click()
  return true
}

const CHAIN = [
  tryCloseTopmostModal,
  tryCloseQuickLyricPanel,
  tryCloseTrackContextMenu,
  tryCloseFileMenu,
  tryCloseBottomDock,
  tryCloseEditorPanel,
]

function handleEscape(event) {
  if (event.key !== 'Escape') return
  if (event.isComposing) return
  if (event.defaultPrevented) return
  if (isSelfHandledSurfaceOpen()) return
  for (const fn of CHAIN) {
    if (fn()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }
}

// 把同一份处理也挂到 voice-runtime-frame 的子窗口——同源，安全
function attachToVoiceRuntimeFrame() {
  const iframe = document.getElementById(VOICE_RUNTIME_FRAME_ID)
  if (!iframe) return
  const attach = () => {
    try {
      const win = iframe.contentWindow
      if (!win || win === window) return
      win.addEventListener('keydown', handleEscape)
    } catch {
      // 跨源或其他异常：放弃，不阻塞主流程
    }
  }
  // 已加载完则直接挂；否则等 load 再挂。iframe src 可能动态切换，监听 load 以便
  // 切到新文档后重新挂上
  if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
    attach()
  }
  iframe.addEventListener('load', attach)
}

export function installGlobalEscape() {
  window.addEventListener('keydown', handleEscape)
  attachToVoiceRuntimeFrame()
  return () => {
    window.removeEventListener('keydown', handleEscape)
  }
}
