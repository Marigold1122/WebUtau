import { createVoiceRuntimeApp } from './app/createVoiceRuntimeApp.js'
import { createRuntimeBridge } from './bridge/createRuntimeBridge.js'
import { applyPianoRollTheme } from './pianoRollThemeBridge.js'
import '../i18n/i18n-overrides.css'
import { applyI18n, onLocaleChange, setLocale } from '../i18n/index.js'

let bridge = null

const app = createVoiceRuntimeApp({
  onEditorDirty(snapshot) {
    bridge?.emitEditorDirty(snapshot)
  },
  onSeekRequested(payload) {
    bridge?.emitSeekRequested(payload)
  },
  onHostShortcut(payload) {
    bridge?.emitHostShortcut(payload)
  },
  onPlaybackState(payload) {
    bridge?.emitPlaybackState(payload)
  },
  onPlaybackTick(payload) {
    bridge?.emitPlaybackTick(payload)
  },
  onJobSubmitted(payload) {
    bridge?.emitJobSubmitted(payload)
  },
  onPredictionReady(snapshot) {
    bridge?.emitPredictionReady(snapshot)
  },
  onRenderManifestSync(payload) {
    bridge?.emitRenderManifestSync(payload)
  },
  onPhraseReady(payload) {
    bridge?.emitPhraseReady(payload)
  },
  onRenderProgress(payload) {
    bridge?.emitRenderProgress(payload)
  },
  onRenderComplete(snapshot) {
    bridge?.emitRenderComplete(snapshot)
  },
  onRenderFailed(payload) {
    bridge?.emitRenderFailed(payload)
  },
})

bridge = createRuntimeBridge(app)
bridge.emitRuntimeReady()

window.voiceRuntimeApp = app

// 主题同步：iframe 自身有独立 document
//   首屏：从 URL 参数 ?theme=dark 立即应用，避免"先米色一闪再切到暗"
//   动态切换：监听 host 发来的 postMessage，同样走 View Transitions API
//
// 注意：host 现在会直接 mutate 我们的 documentElement.dataset.theme，所以
// 不能用 "data-theme 已等于 safe 就 early return"——那样 PIANO_ROLL 常量
// 永远不会被换成暗色版（host 跨过了我们的 bridge）。每次都要走完整流程
function commitIframeTheme(safe) {
  document.documentElement.dataset.theme = safe
  // canvas 画的钢琴卷帘 / 音符 / 音素时序图——直接改 PIANO_ROLL 常量并触发重绘。
  // 即使 data-theme 没变，也仍要调一次：PIANO_ROLL 默认是浅色快照，
  // 必须显式应用一次暗色 palette 才能让 canvas 对
  try { applyPianoRollTheme(safe) } catch (_e) {}
}

function applyIframeTheme(next, { animated = true } = {}) {
  const safe = next === 'dark' ? 'dark' : 'light'
  if (!animated || typeof document.startViewTransition !== 'function') {
    commitIframeTheme(safe)
    return
  }
  const transition = document.startViewTransition(() => {
    commitIframeTheme(safe)
  })
  transition?.finished?.catch?.(() => {})
}

// 首屏检测主题——三道兜底，任意一道命中就行：
//   1. URL 参数 ?theme=...（host 设 src 时塞进来的）
//   2. parent 的 documentElement.dataset.theme（同源 iframe 可读父窗口）
//   3. 都拿不到，默认 light
function detectInitialTheme() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '')
    const t = params.get('theme')
    if (t === 'dark' || t === 'light') return t
  } catch (_e) {}
  try {
    const parentTheme = window.parent?.document?.documentElement?.dataset?.theme
    if (parentTheme === 'dark' || parentTheme === 'light') return parentTheme
  } catch (_e) {}
  return 'light'
}
applyIframeTheme(detectInitialTheme(), { animated: false })

window.addEventListener('message', (event) => {
  if (event?.data?.type !== 'webutau:theme') return
  applyIframeTheme(event.data.theme, { animated: true })
})
// 启动时主动给 host 发 ready——保证 host 后续切主题时能找到 iframe 推消息
try { window.parent?.postMessage({ type: 'webutau:theme:ready' }, '*') } catch (_e) {}

// i18n：先扫一次自身 DOM（iframe 内的 voice-runtime.html）
applyI18n(document)
onLocaleChange(() => applyI18n(document))
window.addEventListener('message', (event) => {
  if (event?.data?.type !== 'webutau:locale') return
  if (setLocale(event.data.locale, { persist: false })) {
    applyI18n(document)
  }
})
// 通知 host：iframe 已准备好接收 locale 消息
try { window.parent?.postMessage({ type: 'webutau:locale:ready' }, '*') } catch (_e) {}
