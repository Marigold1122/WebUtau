// Web Worker：在主线程之外维护到 VST 宿主的 WebSocket 连接，转发 PCM block。
//
// 协议：
//   主线程 → worker（一次）：{ type: 'connect', endpoint, handle, blockSize, channelCount, sampleRate }
//   主线程 → worker（attach worklet 端口）：{ type: 'attachWorklet', port } (transferable)
//   主线程 → worker（关闭）：{ type: 'disconnect' }
//   worklet → worker：{ type: 'in', sequence, blockBuffer }
//   worker → worklet：{ type: 'out', sequence, blockBuffer }
//   worker → 主线程（状态变化）：{ type: 'state', state: 'connecting'|'open'|'closed'|'error', detail? }
//
// WS 二进制帧格式（与 host 协商，与 stdio 协议解耦）：
//   [u32 magic = 0x57415544 'WAUD']
//   [u8 type]   0=input, 1=output, 2=control
//   [u8 channels]
//   [u16 frames]
//   [u32 sequence]
//   [u32 reserved]
//   [f32 ...]   交错存放，长度 = channels * frames
//
// 控制帧（type=2）首字节为子命令：0x01=hello (handle, sampleRate, blockSize)，
// 0x02=heartbeat。host 在收到 hello 后才开始处理 audio

const HEADER_BYTES = 16
const FRAME_MAGIC = 0x57414f44 // 'WAUD' but actual byte order: see writer

let workletPort = null
let socket = null
let endpoint = ''
let handle = ''
let blockSize = 256
let channelCount = 2
let sampleRate = 44100
let connected = false
let helloSent = false
let pendingHelloPayload = null

function postState(state, detail = '') {
  try {
    self.postMessage({ type: 'state', state, detail })
  } catch (_e) {}
}

function ensureWorkletWired() {
  if (!workletPort) return
  workletPort.onmessage = (event) => handleWorkletFrame(event)
  workletPort.start?.()
}

function handleWorkletFrame(event) {
  const data = event?.data
  if (!data || data.type !== 'in') return
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return
  sendAudioFrame(0 /* input */, data.sequence | 0, data.blockBuffer)
}

function sendAudioFrame(type, sequence, blockBuffer) {
  if (!(blockBuffer instanceof ArrayBuffer)) return
  const samples = blockBuffer.byteLength / 4
  const expected = blockSize * channelCount
  if (samples !== expected) return
  const total = HEADER_BYTES + blockBuffer.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  view.setUint32(0, FRAME_MAGIC, true)
  view.setUint8(4, type)
  view.setUint8(5, channelCount)
  view.setUint16(6, blockSize, true)
  view.setUint32(8, sequence >>> 0, true)
  view.setUint32(12, 0, true)
  new Uint8Array(out, HEADER_BYTES).set(new Uint8Array(blockBuffer))
  try {
    socket.send(out)
  } catch (_e) {}
}

function sendHello() {
  if (!socket || socket.readyState !== WebSocket.OPEN || helloSent) return
  helloSent = true
  // hello 控制帧（type=2，无音频负载）
  const payload = pendingHelloPayload || {}
  const helloString = JSON.stringify({
    cmd: 'hello',
    handle,
    sampleRate,
    blockSize,
    channelCount,
    ...payload,
  })
  const helloBytes = new TextEncoder().encode(helloString)
  const total = HEADER_BYTES + helloBytes.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  view.setUint32(0, FRAME_MAGIC, true)
  view.setUint8(4, 2)
  view.setUint8(5, 0)
  view.setUint16(6, 0, true)
  view.setUint32(8, 0, true)
  view.setUint32(12, helloBytes.byteLength, true)
  new Uint8Array(out, HEADER_BYTES).set(helloBytes)
  try { socket.send(out) }
  catch (error) { postState('error', String(error)) }
}

function handleSocketBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return
  if (buffer.byteLength < HEADER_BYTES) return
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== FRAME_MAGIC) return
  const type = view.getUint8(4)
  const sequence = view.getUint32(8, true)
  if (type !== 1) return  // 仅处理 output；其它类型作扩展位预留
  const payloadBuffer = buffer.slice(HEADER_BYTES)
  if (!workletPort) return
  try {
    workletPort.postMessage({
      type: 'out',
      sequence,
      blockBuffer: payloadBuffer,
    }, [payloadBuffer])
  } catch (_e) {}
}

function openSocket() {
  closeSocketSilent()
  if (!endpoint) {
    postState('error', 'missing endpoint')
    return
  }
  postState('connecting')
  try {
    socket = new WebSocket(endpoint)
    socket.binaryType = 'arraybuffer'
  } catch (error) {
    postState('error', String(error))
    return
  }
  socket.onopen = () => {
    connected = true
    helloSent = false
    sendHello()
    postState('open')
  }
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') return
    handleSocketBinary(event.data)
  }
  socket.onerror = (event) => {
    postState('error', event?.message || 'socket error')
  }
  socket.onclose = (event) => {
    connected = false
    helloSent = false
    socket = null
    postState('closed', `code=${event?.code || 0}`)
  }
}

function closeSocketSilent() {
  connected = false
  helloSent = false
  if (socket) {
    try { socket.close() } catch (_e) {}
    socket = null
  }
}

self.onmessage = (event) => {
  const data = event?.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'connect') {
    endpoint = String(data.endpoint || '')
    handle = String(data.handle || '')
    blockSize = Math.max(64, Number(data.blockSize) || 256)
    channelCount = Math.max(1, Math.min(2, Number(data.channelCount) || 2))
    sampleRate = Math.max(8000, Number(data.sampleRate) || 44100)
    pendingHelloPayload = data.helloPayload || null
    openSocket()
  } else if (data.type === 'attachWorklet') {
    workletPort = data.port
    ensureWorkletWired()
  } else if (data.type === 'disconnect') {
    closeSocketSilent()
  }
}
