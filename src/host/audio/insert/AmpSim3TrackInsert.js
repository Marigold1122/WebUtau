const GRAPHIC_EQ_FREQUENCIES = [60, 170, 350, 1000, 3500, 10000]
const WAVESHAPER_SIZE = 44100
const ALT_WAVESHAPER_SIZE = 22050
const impulseBufferPromises = new Map()

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function disconnectNode(node) {
  try { node?.disconnect?.() } catch (_error) {}
}

function knobToDriveAmount(knobValue) {
  const normalizedKnob = clamp(Number.isFinite(knobValue) ? knobValue : 0, 0, 10)
  const value = 150 * normalizedKnob
  const minValue = Math.log(10)
  const maxValue = Math.log(1500)
  const scale = (maxValue - minValue) / 1500
  return Math.exp(minValue + scale * value)
}

function createClassicDistortionCurve(k, multiplier = 57) {
  const curve = new Float32Array(WAVESHAPER_SIZE)
  const deg = Math.PI / 180
  for (let i = 0; i < WAVESHAPER_SIZE; i += 1) {
    const x = (i * 2) / WAVESHAPER_SIZE - 1
    curve[i] = ((3 + k) * x * multiplier * deg) / (Math.PI + k * Math.abs(x))
  }
  return curve
}

function createAsymmetricCurve() {
  const curve = new Float32Array(WAVESHAPER_SIZE)
  for (let i = 0; i < WAVESHAPER_SIZE; i += 1) {
    const x = (i * 2) / WAVESHAPER_SIZE - 1
    if (x < -0.08905) {
      curve[i] = (-3 / 4) * (1 - ((1 - (Math.abs(x) - 0.032857)) ** 12) + ((Math.abs(x) - 0.032847) / 3)) + 0.01
    } else if (x < 0.320018) {
      curve[i] = (-6.153 * (x ** 2)) + (3.9375 * x)
    } else {
      curve[i] = 0.630035
    }
  }
  return curve
}

function createNotSoDistortedCurve(driveAmount) {
  let amount = driveAmount / 150
  amount = (amount + 2) ** 3
  const curve = new Float32Array(ALT_WAVESHAPER_SIZE)
  for (let i = 0; i < ALT_WAVESHAPER_SIZE; i += 1) {
    const x = (i * 2) / ALT_WAVESHAPER_SIZE - 1
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x))
  }
  return curve
}

function createCrunchCurve(driveAmount) {
  let amount = driveAmount / 150
  amount **= 2
  const curve = new Float32Array(ALT_WAVESHAPER_SIZE)
  for (let i = 0; i < ALT_WAVESHAPER_SIZE; i += 1) {
    const x = (i * 2) / ALT_WAVESHAPER_SIZE - 1
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x))
  }
  return curve
}

function createSuperCleanCurve(driveAmount) {
  const amount = ((driveAmount / 150) + 6) / 4
  const curve = new Float32Array(ALT_WAVESHAPER_SIZE)
  for (let i = 0; i < ALT_WAVESHAPER_SIZE; i += 1) {
    const x = (i * 2) / ALT_WAVESHAPER_SIZE - 1
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x))
  }
  return curve
}

function createDistortionCurve(type, driveKnob) {
  const driveAmount = knobToDriveAmount(driveKnob)
  if (type === 'asymetric') return createAsymmetricCurve()
  if (type === 'standard') return createClassicDistortionCurve(driveAmount, 57)
  if (type === 'crunch') return createCrunchCurve(driveAmount)
  if (type === 'superClean') return createSuperCleanCurve(driveAmount)
  if (type === 'notSoDistorded') return createNotSoDistortedCurve(driveAmount)
  return createClassicDistortionCurve(driveAmount, 20)
}

