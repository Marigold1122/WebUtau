import { getReverbPreset } from '../project/reverbConfigState.js'
import { ReverbUpdateCoalescer } from '../audio/reverb/ReverbUpdateCoalescer.js'
import { isSameReverbConfig } from '../audio/reverb/ReverbConfigDiff.js'
import { markReverbProbe } from '../audio/reverb/ReverbDebugProbe.js'
import { isEmptyReverbPatch, normalizeReverbPatch } from '../audio/reverb/ReverbPatchValidator.js'
import {
  normalizeTrackReverbConfig,
  normalizeTrackReverbSend,
  normalizeTrackVolume,
} from '../project/trackPlaybackState.js'

export class TrackMonitorController {
  constructor({
    store,
    sessionStore,
    focusSoloController,
    transportCoordinator,
    persistence = null,
    refreshProjectPlayback = null,
    render,
    view,
    logger = null,
  }) {
    this.store = store
    this.sessionStore = sessionStore
    this.focusSoloController = focusSoloController
    this.transportCoordinator = transportCoordinator
    this.persistence = persistence
    this.refreshProjectPlayback = refreshProjectPlayback
    this.render = render
    this.view = view
    this.logger = logger
    this.trackReverbConfigCoalescer = new ReverbUpdateCoalescer({
      onFlush: (trackId, patch) => {
        this._applyTrackReverbConfig(trackId, patch, { commit: false }).catch((error) => {
          this.logger?.warn?.('Track reverb realtime patch flush failed', {
            trackId,
            error: error?.message || String(error),
          })
        })
      },
    })
    this.trackReverbSendCoalescer = new ReverbUpdateCoalescer({
      onFlush: (trackId, patch) => {
        if (!Object.prototype.hasOwnProperty.call(patch || {}, 'sendAmount')) return
        this._applyTrackReverbSend(trackId, patch.sendAmount, { commit: false }).catch((error) => {
          this.logger?.warn?.('Track reverb send realtime flush failed', {
            trackId,
            error: error?.message || String(error),
          })
        })
      },
    })
  }

  async toggleSelectedTrackSolo() {
    const track = this.store.getSelectedTrack()
    if (!track) return false
    return this.toggleTrackSolo(track.id)
  }

  async toggleSelectedTrackMute() {
    const track = this.store.getSelectedTrack()
    if (!track) return false
    return this.toggleTrackMute(track.id)
  }

  async toggleTrackSolo(trackId) {
    return this._togglePlaybackFlag(trackId, 'solo')
  }

  async toggleTrackMute(trackId) {
    return this._togglePlaybackFlag(trackId, 'mute')
  }

  async setTrackVolume(trackId, volume, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const nextVolume = normalizeTrackVolume(volume, track.playbackState?.volume)
    const currentVolume = normalizeTrackVolume(track.playbackState?.volume)
    if (Math.abs(nextVolume - currentVolume) < 0.0001 && !commit) {
      return false
    }

    this.store.updateTrackPlaybackState(track.id, { volume: nextVolume })
    await this.transportCoordinator.setTrackVolume(track.id, nextVolume)

    if (commit) {
      this.render('track-volume-changed')
      this.view.setStatus(this._buildVolumeStatusText(track.name, nextVolume))
      this.logger?.info?.('Track volume updated', {
        trackId: track.id,
        trackName: track.name,
        volume: nextVolume,
      })
    }

    return true
  }

  async setTrackReverbSend(trackId, sendAmount, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const currentSendAmount = normalizeTrackReverbSend(track.playbackState?.reverbSend)
    const nextSendAmount = normalizeTrackReverbSend(sendAmount, track.playbackState?.reverbSend)

    if (!commit) {
      if (Math.abs(nextSendAmount - currentSendAmount) < 0.0001) return false
      return this.trackReverbSendCoalescer.enqueue(track.id, { sendAmount: nextSendAmount })
    }

    this.trackReverbSendCoalescer.takePending(track.id)
    return this._applyTrackReverbSend(track.id, nextSendAmount, { commit: true })
  }

  async _applyTrackReverbSend(trackId, sendAmount, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const currentSendAmount = normalizeTrackReverbSend(track.playbackState?.reverbSend)
    const nextSendAmount = normalizeTrackReverbSend(sendAmount, currentSendAmount)
    if (Math.abs(nextSendAmount - currentSendAmount) < 0.0001) return false

    this.store.updateTrackPlaybackState(track.id, { reverbSend: nextSendAmount })
    await this.transportCoordinator.setTrackReverbSend(track.id, nextSendAmount)

    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.render('track-reverb-send-changed')
      this.view.setStatus(this._buildReverbSendStatusText(track.name, nextSendAmount))
      this.logger?.info?.('Track reverb send updated', {
        trackId: track.id,
        trackName: track.name,
        reverbSend: nextSendAmount,
      })
    }

