// 实时 LUFS 表：把 master chain 输出节点旁路 tap 出来 → 每通道做 K 加权 →
// AnalyserNode 取近 100ms 时域样本算均方 → 求和 + 入门控 → 暴露 momentary /
// short-term / integrated 三档读数。
//
// 与 menubarMeter 的关系：menubarMeter 读"线性峰值 + 频谱"，本类读"K 加权感知响度"。
// 两个都共用同一个 master tap 节点（projectAudioGraph.getMasterTapNode），互不干扰。
import {
  ABSOLUTE_GATE_LUFS,
  calcIntegratedLufs,
  calcWindowLufs,
  HOP_INTERVAL_MS,
  MOMENTARY_HOPS,
  meanSquareToLufs,
  passesAbsoluteGate,
  SHORT_TERM_HOPS,
} from './lufsMath.js'

function nextPow2AtLeast(n) {
  let p = 1
  while (p < n) p *= 2
  return p
}

// BS.1770-4 K 加权：高架（fc=1681.97 Hz, +3.999... dB）+ 高通（fc=38.13 Hz）。
// Web Audio 的 BiquadFilter "highshelf"/"highpass" 系数由 freq/Q/gain 现算，
// 跟规范的 a/b 系数有微小偏差——但对"实时电平表读数"足够了；
// 真要 ±0.1 LUFS 一致需上 AudioWorklet 自实现 biquad，那是另一个量级的工作。
function buildKWeightingChain(ctx) {
  const shelf = ctx.createBiquadFilter()
  shelf.type = 'highshelf'
  shelf.frequency.value = 1681.97
  shelf.gain.value = 3.999843853973
  shelf.Q.value = 0.7071067811865476

  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 38.13
  hp.Q.value = 0.5

  shelf.connect(hp)
  return { input: shelf, output: hp }
}

export class LufsMeter {
  constructor({ ctx, sourceNode, channels = 2, logger = null } = {}) {
    if (!ctx || !sourceNode) {
      throw new Error('LufsMeter: ctx 和 sourceNode 必须提供')
    }
    this.ctx = ctx
    this.logger = logger
    this.channels = Math.max(1, Math.min(2, channels | 0))
    this.sampleRate = ctx.sampleRate

    // 100ms 一跳的样本数；fftSize 必须是 2 的幂且 ≥ blockSamples，否则 AnalyserNode 拒收
    this.blockSamples = Math.max(256, Math.round(this.sampleRate * (HOP_INTERVAL_MS / 1000)))
    const fftSize = Math.min(32768, nextPow2AtLeast(this.blockSamples))

    this.splitter = ctx.createChannelSplitter(this.channels)
    sourceNode.connect(this.splitter)

    this.channelEntries = []
    for (let c = 0; c < this.channels; c++) {
      const kweight = buildKWeightingChain(ctx)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = fftSize
      analyser.smoothingTimeConstant = 0
      this.splitter.connect(kweight.input, c)
      kweight.output.connect(analyser)
      this.channelEntries.push({
        kweight,
        analyser,
        buffer: new Float32Array(analyser.fftSize),
      })
    }

    this.momentaryHops = []
    this.shortTermHops = []
    this.absoluteGatedBlocks = []
    this.tickHandle = null
    this.subscribers = new Set()
    this.lastSnapshot = this._emptySnapshot()
  }

  _emptySnapshot() {
    return {
      momentary: -Infinity,
      shortTerm: -Infinity,
      integrated: -Infinity,
      // UI 用：自上次 reset 起累计的"门控块数"，可作为采样置信度参考
      gatedBlockCount: 0,
    }
  }

  start() {
    if (this.tickHandle != null) return
    // setInterval 而非 rAF：rAF 在标签隐藏时会暂停，导致 integrated 漏算；
    // 100ms 周期对响度表足够，CPU 也轻
    this.tickHandle = setInterval(() => this._tick(), HOP_INTERVAL_MS)
  }

  stop() {
    if (this.tickHandle != null) {
      clearInterval(this.tickHandle)
      this.tickHandle = null
    }
  }

  // 用户从头开始播放 / 工程切换时调——清空累计读数，新一轮从零开始
  reset() {
    this.momentaryHops = []
    this.shortTermHops = []
    this.absoluteGatedBlocks = []
    this.lastSnapshot = this._emptySnapshot()
    this._notify(this.lastSnapshot)
  }

  // 订阅每跳的最新读数；返回退订函数
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {}
    this.subscribers.add(fn)
    // 立刻把当前快照推给订阅者，让 UI 不必等到下一跳才有内容
    try { fn(this.lastSnapshot) }
    catch (error) {
      this.logger?.warn?.('LufsMeter subscribe initial push failed', { error: error?.message || String(error) })
    }
    return () => { this.subscribers.delete(fn) }
  }

  getSnapshot() {
    return { ...this.lastSnapshot }
  }

  _tick() {
    if (!this.ctx) return
    let hopMeanSquare = 0
    for (const entry of this.channelEntries) {
      try {
        entry.analyser.getFloatTimeDomainData(entry.buffer)
      } catch (error) {
        this.logger?.warn?.('LufsMeter analyser read failed', { error: error?.message || String(error) })
        return
      }
      let sumSq = 0
      const total = entry.buffer.length
      const start = total - this.blockSamples
      for (let i = start; i < total; i++) {
        const v = entry.buffer[i]
        sumSq += v * v
      }
      // 立体声两通道权重均为 1.0（BS.1770 表1）
      hopMeanSquare += sumSq / this.blockSamples
    }

    this.momentaryHops.push(hopMeanSquare)
    if (this.momentaryHops.length > MOMENTARY_HOPS) this.momentaryHops.shift()
    this.shortTermHops.push(hopMeanSquare)
    if (this.shortTermHops.length > SHORT_TERM_HOPS) this.shortTermHops.shift()

    // BS.1770 §5.2：integrated 用 400ms 块、75% 重叠 = 100ms 跳。
    // 当前这 4 跳合在一起就是"最新一块"，过绝对门后入累计池
    if (this.momentaryHops.length === MOMENTARY_HOPS) {
      let blockSum = 0
      for (const ms of this.momentaryHops) blockSum += ms
      const blockMs = blockSum / MOMENTARY_HOPS
      if (passesAbsoluteGate(blockMs)) {
        this.absoluteGatedBlocks.push(blockMs)
      }
    }

    const snapshot = {
      momentary: calcWindowLufs(this.momentaryHops),
      shortTerm: calcWindowLufs(this.shortTermHops),
      integrated: calcIntegratedLufs(this.absoluteGatedBlocks),
      gatedBlockCount: this.absoluteGatedBlocks.length,
    }
    this.lastSnapshot = snapshot
    this._notify(snapshot)
  }

  _notify(snapshot) {
    this.subscribers.forEach((fn) => {
      try { fn(snapshot) }
      catch (error) {
        this.logger?.warn?.('LufsMeter subscriber threw', { error: error?.message || String(error) })
      }
    })
  }

  dispose() {
    this.stop()
    this.subscribers.clear()
    try { this.splitter?.disconnect?.() } catch (_e) {}
    for (const entry of this.channelEntries) {
      try { entry.kweight?.input?.disconnect?.() } catch (_e) {}
      try { entry.kweight?.output?.disconnect?.() } catch (_e) {}
      try { entry.analyser?.disconnect?.() } catch (_e) {}
    }
    this.channelEntries = []
    this.ctx = null
  }
}

// 重新导出常数，省得 UI 文件再 import 一次 lufsMath
export { ABSOLUTE_GATE_LUFS, HOP_INTERVAL_MS, meanSquareToLufs }