async function loadImpulseBuffer(rawContext, url) {
  if (!impulseBufferPromises.has(url)) {
    const promise = fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load impulse: ${response.status} ${response.statusText}`)
        }
        return response.arrayBuffer()
      })
      .then((arrayBuffer) => rawContext.decodeAudioData(arrayBuffer.slice(0)))
      .catch((error) => {
        impulseBufferPromises.delete(url)
        throw error
      })
    impulseBufferPromises.set(url, promise)
  }
  return impulseBufferPromises.get(url)
}

function createGraphicEq(rawContext, values = []) {
  const filters = GRAPHIC_EQ_FREQUENCIES.map((frequency, index) => {
    const filter = rawContext.createBiquadFilter()
    filter.type = 'peaking'
    filter.frequency.value = frequency
    filter.gain.value = Number.isFinite(values[index]) ? values[index] : 0
    return filter
  })

  for (let i = 0; i < filters.length - 1; i += 1) {
    filters[i].connect(filters[i + 1])
  }

  return {
    input: filters[0],
    output: filters[filters.length - 1],
    filters,
  }
}

function createCabinetBlend(rawContext, cabinet, logger = null) {
  const input = rawContext.createGain()
  const output = rawContext.createGain()
  const convolver = rawContext.createConvolver()
  const dryGain = rawContext.createGain()
  const wetGain = rawContext.createGain()
  let disposed = false
  let currentUrl = ''
  let readyPromise = Promise.resolve()

  input.connect(dryGain)
  dryGain.connect(output)
  input.connect(convolver)
  convolver.connect(wetGain)
  wetGain.connect(output)

  const setMix = (mixValue) => {
    const mix = clamp(Number.isFinite(mixValue) ? mixValue : 0, 0, 1)
    dryGain.gain.value = Math.cos(mix * Math.PI / 2)
    wetGain.gain.value = Math.cos((1 - mix) * Math.PI / 2)
  }

  const loadCabinet = (url) => {
    if (!url) {
      currentUrl = ''
      convolver.buffer = null
      readyPromise = Promise.resolve()
      return readyPromise
    }
    if (currentUrl === url) return readyPromise
    currentUrl = url
    readyPromise = loadImpulseBuffer(rawContext, url)
      .then((buffer) => {
        if (!disposed) {
          convolver.buffer = buffer
        }
      })
      .catch((error) => {
        logger?.warn?.('Amp cabinet impulse load failed', {
          url,
          error: error?.message || String(error),
        })
      })
    return readyPromise
  }

  const setProfile = (nextCabinet) => {
    setMix(nextCabinet?.mix)
    return loadCabinet(nextCabinet?.mix > 0.0001 ? nextCabinet?.url : null)
  }

  setProfile(cabinet)

  return {
    input,
    output,
    get readyPromise() {
      return readyPromise
    },
    setProfile,
    dispose() {
      disposed = true
      disconnectNode(input)
      disconnectNode(convolver)
      disconnectNode(dryGain)
      disconnectNode(wetGain)
      disconnectNode(output)
    },
  }
}

function applyToneProfile(filters, tone = {}) {
  filters.bass.gain.value = ((Number.isFinite(tone.bass) ? tone.bass : 10) - 10) * 7
  filters.mid.gain.value = ((Number.isFinite(tone.mid) ? tone.mid : 5) - 5) * 4
  filters.treble.gain.value = ((Number.isFinite(tone.treble) ? tone.treble : 10) - 10) * 10
  filters.presence.gain.value = ((Number.isFinite(tone.presence) ? tone.presence : 5) - 5) * 2
}

function applyGraphicEqProfile(graphicEq, values = []) {
  graphicEq.filters.forEach((filter, index) => {
    filter.gain.value = Number.isFinite(values[index]) ? values[index] : 0
  })
}

function applyAmpSim3Profile(nodeRefs, profile = {}) {
  nodeRefs.inputGain.gain.value = Number.isFinite(profile.inputGain) ? profile.inputGain : 1
  nodeRefs.lowShelf1.frequency.value = Number(profile?.lowShelf1?.frequency) || nodeRefs.lowShelf1.frequency.value
  nodeRefs.lowShelf1.gain.value = Number(profile?.lowShelf1?.gain) || 0
  nodeRefs.lowShelf2.frequency.value = Number(profile?.lowShelf2?.frequency) || nodeRefs.lowShelf2.frequency.value
  nodeRefs.lowShelf2.gain.value = Number(profile?.lowShelf2?.gain) || 0
  nodeRefs.preampStage1Gain.gain.value = Number.isFinite(profile.preampStage1Gain) ? profile.preampStage1Gain : 1
  nodeRefs.distoStage1.curve = createDistortionCurve(profile?.distoStage1?.type, profile?.distoStage1?.drive)
  nodeRefs.highPass1.frequency.value = Number(profile?.highPass1?.frequency) || nodeRefs.highPass1.frequency.value
  nodeRefs.highPass1.Q.value = Number(profile?.highPass1?.q) || nodeRefs.highPass1.Q.value
  nodeRefs.lowShelf3.frequency.value = Number(profile?.lowShelf3?.frequency) || nodeRefs.lowShelf3.frequency.value
  nodeRefs.lowShelf3.gain.value = Number(profile?.lowShelf3?.gain) || 0
  nodeRefs.preampStage2Gain.gain.value = Number.isFinite(profile.preampStage2Gain) ? profile.preampStage2Gain : 1
  nodeRefs.distoStage2.curve = createDistortionCurve(profile?.distoStage2?.type, profile?.distoStage2?.drive)
  nodeRefs.outputGain.gain.value = Number.isFinite(profile.outputGain) ? profile.outputGain : 1
  applyToneProfile(nodeRefs.toneFilters, profile.tone)
  nodeRefs.eqLowCut.frequency.value = Number(profile?.postCuts?.low?.frequency) || nodeRefs.eqLowCut.frequency.value
  nodeRefs.eqLowCut.gain.value = Number(profile?.postCuts?.low?.gain) || 0
  nodeRefs.eqHighCut.frequency.value = Number(profile?.postCuts?.high?.frequency) || nodeRefs.eqHighCut.frequency.value
  nodeRefs.eqHighCut.gain.value = Number(profile?.postCuts?.high?.gain) || 0
  applyGraphicEqProfile(nodeRefs.graphicEq, profile.graphicEq)
  nodeRefs.cabinet?.setProfile?.(profile.cabinet)
}

export function createAmpSim3TrackInsert({ rawContext, profile, logger = null } = {}) {
  if (!rawContext || !profile || profile.engine !== 'amp-sim3') return null

  const input = rawContext.createGain()
  const output = rawContext.createGain()
  const inputGain = rawContext.createGain()

  const lowShelf1 = rawContext.createBiquadFilter()
  lowShelf1.type = 'lowshelf'

  const lowShelf2 = rawContext.createBiquadFilter()
  lowShelf2.type = 'lowshelf'

  const preampStage1Gain = rawContext.createGain()

  const distoStage1 = rawContext.createWaveShaper()
  distoStage1.oversample = '4x'

  const highPass1 = rawContext.createBiquadFilter()
  highPass1.type = 'highpass'

  const lowShelf3 = rawContext.createBiquadFilter()
  lowShelf3.type = 'lowshelf'

  const preampStage2Gain = rawContext.createGain()

  const distoStage2 = rawContext.createWaveShaper()
  distoStage2.oversample = '4x'

  const outputGain = rawContext.createGain()

  const treble = rawContext.createBiquadFilter()
  treble.type = 'highshelf'
  treble.frequency.value = 6500
  treble.Q.value = 0.7071

  const bass = rawContext.createBiquadFilter()
  bass.type = 'lowshelf'
  bass.frequency.value = 100
  bass.Q.value = 0.7071

  const mid = rawContext.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1700
  mid.Q.value = 0.7071

  const presence = rawContext.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 3900
  presence.Q.value = 0.7071

  const eqLowCut = rawContext.createBiquadFilter()
  eqLowCut.type = 'peaking'

  const eqHighCut = rawContext.createBiquadFilter()
  eqHighCut.type = 'peaking'

  const graphicEq = createGraphicEq(rawContext, profile.graphicEq)
  const finalGain = rawContext.createGain()
  finalGain.gain.value = 1
  const cabinet = profile.cabinet ? createCabinetBlend(rawContext, profile.cabinet, logger) : null

  input.connect(inputGain)
  inputGain.connect(lowShelf1)
  lowShelf1.connect(lowShelf2)
  lowShelf2.connect(preampStage1Gain)
  preampStage1Gain.connect(distoStage1)
  distoStage1.connect(highPass1)
  highPass1.connect(lowShelf3)
  lowShelf3.connect(preampStage2Gain)
  preampStage2Gain.connect(distoStage2)
  distoStage2.connect(outputGain)
  outputGain.connect(treble)
  treble.connect(bass)
  bass.connect(mid)
  mid.connect(presence)
  presence.connect(eqLowCut)
  eqLowCut.connect(eqHighCut)
  eqHighCut.connect(graphicEq.input)

  if (cabinet) {
    graphicEq.output.connect(cabinet.input)
    cabinet.output.connect(finalGain)
  } else {
    graphicEq.output.connect(finalGain)
  }

  finalGain.connect(output)

  const nodeRefs = {
    inputGain,
    lowShelf1,
    lowShelf2,
    preampStage1Gain,
    distoStage1,
    highPass1,
    lowShelf3,
    preampStage2Gain,
    distoStage2,
    outputGain,
    toneFilters: {
      bass,
      mid,
      treble,
      presence,
    },
    eqLowCut,
    eqHighCut,
    graphicEq,
    cabinet,
  }
  applyAmpSim3Profile(nodeRefs, profile)

  const nodes = [
    input,
    output,
    inputGain,
    lowShelf1,
    lowShelf2,
    preampStage1Gain,
    distoStage1,
    highPass1,
    lowShelf3,
    preampStage2Gain,
    distoStage2,
    outputGain,
    treble,
    bass,
    mid,
    presence,
    eqLowCut,
    eqHighCut,
    ...graphicEq.filters,
    finalGain,
  ]

  return {
    input,
    output,
    readyPromise: cabinet?.readyPromise || Promise.resolve(),
    updateProfile(nextProfile) {
      applyAmpSim3Profile(nodeRefs, nextProfile)
    },
    dispose() {
      cabinet?.dispose?.()
      nodes.forEach(disconnectNode)
    },
  }
}
