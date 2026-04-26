import {
  createProjectMixState,
  getProjectReverbPreset,
  listProjectReverbPresetTags,
  listProjectReverbPresets,
} from '../project/projectMixState.js'
import { getMasterChainPreset, MASTER_CHAIN_PRESETS, mergeEqBand, normalizeMasterChain } from '../project/masterChainState.js'
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
    // master chain 同样要在加载/重建工程时同步，否则 store 配置 vs audioGraph
    // 节点参数会脱节（pan 漏同步那个 bug 的同款问题）
    this.audioGraph?.setMasterChainConfig?.(mixState.masterChain)
    ;(Array.isArray(resolvedProject?.tracks) ? resolvedProject.tracks : []).forEach((track) => {
      if (!track?.id) return
      this.audioGraph?.syncTrackState?.(track.id, {
        volume: track?.playbackState?.volume,
        // pan 必须在加载/重建工程时同步给 audioGraph 的 channel——否则 store 的 pan
        // 跟 StereoPannerNode 的实际值会脱节，UI 显示 R100 但音频在正中
        pan: track?.playbackState?.pan,
        reverbSend: track?.playbackState?.reverbSend,
        reverb: track?.playbackState?.reverb,
        reverbConfig: track?.playbackState?.reverbConfig,
        guitarTone: track?.playbackState?.guitarTone,
      })
    })
    return mixState
  }

  // ===== Master Chain =====

  getMasterChain() {
    return normalizeMasterChain(this.getMixState()?.masterChain)
  }

  // 通用入口：传一个 patch（可以是 { enabled }, { eq: {...} }, { compressor: {...} }, ...）
  // 内部走 mergeProjectMixState（masterChain 字段会被 mergeMasterChain 合并），
  // 然后 store.updateProjectMixState、push 给 audioGraph、按需 saveProject
  setMasterChain(patch = {}, { commit = true } = {}) {
    if (!patch || typeof patch !== 'object') return null
    this.store?.ensureProject?.()
    const mixState = this.store?.updateProjectMixState?.({ masterChain: patch })
      || createProjectMixState({ masterChain: patch })
    this.audioGraph?.setMasterChainConfig?.(mixState.masterChain)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.logger?.info?.('Master chain updated', { patch })
    }
    return mixState.masterChain
  }

  setMasterChainEnabled(enabled, options = {}) {
    return this.setMasterChain({ enabled: Boolean(enabled) }, options)
  }

  setMasterEqEnabled(enabled, options = {}) {
    return this.setMasterChain({ eq: { enabled: Boolean(enabled) } }, options)
  }

  // EQ 单段调参：UI 拖某段的 freq / gain / Q 时调
  setMasterEqBand(bandIndex, bandPatch = {}, { commit = true } = {}) {
    if (!Number.isInteger(bandIndex) || bandIndex < 0) return null
    this.store?.ensureProject?.()
    const current = this.getMasterChain()
    const merged = mergeEqBand(current, bandIndex, bandPatch)
    const mixState = this.store?.updateProjectMixState?.({ masterChain: merged })
      || createProjectMixState({ masterChain: merged })
    this.audioGraph?.setMasterChainConfig?.(mixState.masterChain)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
    }
    return mixState.masterChain
  }

  setMasterCompressorEnabled(enabled, options = {}) {
    return this.setMasterChain({ compressor: { enabled: Boolean(enabled) } }, options)
  }

  setMasterCompressor(patch = {}, options = {}) {
    return this.setMasterChain({ compressor: patch }, options)
  }

  setMasterLimiterEnabled(enabled, options = {}) {
    return this.setMasterChain({ limiter: { enabled: Boolean(enabled) } }, options)
  }

  setMasterLimiter(patch = {}, options = {}) {
    return this.setMasterChain({ limiter: patch }, options)
  }

  // 一次性把所有参数设为预设值——presetId 跟着写入，UI 据此显示当前激活的预设名
  setMasterChainPreset(presetId, { commit = true } = {}) {
    const preset = getMasterChainPreset(presetId)
    if (!preset) return null
    this.store?.ensureProject?.()
    const next = normalizeMasterChain({ ...preset.config, presetId: preset.id })
    const mixState = this.store?.updateProjectMixState?.({ masterChain: next })
      || createProjectMixState({ masterChain: next })
    this.audioGraph?.setMasterChainConfig?.(mixState.masterChain)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.logger?.info?.('Master chain preset applied', { presetId: preset.id, presetName: preset.name })
    }
    return mixState.masterChain
  }

  getMasterChainPresets() {
    return MASTER_CHAIN_PRESETS
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
