// VST 插件 insert 在 Web Audio 通路中的承载。实现 createTrackInsertEffect 期望的形状：
//   { input, output, readyPromise, dispose, updateProfile }
//
// 通路：
//   input → dryGain → output         （桥接前 / bypass 时走 dry）
//   input → bridgeNode → wetGain → output  （桥接成功且未 bypass 时切到 wet）
//
// 桥接节点 = AudioWorkletNode + Worker + WebSocket 到 host。
// 节点本身两通道立体声 IO；创建/销毁完全在 createVstAudioBridge 内部封装。

import { getVstGateway } from '../../../services/VstGateway.js'
import { createVstAudioBridge } from './vstAudioBridge.js'

function disconnectNode(node) {
  try { node?.disconnect?.() } catch (_error) {}
}

function setGainSmoothly(param, value, currentTime, ramp = 0.012) {
  if (!param) return
  try {
    param.cancelScheduledValues(currentTime)
    param.setTargetAtTime(value, currentTime, ramp)
  } catch (_error) {
    try { param.value = value } catch (_e) {}
  }
}

export function createVstTrackInsert({ rawContext, profile, logger = null } = {}) {
  if (!rawContext || !profile || profile.engine !== 'vst' || !profile.vstInsert) return null

  const gateway = getVstGateway({ logger })
  const input = rawContext.createGain()
  const output = rawContext.createGain()
  const dryGain = rawContext.createGain()
  const wetGain = rawContext.createGain()

  dryGain.gain.value = 1
  wetGain.gain.value = 0

  input.connect(dryGain)
  dryGain.connect(output)
  wetGain.connect(output)

  let disposed = false
  let currentVstState = profile.vstInsert
  let bridge = null
  let bridgeAttachedHandle = null

  const applyMix = ({ wetReady }) => {
    const now = rawContext.currentTime
    const bypassed = Boolean(currentVstState?.bypass)
    if (bypassed || !wetReady) {
      setGainSmoothly(dryGain.gain, 1, now)
      setGainSmoothly(wetGain.gain, 0, now)
    } else {
      setGainSmoothly(dryGain.gain, 0, now)
      setGainSmoothly(wetGain.gain, 1, now)
    }
  }

  applyMix({ wetReady: false })

  const detachBridge = () => {
    if (!bridge) return
    try { input.disconnect(bridge.node) } catch (_e) {}
    try { bridge.node.disconnect(wetGain) } catch (_e) {}
    bridge.dispose()
    bridge = null
    bridgeAttachedHandle = null
  }

  const attachBridgeForHandle = async (handle) => {
    if (!handle || disposed) return
    if (bridgeAttachedHandle === handle && bridge) return
    detachBridge()
    try {
      const created = await createVstAudioBridge({
        audioContext: rawContext,
        handle,
        blockSize: 256,
        channelCount: 2,
        helloPayload: { instanceId: currentVstState?.instanceId },
        onState: ({ state, detail }) => {
          if (state === 'open') {
            applyMix({ wetReady: !currentVstState?.bypass })
          } else if (state === 'closed' || state === 'error') {
            applyMix({ wetReady: false })
            logger?.warn?.('VST audio bridge state', {
              instanceId: currentVstState?.instanceId,
              state,
              detail,
            })
          }
        },
      })
      if (!created || disposed) {
        if (created) created.dispose()
        return
      }
      bridge = created
      bridgeAttachedHandle = handle
      input.connect(bridge.node)
      bridge.node.connect(wetGain)
    } catch (error) {
      logger?.warn?.('VST audio bridge attach failed', {
        instanceId: currentVstState?.instanceId,
        error: error?.message || String(error),
      })
    }
  }

  const readyPromise = (async () => {
    try {
      const snapshot = await gateway.syncInstance(currentVstState, {
        sampleRate: rawContext.sampleRate,
        blockSize: 256,
      })
      if (disposed) return null
      if (!snapshot || snapshot.status !== 'ready' || !snapshot.handle) {
        logger?.info?.('VST insert not ready, dry through', {
          instanceId: currentVstState.instanceId,
          status: snapshot?.status || 'unknown',
        })
        return snapshot
      }
      await attachBridgeForHandle(snapshot.handle)
      return snapshot
    } catch (error) {
      logger?.warn?.('VST insert ready failed', {
        instanceId: currentVstState?.instanceId,
        error: error?.message || String(error),
      })
      return null
    }
  })()

  return {
    input,
    output,
    readyPromise,
    updateProfile(nextProfile) {
      if (!nextProfile?.vstInsert) return
      const prev = currentVstState
      currentVstState = nextProfile.vstInsert
      // bypass 切换 / chunk 修改：仅刷 mix；不重连
      if (
        prev?.instanceId === currentVstState.instanceId
        && prev?.pluginPath === currentVstState.pluginPath
      ) {
        applyMix({ wetReady: Boolean(bridge) })
        gateway.syncInstance(currentVstState, {
          sampleRate: rawContext.sampleRate,
          blockSize: 256,
        }).catch(() => {})
        return
      }
      // 实例换了：重新走 ready 流程
      gateway.syncInstance(currentVstState, {
        sampleRate: rawContext.sampleRate,
        blockSize: 256,
      }).then((snapshot) => {
        if (disposed) return
        if (snapshot?.status === 'ready' && snapshot.handle) {
          return attachBridgeForHandle(snapshot.handle)
        }
        detachBridge()
        applyMix({ wetReady: false })
        return null
      }).catch((error) => {
        logger?.warn?.('VST insert updateProfile sync failed', {
          instanceId: currentVstState.instanceId,
          error: error?.message || String(error),
        })
      })
    },
    dispose() {
      disposed = true
      const now = rawContext.currentTime
      try {
        dryGain.gain.cancelScheduledValues(now)
        wetGain.gain.cancelScheduledValues(now)
      } catch (_error) {}
      dryGain.gain.value = 0
      wetGain.gain.value = 0
      detachBridge()
      disconnectNode(input)
      disconnectNode(dryGain)
      disconnectNode(wetGain)
      disconnectNode(output)
      // gateway 实例释放交给 view-handlers / project release 流程，而非这里
    },
  }
}
