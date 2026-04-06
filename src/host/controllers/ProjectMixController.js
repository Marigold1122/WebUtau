import {
  createProjectMixState,
  getProjectReverbPreset,
  listProjectReverbPresetTags,
  listProjectReverbPresets,
} from '../project/projectMixState.js'
import { isSameReverbConfig } from '../audio/reverb/ReverbConfigDiff.js'
import { isEmptyReverbPatch, normalizeReverbPatch } from '../audio/reverb/ReverbPatchValidator.js'
import { LEGACY_REVERB_ENGINE_ID } from '../audio/reverb/ReverbParameterSchema.js'

export class ProjectMixController {
  constructor({ store, audioGraph, logger = null, persistence = null } = {}) {
    this.store = store
    this.audioGraph = audioGraph
    this.logger = logger
    this.persistence = persistence
  }

  init() {
    return this.syncProjectState()
  }

  getMixState() {
    return createProjectMixState(this.store?.getProject?.()?.mixState)
  }

  getAvailableReverbPresetTags() {
    return listProjectReverbPresetTags()
  }

  getAvailableReverbPresets(options = {}) {
    return listProjectReverbPresets(options)
  }

  syncProjectState(project = null) {
    const resolvedProject = project ?? this.store?.getProject?.()
    const mixState = createProjectMixState(resolvedProject?.mixState)
    this.audioGraph?.setReverbConfig?.(mixState.reverb)
    ;(Array.isArray(resolvedProject?.tracks) ? resolvedProject.tracks : []).forEach((track) => {
      if (!track?.id) return
      this.audioGraph?.syncTrackState?.(track.id, {
        volume: track?.playbackState?.volume,
        reverbSend: track?.playbackState?.reverbSend,
        reverb: track?.playbackState?.reverb,
        reverbConfig: track?.playbackState?.reverbConfig,
        guitarTone: track?.playbackState?.guitarTone,
      })
    })
    return mixState
  }

  setProjectReverbConfig(config = {}, { commit = true } = {}) {
    this.store?.ensureProject?.()
    const currentMixState = this.getMixState()
    const normalizedPatch = normalizeReverbPatch(
      LEGACY_REVERB_ENGINE_ID,
      config,
      currentMixState?.reverb,
    ).patch
    if (isEmptyReverbPatch(normalizedPatch)) return currentMixState
    const nextReverb = {
      ...(currentMixState?.reverb || {}),
      ...normalizedPatch,
    }
    if (isSameReverbConfig(currentMixState?.reverb, nextReverb)) return currentMixState

    const mixState = this.store?.updateProjectMixState?.({ reverb: normalizedPatch }) || createProjectMixState({
      reverb: normalizedPatch,
    })
    this.audioGraph?.setReverbConfig?.(mixState.reverb)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.logger?.info?.('Project reverb config updated', { reverb: mixState.reverb })
    }
    return mixState
  }

  setProjectReverbPreset(presetId, overrides = null, { commit = true } = {}) {
    this.store?.ensureProject?.()
    const currentMixState = this.getMixState()
    const preset = getProjectReverbPreset(presetId)
    const nextConfig = overrides && typeof overrides === 'object'
      ? overrides
      : preset.config
    if (
      currentMixState?.reverbPresetId === preset.id
      && isSameReverbConfig(currentMixState?.reverb, nextConfig)
    ) {
      return currentMixState
    }
    const mixState = this.store?.updateProjectMixState?.({
      reverbPresetId: preset.id,
      reverb: nextConfig,
    }) || createProjectMixState({
      reverbPresetId: preset.id,
      reverb: nextConfig,
    })
    this.audioGraph?.setReverbConfig?.(mixState.reverb)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.logger?.info?.('Project reverb preset updated', {
        reverbPresetId: mixState.reverbPresetId,
        reverb: mixState.reverb,
      })
    }
    return mixState
  }
}
