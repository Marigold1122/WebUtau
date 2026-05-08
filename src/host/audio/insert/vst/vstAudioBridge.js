// 主线程粘合层：把 AudioWorkletNode、Worker、host endpoint 拼起来。
// 给 VstTrackInsert 单方法调用入口；处理握手、销毁、状态回报。

import { vstGetWsEndpoint } from './vstHostClient.js'

const WORKLET_NAME = 'webutau-vst-bridge'
const WORKLET_URL = '/vendor/vst-bridge/vstBridgeProcessor.js'

const moduleRegistration = new WeakMap()

async function ensureWorkletModule(audioContext) {
  if (!audioContext?.audioWorklet) return false
  if (moduleRegistration.has(audioContext)) {
    return moduleRegistration.get(audioContext)
  }
  const promise = audioContext.audioWorklet.addModule(WORKLET_URL).then(() => true).catch((error) => {
    moduleRegistration.delete(audioContext)
    throw error
  })
  moduleRegistration.set(audioContext, promise)
  return promise
}

function createBridgeWorker() {
  // Vite 通过 new URL(..., import.meta.url) 把 worker 文件作为独立 chunk 打出来
  return new Worker(new URL('./vstAudioBridgeWorker.js', import.meta.url), { type: 'module' })
}

// 创建一段 worklet+worker bridge。返回的 controller 暴露给 VstTrackInsert：
//   { node, ready, dispose, onState }
// 其中 node 已经接到 input/output；调用方决定何时把 dryGain/wetGain 切到 wet
export async function createVstAudioBridge({
  audioContext,
  handle,
  blockSize = 256,
  channelCount = 2,
  helloPayload = null,
  onState = null,
} = {}) {
  if (!audioContext || !handle) return null

  await ensureWorkletModule(audioContext)

  const node = new AudioWorkletNode(audioContext, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channelCount],
    processorOptions: { blockSize, channelCount },
  })

  const worker = createBridgeWorker()
  const channel = new MessageChannel()

  // Worklet ↔ Worker 直连，绕开主线程消息泵
  node.port.postMessage({ type: 'attachWorker', port: channel.port1 }, [channel.port1])
  worker.postMessage({ type: 'attachWorklet', port: channel.port2 }, [channel.port2])

  let endpoint = ''
  try {
    endpoint = await vstGetWsEndpoint()
  } catch (error) {
    onState?.({ state: 'error', detail: error?.message || String(error) })
    worker.terminate()
    try { node.disconnect() } catch (_e) {}
    return null
  }

  const stateListener = (event) => {
    const payload = event?.data
    if (!payload || payload.type !== 'state') return
    onState?.(payload)
  }
  worker.addEventListener('message', stateListener)

  worker.postMessage({
    type: 'connect',
    endpoint,
    handle,
    blockSize,
    channelCount,
    sampleRate: audioContext.sampleRate,
    helloPayload,
  })

  let disposed = false

  return {
    node,
    workerPortReady: true,
    dispose() {
      if (disposed) return
      disposed = true
      try { worker.postMessage({ type: 'disconnect' }) } catch (_e) {}
      try { worker.removeEventListener('message', stateListener) } catch (_e) {}
      try { worker.terminate() } catch (_e) {}
      try { node.port.postMessage({ type: 'detachWorker' }) } catch (_e) {}
      try { node.disconnect() } catch (_e) {}
    },
  }
}
