import { createVoiceRuntimeApp } from './app/createVoiceRuntimeApp.js'
import { createRuntimeBridge } from './bridge/createRuntimeBridge.js'

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
