import {
  VOICE_BRIDGE_COMMANDS,
  VOICE_BRIDGE_EVENTS,
  createBridgeMessage,
  isBridgeMessage,
} from '../../shared/voiceBridgeProtocol.js'

function postToHost(type, payload = {}, requestId = null) {
  window.parent.postMessage(createBridgeMessage(type, payload, requestId), window.location.origin)
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '未知错误'
}

function buildBridgeHandlers(app) {
  return {
    async [VOICE_BRIDGE_COMMANDS.LOAD_TRACK](payload, requestId) {
      await app.loadTrack(payload.track)
      postToHost(VOICE_BRIDGE_EVENTS.TRACK_LOADED, { trackId: payload.track.trackId }, requestId)
    },
    [VOICE_BRIDGE_COMMANDS.REQUEST_SNAPSHOT](_payload, requestId) {
      postToHost(VOICE_BRIDGE_EVENTS.SNAPSHOT_RESPONSE, { snapshot: app.requestSnapshot() }, requestId)
    },
    async [VOICE_BRIDGE_COMMANDS.APPLY_NOTE_EDITS](payload, requestId) {
      const result = await app.applyNoteEdits?.(payload.edits || [])
      postToHost(VOICE_BRIDGE_EVENTS.NOTE_EDITS_RESPONSE, result || {}, requestId)
    },
    async [VOICE_BRIDGE_COMMANDS.UNDO_EDITOR]() {
      await app.undoEditor?.()
    },
    [VOICE_BRIDGE_COMMANDS.RESET_RUNTIME]() {
      app.reset()
    },
    async [VOICE_BRIDGE_COMMANDS.START_SYNTHESIS](payload) {
      try {
        await app.startSynthesis(payload.options)
      } catch (error) {
        const snapshot = app.requestSnapshot?.()
        postToHost(VOICE_BRIDGE_EVENTS.RENDER_FAILED, {
          trackId: snapshot?.trackId || null,
          error: toErrorMessage(error),
        })
      }
    },
    [VOICE_BRIDGE_COMMANDS.SEEK](payload) {
      app.seekTo?.(payload.time)
    },
    [VOICE_BRIDGE_COMMANDS.TOGGLE_PLAYBACK]() {
      app.togglePlayback?.()
    },
    [VOICE_BRIDGE_COMMANDS.HOST_PLAYBACK_STATE](payload) {
      app.syncHostPlaybackState?.(payload)
    },
    [VOICE_BRIDGE_COMMANDS.HOST_PLAYBACK_TICK](payload) {
      app.syncHostPlaybackTick?.(payload)
    },
    [VOICE_BRIDGE_COMMANDS.SET_EDITOR_MODE](payload) {
      app.setEditorMode?.(payload.mode)
    },
    [VOICE_BRIDGE_COMMANDS.SET_PLAYHEAD_FOLLOW_MODE](payload) {
      app.setPlayheadFollowMode?.(payload.mode)
    },
  }
}

export function createRuntimeBridge(app) {
  const handlers = buildBridgeHandlers(app)

  function handleMessage(event) {
    if (event.origin !== window.location.origin) return
    if (!isBridgeMessage(event.data)) return
    const handler = handlers[event.data.type]
    if (typeof handler !== 'function') return
    Promise.resolve(handler(event.data.payload || {}, event.data.requestId)).catch(handleBridgeError)
  }

  function handleBridgeError(error) {
    console.error('voice-runtime bridge error', error)
  }

  function emitRuntimeReady() {
    postToHost(VOICE_BRIDGE_EVENTS.RUNTIME_READY)
  }

  function emitEditorDirty(snapshot) {
    postToHost(VOICE_BRIDGE_EVENTS.EDITOR_DIRTY, { snapshot })
  }

  function emitSeekRequested(payload = {}) {
    postToHost(VOICE_BRIDGE_EVENTS.SEEK_REQUESTED, payload)
  }

  function emitHostShortcut(payload = {}) {
    postToHost(VOICE_BRIDGE_EVENTS.HOST_SHORTCUT, payload)
  }

  function emitPlaybackState(payload = {}) {
    postToHost(VOICE_BRIDGE_EVENTS.PLAYBACK_STATE, payload)
  }

  function emitPlaybackTick(payload = {}) {
    postToHost(VOICE_BRIDGE_EVENTS.PLAYBACK_TICK, payload)
  }

  function emitJobSubmitted(payload) {
    postToHost(VOICE_BRIDGE_EVENTS.JOB_SUBMITTED, payload)
  }

  function emitPredictionReady(snapshot) {
    postToHost(VOICE_BRIDGE_EVENTS.PREDICTION_READY, { snapshot })
  }

  function emitRenderManifestSync(payload) {
    postToHost(VOICE_BRIDGE_EVENTS.RENDER_MANIFEST_SYNC, payload)
  }

  function emitPhraseReady(payload) {
    postToHost(VOICE_BRIDGE_EVENTS.PHRASE_READY, payload)
  }

  function emitRenderProgress(payload) {
    postToHost(VOICE_BRIDGE_EVENTS.RENDER_PROGRESS, payload)
  }

  function emitRenderComplete(snapshot) {
    postToHost(VOICE_BRIDGE_EVENTS.RENDER_COMPLETE, { snapshot })
  }

  function emitRenderFailed(payload) {
    postToHost(VOICE_BRIDGE_EVENTS.RENDER_FAILED, payload)
  }

  window.addEventListener('message', handleMessage)

  return {
    emitRuntimeReady,
    emitEditorDirty,
    emitSeekRequested,
    emitHostShortcut,
    emitPlaybackState,
    emitPlaybackTick,
    emitJobSubmitted,
    emitPredictionReady,
    emitRenderManifestSync,
    emitPhraseReady,
    emitRenderProgress,
    emitRenderComplete,
    emitRenderFailed,
  }
}
