// 主控母带链：4 段 EQ → Compressor + Makeup → Limiter
// 全工程一份；UI 改参数 / 切 preset 都通过 applyConfig 一次性同步给所有内部节点。
//
// 启用/禁用策略：
//   1) 整链 bypass：bypassGain（直连 output）和 wetGain（链尾→output）做交叉淡入淡出，
//      避免断接重连引发的咔哒声
//   2) 子模块 bypass（EQ / Compressor / Limiter 各自）：用"参数透明化"——
//      EQ band gain = 0，Compressor threshold = 0 + ratio = 1，Limiter 同样——
//      让节点继续在链上但不做处理。比每个子模块都搞 bypass 路由简洁
import {
  DEFAULT_EQ_BANDS,
  LIMITER_FIXED_PARAMS,
  normalizeMasterChain,
} from '../../project/masterChainState.js'

function dbToLinear(db) {
  return Math.pow(10, db / 20)
}

function safeDisconnect(node) {
  try { node?.disconnect?.() } catch (_error) { /* 已断开是正常情况 */ }
}

export class MasterChainBus {
  constructor({ logger = null } = {}) {
    this.logger = logger
    this.ctx = null
    this.input = null
    this.output = null
    this.bypassGain = null
    this.wetGain = null
    this.eqNodes = []
    this.compressor = null
    this.makeupGain = null
    this.limiter = null
    this.config = null
  }

  attach(rawContext) {
    if (!rawContext || this.ctx) return this
    this.ctx = rawContext

    this.input = rawContext.createGain()
    this.output = rawContext.createGain()

    // bypass 旁路：input 直达 output，bypassGain 控制其音量
    this.bypassGain = rawContext.createGain()
    this.bypassGain.gain.value = 0
    this.input.connect(this.bypassGain)
    this.bypassGain.connect(this.output)

    // 主链路：input → EQ[0..3] → Compressor → Makeup → Limiter → wetGain → output
    this.wetGain = rawContext.createGain()
    this.wetGain.gain.value = 1

    this.eqNodes = DEFAULT_EQ_BANDS.map((band) => {
      const node = rawContext.createBiquadFilter()
      node.type = band.type
      node.frequency.value = band.freq
      node.Q.value = band.q
      node.gain.value = band.gain
      return node
    })

    this.compressor = rawContext.createDynamicsCompressor()
    this.makeupGain = rawContext.createGain()
    // 限幅器跟压缩器用同一种节点（DynamicsCompressorNode），但参数极端化为砖墙
    this.limiter = rawContext.createDynamicsCompressor()

    let lastNode = this.input
    this.eqNodes.forEach((eqNode) => {
      lastNode.connect(eqNode)
      lastNode = eqNode
    })
    lastNode.connect(this.compressor)
    this.compressor.connect(this.makeupGain)
    this.makeupGain.connect(this.limiter)
    this.limiter.connect(this.wetGain)
    this.wetGain.connect(this.output)

    return this
  }

  applyConfig(rawConfig) {
    if (!this.ctx) return
    const config = normalizeMasterChain(rawConfig)
    this.config = config

    // 整链交叉淡入淡出：避免咔哒
    const fadeTime = 0.02 // 20ms
    const now = this.ctx.currentTime
    const targetWet = config.enabled ? 1 : 0
    const targetBypass = config.enabled ? 0 : 1
    if (this.wetGain?.gain) {
      this.wetGain.gain.cancelScheduledValues(now)
      this.wetGain.gain.setTargetAtTime(targetWet, now, fadeTime)
    }
    if (this.bypassGain?.gain) {
      this.bypassGain.gain.cancelScheduledValues(now)
      this.bypassGain.gain.setTargetAtTime(targetBypass, now, fadeTime)
    }

    // EQ：disabled 时把每段 gain 归零（passthrough），频率/Q 仍然写入，
    // 这样切回 enabled 时立刻恢复用户的设定
    const eqEnabled = config.eq.enabled
    config.eq.bands.forEach((band, index) => {
      const node = this.eqNodes[index]
      if (!node) return
      try {
        node.frequency.setValueAtTime(band.freq, now)
        node.Q.setValueAtTime(band.q, now)
        node.gain.setTargetAtTime(eqEnabled ? band.gain : 0, now, 0.01)
      } catch (_error) { /* 个别浏览器对 setTargetAtTime 时间常数敏感，忽略 */ }
    })

    // Compressor：disabled = 高阈值 + ratio 1（不触发压缩）+ makeup gain = 1
    const comp = config.compressor
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

    // Limiter：disabled = 高阈值 + ratio 1
    const lim = config.limiter
    if (lim.enabled) {
      this._setAudioParam(this.limiter.threshold, lim.threshold, now)
      this._setAudioParam(this.limiter.ratio, LIMITER_FIXED_PARAMS.ratio, now)
      this._setAudioParam(this.limiter.attack, LIMITER_FIXED_PARAMS.attack, now)
      this._setAudioParam(this.limiter.release, LIMITER_FIXED_PARAMS.release, now)
      this._setAudioParam(this.limiter.knee, LIMITER_FIXED_PARAMS.knee, now)
    } else {
      this._setAudioParam(this.limiter.threshold, 0, now)
      this._setAudioParam(this.limiter.ratio, 1, now)
    }
  }

  // 包一层防御：超出节点默认范围的值会抛 RangeError，记录但不让它打断整体 applyConfig
  _setAudioParam(param, value, now, smoothTime = 0) {
    if (!param) return
    try {
      if (smoothTime > 0) {
        param.setTargetAtTime(value, now, smoothTime)
      } else {
        param.setValueAtTime(value, now)
      }
    } catch (error) {
      this.logger?.warn?.('MasterChainBus param set failed', {
        value,
        error: error?.message || String(error),
      })
    }
  }

  // 给电平表 / 后续其它"读 master 输出"的消费者用
  getOutputNode() {
    return this.output
  }

  dispose() {
    safeDisconnect(this.input)
    safeDisconnect(this.output)
    safeDisconnect(this.bypassGain)
    safeDisconnect(this.wetGain)
    safeDisconnect(this.compressor)
    safeDisconnect(this.makeupGain)
    safeDisconnect(this.limiter)
    this.eqNodes.forEach(safeDisconnect)
    this.eqNodes = []
    this.ctx = null
  }
}
