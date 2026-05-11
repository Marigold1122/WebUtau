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
import { calcAutoFitMakeupGain } from '../audio/master/lufsMath.js'

export class ProjectMixController {
  constructor({ store, audioGraph, logger = null, persistence = null } = {}) {
    this.store = store
    this.audioGraph = audioGraph
    this.logger = logger
    this.persistence = persistence
    // 自动达标状态机：'idle' → 'measuring' → ('idle' | 'cancelled')
    // 进 measuring 后仅在 transport 自然结束时计算并应用增益；中途暂停 / 停止 / 拖动一律取消
    this._autoFitState = 'idle'
  }

  isAutoFitMeasuring() {
    return this._autoFitState === 'measuring'
  }

  beginAutoFitMeasurement() {
    this._autoFitState = 'measuring'
    this._lastAutoFitResult = null // 进新一轮——旧结果失效
    this.resetLufsIntegrated()
  }

  cancelAutoFitMeasurement() {
    if (this._autoFitState !== 'measuring') return false
    this._autoFitState = 'idle'
    return true
  }

  // 自然结束触发：基于刚刚整首歌的 integrated 计算并应用 makeup gain。
  // 如果不在 measuring 状态（用户没点 autofit，只是普通播放结束）则什么都不做
  finalizeAutoFitMeasurement() {
    if (this._autoFitState !== 'measuring') return null
    this._autoFitState = 'idle'
    // minGatedBlocks 设很小（5）——既然是"完整播完一首歌"的数据，几乎不可能不够
    const result = this.autoFitLoudness({ minGatedBlocks: 5 })
    if (result?.ok && !result.alreadyOnTarget) {
      // 保存"刚刚的成功结果" + 当时 gatedBlockCount——UI 据此显示绿色成功横幅。
      // 当 LUFS 累计块数继续增长（用户开新一轮播放），结果自动失效，状态行回归实时读数
      this._lastAutoFitResult = {
        appliedDb: result.appliedDb,
        deltaLu: result.deltaLu,
        beforeIntegrated: result.snapshot?.integrated,
        // 线性预计：调整后的 integrated ≈ 调整前 + 新增的 dB（被限幅器修正后会略小）
        predictedIntegrated: result.snapshot?.integrated + result.appliedDb,
        targetLufs: result.chain?.loudnessTarget,
        atGatedBlockCount: result.snapshot?.gatedBlockCount || 0,
        hitLimit: result.hitLimit,
        largeAdjustment: result.largeAdjustment,
      }
    } else if (result?.ok && result.alreadyOnTarget) {
      this._lastAutoFitResult = {
        alreadyOnTarget: true,
        deltaLu: result.deltaLu,
        beforeIntegrated: result.snapshot?.integrated,
        predictedIntegrated: result.snapshot?.integrated,
        targetLufs: result.chain?.loudnessTarget,
        atGatedBlockCount: result.snapshot?.gatedBlockCount || 0,
      }
    }
    return result
  }

  // 给 UI 用：返回最近一次 autofit 的结果——前提是之后没有累计新的测量数据。
  // 一旦用户开始新播放、积分块数增长，结果就过期返回 null
  getLastAutoFitResult() {
    if (!this._lastAutoFitResult) return null
    const live = this.audioGraph?.getLufsSnapshot?.()
    const liveBlocks = live?.gatedBlockCount || 0
    if (liveBlocks > (this._lastAutoFitResult.atGatedBlockCount || 0)) {
      // 新数据进来了，旧结果过时——清掉避免下次还显示
      this._lastAutoFitResult = null
      return null
    }
    return this._lastAutoFitResult
  }

