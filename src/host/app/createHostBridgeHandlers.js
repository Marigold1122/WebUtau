import {
  buildRenderProgressText,
  buildPredictionOverlayText,
  buildPredictionStatusText,
  getPredictionPhase,
  getPredictionProgressPercent,
} from './trackPredictionProgress.js'
import { hasPredictedPitch, isTrackPrepReady } from '../project/trackPrepState.js'

function getTrackName(store, trackId) {
  return store.getTrack(trackId)?.name || '当前轨道'
}

function matchesTrackJob(store, trackId, jobId) {
  const track = store.getTrack(trackId)
  if (!track) return false
  if (!jobId) return true
  return track.jobRef?.jobId === jobId || track.vocalManifest?.jobId === jobId
}

function updatePredictionProgress(store, view, trackId, payload) {
  const progress = getPredictionProgressPercent(payload)
  store.updateTrackPrepState(trackId, {
    status: getPredictionPhase(payload),
    progress,
    error: null,
  })
  view.updateTrackSynthesisOverlay(buildPredictionOverlayText(progress), progress / 100)
  view.setStatus(buildPredictionStatusText(getTrackName(store, trackId), progress))
}

function invalidateVoiceConversion(onVoiceConversionInvalidated, trackId, reason) {
  Promise.resolve(onVoiceConversionInvalidated?.(trackId, reason)).catch((error) => {
    console.error('Voice conversion invalidation failed:', error)
  })
}

