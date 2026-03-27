export const VOICE_BRIDGE_SOURCE = 'melody-voice-bridge'

export const VOICE_BRIDGE_COMMANDS = {
  LOAD_TRACK: 'load-track',
  REQUEST_SNAPSHOT: 'request-snapshot',
  RESET_RUNTIME: 'reset-runtime',
  START_SYNTHESIS: 'start-synthesis',
  SEEK: 'seek',
  TOGGLE_PLAYBACK: 'toggle-playback',
  HOST_PLAYBACK_STATE: 'host-playback-state',
  HOST_PLAYBACK_TICK: 'host-playback-tick',
}

export const VOICE_BRIDGE_EVENTS = {
  RUNTIME_READY: 'runtime-ready',
  TRACK_LOADED: 'track-loaded',
  SNAPSHOT_RESPONSE: 'snapshot-response',
  EDITOR_DIRTY: 'editor-dirty',
  SEEK_REQUESTED: 'seek-requested',
  PLAYBACK_SHORTCUT: 'playback-shortcut',
  HOST_SHORTCUT: 'host-shortcut',
  PLAYBACK_STATE: 'playback-state',
  PLAYBACK_TICK: 'playback-tick',
  JOB_SUBMITTED: 'job-submitted',
  PREDICTION_READY: 'prediction-ready',
  RENDER_MANIFEST_SYNC: 'render-manifest-sync',
  PHRASE_READY: 'phrase-ready',
  RENDER_PROGRESS: 'render-progress',
  RENDER_COMPLETE: 'render-complete',
  RENDER_FAILED: 'render-failed',
}

export function createBridgeMessage(type, payload = {}, requestId = null) {
  return {
    source: VOICE_BRIDGE_SOURCE,
    type,
    payload,
    requestId,
  }
}

export function isBridgeMessage(data) {
  return Boolean(data) && data.source === VOICE_BRIDGE_SOURCE && typeof data.type === 'string'
}
