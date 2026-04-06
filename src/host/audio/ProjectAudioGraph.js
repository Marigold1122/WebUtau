import {
  normalizeTrackGuitarToneConfig,
  normalizeTrackReverbConfig,
  normalizeTrackReverbSend,
  normalizeTrackVolume,
  resolveTrackPlaybackGain,
} from '../project/trackPlaybackState.js'
import { isSameReverbConfig } from './reverb/ReverbConfigDiff.js'
import { LEGACY_REVERB_ENGINE_ID } from './reverb/ReverbParameterSchema.js'
import { startToneAudio } from './instruments/toneRuntime.js'
import { TrackReverbBus } from './TrackReverbBus.js'
import { createTrackInsertEffect } from './insert/createTrackInsertEffect.js'
import {
  buildTrackInsertProfile,
  normalizeTrackInsertId,
  supportsTrackGuitarToneInsertId,
} from './insert/trackInsertCatalog.js'

function disconnectNode(node) {
  try { node?.disconnect?.() } catch (_error) {}
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

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

  setTrackGuitarTone(trackId, guitarTone) {
    return Boolean(this.syncTrackState(trackId, { guitarTone }))
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
    channel.insertEffect?.dispose?.()
    channel.reverbBus?.dispose?.()
    disconnectNode(channel.input)
    disconnectNode(channel.postInsert)
    disconnectNode(channel.volume)
    disconnectNode(channel.send)
    return true
  }

  _mergeTrackState(trackId, changes = {}) {
    const reverbSource = changes?.reverb && typeof changes.reverb === 'object'
      ? changes.reverb
      : null
    const previous = this.trackStates.get(trackId) || {
      insertId: null,
      volume: normalizeTrackVolume(),
      reverbSend: normalizeTrackReverbSend(),
      reverbConfig: normalizeTrackReverbConfig({}, this.defaultReverbConfig),
      reverbEngineId: LEGACY_REVERB_ENGINE_ID,
      guitarTone: normalizeTrackGuitarToneConfig(),
    }
    const hasReverbConfigChange = (
      hasOwn(reverbSource || {}, 'config')
      || hasOwn(reverbSource || {}, 'highCutHz')
      || hasOwn(reverbSource || {}, 'lowCutHz')
      || hasOwn(reverbSource || {}, 'decaySec')
      || hasOwn(reverbSource || {}, 'decayCurve')
      || hasOwn(reverbSource || {}, 'preDelaySec')
      || hasOwn(reverbSource || {}, 'returnGain')
      || hasOwn(changes, 'reverbConfig')
    )
    const hasReverbEngineChange = (
      hasOwn(changes, 'reverbEngineId')
      || hasOwn(reverbSource || {}, 'engineId')
    )
    const nextState = {
      insertId: hasOwn(changes, 'insertId')
        ? normalizeTrackInsertId(changes.insertId)
        : previous.insertId,
      volume: hasOwn(changes, 'volume')
        ? normalizeTrackVolume(changes.volume, previous.volume)
        : previous.volume,
      reverbSend: (hasOwn(changes, 'reverbSend') || hasOwn(changes, 'sendAmount'))
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
      guitarTone: hasOwn(changes, 'guitarTone')
        ? normalizeTrackGuitarToneConfig(changes.guitarTone, previous.guitarTone)
        : previous.guitarTone,
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
    const postInsert = this.rawContext.createGain()
    const volume = this.rawContext.createGain()
    const send = this.rawContext.createGain()
    const reverbBus = new TrackReverbBus({
      logger: this.logger,
      config: state.reverbConfig ?? this.defaultReverbConfig,
      engineId: state.reverbEngineId,
    })

    postInsert.connect(volume)
    volume.connect(this.masterGain)
    postInsert.connect(send)
    reverbBus.attach({
      rawContext: this.rawContext,
      inputNode: send,
      outputNode: this.masterGain,
    })

    channel = {
      input,
      postInsert,
      volume,
      send,
      reverbBus,
      reverbEngineId: state.reverbEngineId,
      lastReverbConfig: normalizeTrackReverbConfig(
        state.reverbConfig,
        this.defaultReverbConfig,
      ),
      insertEffect: null,
      insertId: '__uninitialized__',
      insertStateKey: '__uninitialized__',
    }
    this.trackChannels.set(trackId, channel)
    this._syncTrackInsert(channel, state)
    return channel
  }

  _syncTrackChannel(trackId, state = null) {
    const channel = this.trackChannels.get(trackId)
    const nextState = state || this.trackStates.get(trackId)
    if (!channel || !nextState) return false

    this._syncTrackInsert(channel, nextState)
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

  _syncTrackInsert(channel, state) {
    const nextInsertId = normalizeTrackInsertId(state?.insertId)
    const nextInsertStateKey = this._buildInsertStateKey(nextInsertId, state?.guitarTone)
    if (channel.insertStateKey === nextInsertStateKey) return false

    if (
      channel.insertId === nextInsertId
      && nextInsertId
      && channel.insertEffect
      && typeof channel.insertEffect.updateProfile === 'function'
    ) {
      try {
        channel.insertEffect.updateProfile(buildTrackInsertProfile(nextInsertId, {
          guitarToneConfig: state?.guitarTone,
        }))
        channel.insertStateKey = nextInsertStateKey
        return true
      } catch (error) {
        this.logger?.warn?.('Track insert live profile update failed; recreating insert', {
          insertId: nextInsertId,
          error: error?.message || String(error),
        })
      }
    }

    disconnectNode(channel.input)
    channel.insertEffect?.dispose?.()
    channel.insertEffect = null

    try {
      if (nextInsertId) {
        const insertEffect = createTrackInsertEffect({
          rawContext: this.rawContext,
          insertId: nextInsertId,
          guitarToneConfig: state?.guitarTone,
          logger: this.logger,
        })
        if (insertEffect) {
          channel.input.connect(insertEffect.input)
          insertEffect.output.connect(channel.postInsert)
          channel.insertEffect = insertEffect
          channel.insertId = nextInsertId
          channel.insertStateKey = nextInsertStateKey
          return true
        }
      }
    } catch (error) {
      this.logger?.warn?.('Track insert setup failed', {
        insertId: nextInsertId,
        error: error?.message || String(error),
      })
    }

    channel.input.connect(channel.postInsert)
    channel.insertId = null
    channel.insertStateKey = 'none'
    return true
  }

  _buildInsertStateKey(insertId, guitarTone) {
    const normalizedInsertId = normalizeTrackInsertId(insertId)
    if (!normalizedInsertId) return 'none'
    if (!supportsTrackGuitarToneInsertId(normalizedInsertId)) return normalizedInsertId
    return `${normalizedInsertId}::${JSON.stringify(normalizeTrackGuitarToneConfig(guitarTone))}`
  }

  _normalizeReverbEngineId(value, fallback = LEGACY_REVERB_ENGINE_ID) {
    const resolvedValue = typeof value === 'string' ? value.trim() : ''
    if (resolvedValue) return resolvedValue
    const resolvedFallback = typeof fallback === 'string' ? fallback.trim() : ''
    return resolvedFallback || LEGACY_REVERB_ENGINE_ID
  }
}
