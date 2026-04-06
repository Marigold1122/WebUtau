const NAM_RUNTIME_SCRIPT_URL = '/t3k-wasm-module.js'
const MODULE_READY_TIMEOUT_MS = 15000
const DSP_READY_TIMEOUT_MS = 30000
const MODULE_POLL_INTERVAL_MS = 100

let runtimeScriptPromise = null
let moduleReadyPromise = null
let processorCreationQueue = Promise.resolve()
let sharedProcessor = null
let sharedProcessorBootstrapPromise = null

function restoreGlobalCallback(previousCallback, assignedCallback) {
  if (window.wasmAudioWorkletCreated !== assignedCallback) return
  if (typeof previousCallback === 'function') {
    window.wasmAudioWorkletCreated = previousCallback
    return
  }
  try {
    delete window.wasmAudioWorkletCreated
  } catch (_error) {
    window.wasmAudioWorkletCreated = undefined
  }
}

function ensureBrowserSupport() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('NAM bass insert requires a browser environment.')
  }
  if (typeof window.AudioContext !== 'function' && typeof window.webkitAudioContext !== 'function') {
    throw new Error('NAM bass insert requires AudioContext support.')
  }
  if (typeof SharedArrayBuffer === 'undefined' || window.crossOriginIsolated !== true) {
    throw new Error('NAM bass insert requires crossOriginIsolated and SharedArrayBuffer. Configure COOP/COEP headers for the frontend host.')
  }
}

function isRuntimeModuleReady(moduleRef) {
  if (!moduleRef?._malloc || !moduleRef?._free || !moduleRef?.stringToUTF8 || !moduleRef?.ccall) {
    return false
  }
  if (!(moduleRef.runtimeInitialized === true || moduleRef.wasmMemory)) {
    return false
  }
  try {
    const pointer = moduleRef._malloc(1)
    if (pointer !== 0) {
      moduleRef._free(pointer)
    }
    return true
  } catch (_error) {
    return false
  }
}

function pollForRuntimeModuleReady(timeoutMs = MODULE_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const intervalId = window.setInterval(() => {
      if (isRuntimeModuleReady(window.Module)) {
        window.clearInterval(intervalId)
        resolve(window.Module)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(intervalId)
        reject(new Error('Timed out while waiting for the NAM runtime module to become ready.'))
      }
    }, MODULE_POLL_INTERVAL_MS)
  })
}

function loadRuntimeScript() {
  if (runtimeScriptPromise) return runtimeScriptPromise

  runtimeScriptPromise = new Promise((resolve, reject) => {
    if (isRuntimeModuleReady(window.Module)) {
      resolve()
      return
    }

    const existingScript = document.querySelector('script[data-nam-runtime="true"]')
    if (existingScript) {
      if (existingScript.dataset.loaded === 'true') {
        resolve()
        return
      }
      const handleLoad = () => {
        existingScript.removeEventListener('load', handleLoad)
        existingScript.removeEventListener('error', handleError)
        resolve()
      }
      const handleError = () => {
        existingScript.removeEventListener('load', handleLoad)
        existingScript.removeEventListener('error', handleError)
        runtimeScriptPromise = null
        reject(new Error('Failed to load the NAM runtime script.'))
      }
      existingScript.addEventListener('load', handleLoad)
      existingScript.addEventListener('error', handleError)
      return
    }

    window.Module = window.Module && typeof window.Module === 'object' ? window.Module : {}
    window.Module.mainScriptUrlOrBlob = NAM_RUNTIME_SCRIPT_URL

    const script = document.createElement('script')
    script.src = NAM_RUNTIME_SCRIPT_URL
    script.async = true
    script.dataset.namRuntime = 'true'
    script.onload = () => {
      script.dataset.loaded = 'true'
      resolve()
    }
    script.onerror = () => {
      runtimeScriptPromise = null
      reject(new Error(`Failed to load NAM runtime script: ${NAM_RUNTIME_SCRIPT_URL}`))
    }

    const mountPoint = document.head || document.body || document.documentElement
    mountPoint.appendChild(script)
  }).catch((error) => {
    runtimeScriptPromise = null
    throw error
  })

  return runtimeScriptPromise
}

async function ensureNamModuleReady() {
  ensureBrowserSupport()
  if (isRuntimeModuleReady(window.Module)) {
    return window.Module
  }
  if (!moduleReadyPromise) {
    moduleReadyPromise = (async () => {
      await loadRuntimeScript()
      return pollForRuntimeModuleReady()
    })().catch((error) => {
      moduleReadyPromise = null
      throw error
    })
  }
  return moduleReadyPromise
}

