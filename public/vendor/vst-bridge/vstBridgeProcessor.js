// AudioWorkletProcessor：把 Web Audio 实时音频流转成定长 block，通过 MessagePort
// 传给 Worker（Worker 持 WebSocket 连到 VST 宿主）。处理后的 PCM 走相同链路返回。
//
// 设计：
//   - block 大小由主线程通过 init 消息指定（默认 256 samples，与 VST 常用块大小对齐）
//   - 通道数固定 2（立体声）。单声道输入会被复制到右声道
//   - 累计到 block 边界才发送，避免 quantum=128 与 host blockSize=256 的对齐抖动
//   - 输入 ring 与输出 ring 都是定长循环缓冲；满时丢弃最早块（防止累积）
//   - 输出 ring 为空时输出最近一块的静音版（连续 dropout 触发缓冲恢复）
//
// 协议（与 Worker 共用）：
//   主线程 → worklet（仅一次）：{ type: 'init', blockSize, channelCount }
//   主线程 → worklet（attach worker）：{ type: 'attachWorker', port } (transferable)
//   worklet → worker（每个 block）：{ type: 'in', sequence: u32, blockBuffer: ArrayBuffer }
//     blockBuffer = Float32Array of length blockSize * channelCount, 通道交错
//   worker → worklet：{ type: 'out', sequence: u32, blockBuffer: ArrayBuffer }
//   worklet → 主线程（统计回报，可选）：{ type: 'stat', sent, received, dropped }

const DEFAULT_BLOCK_SIZE = 256
const DEFAULT_CHANNELS = 2
const RING_BLOCKS = 8   // 输入/输出环形缓冲容量（块数）
const STAT_INTERVAL_QUANTA = 750  // 每 ~2 秒回报一次

class VstBridgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const init = options?.processorOptions || {}
    this.blockSize = Math.max(64, Number(init.blockSize) || DEFAULT_BLOCK_SIZE)
    this.channelCount = Math.max(1, Math.min(2, Number(init.channelCount) || DEFAULT_CHANNELS))
    this.workerPort = null

    // 输入累积（Float32 交错）
    this.inputAccum = new Float32Array(this.blockSize * this.channelCount)
    this.inputFill = 0

    // 输出 ring（数组循环复用）
    this.outputRing = []
    this.outputDraining = null
    this.outputDrainOffset = 0

    this.sentSequence = 0
    this.lastReceivedSequence = 0
    this.statCounter = 0
    this.dropped = 0

    this.port.onmessage = (event) => this._handleMainMessage(event)
  }

  _handleMainMessage(event) {
    const data = event?.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'attachWorker') {
      const port = data.port
      if (!port) return
      this.workerPort = port
      port.onmessage = (workerEvent) => this._handleWorkerMessage(workerEvent)
      port.start?.()
    } else if (data.type === 'detachWorker') {
      if (this.workerPort) {
        try { this.workerPort.close?.() } catch (_e) {}
        this.workerPort = null
      }
    } else if (data.type === 'reconfigure') {
      const newBlockSize = Math.max(64, Number(data.blockSize) || this.blockSize)
      if (newBlockSize !== this.blockSize) {
        this.blockSize = newBlockSize
        this.inputAccum = new Float32Array(this.blockSize * this.channelCount)
        this.inputFill = 0
      }
    }
  }

  _handleWorkerMessage(event) {
    const data = event?.data
    if (!data || typeof data !== 'object') return
    if (data.type !== 'out' || !(data.blockBuffer instanceof ArrayBuffer)) return
    const view = new Float32Array(data.blockBuffer)
    if (view.length !== this.blockSize * this.channelCount) {
      // 尺寸不匹配——丢弃该块（host 配置变化中？）
      this.dropped += 1
      return
    }
    if (this.outputRing.length >= RING_BLOCKS) {
      this.outputRing.shift()
      this.dropped += 1
    }
    this.outputRing.push(view)
    this.lastReceivedSequence = data.sequence | 0
  }

  _pushInputBlock() {
    if (!this.workerPort) return
    // 复制一份发出去——transferable 比较安全；但需要保留 inputAccum
    const buffer = new ArrayBuffer(this.inputAccum.byteLength)
    new Float32Array(buffer).set(this.inputAccum)
    this.sentSequence = (this.sentSequence + 1) & 0xffffffff
    try {
      this.workerPort.postMessage({
        type: 'in',
        sequence: this.sentSequence,
        blockBuffer: buffer,
      }, [buffer])
    } catch (_error) {
      // worker port 已关闭——静默忽略，下一帧 fallback 到 dry through
    }
  }

  _accumulateInput(input) {
    const sourceLeft = input?.[0]
    const sourceRight = input?.[1] || sourceLeft
    if (!sourceLeft) return
    const quantumLength = sourceLeft.length

    let read = 0
    while (read < quantumLength) {
      const writeStart = this.inputFill
      const remaining = (this.blockSize * this.channelCount) - writeStart * this.channelCount
      const takeFrames = Math.min(quantumLength - read, this.blockSize - writeStart)
      for (let i = 0; i < takeFrames; i += 1) {
        const dst = (writeStart + i) * this.channelCount
        this.inputAccum[dst] = sourceLeft[read + i] || 0
        if (this.channelCount === 2) {
          this.inputAccum[dst + 1] = sourceRight[read + i] || 0
        }
      }
      this.inputFill += takeFrames
      read += takeFrames
      if (this.inputFill >= this.blockSize) {
        this._pushInputBlock()
        this.inputFill = 0
      }
      void remaining
    }
  }

  _writeOutput(output) {
    const left = output?.[0]
    if (!left) return
    const right = output?.[1] || left
    const quantumLength = left.length
    let written = 0
    while (written < quantumLength) {
      if (!this.outputDraining) {
        this.outputDraining = this.outputRing.shift() || null
        this.outputDrainOffset = 0
      }
      if (!this.outputDraining) {
        // ring 空——输出剩余采样的静音
        for (let i = written; i < quantumLength; i += 1) {
          left[i] = 0
          if (right !== left) right[i] = 0
        }
        return
      }
      const blockFrames = this.blockSize
      const remainingFrames = blockFrames - this.outputDrainOffset
      const takeFrames = Math.min(quantumLength - written, remainingFrames)
      for (let i = 0; i < takeFrames; i += 1) {
        const src = (this.outputDrainOffset + i) * this.channelCount
        left[written + i] = this.outputDraining[src] || 0
        if (this.channelCount === 2 && right !== left) {
          right[written + i] = this.outputDraining[src + 1] || 0
        }
      }
      this.outputDrainOffset += takeFrames
      written += takeFrames
      if (this.outputDrainOffset >= blockFrames) {
        this.outputDraining = null
        this.outputDrainOffset = 0
      }
    }
  }

  _maybeReportStats() {
    this.statCounter += 1
    if (this.statCounter < STAT_INTERVAL_QUANTA) return
    this.statCounter = 0
    try {
      this.port.postMessage({
        type: 'stat',
        sent: this.sentSequence,
        received: this.lastReceivedSequence,
        dropped: this.dropped,
        ringDepth: this.outputRing.length,
      })
    } catch (_error) {}
  }

  process(inputs, outputs) {
    const input = inputs?.[0] || []
    const output = outputs?.[0] || []
    this._accumulateInput(input)
    this._writeOutput(output)
    this._maybeReportStats()
    return true
  }
}

registerProcessor('webutau-vst-bridge', VstBridgeProcessor)
