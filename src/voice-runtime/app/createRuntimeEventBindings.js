import eventBus from '../../core/EventBus.js'
import phraseStore from '../../core/PhraseStore.js'
import playheadController from '../../modules/PlayheadController.js'
import { EVENTS } from '../../config/constants.js'
import { buildRuntimeSnapshot } from './runtimeSnapshot.js'

export function createRuntimeEventBindings({
  callbacks,
  embedded,
  state,
  setStatus,
  buildPlaybackPayload,
  buildSeekPayload,
  emitPlaybackState,
}) {
  function handlePhraseRebuilt({ phrases }) {
    setStatus(`后端分句完成：${phrases.length} 个语句，渲染中...`)
  }

  function handleTransportTick({ time }) {
    if (embedded) return
    callbacks.onPlaybackTick?.(buildPlaybackPayload(time))
  }

  function handleTransportSeek({ time }) {
    if (embedded) {
      callbacks.onSeekRequested?.(buildSeekPayload(time))
      return
    }
    callbacks.onPlaybackTick?.(buildPlaybackPayload(time))
  }

  function handleTransportStateChange({ time } = {}) {
    if (embedded) return
    emitPlaybackState(Number.isFinite(time) ? time : playheadController.getPosition())
  }

  function handleJobSubmitted({ jobId }) {
    callbacks.onJobSubmitted?.({
      trackId: state.trackId,
      jobId: jobId || phraseStore.getJobId() || null,
    })
  }

  function handlePitchLoaded() {
    setStatus(`音高预测完成：${state.trackName}`)
    callbacks.onPredictionReady?.(buildRuntimeSnapshot(state, phraseStore))
  }

  function handleJobProgress(payload = {}) {
    const { completed, total, status, progress, phrases = [] } = payload
    const jobId = phraseStore.getJobId()
    if (state.trackId) {
      callbacks.onRenderManifestSync?.({
        trackId: state.trackId,
        jobId,
        status,
        hasPredictedPitch: Boolean(phraseStore.getPitchData()),
        phraseStates: phrases.map((phraseInfo) => ({
          phraseIndex: phraseInfo.index,
          inputHash: phraseStore.getPhrase(phraseInfo.index)?.inputHash || null,
          startMs: phraseInfo.startMs,
          durationMs: phraseInfo.durationMs,
          status: phraseInfo.status,
        })),
      })
    }
    if (status === 'completed') {
      setStatus('渲染完成')
      callbacks.onRenderComplete?.(buildRuntimeSnapshot(state, phraseStore))
      return
    }
    setStatus(progress || ('渲染中 ' + completed + '/' + total))
    callbacks.onRenderProgress?.({
      trackId: state.trackId,
      jobId,
      completed,
      total,
      status,
      progress,
    })
  }

  function handleJobFailed({ error }) {
    setStatus('渲染失败: ' + (error || '未知错误'))
    emitPlaybackState()
    callbacks.onRenderFailed?.({
      trackId: state.trackId,
      jobId: phraseStore.getJobId(),
      error: error || '未知错误',
    })
  }

  function handlePhraseReady(payload = {}) {
    if (state.trackId == null || !Number.isInteger(payload.phraseIndex)) return
    const phrase = phraseStore.getPhrase(payload.phraseIndex)
    console.log('[RuntimeSession] Runtime phrase ready bridged', {
      trackId: state.trackId,
      phraseIndex: payload.phraseIndex,
      startMs: payload.startMs,
      durationMs: payload.durationMs,
    })
    callbacks.onPhraseReady?.({
      trackId: state.trackId,
      jobId: phraseStore.getJobId(),
      phraseIndex: payload.phraseIndex,
      inputHash: payload.inputHash || phrase?.inputHash || null,
      startMs: payload.startMs,
      durationMs: payload.durationMs,
    })
  }

  return function bindRuntimeEvents(notifyDirty) {
    eventBus.on(EVENTS.PHRASES_REBUILT, handlePhraseRebuilt)
    eventBus.on(EVENTS.PHRASES_EDITED, notifyDirty)
    eventBus.on(EVENTS.TRANSPORT_PLAY, handleTransportStateChange)
    eventBus.on(EVENTS.TRANSPORT_PAUSE, handleTransportStateChange)
    eventBus.on(EVENTS.TRANSPORT_SEEK_UPDATE, handleTransportStateChange)
    eventBus.on(EVENTS.TRANSPORT_TICK, handleTransportTick)
    eventBus.on(EVENTS.TRANSPORT_SEEK, handleTransportSeek)
    eventBus.on(EVENTS.JOB_SUBMITTED, handleJobSubmitted)
    eventBus.on(EVENTS.PITCH_LOADED, handlePitchLoaded)
    eventBus.on(EVENTS.JOB_PROGRESS, handleJobProgress)
    eventBus.on(EVENTS.JOB_FAILED, handleJobFailed)
    eventBus.on(EVENTS.RENDER_COMPLETE, handlePhraseReady)
  }
}
