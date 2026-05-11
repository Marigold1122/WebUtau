/**
 * 单轨 insert 效果链：4 段 EQ → Compressor + Makeup → output。
 *
 * 与 MasterChainBus 关系：节点拓扑几乎一致（少一个 Limiter），但**每条轨各一份**。
 * 拓扑：input → eq[0..3] → comp → makeup → output
 *
 * Bypass 策略：
 *   1) 整链 enabled 不存在（链就两个独立子模块，分别 enabled）—— 没有"整链 bypass"概念
 *   2) 子模块 bypass = 参数透明化（EQ gain=0；Comp threshold=0 + ratio=1）
 *      —— 避免动态断接重连引发的咔哒声
 *
 * 调用方约定：
 *   - new TrackInsertChainBus({ logger }).attach(rawContext) → 节点起来
 *   - applyConfig(state) 每次 state 变写一次（拖参数实时调）
 *   - dispose() 在轨道被删除 / runtime 销毁时调
 */

import { normalizeTrackInsertChain } from '../../project/trackInsertChainState.js'

function dbToLinear(db) {
  return Math.pow(10, db / 20)
}

function safeDisconnect(node) {
  try { node?.disconnect?.() } catch (_error) { /* 已断开是正常情况 */ }
}

export class TrackInsertChainBus {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.ctx = null
    this.input = null
    this.output = null
    this.eqNodes = []
    this.compressor = null
    this.makeupGain = null
    this.config = null
  }

  attach(rawContext) {
    if (!rawContext || this.ctx) return this
    this.ctx = rawContext

    this.input = rawContext.createGain()
    this.output = rawContext.createGain()

    // 4 段 EQ：lowshelf → peaking → peaking → highshelf
    // 默认值无所谓——applyConfig 立刻会把 state 的值写进来
    const bandTypes = ['lowshelf', 'peaking', 'peaking', 'highshelf']
    this.eqNodes = bandTypes.map((type) => {
      const node = rawContext.createBiquadFilter()
      node.type = type
      node.gain.value = 0    // 默认透明
      return node
    })

    this.compressor = rawContext.createDynamicsCompressor()
    this.makeupGain = rawContext.createGain()
    this.makeupGain.gain.value = 1

    // 拓扑：input → eq[0..3] → comp → makeup → output
    let lastNode = this.input
    this.eqNodes.forEach((eq) => {
      lastNode.connect(eq)
      lastNode = eq
    })
    lastNode.connect(this.compressor)
    this.compressor.connect(this.makeupGain)
    this.makeupGain.connect(this.output)

    return this
  }

  applyConfig(rawConfig) {
    if (!this.ctx) return
    const config = normalizeTrackInsertChain(rawConfig)
    this.config = config
    const now = this.ctx.currentTime

    // EQ：disabled 时所有段 gain=0（参数透明），freq/Q 仍正常写入
    const eqEnabled = config.eq4.enabled
    config.eq4.bands.forEach((band, index) => {
      const node = this.eqNodes[index]
      if (!node) return
      this._setAudioParam(node.frequency, band.freq, now)
      this._setAudioParam(node.Q, band.q, now)
      this._setAudioParam(node.gain, eqEnabled ? band.gain : 0, now, 0.01)
    })

    // Comp：disabled = 高阈值 + ratio 1（透明），enabled 时按 state 写
    // makeupGain：仅当 comp.enabled 时生效；disabled 时锁死 1（不补偿）
    // ——和 MasterChain 不同：master 那边 makeupGain 始终生效（用作 trim），
    // 但 track insert 只是混音段，makeupGain 应跟 comp 一起开关
    const comp = config.comp
    if (comp.enabled) {
      this._setAudioParam(this.compressor.threshold, comp.threshold, now)
      this._setAudioParam(this.compressor.ratio, comp.ratio, now)
      this._setAudioParam(this.compressor.attack, comp.attack, now)
      this._setAudioParam(this.compressor.release, comp.release, now)
      this._setAudioParam(this.compressor.knee, comp.knee, now)
      this._setAudioParam(this.makeupGain.gain, dbToLinear(comp.makeupGain), now, 0.01)
    } else {
      this._setAudioParam(this.compressor.threshold, 0, now)
      this._setAudioParam(this.compressor.ratio, 1, now)
      this._setAudioParam(this.makeupGain.gain, 1, now, 0.01)
    }
  }

  /** 给上层判断"整条链是否真在做事"——两槽都关 = 可跳过 */
  isTransparent() {
    return Boolean(this.config && !this.config.eq4.enabled && !this.config.comp.enabled)
  }

  // 包一层防御：超出节点默认范围的值会抛 RangeError，记录但不打断整体 applyConfig
  _setAudioParam(param, value, now, smoothTime = 0) {
    if (!param) return
    try {
      if (smoothTime > 0) {
        param.setTargetAtTime(value, now, smoothTime)
      } else {
        param.setValueAtTime(value, now)
      }
    } catch (error) {
      this.logger?.warn?.('TrackInsertChainBus param set failed', {
        value, error: error?.message || String(error),
      })
    }
  }

  dispose() {
    safeDisconnect(this.input)
    this.eqNodes.forEach((node) => safeDisconnect(node))
    safeDisconnect(this.compressor)
    safeDisconnect(this.makeupGain)
    safeDisconnect(this.output)
    this.ctx = null
    this.input = null
    this.output = null
    this.eqNodes = []
    this.compressor = null
    this.makeupGain = null
    this.config = null
  }
}