export function createHostBridgeHandlers({
  store,
  view,
  taskCoordinator,
  transportCoordinator,
  playbackMode,
  runtimeTransportSync,
  prepWaiters,
  vocalManifestController,
  getActiveGateTrackId,
  onResumeBufferedPlayback,
  onPlaybackShortcut,
  onHostShortcut,
  onVoiceConversionInvalidated,
  syncLiveProjectMeta,
  render,
}) {
  void runtimeTransportSync

  return {
    onRuntimeReady() {
      view.setStatus('运行时已连接')
    },
    onSeekRequested(payload) {
      const trackId = payload?.trackId
      const currentTime = payload?.currentTime
      if (!trackId || !Number.isFinite(currentTime)) return
      const editorTrack = store.getEditorTrack()
      if (!editorTrack || editorTrack.id !== trackId) return
      Promise.resolve(transportCoordinator?.seekToTime?.(currentTime)).catch((error) => {
        console.error('Host runtime seek sync failed:', error)
      })
    },
    onPlaybackShortcut() {
      onPlaybackShortcut?.()
    },
    onHostShortcut(payload) {
      onHostShortcut?.(payload)
    },
    onEditorDirty(snapshot) {
      if (!snapshot?.trackId) return
      store.replaceVoiceSnapshot(snapshot.trackId, snapshot)
      taskCoordinator.markTrackEdited(snapshot.trackId)
      vocalManifestController?.resetTrackFromSnapshot(snapshot.trackId, snapshot)
      invalidateVoiceConversion(onVoiceConversionInvalidated, snapshot.trackId, '轨道内容已变更，需要重新转换')
      render('bridge-editor-dirty')
    },
    onJobSubmitted(payload) {
      if (!payload?.trackId || !payload?.jobId) return
      if (!taskCoordinator.attachJobId(payload.trackId, payload.jobId)) return
      vocalManifestController?.markJobSubmitted(payload.trackId, payload.jobId)
      invalidateVoiceConversion(onVoiceConversionInvalidated, payload.trackId, '当前轨道已重新提交渲染，需要重新转换')
      render('bridge-job-submitted')
    },
    onPredictionReady(snapshot) {
      if (!snapshot?.trackId) return
      if (!taskCoordinator.markPredictionReady(snapshot.trackId, snapshot)) return
      store.replaceVoiceSnapshot(snapshot.trackId, snapshot)
      vocalManifestController?.markPredictionReady(snapshot.trackId, snapshot)
      if (!hasPredictedPitch(snapshot)) return
      store.updateTrackPrepState(snapshot.trackId, { status: 'ready', progress: 100, error: null })
      render('bridge-prediction-ready')
      if (getActiveGateTrackId() !== snapshot.trackId) return
      view.updateTrackSynthesisOverlay(buildPredictionOverlayText(100), 1)
      prepWaiters.resolve(snapshot.trackId, { ok: true, snapshot })
    },
    onRenderManifestSync(payload) {
      if (!payload?.trackId || !matchesTrackJob(store, payload.trackId, payload.jobId)) return
      const manifest = vocalManifestController?.syncRenderManifest(payload)
      if (payload?.source === 'runtime-cache' && transportCoordinator?.isProjectPlaybackActive?.()) {
        Promise.resolve(transportCoordinator.refreshProjectPlayback('runtime-cache-sync')).catch((error) => {
          console.error('Host playback refresh after runtime cache invalidation failed:', error)
        })
      }
      return manifest
    },
    onPhraseReady(payload) {
      if (!payload?.trackId || !matchesTrackJob(store, payload.trackId, payload.jobId)) return
      Promise.resolve(vocalManifestController?.handlePhraseReady(payload))
        .then(() => {
          const resumeDecision = playbackMode.handlePhraseReady(payload.phraseIndex, payload.jobId)
          if (resumeDecision.action === 'resume') {
            return Promise.resolve(onResumeBufferedPlayback?.())
          }
        })
        .catch((error) => {
          console.error('Host vocal asset sync failed:', error)
        })
    },
    onRenderProgress(payload) {
      if (!payload?.trackId || !taskCoordinator.matchesActiveTask(payload.trackId, payload.jobId)) return
      const track = store.getTrack(payload.trackId)
      store.updateTrackRenderState(payload.trackId, payload)
      if (getActiveGateTrackId() === payload.trackId && !isTrackPrepReady(track)) {
        updatePredictionProgress(store, view, payload.trackId, payload)
        syncLiveProjectMeta?.()
        return
      }
      syncLiveProjectMeta?.()
      view.setStatus(buildRenderProgressText(track?.name, payload))
    },
    onRenderComplete(snapshot) {
      if (!snapshot?.trackId || !taskCoordinator.markRenderCompleted(snapshot.trackId, snapshot)) return
      store.replaceVoiceSnapshot(snapshot.trackId, snapshot)
      vocalManifestController?.markRenderComplete(snapshot.trackId, snapshot)
      store.updateTrackRenderState(snapshot.trackId, {
        status: 'completed',
        completed: snapshot.phraseCount ?? store.getTrack(snapshot.trackId)?.renderState?.total ?? 0,
        total: snapshot.phraseCount ?? store.getTrack(snapshot.trackId)?.renderState?.total ?? 0,
        error: null,
      })
      if (hasPredictedPitch(snapshot)) {
        store.updateTrackPrepState(snapshot.trackId, { status: 'ready', progress: 100, error: null })
      }
      render('bridge-render-complete')
      view.setStatus(`渲染完成: ${getTrackName(store, snapshot.trackId)}`)
    },
    onRenderFailed(payload) {
      if (!payload?.trackId || !taskCoordinator.markFailed(payload.trackId, payload.error || '未知错误', payload.jobId)) return
      const track = store.getTrack(payload.trackId)
      vocalManifestController?.markRenderFailed(payload.trackId, payload.error || '未知错误')
      store.updateTrackRenderState(payload.trackId, {
        status: 'failed',
        error: payload.error || '未知错误',
      })
      if (getActiveGateTrackId() === payload.trackId && !isTrackPrepReady(track)) {
        store.updateTrackPrepState(payload.trackId, {
          status: 'failed',
          error: payload.error || '未知错误',
        })
        prepWaiters.resolve(payload.trackId, { ok: false, error: payload.error || '未知错误' })
      }
      render('bridge-render-failed')
      view.setStatus(`渲染失败: ${getTrackName(store, payload.trackId)} | ${payload.error || '未知错误'}`)
    },
  }
}
