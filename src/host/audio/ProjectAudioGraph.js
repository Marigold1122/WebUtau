import {
  normalizeTrackReverbConfig,
  normalizeTrackReverbSend,
  normalizeTrackVolume,
  resolveTrackPlaybackGain,
} from '../project/trackPlaybackState.js'
import { isSameReverbConfig } from './reverb/ReverbConfigDiff.js'
import { LEGACY_REVERB_ENGINE_ID } from './reverb/ReverbParameterSchema.js'
import { startToneAudio } from './instruments/toneRuntime.js'
import { TrackReverbBus } from './TrackReverbBus.js'

export class ProjectAudioGraph {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.readyPromise = null
    this.rawContext = null
    this.masterGain = null
    this.defaultReverbConfig = normalizeTrackReverbConfig()
    this.trackStates = new Map()
    this.trackChannels = new Map()
  }

  async ensureReady() {
    if (this.rawContext) return this.rawContext
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const rawContext = await startToneAudio()
        this.rawContext = rawContext
        this.masterGain = rawContext.createGain()
        this.masterGain.gain.value = 1
        this.masterGain.connect(rawContext.destination)

        this.trackStates.forEach((_state, trackId) => {
          this._ensureTrackChannel(trackId)
          this._syncTrackChannel(trackId)
        })
        return rawContext
      })().catch((error) => {
        this.readyPromise = null
        throw error
      })
    }
    return this.readyPromise
  }

  syncTrackState(trackId, changes = {}) {
    if (!trackId) return false
    const state = this._mergeTrackState(trackId, changes)
    if (!this.rawContext) return state
    this._ensureTrackChannel(trackId)
    this._syncTrackChannel(trackId, state)
    return state
  }

  setTrackVolume(trackId, volume) {
    return Boolean(this.syncTrackState(trackId, { volume }))
  }

  setTrackReverbSend(trackId, reverbSend) {
    return Boolean(this.syncTrackState(trackId, { reverbSend }))
  }

  setTrackSendAmount(trackId, sendAmount) {
    return this.setTrackReverbSend(trackId, sendAmount)
  }

  setTrackReverbConfig(trackId, reverbConfig) {
    return Boolean(this.syncTrackState(trackId, { reverbConfig }))
  }

  setReverbConfig(config = {}) {
    this.defaultReverbConfig = normalizeTrackReverbConfig(config, this.defaultReverbConfig)
    return this.defaultReverbConfig
  }

  getTrackInput(trackId, defaults = {}) {
    if (!trackId || !this.rawContext) return null
    this._mergeTrackState(trackId, defaults)
    const channel = this._ensureTrackChannel(trackId)
    this._syncTrackChannel(trackId)
    return channel?.input || null
  }

  releaseTrack(trackId) {
    if (!trackId) return false
    this.trackStates.delete(trackId)
    const channel = this.trackChannels.get(trackId)
    if (!channel) return false

    this.trackChannels.delete(trackId)
    channel.reverbBus?.dispose?.()
    try { channel.input.disconnect() } catch (_error) {}
    try { channel.volume.disconnect() } catch (_error) {}
    try { channel.send.disconnect() } catch (_error) {}
    return true
  }

  _mergeTrackState(trackId, changes = {}) {
    const reverbSource = changes?.reverb && typeof changes.reverb === 'object'
      ? changes.reverb
      : null
    const previous = this.trackStates.get(trackId) || {
      volume: normalizeTrackVolume(),
      reverbSend: normalizeTrackReverbSend(),
      reverbConfig: normalizeTrackReverbConfig({}, this.defaultReverbConfig),
      reverbEngineId: LEGACY_REVERB_ENGINE_ID,
    }
    const hasReverbConfigChange = (
      Object.prototype.hasOwnProperty.call(reverbSource || {}, 'config')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'highCutHz')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'lowCutHz')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'decaySec')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'decayCurve')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'preDelaySec')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'returnGain')
      || Object.prototype.hasOwnProperty.call(changes, 'reverbConfig')
    )
    const hasReverbEngineChange = (
      Object.prototype.hasOwnProperty.call(changes, 'reverbEngineId')
      || Object.prototype.hasOwnProperty.call(reverbSource || {}, 'engineId')
    )
    const nextState = {
      volume: Object.prototype.hasOwnProperty.call(changes, 'volume')
        ? normalizeTrackVolume(changes.volume, previous.volume)
        : previous.volume,
      reverbSend: (
        Object.prototype.hasOwnProperty.call(changes, 'reverbSend')
        || Object.prototype.hasOwnProperty.call(changes, 'sendAmount')
      )
        ? normalizeTrackReverbSend(
          changes.reverbSend == null ? changes.sendAmount : changes.reverbSend,
          previous.reverbSend,
        )
        : previous.reverbSend,
      reverbConfig: hasReverbConfigChange
        ? normalizeTrackReverbConfig(
          changes.reverbConfig == null ? (reverbSource?.config ?? changes.reverb) : changes.reverbConfig,
          previous.reverbConfig ?? this.defaultReverbConfig,
        )
        : previous.reverbConfig,
      reverbEngineId: hasReverbEngineChange
        ? this._normalizeReverbEngineId(
          changes.reverbEngineId == null ? reverbSource?.engineId : changes.reverbEngineId,
          previous.reverbEngineId,
        )
        : previous.reverbEngineId,
    }
    this.trackStates.set(trackId, nextState)
    return nextState
  }

  _ensureTrackChannel(trackId) {
    let channel = this.trackChannels.get(trackId)
    if (channel || !this.rawContext || !this.masterGain) {
      return channel || null
    }

    const state = this.trackStates.get(trackId) || this._mergeTrackState(trackId, {})
    const input = this.rawContext.createGain()
    const volume = this.rawContext.createGain()
    const send = this.rawContext.createGain()
    const reverbBus = new TrackReverbBus({
      logger: this.logger,
      config: state.reverbConfig ?? this.defaultReverbConfig,
      engineId: state.reverbEngineId,
    })

    input.connect(volume)
    volume.connect(this.masterGain)
    input.connect(send)
    reverbBus.attach({
      rawContext: this.rawContext,
      inputNode: send,
      outputNode: this.masterGain,
    })

    channel = {
      input,
      volume,
      send,
      reverbBus,
      reverbEngineId: state.reverbEngineId,
      lastReverbConfig: normalizeTrackReverbConfig(
        state.reverbConfig,
        this.defaultReverbConfig,
      ),
    }
    this.trackChannels.set(trackId, channel)
    return channel
  }

  _syncTrackChannel(trackId, state = null) {
    const channel = this.trackChannels.get(trackId)
    const nextState = state || this.trackStates.get(trackId)
    if (!channel || !nextState) return false
    channel.volume.gain.value = resolveTrackPlaybackGain(nextState.volume)
    channel.send.gain.value = nextState.reverbSend
    const nextReverbConfig = normalizeTrackReverbConfig(
      nextState.reverbConfig,
      channel.lastReverbConfig || this.defaultReverbConfig,
    )
    if (channel.reverbEngineId !== nextState.reverbEngineId) {
      channel.reverbBus?.dispose?.()
      channel.reverbBus = new TrackReverbBus({
        logger: this.logger,
        config: nextReverbConfig,
        engineId: nextState.reverbEngineId,
      })
      channel.reverbBus.attach({
        rawContext: this.rawContext,
        inputNode: channel.send,
        outputNode: this.masterGain,
      })
      channel.reverbEngineId = nextState.reverbEngineId
      channel.lastReverbConfig = nextReverbConfig
      return true
    }
    if (!isSameReverbConfig(channel.lastReverbConfig, nextReverbConfig)) {
      channel.reverbBus?.setConfig?.(nextReverbConfig)
      channel.lastReverbConfig = nextReverbConfig
    }
    return true
  }

  _normalizeReverbEngineId(value, fallback = LEGACY_REVERB_ENGINE_ID) {
    const resolvedValue = typeof value === 'string' ? value.trim() : ''
    if (resolvedValue) return resolvedValue
    const resolvedFallback = typeof fallback === 'string' ? fallback.trim() : ''
    return resolvedFallback || LEGACY_REVERB_ENGINE_ID
  }
}
