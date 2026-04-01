import {
  VOICE_BRIDGE_COMMANDS,
  VOICE_BRIDGE_EVENTS,
  createBridgeMessage,
  isBridgeMessage,
} from '../../shared/voiceBridgeProtocol.js'

export class VoiceBridgeController {
  constructor(frameElement, handlers = {}) {
    this.frameElement = frameElement
    this.handlers = handlers
    this.pendingRequests = new Map()
    this.runtimeReady = false
    this.requestSeed = 0
    this.readyResolvers = []
    this._handleMessage = this._handleMessage.bind(this)
  }

  init() {
    window.addEventListener('message', this._handleMessage)
  }

  waitUntilReady() {
    if (this.runtimeReady) return Promise.resolve()
    return new Promise((resolve) => this.readyResolvers.push(resolve))
  }

  async loadTrack(track) {
    await this.waitUntilReady()
    return this._sendRequest(VOICE_BRIDGE_COMMANDS.LOAD_TRACK, { track })
  }

  async requestSnapshot() {
    await this.waitUntilReady()
    const payload = await this._sendRequest(VOICE_BRIDGE_COMMANDS.REQUEST_SNAPSHOT, {})
    return payload.snapshot || null
  }

  async startSynthesis(options) {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.START_SYNTHESIS, { options })
  }

  async applyNoteEdits(edits = []) {
    await this.waitUntilReady()
    const payload = await this._sendRequest(VOICE_BRIDGE_COMMANDS.APPLY_NOTE_EDITS, { edits })
    if (payload?.error) throw new Error(payload.error)
    return payload || null
  }

  async undoEditor() {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.UNDO_EDITOR, {})
  }

  async setEditorMode(mode) {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.SET_EDITOR_MODE, { mode })
  }

  async setPlayheadFollowMode(mode) {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.SET_PLAYHEAD_FOLLOW_MODE, { mode })
  }

  async togglePlayback() {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.TOGGLE_PLAYBACK, {})
  }

  async seekTo(time) {
    await this.waitUntilReady()
    this._postMessage(VOICE_BRIDGE_COMMANDS.SEEK, { time })
  }

  syncHostPlaybackState(payload) {
    return this._postMessageWhenReady(VOICE_BRIDGE_COMMANDS.HOST_PLAYBACK_STATE, payload || {})
  }

  syncHostPlaybackTick(payload) {
    return this._postMessageWhenReady(VOICE_BRIDGE_COMMANDS.HOST_PLAYBACK_TICK, payload || {})
  }

  resetRuntime() {
    if (!this.runtimeReady) return
    this._postMessage(VOICE_BRIDGE_COMMANDS.RESET_RUNTIME, {})
  }

  _handleMessage(event) {
    if (event.origin !== window.location.origin) return
    if (!isBridgeMessage(event.data)) return

    switch (event.data.type) {
      case VOICE_BRIDGE_EVENTS.RUNTIME_READY:
        this.runtimeReady = true
        this.readyResolvers.splice(0).forEach((resolve) => resolve())
        this.handlers.onRuntimeReady?.()
        break
      case VOICE_BRIDGE_EVENTS.TRACK_LOADED:
      case VOICE_BRIDGE_EVENTS.SNAPSHOT_RESPONSE:
      case VOICE_BRIDGE_EVENTS.NOTE_EDITS_RESPONSE:
        this._resolvePending(event.data.requestId, event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.EDITOR_DIRTY:
        this.handlers.onEditorDirty?.(event.data.payload?.snapshot || null)
        break
      case VOICE_BRIDGE_EVENTS.SEEK_REQUESTED:
        this.handlers.onSeekRequested?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.PLAYBACK_SHORTCUT:
        this.handlers.onPlaybackShortcut?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.HOST_SHORTCUT:
        this.handlers.onHostShortcut?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.PLAYBACK_STATE:
        this.handlers.onPlaybackState?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.PLAYBACK_TICK:
        this.handlers.onPlaybackTick?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.JOB_SUBMITTED:
        this.handlers.onJobSubmitted?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.PREDICTION_READY:
        this.handlers.onPredictionReady?.(event.data.payload?.snapshot || null)
        break
      case VOICE_BRIDGE_EVENTS.RENDER_MANIFEST_SYNC:
        this.handlers.onRenderManifestSync?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.PHRASE_READY:
        this.handlers.onPhraseReady?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.RENDER_PROGRESS:
        this.handlers.onRenderProgress?.(event.data.payload || {})
        break
      case VOICE_BRIDGE_EVENTS.RENDER_COMPLETE:
        this.handlers.onRenderComplete?.(event.data.payload?.snapshot || null)
        break
      case VOICE_BRIDGE_EVENTS.RENDER_FAILED:
        this.handlers.onRenderFailed?.(event.data.payload || {})
        break
      default:
        break
    }
  }

  _resolvePending(requestId, payload) {
    if (!requestId || !this.pendingRequests.has(requestId)) return
    const resolve = this.pendingRequests.get(requestId)
    this.pendingRequests.delete(requestId)
    resolve(payload)
  }

  _sendRequest(type, payload) {
    const requestId = `bridge-${++this.requestSeed}`
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, resolve)
      this._postMessage(type, payload, requestId)
    })
  }

  _postMessageWhenReady(type, payload) {
    if (this.runtimeReady) {
      this._postMessage(type, payload)
      return null
    }
    return this.waitUntilReady().then(() => {
      this._postMessage(type, payload)
    })
  }

  _postMessage(type, payload, requestId = null) {
    const targetWindow = this.frameElement?.contentWindow
    if (!targetWindow) return
    targetWindow.postMessage(createBridgeMessage(type, payload, requestId), window.location.origin)
  }
}
