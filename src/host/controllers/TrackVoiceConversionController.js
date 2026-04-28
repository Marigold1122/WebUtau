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
import { t } from '../../i18n/index.js'
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
  if (!track) return t('voiceConversion.pick_track')
  if (!isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return ''
  if (!canConvertTrack(track)) return t('voiceConversion.must_finish_render')
  if (state.status === 'converting') return t('voiceConversion.converting')
  if (state.stale) return state.error || t('voiceConversion.stale')
  if (state.status === 'failed') return state.error || t('voiceConversion.failed')
  if (state.error && hasReusableResult(state)) {
    return state.appliedVariant === 'converted'
      ? t('voiceConversion.fail_apply_change')
      : t('voiceConversion.fail_keep_old')
  }
  if (hasReusableResult(state) && state.appliedVariant === 'converted') {
    return draftReferenceChanged || draftParamsChanged
      ? t('voiceConversion.using_converted_changed')
      : t('voiceConversion.using_converted')
  }
  if (hasReusableResult(state)) {
    return draftReferenceChanged || draftParamsChanged
      ? t('voiceConversion.have_result_changed')
      : t('voiceConversion.have_result')
  }
  if (hasDraftReference) {
    return draftParamsChanged
      ? t('voiceConversion.ready_changed')
      : t('voiceConversion.ready')
  }
  return t('voiceConversion.pick_reference_first')
}

function buildDraftText(track, state, draftReferenceChanged, draftParamsChanged) {
  if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return ''
  if (!canConvertTrack(track)) return ''
  const hasPreviousResult = hasCompletedResult(state)
  if (draftReferenceChanged && draftParamsChanged) {
    return hasPreviousResult
      ? t('voiceConversion.draft_ref_changed')
      : t('voiceConversion.draft_ref_param_changed')
  }
  if (draftReferenceChanged) {
    return hasPreviousResult
      ? t('voiceConversion.draft_ref_set')
      : t('voiceConversion.draft_ref_initial')
  }
  if (draftParamsChanged) {
    return hasPreviousResult
      ? t('voiceConversion.draft_param_changed')
      : t('voiceConversion.draft_param_set')
  }
  if (!state.referenceAudioName) return t('voiceConversion.no_result')
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
  constructor(message) {
    super(message || t('voiceConversion.canceled'))
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
      disabledText: canConvertTrack(track) ? '' : t('voiceConversion.must_finish_render_disabled'),
      messageTone: canConvertTrack(track) ? 'idle' : 'blocked',
      statusText: buildStatusText(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference),
      draftText: buildDraftText(track, state, draftReferenceChanged, draftParamsChanged),
      statusTone: buildStatusTone(track, state, draftReferenceChanged, draftParamsChanged, hasDraftReference),
      draftTone: buildDraftTone(track, state, draftReferenceChanged, draftParamsChanged),
      params,
      referenceLabel: draftReference?.file?.name || state.referenceAudioName || t('inspector.vc.no_reference'),
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
    if (!canConvertTrack(track)) throw new Error(t('voiceConversion.not_yet'))
    if (this.activeConversions.has(trackId)) throw new Error(t('voiceConversion.in_progress'))

    const draftReference = this.referenceFiles.get(trackId)
    if (!(draftReference?.file instanceof File)) throw new Error(t('voiceConversion.pick_reference'))

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
        throw new Error(t('voiceConversion.track_changed'))
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
      const failedState = failTrackVoiceConversion(this.store.getTrack(trackId)?.voiceConversionState, error?.message || t('voiceConversion.failed'))
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
