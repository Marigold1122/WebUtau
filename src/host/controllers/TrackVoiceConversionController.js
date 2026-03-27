import {
  applyConvertedTrackVoice,
  beginTrackVoiceConversion,
  clearTrackVoiceConversion,
  cloneTrackVoiceConversionState,
  completeTrackVoiceConversion,
  createTrackVoiceConversionState,
  failTrackVoiceConversion,
  invalidateTrackVoiceConversion,
  restoreOriginalTrackVoice,
} from '../vocal/TrackVoiceConversionState.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
function buildFileSignature(file) {
  if (!(file instanceof File)) return null
  return [file.name || 'reference', file.size || 0, file.lastModified || 0].join(':')
}

function buildParams(state = null, draft = null) {
  return createTrackVoiceConversionState({ params: draft || state?.params || undefined }).params
}

function buildParamSignature(params) {
  return [params.diffusionSteps, params.lengthAdjust, params.cfgRate, params.f0Condition ? 1 : 0, params.autoF0Adjust ? 1 : 0, params.pitchShift].join(':')
}

function buildSourceJobId(track) {
  return track?.vocalManifest?.jobId || track?.jobRef?.jobId || null
}

function buildSourceAssetSignature(track, jobId) {
  return [track?.id || 'track', jobId || 'job', track?.revision || 0].join(':')
}

function buildResultAssetKey(track, jobId, referenceSignature, params) {
  return [track?.id || 'track', jobId || 'job', track?.revision || 0, referenceSignature || 'reference', buildParamSignature(params)].join(':')
}

function canConvertTrack(track) {
  return Boolean(
    track
    && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
    && track.renderState?.status === 'completed'
    && buildSourceJobId(track),
  )
}

function hasReusableResult(state) {
  return Boolean(state?.resultAssetKey && state?.resultAssetUrl && !state?.stale)
}

function hasCompletedResult(state) {
  return Boolean(state?.referenceAudioName || state?.resultAssetKey || state?.resultAssetUrl)
}

