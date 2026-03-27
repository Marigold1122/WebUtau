const DEFAULT_PARAMS = Object.freeze({
  diffusionSteps: 20,
  lengthAdjust: 1.0,
  cfgRate: 0.7,
  f0Condition: true,
  autoF0Adjust: false,
  pitchShift: 0,
})

function cloneValue(value, fallback) {
  if (value == null) return fallback
  return structuredClone(value)
}

function normalizeParams(params = {}) {
  return {
    diffusionSteps: Number.isFinite(params.diffusionSteps) ? Math.max(1, Math.round(params.diffusionSteps)) : DEFAULT_PARAMS.diffusionSteps,
    lengthAdjust: Number.isFinite(params.lengthAdjust) ? Math.max(0.5, Math.min(2, params.lengthAdjust)) : DEFAULT_PARAMS.lengthAdjust,
    cfgRate: Number.isFinite(params.cfgRate) ? Math.max(0, Math.min(1, params.cfgRate)) : DEFAULT_PARAMS.cfgRate,
    f0Condition: Boolean(params.f0Condition),
    autoF0Adjust: params.autoF0Adjust == null ? DEFAULT_PARAMS.autoF0Adjust : Boolean(params.autoF0Adjust),
    pitchShift: Number.isFinite(params.pitchShift) ? Math.round(params.pitchShift) : DEFAULT_PARAMS.pitchShift,
  }
}

function createBaseState(state = {}) {
  return {
    status: typeof state.status === 'string' ? state.status : 'idle',
    appliedVariant: state.appliedVariant === 'converted' ? 'converted' : 'original',
    sourceJobId: state.sourceJobId || null,
    sourceRevision: Number.isInteger(state.sourceRevision) ? state.sourceRevision : 0,
    sourceAssetSignature: state.sourceAssetSignature || null,
    resultAssetKey: state.resultAssetKey || null,
    resultAssetUrl: state.resultAssetUrl || null,
    referenceAudioName: state.referenceAudioName || null,
    referenceAudioSignature: state.referenceAudioSignature || null,
    params: normalizeParams(state.params),
    stale: Boolean(state.stale),
    error: state.error || null,
    updatedAt: state.updatedAt || null,
  }
}

function stamp(state) {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
  }
}

export function createTrackVoiceConversionState(state = {}) {
  return stamp(createBaseState(state))
}

export function cloneTrackVoiceConversionState(state) {
  return cloneValue(state, createTrackVoiceConversionState())
}

export function beginTrackVoiceConversion(state, payload = {}) {
  return stamp({
    ...createBaseState(state),
    status: 'converting',
    appliedVariant: 'original',
    sourceJobId: payload.sourceJobId || null,
    sourceRevision: Number.isInteger(payload.sourceRevision) ? payload.sourceRevision : 0,
    sourceAssetSignature: payload.sourceAssetSignature || null,
    referenceAudioName: payload.referenceAudioName || null,
    referenceAudioSignature: payload.referenceAudioSignature || null,
    params: normalizeParams(payload.params),
    stale: false,
    error: null,
  })
}

export function completeTrackVoiceConversion(state, payload = {}) {
  return stamp({
    ...createBaseState(state),
    status: 'ready',
    appliedVariant: 'original',
    sourceJobId: payload.sourceJobId || null,
    sourceRevision: Number.isInteger(payload.sourceRevision) ? payload.sourceRevision : 0,
    sourceAssetSignature: payload.sourceAssetSignature || null,
    resultAssetKey: payload.resultAssetKey || null,
    resultAssetUrl: payload.resultAssetUrl || null,
    referenceAudioName: payload.referenceAudioName || null,
    referenceAudioSignature: payload.referenceAudioSignature || null,
    params: normalizeParams(payload.params),
    stale: false,
    error: null,
  })
}

export function failTrackVoiceConversion(state, error) {
  const current = createBaseState(state)
  if (current.resultAssetKey) {
    return stamp({
      ...current,
      status: 'ready',
      appliedVariant: 'original',
      error: error || '音色转换失败',
    })
  }
  return stamp({
    ...current,
    status: 'failed',
    appliedVariant: 'original',
    error: error || '音色转换失败',
  })
}

export function applyConvertedTrackVoice(state) {
  const current = createBaseState(state)
  if (current.status !== 'ready' || current.stale || !current.resultAssetKey) return stamp(current)
  return stamp({
    ...current,
    appliedVariant: 'converted',
    error: null,
  })
}

export function restoreOriginalTrackVoice(state) {
  return stamp({
    ...createBaseState(state),
    appliedVariant: 'original',
  })
}

export function clearTrackVoiceConversion() {
  return createTrackVoiceConversionState()
}

export function invalidateTrackVoiceConversion(state, reason = '轨道已变更') {
  const current = createBaseState(state)
  if (!current.resultAssetKey) {
    return stamp({
      ...createBaseState(),
      error: null,
    })
  }
  return stamp({
    ...current,
    status: 'ready',
    appliedVariant: 'original',
    stale: true,
    error: reason,
  })
}
