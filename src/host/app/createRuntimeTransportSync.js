import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'

export function createRuntimeTransportSync({ store, taskCoordinator, getBridge }) {
  function postToRuntime(type, snapshot) {
    const editorTrack = store.getEditorTrack()
    const bridge = getBridge?.()
    if (!editorTrack || !isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) return
    if (!taskCoordinator.isRuntimeAttachedTo(editorTrack.id) || !bridge) return
    const payload = {
      trackId: editorTrack.id,
      playing: snapshot.playing,
      currentTime: snapshot.currentTime,
      duration: snapshot.duration,
    }
    const operation = type === 'tick'
      ? bridge.syncHostPlaybackTick(payload)
      : bridge.syncHostPlaybackState(payload)
    if (!operation || typeof operation.catch !== 'function') return
    operation.catch((error) => {
      console.error(`Runtime playback ${type} sync failed:`, error)
    })
  }

  return {
    syncState(snapshot) {
      postToRuntime('state', snapshot)
    },
    syncTick(snapshot) {
      postToRuntime('tick', snapshot)
    },
    syncWaiting(snapshot) {
      const editorTrack = store.getEditorTrack()
      const bridge = getBridge?.()
      if (!editorTrack || !bridge) return
      if (!taskCoordinator.isRuntimeAttachedTo(editorTrack.id)) return
      const payload = {
        trackId: editorTrack.id,
        playing: false,
        waiting: true,
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
      }
      const operation = bridge.syncHostPlaybackState(payload)
      if (!operation || typeof operation.catch !== 'function') return
      operation.catch((error) => {
        console.error('Runtime playback waiting sync failed:', error)
      })
    },
  }
}