function buildStatusText(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference) {
  if (!track) return '请选择轨道'
  if (!isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return ''
  if (!canConvertTrack(track)) return '请先完成当前轨的人声合成，再进行音色转换'
  if (state.status === 'converting') return '正在进行本地音色转换...'
  if (state.stale) return state.error || '当前结果已失效，需要重新转换'
  if (state.status === 'failed') return state.error || '音色转换失败'
  if (state.error && hasReusableResult(state)) {
    return state.appliedVariant === 'converted'
      ? '新的转换失败，当前仍在使用上一版转换结果'
      : '新的转换失败，已保留上一版转换结果'
  }
  if (hasReusableResult(state) && state.appliedVariant === 'converted') {
    return draftReferenceChanged || draftParamsChanged
      ? '当前正在使用转换后人声，右侧配置已变更，重新转换后才会更新结果'
      : '当前正在使用转换后人声'
  }
  if (hasReusableResult(state)) {
    return draftReferenceChanged || draftParamsChanged
      ? '已存在转换结果，右侧配置已变更，重新转换后才会更新结果'
      : '已存在转换结果，尚未应用到播放'
  }
  if (hasDraftReference) {
    return draftParamsChanged
      ? '参考音频与参数已就绪，可以开始转换'
      : '参考音频已就绪，可以开始转换'
  }
  return '请选择参考音频并开始转换'
}

function buildDraftText(track, state, draftReferenceChanged, draftParamsChanged) {
  if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return ''
  if (!canConvertTrack(track)) return ''
  const hasPreviousResult = hasCompletedResult(state)
  if (draftReferenceChanged && draftParamsChanged) {
    return hasPreviousResult
      ? '已选择新的参考音频并修改参数，重新转换后生效'
      : '参考音频与参数已就绪，开始转换后生效'
  }
  if (draftReferenceChanged) {
    return hasPreviousResult
      ? '已选择新的参考音频，重新转换后生效'
      : '已选择参考音频，开始转换后生效'
  }
  if (draftParamsChanged) {
    return hasPreviousResult
      ? '参数已修改，重新转换后生效'
      : '参数已设置，开始转换后生效'
  }
  if (!state.referenceAudioName) return '当前还没有已完成的转换结果'
  return ''
}

function buildStatusTone(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference) {
  if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return 'idle'
  if (!canConvertTrack(track)) return 'blocked'
  if (state.status === 'converting') return 'converting'
  if (state.status === 'failed') return 'failed'
  if (state.stale) return 'warning'
  if (state.error && hasReusableResult(state)) return 'warning'
  if (hasReusableResult(state) && state.appliedVariant === 'converted') {
    return draftReferenceChanged || draftParamsChanged ? 'warning' : 'active'
  }
  if (hasReusableResult(state)) {
    return draftReferenceChanged || draftParamsChanged ? 'warning' : 'ready'
  }
  if (hasDraftReference) return 'ready'
  return 'blocked'
}

function buildDraftTone(track, state, draftReferenceChanged, draftParamsChanged) {
  if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return 'hint'
  if (!canConvertTrack(track)) return 'hint'
  const hasPreviousResult = hasCompletedResult(state)
  if (draftReferenceChanged || draftParamsChanged) {
    return hasPreviousResult ? 'warning' : 'hint'
  }
  if (!state.referenceAudioName) return 'hint'
  return 'hint'
}

function isAbortError(error) {
  return Boolean(
    error
    && (
      error.name === 'AbortError'
      || error.code === 'ERR_CANCELED'
      || error.message === 'The operation was aborted.'
    )
  )
}

export class VoiceConversionCancelledError extends Error {
  constructor(message = '已取消当前音色转换') {
    super(message)
    this.name = 'VoiceConversionCancelledError'
  }
}
export class TrackVoiceConversionController {
  constructor({
    store,
    renderOutputGateway,
    seedVcGateway,
    assetRegistry,
    transportCoordinator,
    refreshProjectPlayback = null,
    render,
    logger = null,
  }) {
    this.store = store
    this.renderOutputGateway = renderOutputGateway
    this.seedVcGateway = seedVcGateway
    this.assetRegistry = assetRegistry
    this.transportCoordinator = transportCoordinator
    this.refreshProjectPlayback = refreshProjectPlayback
    this.render = render
    this.logger = logger
    this.referenceFiles = new Map()
    this.paramDrafts = new Map()
    this.activeConversions = new Map()
  }

  reset() {
    this.activeConversions.forEach((entry) => entry.abortController?.abort?.())
    this.activeConversions.clear()
    this.referenceFiles.clear()
    this.paramDrafts.clear()
    this.assetRegistry.reset()
  }

  setReferenceFile(trackId, file) {
    if (!trackId) return
    if (!(file instanceof File)) {
      this.referenceFiles.delete(trackId)
    } else {
      this.referenceFiles.set(trackId, {
        file,
        signature: buildFileSignature(file),
      })
    }
    this.render('voice-conversion-reference-selected')
  }

  updateParams(trackId, patch = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return
    const nextParams = buildParams(track.voiceConversionState, {
      ...this.paramDrafts.get(trackId),
      ...patch,
    })
    this.paramDrafts.set(trackId, nextParams)
    this.render('voice-conversion-params-updated')
  }
  buildInspectorState(trackId) {
    const track = this.store.getTrack(trackId)
    if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
      return { visible: false }
    }
    const state = cloneTrackVoiceConversionState(track.voiceConversionState)
    const draftReference = this.referenceFiles.get(trackId) || null
    const hasDraftReference = Boolean(draftReference?.file)
    const params = this.paramDrafts.get(trackId) || state.params
    const draftReferenceChanged = Boolean(draftReference?.signature && draftReference.signature !== state.referenceAudioSignature)
    const draftParamsChanged = buildParamSignature(params) !== buildParamSignature(state.params)
    const reusableResult = hasReusableResult(state)

    return {
      visible: true,
      uiState: canConvertTrack(track) ? state.status : 'disabled-wait-render',
      disabledText: canConvertTrack(track) ? '' : '请先完成当前轨的人声合成，再进行音色转换',
      messageTone: canConvertTrack(track) ? 'idle' : 'blocked',
      statusText: buildStatusText(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference),
      draftText: buildDraftText(track, state, draftReferenceChanged, draftParamsChanged),
      statusTone: buildStatusTone(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference),
      draftTone: buildDraftTone(track, state, draftReferenceChanged, draftParamsChanged),
      params,
      referenceLabel: draftReference?.file?.name || state.referenceAudioName || '未选择参考音频',
      canStart: canConvertTrack(track) && state.status !== 'converting' && hasDraftReference,
      canApply: reusableResult && state.status !== 'converting' && state.appliedVariant !== 'converted',
      canRestore: reusableResult && state.status !== 'converting' && state.appliedVariant === 'converted',
      canClear: state.status !== 'converting' && Boolean(state.resultAssetKey || state.error),
      canCancel: state.status === 'converting' && this.activeConversions.has(trackId),
      busy: state.status === 'converting',
    }
  }

  async startConversion(trackId) {
    const track = this.store.getTrack(trackId)
    if (!canConvertTrack(track)) throw new Error('当前轨还不能进行音色转换')
    if (this.activeConversions.has(trackId)) throw new Error('当前轨道正在进行音色转换')

    const draftReference = this.referenceFiles.get(trackId)
    if (!(draftReference?.file instanceof File)) throw new Error('请先选择参考音频')

    const jobId = buildSourceJobId(track)
    const params = this.paramDrafts.get(trackId) || buildParams(track.voiceConversionState)
    const previousState = cloneTrackVoiceConversionState(track.voiceConversionState)
    const requestId = `${trackId}:${Date.now()}:${Math.random().toString(16).slice(2)}`
    const abortController = new AbortController()
    const nextState = beginTrackVoiceConversion(track.voiceConversionState, {
      sourceJobId: jobId,
      sourceRevision: track.revision || 0,
      sourceAssetSignature: buildSourceAssetSignature(track, jobId),
      referenceAudioName: draftReference.file.name || null,
      referenceAudioSignature: draftReference.signature,
      params,
    })
    const wasConverted = track.voiceConversionState?.appliedVariant === 'converted'
    this.activeConversions.set(trackId, { requestId, abortController, previousState })
    this.store.replaceTrackVoiceConversionState(trackId, nextState)
    this.render('voice-conversion-started')
    await this._refreshPlaybackIfNeeded(wasConverted, 'voice-conversion-start')

    try {
      const sourceUrl = this.renderOutputGateway.resolveJobDownloadUrl(jobId)
      const result = await this.seedVcGateway.convert({
        sourceUrl,
        referenceFile: draftReference.file,
        params,
        signal: abortController.signal,
      })
      const active = this.activeConversions.get(trackId)
      if (!active || active.requestId !== requestId) {
        throw new VoiceConversionCancelledError()
      }
      const resultAssetKey = buildResultAssetKey(track, jobId, draftReference.signature, params)
      await this.assetRegistry.ensureAsset({
        assetKey: resultAssetKey,
        assetUrl: result.assetUrl,
        trackId,
        sourceJobId: jobId,
        sourceRevision: track.revision || 0,
      })
      const freshTrack = this.store.getTrack(trackId)
      if (!freshTrack || freshTrack.revision !== (track.revision || 0) || buildSourceJobId(freshTrack) !== jobId) {
        throw new Error('轨道在转换过程中已变化，请重新转换')
      }

      const completedState = completeTrackVoiceConversion(this.store.getTrack(trackId)?.voiceConversionState, {
        sourceJobId: jobId,
        sourceRevision: track.revision || 0,
        sourceAssetSignature: buildSourceAssetSignature(track, jobId),
        resultAssetKey,
        resultAssetUrl: result.assetUrl,
        referenceAudioName: draftReference.file.name || null,
        referenceAudioSignature: draftReference.signature,
        params,
      })
      this.store.replaceTrackVoiceConversionState(trackId, completedState)
      this.paramDrafts.set(trackId, params)
      this.activeConversions.delete(trackId)
      this.logger?.info?.('VoiceConversion ready', { trackId, resultAssetKey, jobId })
      this.render('voice-conversion-ready')
      return completedState
    } catch (error) {
      const active = this.activeConversions.get(trackId)
      const isCurrentRequest = active?.requestId === requestId
      if (isCurrentRequest) {
        this.activeConversions.delete(trackId)
      }
      if (error instanceof VoiceConversionCancelledError || isAbortError(error)) {
        if (isCurrentRequest) {
          this.store.replaceTrackVoiceConversionState(trackId, cloneTrackVoiceConversionState(previousState))
          this.render('voice-conversion-cancelled')
          await this._refreshPlaybackIfNeeded(previousState?.appliedVariant === 'converted', 'voice-conversion-cancelled')
        }
        this.logger?.info?.('VoiceConversion cancelled', { trackId, jobId })
        throw error instanceof VoiceConversionCancelledError ? error : new VoiceConversionCancelledError()
      }
      const failedState = failTrackVoiceConversion(this.store.getTrack(trackId)?.voiceConversionState, error?.message || '音色转换失败')
      this.store.replaceTrackVoiceConversionState(trackId, failedState)
      this.logger?.info?.('VoiceConversion failed', { trackId, error: error?.message || String(error) })
      this.render('voice-conversion-failed')
      throw error
    }
  }

  async cancelConversion(trackId) {
    const active = this.activeConversions.get(trackId)
    if (!trackId || !active) return false
    this.activeConversions.delete(trackId)
    active.abortController?.abort?.()
    this.store.replaceTrackVoiceConversionState(trackId, cloneTrackVoiceConversionState(active.previousState))
    this.logger?.info?.('VoiceConversion cancel requested', { trackId })
    this.render('voice-conversion-cancelled')
    await this._refreshPlaybackIfNeeded(active.previousState?.appliedVariant === 'converted', 'voice-conversion-cancel')
    return true
  }

  async applyConvertedVariant(trackId) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    const state = cloneTrackVoiceConversionState(track.voiceConversionState)
    if (!hasReusableResult(state)) throw new Error('当前没有可应用的转换结果')
    await this.assetRegistry.ensureAsset({
      assetKey: state.resultAssetKey,
      assetUrl: state.resultAssetUrl,
      trackId,
      sourceJobId: state.sourceJobId,
      sourceRevision: state.sourceRevision,
    })

    const nextState = applyConvertedTrackVoice(state)
    this.store.replaceTrackVoiceConversionState(trackId, nextState)
    this.render('voice-conversion-applied')
    await this._refreshPlaybackIfNeeded(true, 'voice-conversion-apply')
    return nextState
  }

  async restoreOriginalVariant(trackId) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    const state = restoreOriginalTrackVoice(track.voiceConversionState)
    this.store.replaceTrackVoiceConversionState(trackId, state)
    this.render('voice-conversion-restored')
    await this._refreshPlaybackIfNeeded(true, 'voice-conversion-restore')
    return state
  }

  async clearConversion(trackId) {
    const active = this.activeConversions.get(trackId)
    if (active) {
      this.activeConversions.delete(trackId)
      active.abortController?.abort?.()
    }
    const track = this.store.getTrack(trackId)
    if (!track) return null
    const wasConverted = track.voiceConversionState?.appliedVariant === 'converted'
    this.assetRegistry.releaseTrack(trackId)
    this.store.replaceTrackVoiceConversionState(trackId, clearTrackVoiceConversion())
    this.render('voice-conversion-cleared')
    await this._refreshPlaybackIfNeeded(wasConverted, 'voice-conversion-clear')
    return this.store.getTrack(trackId)?.voiceConversionState || null
  }

  async invalidateConversion(trackId, reason = '轨道已变更，需要重新转换') {
    const active = this.activeConversions.get(trackId)
    if (active) {
      this.activeConversions.delete(trackId)
      active.abortController?.abort?.()
      this.store.replaceTrackVoiceConversionState(trackId, cloneTrackVoiceConversionState(active.previousState))
    }
    const track = this.store.getTrack(trackId)
    if (!track) return false
    const state = cloneTrackVoiceConversionState(track.voiceConversionState)
    const hasState = Boolean(state.resultAssetKey || state.error || state.status !== 'idle')
    if (!hasState) return false
    if (state.stale && state.appliedVariant === 'original' && (state.error || null) === reason) return false
    const nextState = invalidateTrackVoiceConversion(state, reason)
    const changed = JSON.stringify(nextState) !== JSON.stringify(state)
    if (!changed) return false

    const wasConverted = state.appliedVariant === 'converted'
    this.store.replaceTrackVoiceConversionState(trackId, nextState)
    this.render('voice-conversion-invalidated')
    await this._refreshPlaybackIfNeeded(wasConverted, 'voice-conversion-invalidated')
    return true
  }

  async _refreshPlaybackIfNeeded(shouldRefresh, reason) {
    if (!shouldRefresh) return
    if (!this.transportCoordinator?.isProjectPlaybackActive?.()) return
    if (this.refreshProjectPlayback) {
      await this.refreshProjectPlayback(reason)
      return
    }
    await this.transportCoordinator.refreshProjectPlayback(reason)
  }
}