  clearLastAutoFitResult() {
    this._lastAutoFitResult = null
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
    // master volume 同步：跟 master chain 同样的 pattern，工程加载 / 重建时必须同步
    this.audioGraph?.setMasterVolume?.(mixState.masterVolume)
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
        // 单轨 insert 链（EQ4 + Comp）—— 与上面字段同款：工程加载 / 重建时必须同步
        inserts: track?.playbackState?.inserts,
      })
    })
    return mixState
  }

  // ===== Master Volume =====
  // 单独的字段（不属于 masterChain），跟 track volume 同款 commit/realtime 语义：
  //   commit:false 实时拖动（写 store + audioGraph，不 render、不存盘）
  //   commit:true 落定（render + saveProject）
  setMasterVolume(volume, { commit = true } = {}) {
    if (!this.store) return null
    this.store.ensureProject?.()
    const mixState = this.store.updateProjectMixState?.({ masterVolume: volume })
      || createProjectMixState({ masterVolume: volume })
    this.audioGraph?.setMasterVolume?.(mixState.masterVolume)
    if (commit) {
      this.persistence?.saveProject?.(this.store.getProject?.())
      this.logger?.info?.('Master volume updated', { volume: mixState.masterVolume })
    }
    return mixState.masterVolume
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
    // preset.config 只覆盖音频处理参数（eq / compressor / limiter / enabled），
    // 不要覆盖 loudnessTarget——那是用户单独配的"成品响度目标"，跨预设保留
    const current = this.getMasterChain()
    const next = normalizeMasterChain({
      ...preset.config,
      presetId: preset.id,
      loudnessTarget: current.loudnessTarget,
    })
    const mixState = this.store?.updateProjectMixState?.({ masterChain: next })
      || createProjectMixState({ masterChain: next })
    this.audioGraph?.setMasterChainConfig?.(mixState.masterChain)
    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.logger?.info?.('Master chain preset applied', { presetId: preset.id, presetName: preset.name })
    }
    return mixState.masterChain
  }

  setMasterChainLoudnessTarget(value, options = {}) {
    return this.setMasterChain({ loudnessTarget: value }, options)
  }

  // 自动达标：读 LufsMeter 当前 integrated → 算 delta → 调主控母带链 makeupGain。
  // 返回值给 UI 写状态用：包含是否成功、最终调了多少 dB、是否撞限幅、是否大调整等。
  //
  // 注意：本函数不主动 reset LUFS——M/S/I 读数保留为"调整前的真实测量值"，
  // 让用户看到"刚才完整播完测出来的就是这个数"。新一轮测量开始（按 play / 重新点 autofit）
  // 由 beginAutoFitMeasurement / 手动 reset / 下一轮 measuring 自动清掉
  autoFitLoudness({ minGatedBlocks = 30 } = {}) {
    const chain = this.getMasterChain()
    const snapshot = this.audioGraph?.getLufsSnapshot?.() || { integrated: -Infinity, gatedBlockCount: 0 }
    if (!Number.isFinite(snapshot.integrated)) {
      return { ok: false, reason: 'no-playback', snapshot, chain }
    }
    if ((snapshot.gatedBlockCount || 0) < minGatedBlocks) {
      // 至少要 3 秒（30 个门控块）的素材，否则 integrated 还在剧烈波动，调出来不准
      return { ok: false, reason: 'insufficient-data', snapshot, chain }
    }
    const result = calcAutoFitMakeupGain({
      currentIntegrated: snapshot.integrated,
      targetLufs: chain.loudnessTarget,
      currentMakeupGainDb: chain.compressor.makeupGain,
    })
    if (!result.ok) {
      return { ok: false, reason: result.reason || 'compute-failed', snapshot, chain }
    }
    if (Math.abs(result.appliedDb) < 0.05) {
      // 已经在 ±0.05 dB 内，没必要调；告诉 UI 已达标
      return { ok: true, alreadyOnTarget: true, snapshot, chain, ...result }
    }
    // 通过 setMasterCompressor patch 把 makeupGain 改了；commit:true → 持久化 + render
    this.setMasterCompressor({ makeupGain: result.nextMakeupGainDb }, { commit: true })
    return { ok: true, alreadyOnTarget: false, snapshot, chain, ...result }
  }

  // ===== LUFS 表 =====

  subscribeLufs(fn) {
    return this.audioGraph?.subscribeLufs?.(fn) || (() => {})
  }

  getLufsSnapshot() {
    return this.audioGraph?.getLufsSnapshot?.() || {
      momentary: -Infinity,
      shortTerm: -Infinity,
      integrated: -Infinity,
      gatedBlockCount: 0,
    }
  }

  resetLufsIntegrated() {
    // 用户手动重置积分时，旧的 autofit 结果也应当失效——避免"已重置但状态行还显示成功横幅"
    this._lastAutoFitResult = null
    this.audioGraph?.resetLufsIntegrated?.()
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
