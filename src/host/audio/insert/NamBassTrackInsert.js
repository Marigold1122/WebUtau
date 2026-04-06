import { acquireNamProcessor, releaseNamProcessor } from './NamBassRuntime.js'

function disconnectNode(node) {
  try { node?.disconnect?.() } catch (_error) {}
}

function disconnectConnection(source, target) {
  try { source?.disconnect?.(target) } catch (_error) {}
}

function stopStreamTracks(stream) {
  try {
    stream?.getTracks?.().forEach((track) => {
      try { track.stop() } catch (_error) {}
    })
  } catch (_error) {}
}

export function createNamBassTrackInsert({ rawContext, profile, logger = null } = {}) {
  if (!rawContext || !profile || profile.engine !== 'nam-bass') return null
  if (
    typeof rawContext.createMediaStreamDestination !== 'function'
    || typeof rawContext.createMediaStreamSource !== 'function'
  ) {
    throw new Error('NAM bass insert requires MediaStream audio graph bridging support.')
  }

  const input = rawContext.createGain()
  const output = rawContext.createGain()
  const dryGain = rawContext.createGain()
  const wetGain = rawContext.createGain()
  const bridgeInputGain = rawContext.createGain()
  const bridgeInputDestination = rawContext.createMediaStreamDestination()

  dryGain.gain.value = 1
  wetGain.gain.value = 0
  bridgeInputGain.gain.value = Number.isFinite(profile.bridgeInputGain) ? profile.bridgeInputGain : 1

  input.connect(dryGain)
  dryGain.connect(output)
  input.connect(bridgeInputGain)
  bridgeInputGain.connect(bridgeInputDestination)
  wetGain.connect(output)

  let disposed = false
  let sharedProcessor = null
  let namContext = null
  let namAudioWorkletNode = null
  let namInputSource = null
  let namInputGain = null
  let namOutputGain = null
  let namOutputDestination = null
  let returnSource = null

  const releaseSharedProcessor = () => {
    if (!sharedProcessor) return
    releaseNamProcessor(sharedProcessor)
    sharedProcessor = null
  }

  const disposeNamNodes = () => {
    disconnectNode(returnSource)
    returnSource = null

    disconnectConnection(namInputGain, namAudioWorkletNode)
    disconnectConnection(namAudioWorkletNode, namOutputGain)

    disconnectNode(namInputSource)
    namInputSource = null

    disconnectNode(namInputGain)
    namInputGain = null

    disconnectNode(namOutputGain)
    namOutputGain = null

    stopStreamTracks(namOutputDestination?.stream)
    disconnectNode(namOutputDestination)
    namOutputDestination = null

    namContext = null
    namAudioWorkletNode = null
    releaseSharedProcessor()
  }

  const readyPromise = acquireNamProcessor({ modelUrl: profile.modelUrl })
    .then(async (processor) => {
      sharedProcessor = processor
      namContext = processor.audioContext
      namAudioWorkletNode = processor.audioWorkletNode

      if (disposed) {
        disposeNamNodes()
        return null
      }

      namInputSource = namContext.createMediaStreamSource(bridgeInputDestination.stream)
      namInputGain = namContext.createGain()
      namInputGain.gain.value = Number.isFinite(profile.inputGain) ? profile.inputGain : 1
      namOutputGain = namContext.createGain()
      namOutputGain.gain.value = Number.isFinite(profile.outputGain) ? profile.outputGain : 1
      namOutputDestination = namContext.createMediaStreamDestination()

      namInputSource.connect(namInputGain)
      namInputGain.connect(namAudioWorkletNode)
      namAudioWorkletNode.connect(namOutputGain)
      namOutputGain.connect(namOutputDestination)

      returnSource = rawContext.createMediaStreamSource(namOutputDestination.stream)
      returnSource.connect(wetGain)

      try {
        await namContext.resume()
      } catch (_error) {}
      if (namContext.state !== 'running') {
        throw new Error('NAM audio context failed to resume.')
      }
      if (disposed) {
        disposeNamNodes()
        return null
      }

      dryGain.gain.setTargetAtTime(0, rawContext.currentTime, 0.015)
      wetGain.gain.setTargetAtTime(1, rawContext.currentTime, 0.015)
      return null
    })
    .catch((error) => {
      if (!disposed) {
        logger?.warn?.('NAM bass insert initialization failed', {
          insertId: profile.insertId,
          error: error?.message || String(error),
        })
      }
      disposeNamNodes()
      return null
    })

  return {
    input,
    output,
    readyPromise,
    dispose() {
      disposed = true
      dryGain.gain.cancelScheduledValues(rawContext.currentTime)
      wetGain.gain.cancelScheduledValues(rawContext.currentTime)
      dryGain.gain.value = 0
      wetGain.gain.value = 0

      disposeNamNodes()
      stopStreamTracks(bridgeInputDestination.stream)

      disconnectNode(input)
      disconnectNode(output)
      disconnectNode(dryGain)
      disconnectNode(wetGain)
      disconnectNode(bridgeInputGain)
      disconnectNode(bridgeInputDestination)
    },
  }
}