async function fetchNamModelText(modelUrl) {
  const response = await fetch(modelUrl, {
    mode: 'cors',
    credentials: 'omit',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch NAM model: ${response.status} ${response.statusText}`)
  }
  const modelText = await response.text()
  if (!modelText) {
    throw new Error('NAM model response was empty.')
  }
  return modelText
}

async function allocateDsp(moduleRef, modelText) {
  const byteLength = new TextEncoder().encode(modelText).length + 1
  const pointer = moduleRef._malloc(byteLength)
  moduleRef.stringToUTF8(modelText, pointer, byteLength)

  const previousCallback = window.wasmAudioWorkletCreated
  let timeoutId = 0
  let settleCreation = null

  const creationPromise = new Promise((resolve, reject) => {
    settleCreation = { resolve, reject }
  })

  const assignedCallback = (audioWorkletNode, audioContext) => {
    if (timeoutId) {
      window.clearTimeout(timeoutId)
      timeoutId = 0
    }
    restoreGlobalCallback(previousCallback, assignedCallback)
    settleCreation.resolve({ audioWorkletNode, audioContext })
  }

  timeoutId = window.setTimeout(() => {
    restoreGlobalCallback(previousCallback, assignedCallback)
    settleCreation.reject(new Error('Timed out while waiting for the NAM audio worklet to be created.'))
  }, DSP_READY_TIMEOUT_MS)

  window.wasmAudioWorkletCreated = assignedCallback

  try {
    await moduleRef.ccall('setDsp', null, ['number'], [pointer], { async: true })
    return await creationPromise
  } catch (error) {
    if (timeoutId) {
      window.clearTimeout(timeoutId)
      timeoutId = 0
    }
    restoreGlobalCallback(previousCallback, assignedCallback)
    throw error
  } finally {
    moduleRef._free(pointer)
  }
}

function serializeProcessorCreation(task) {
  const run = processorCreationQueue.then(task, task)
  processorCreationQueue = run.catch(() => {})
  return run
}

async function createNamProcessorInternal({ modelUrl } = {}) {
  if (!modelUrl) {
    throw new Error('A NAM model URL is required.')
  }

  return serializeProcessorCreation(async () => {
    const moduleRef = await ensureNamModuleReady()
    const modelText = await fetchNamModelText(modelUrl)
    return allocateDsp(moduleRef, modelText)
  })
}

function isSharedProcessorReusable(processor, modelUrl) {
  return (
    processor
    && processor.modelUrl === modelUrl
    && processor.audioContext
    && processor.audioContext.state !== 'closed'
  )
}

export async function createNamProcessor({ modelUrl } = {}) {
  return createNamProcessorInternal({ modelUrl })
}

export async function acquireNamProcessor({ modelUrl } = {}) {
  if (!modelUrl) {
    throw new Error('A NAM model URL is required.')
  }

  if (sharedProcessor && sharedProcessor.audioContext?.state === 'closed') {
    sharedProcessor = null
    sharedProcessorBootstrapPromise = null
  }

  if (isSharedProcessorReusable(sharedProcessor, modelUrl)) {
    if (sharedProcessor.references > 0) {
      throw new Error('NAM bass engine currently supports only one active insert at a time.')
    }
    sharedProcessor.references = 1
    return sharedProcessor
  }

  if (!sharedProcessorBootstrapPromise) {
    sharedProcessorBootstrapPromise = createNamProcessorInternal({ modelUrl })
      .then((processor) => {
        sharedProcessor = {
          ...processor,
          modelUrl,
          references: 0,
        }
        return sharedProcessor
      })
      .catch((error) => {
        sharedProcessorBootstrapPromise = null
        throw error
      })
  }

  const processor = await sharedProcessorBootstrapPromise
  if (!isSharedProcessorReusable(processor, modelUrl)) {
    sharedProcessor = null
    sharedProcessorBootstrapPromise = null
    throw new Error('NAM bass processor is unavailable after initialization.')
  }
  if (processor.references > 0) {
    throw new Error('NAM bass engine currently supports only one active insert at a time.')
  }

  processor.references = 1
  return processor
}

export function releaseNamProcessor(processor) {
  if (!processor || processor !== sharedProcessor) return
  processor.references = Math.max(0, (processor.references || 0) - 1)
  if (processor.audioContext?.state === 'closed') {
    sharedProcessor = null
    sharedProcessorBootstrapPromise = null
  }
}