    return true
  }

  async setTrackReverbConfig(trackId, config, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false
    markReverbProbe('trackReverbConfigCalls')
    const currentConfig = normalizeTrackReverbConfig(track.playbackState?.reverbConfig)

    if (!commit) {
      const normalizedPatch = normalizeReverbPatch(
        track.playbackState?.reverb?.engineId,
        config || {},
        currentConfig,
      ).patch
      if (isEmptyReverbPatch(normalizedPatch)) return false
      return this.trackReverbConfigCoalescer.enqueue(track.id, normalizedPatch)
    }

    const pendingRealtimePatch = this.trackReverbConfigCoalescer.takePending(track.id) || {}
    const mergedInput = {
      ...pendingRealtimePatch,
      ...(config || {}),
    }
    const normalizedPatch = normalizeReverbPatch(
      track.playbackState?.reverb?.engineId,
      mergedInput,
      currentConfig,
    ).patch
    if (isEmptyReverbPatch(normalizedPatch)) return false
    return this._applyTrackReverbConfig(track.id, normalizedPatch, { commit: true })
  }

  async setTrackReverbPreset(trackId, presetId, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const preset = getReverbPreset(presetId)
    const nextConfig = normalizeTrackReverbConfig(preset.config, track.playbackState?.reverbConfig)
    const currentPresetId = track.playbackState?.reverbPresetId || ''
    if (preset.id === currentPresetId && isSameReverbConfig(nextConfig, track.playbackState?.reverbConfig)) {
      return false
    }

    this.trackReverbConfigCoalescer.clear(track.id)
    this.store.updateTrackPlaybackState(track.id, {
      reverbPresetId: preset.id,
      reverbConfig: nextConfig,
    })
    await this.transportCoordinator.setTrackReverbConfig(track.id, nextConfig)

    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.render('track-reverb-preset-changed')
      this.view.setStatus(this._buildReverbPresetStatusText(track.name, preset.name))
      this.logger?.info?.('Track reverb preset updated', {
        trackId: track.id,
        trackName: track.name,
        reverbPresetId: preset.id,
      })
    }

    return true
  }

  async _applyTrackReverbConfig(trackId, config, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const currentConfig = normalizeTrackReverbConfig(track.playbackState?.reverbConfig)
    const nextConfig = normalizeTrackReverbConfig(config, currentConfig)
    if (isSameReverbConfig(nextConfig, currentConfig)) {
      return false
    }

    this.store.updateTrackPlaybackState(track.id, { reverbConfig: nextConfig })
    await this.transportCoordinator.setTrackReverbConfig(track.id, nextConfig)

    if (commit) {
      this.persistence?.saveProject?.(this.store?.getProject?.())
      this.render('track-reverb-config-changed')
      this.view.setStatus(this._buildReverbConfigStatusText(track.name))
      this.logger?.info?.('Track reverb config updated', {
        trackId: track.id,
        trackName: track.name,
        reverbConfig: nextConfig,
      })
    }

    return true
  }

  async _togglePlaybackFlag(trackId, flagKey) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    this._promotePersistentMonitorState()

    const nextValue = !Boolean(track.playbackState?.[flagKey])
    this.store.setSelectedTrack(track.id)
    this.store.updateTrackPlaybackState(track.id, { [flagKey]: nextValue })
    this.render(`track-${flagKey}-toggled`)
    this.view.setStatus(this._buildStatusText(track.name, flagKey, nextValue))
    this.logger?.info?.(`Track monitor updated | ${flagKey}=${nextValue}`, {
      trackId: track.id,
      trackName: track.name,
    })
    if (this.refreshProjectPlayback) {
      await this.refreshProjectPlayback(`monitor-${flagKey}`)
    } else {
      await this.transportCoordinator.refreshProjectPlayback(`monitor-${flagKey}`)
    }
    return true
  }

  _promotePersistentMonitorState() {
    if (!this.sessionStore.hasFocusSoloTrack()) return
    this.focusSoloController.markPersistentMonitorChange()
    this.focusSoloController.clearCurrentTrack()
  }

  _buildStatusText(trackName, flagKey, enabled) {
    if (flagKey === 'solo') {
      return enabled
        ? `${trackName} 已开启独奏 / Solo enabled`
        : `${trackName} 已关闭独奏 / Solo disabled`
    }
    return enabled
      ? `${trackName} 已静音 / Mute enabled`
      : `${trackName} 已取消静音 / Mute disabled`
  }

  _buildVolumeStatusText(trackName, volume) {
    return `${trackName} 音量 / Volume ${Math.round(normalizeTrackVolume(volume) * 100)}%`
  }

  _buildReverbSendStatusText(trackName, sendAmount) {
    return `${trackName} 混响发送 / Reverb send ${Math.round(normalizeTrackReverbSend(sendAmount) * 100)}%`
  }

  _buildReverbConfigStatusText(trackName) {
    return `${trackName} 混响参数已更新 / Reverb settings updated`
  }

  _buildReverbPresetStatusText(trackName, presetName) {
    return `${trackName} 混响预设 / Reverb preset ${presetName}`
  }
}
