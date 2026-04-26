import {
  normalizeTrackGuitarToneConfig,
  normalizeTrackPan,
  normalizeTrackReverbConfig,
  normalizeTrackReverbSend,
  normalizeTrackVolume,
  resolveTrackPlaybackGain,
} from '../project/trackPlaybackState.js'
import { isSameReverbConfig } from './reverb/ReverbConfigDiff.js'
import { LEGACY_REVERB_ENGINE_ID } from './reverb/ReverbParameterSchema.js'
import { startToneAudio } from './instruments/toneRuntime.js'
import { LufsMeter } from './master/LufsMeter.js'
import { MasterChainBus } from './master/MasterChainBus.js'
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
    this.masterChainBus = null
    this.lufsMeter = null
    // LufsMeter 在用户首次按 play / 触发 audioGraph.ensureReady 后才生成；
    // 早于这个时机调 subscribeLufs（比如顶栏电平表在 createHostApp 启动时就订阅）
    // 的回调先入队，等 meter 起来再一并接进去
    this._pendingLufsSubscribers = new Set()
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
        // master chain 接在 masterGain 与 destination 之间——
        // 所有轨道的混音和 → masterGain → MasterChainBus → destination。
        // 电平表通过 getMasterTapNode() 拿到 chain 输出节点，读到的是"用户实际听到的"信号
        this.masterChainBus = new MasterChainBus({ logger: this.logger }).attach(rawContext)
        this.masterGain.connect(this.masterChainBus.input)
        this.masterChainBus.output.connect(rawContext.destination)

        // LUFS 表旁路 tap 在 chain output 上——读"用户实际听到的"响度（含限幅 / 压缩后）。
        // 自启动后 100ms 一跳；用户切工程 / 重置时再 reset，正常播放期间一直累计 integrated
        try {
          this.lufsMeter = new LufsMeter({
            ctx: rawContext,
            sourceNode: this.masterChainBus.output,
            channels: 2,
            logger: this.logger,
          })
          this.lufsMeter.start()
          // 把启动前积压的订阅者一次性接进去——他们已经收过一帧 empty 快照，
          // 现在开始会收到真实读数
          this._pendingLufsSubscribers.forEach((entry) => {
            entry.unsubscribe = this.lufsMeter.subscribe(entry.fn)
          })
        } catch (error) {
          // LufsMeter 抛错不能影响音频本身——表挂掉，音频照常出
          this.logger?.warn?.('LufsMeter init failed; loudness readout disabled', {
            error: error?.message || String(error),
          })
          this.lufsMeter = null
        }

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

  // 给电平表 / 频谱用——拿到 master chain 输出节点；chain 还没起来时退化到 masterGain
  getMasterTapNode() {
    return this.masterChainBus?.output || this.masterGain || null
  }

  setMasterChainConfig(config) {
    this.masterChainBus?.applyConfig?.(config)
  }

  // LUFS 表订阅——返回退订函数。订阅时立即推一帧当前快照，便于 UI 启动期就有内容
  subscribeLufs(fn) {
    if (typeof fn !== 'function') return () => {}
    if (this.lufsMeter) {
      return this.lufsMeter.subscribe(fn)
    }
    // 未起来：进 pending 队列，先推一帧 empty，等 ensureReady 完成时统一接进真表
    try { fn({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, gatedBlockCount: 0 }) }
    catch (_e) {}
    const entry = { fn, unsubscribe: null }
    this._pendingLufsSubscribers.add(entry)
    return () => {
      // 退订要兼顾两种状态：还在 pending 时只移出队列；已接进真表则调真退订
      if (entry.unsubscribe) {
        try { entry.unsubscribe() } catch (_e) {}
        entry.unsubscribe = null
      }
      this._pendingLufsSubscribers.delete(entry)
    }
  }

  getLufsSnapshot() {
    return this.lufsMeter?.getSnapshot?.() || {
      momentary: -Infinity,
      shortTerm: -Infinity,
      integrated: -Infinity,
      gatedBlockCount: 0,
    }
  }

  // 用户从头播放 / 切工程时调——清空 momentary / short-term / integrated 累计，
  // 让仪表反映"这段播放从此刻起"的响度，而非历次叠加
  resetLufsIntegrated() {
    this.lufsMeter?.reset?.()
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

  setTrackPan(trackId, pan) {
    return Boolean(this.syncTrackState(trackId, { pan }))
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
    disconnectNode(channel.pan)
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
      pan: normalizeTrackPan(),
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
      pan: hasOwn(changes, 'pan')
        ? normalizeTrackPan(changes.pan, previous.pan)
        : previous.pan,
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
    // pan 节点放在 postInsert 之后、volume / send 分叉之前——dry 与 wet 两路都从 pan 出发，
    // 这样混响也跟着声像走。StereoPannerNode 自动做等功率定位（equal-power），混音学标准
    const pan = this.rawContext.createStereoPanner()
    const volume = this.rawContext.createGain()
    const send = this.rawContext.createGain()
    const reverbBus = new TrackReverbBus({
      logger: this.logger,
      config: state.reverbConfig ?? this.defaultReverbConfig,
      engineId: state.reverbEngineId,
    })

    postInsert.connect(pan)
    pan.connect(volume)
    volume.connect(this.masterGain)
    pan.connect(send)
    reverbBus.attach({
      rawContext: this.rawContext,
      inputNode: send,
      outputNode: this.masterGain,
    })
    pan.pan.value = normalizeTrackPan(state.pan)

    channel = {
      input,
      postInsert,
      pan,
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
    if (channel.pan?.pan) channel.pan.pan.value = normalizeTrackPan(nextState.pan)
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
