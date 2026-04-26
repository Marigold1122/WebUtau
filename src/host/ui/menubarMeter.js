// 顶栏主输出电平表：双通道 PPM（即时峰值 + 1.2s hold + 释放）
// + 12 段对数 FFT 频谱条 + 锁存式 CLIP 指示。
// 旁路接入 ProjectAudioGraph.masterGain（不打断主路输出），
// 用户首次点击播放后 audio context 才创建——这里通过轮询等到 master 节点出现再 tap。

const FFT_SIZE = 2048
const SPECTRUM_BANDS = 12
const SPECTRUM_MIN_DB = -90
const SPECTRUM_MAX_DB = -10
const SPECTRUM_SMOOTHING = 0.32
const PEAK_RELEASE_DB_PER_SEC = 18
const HOLD_TIME_MS = 1200
const HOLD_RELEASE_DB_PER_SEC = 28
const RMS_SMOOTHING = 0.35
const DB_MIN = -60
const DB_MAX = 6
const CLIP_DB = -0.1
const POLL_AUDIO_GRAPH_MS = 200

function linearToDb(amp) {
  if (!(amp > 1e-7)) return -Infinity
  return 20 * Math.log10(amp)
}

function dbToPercent(db) {
  if (!Number.isFinite(db)) return 0
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
  return ((clamped - DB_MIN) / (DB_MAX - DB_MIN)) * 100
}

function buildChannelRow(label) {
  const row = document.createElement('div')
  row.className = 'menubar-meter-row'

  const channelLabel = document.createElement('span')
  channelLabel.className = 'menubar-meter-channel-label'
  channelLabel.textContent = label

  const track = document.createElement('div')
  track.className = 'menubar-meter-track'

  const fill = document.createElement('div')
  fill.className = 'menubar-meter-fill'
  const rms = document.createElement('div')
  rms.className = 'menubar-meter-rms'
  const hold = document.createElement('div')
  hold.className = 'menubar-meter-hold'
  const grid = document.createElement('div')
  grid.className = 'menubar-meter-grid'
  grid.setAttribute('aria-hidden', 'true')
  track.append(fill, rms, hold, grid)

  const readout = document.createElement('span')
  readout.className = 'menubar-meter-readout'
  readout.textContent = '−∞'

  row.append(channelLabel, track, readout)
  return { row, track, readout }
}

function buildSpectrum(count) {
  const container = document.createElement('div')
  container.className = 'menubar-meter-spectrum'
  container.setAttribute('aria-hidden', 'true')
  const bars = []
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('span')
    bar.className = 'menubar-meter-spectrum-bar'
    container.appendChild(bar)
    bars.push(bar)
  }
  return { container, bars }
}

// 把 0..(fftSize/2) 个 bin 按对数频率聚成 SPECTRUM_BANDS 段，
// 返回每段对应的 [lowBin, highBin] 闭区间。
function buildFrequencyBands(count, sampleRate, fftSize) {
  const minHz = 60
  const maxHz = sampleRate / 2
  const ratio = Math.pow(maxHz / minHz, 1 / count)
  const binWidth = sampleRate / fftSize
  const bands = []
  let lowHz = minHz
  for (let i = 0; i < count; i++) {
    const highHz = lowHz * ratio
    const lowBin = Math.max(1, Math.floor(lowHz / binWidth))
    const highBin = Math.min(Math.floor(fftSize / 2) - 1, Math.ceil(highHz / binWidth))
    bands.push([lowBin, Math.max(lowBin, highBin)])
    lowHz = highHz
  }
  return bands
}

function createChannelState(refs) {
  return {
    refs,
    displayPeak: -Infinity,
    displayRms: -Infinity,
    holdPeak: -Infinity,
    holdAt: 0,
    lastReadoutText: '',
    lastReadoutTone: '',
  }
}

function analyseChannel(state, analyser, buffer, dt, now, clipBtn) {
  analyser.getFloatTimeDomainData(buffer)
  let peak = 0
  let sumSq = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i]
    const abs = v < 0 ? -v : v
    if (abs > peak) peak = abs
    sumSq += v * v
  }
  const peakDb = linearToDb(peak)
  const rmsDb = linearToDb(Math.sqrt(sumSq / buffer.length))

  if (peakDb > state.displayPeak) {
    state.displayPeak = peakDb
  } else {
    state.displayPeak = Math.max(DB_MIN, state.displayPeak - PEAK_RELEASE_DB_PER_SEC * dt)
  }

  if (Number.isFinite(state.displayRms)) {
    state.displayRms += (rmsDb - state.displayRms) * Math.min(1, RMS_SMOOTHING * dt * 60)
  } else {
    state.displayRms = Number.isFinite(rmsDb) ? rmsDb : DB_MIN
  }
  if (!Number.isFinite(state.displayRms)) state.displayRms = DB_MIN

  if (peakDb >= state.holdPeak) {
    state.holdPeak = peakDb
    state.holdAt = now
  } else if (now - state.holdAt > HOLD_TIME_MS) {
    state.holdPeak = Math.max(DB_MIN, state.holdPeak - HOLD_RELEASE_DB_PER_SEC * dt)
  }

  const { track, readout } = state.refs
  track.style.setProperty('--peak-pct', `${dbToPercent(state.displayPeak)}%`)
  track.style.setProperty('--rms-pct', `${dbToPercent(state.displayRms)}%`)
  track.style.setProperty('--hold-pct', `${dbToPercent(state.holdPeak)}%`)

  const readoutText = state.displayPeak < DB_MIN + 0.5 ? '−∞' : state.displayPeak.toFixed(1)
  if (readoutText !== state.lastReadoutText) {
    readout.textContent = readoutText
    state.lastReadoutText = readoutText
  }
  let tone = ''
  if (state.displayPeak >= -0.5) tone = 'is-danger'
  else if (state.displayPeak >= -6) tone = 'is-warning'
  if (tone !== state.lastReadoutTone) {
    readout.classList.toggle('is-warning', tone === 'is-warning')
    readout.classList.toggle('is-danger', tone === 'is-danger')
    state.lastReadoutTone = tone
  }

  if (peakDb >= CLIP_DB) clipBtn.classList.add('is-clipped')
}

function updateSpectrum(spectrumState, analyser, buffer, dt) {
  analyser.getFloatFrequencyData(buffer)
  const { bars, bands, prev } = spectrumState
  const span = SPECTRUM_MAX_DB - SPECTRUM_MIN_DB
  const alpha = Math.min(1, SPECTRUM_SMOOTHING * dt * 60)
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i]
    let max = -Infinity
    for (let b = lo; b <= hi; b++) {
      if (buffer[b] > max) max = buffer[b]
    }
    const norm = Number.isFinite(max)
      ? Math.max(0, Math.min(1, (max - SPECTRUM_MIN_DB) / span))
      : 0
    prev[i] += (norm - prev[i]) * alpha
    bars[i].style.setProperty('--bar-height', `${(prev[i] * 100).toFixed(2)}%`)
  }
}

export function installMenubarMeter({ container, audioGraph, onBezelClick = null }) {
  if (!container || !audioGraph) return null
  if (container.dataset.meterInstalled === '1') return null
  container.dataset.meterInstalled = '1'

  const bezel = document.createElement('div')
  bezel.className = 'menubar-meter-bezel'
  if (typeof onBezelClick === 'function') {
    bezel.style.cursor = 'pointer'
    bezel.title = '点击打开主控母带链'
    // 父级 .menubar-meter 有 pointer-events: none（让 transport 控件穿透），
    // bezel 自己必须显式 auto 才能接到点击。inline style 覆盖样式表的 none
    bezel.style.pointerEvents = 'auto'
    bezel.addEventListener('click', (event) => {
      // CLIP 按钮自己 stopPropagation 处理过载复位，不会走到这里——
      // 这里只接 bezel 其它区域（条形、读数、频谱）的点击
      if (event.target.closest?.('.menubar-meter-clip')) return
      event.preventDefault()
      onBezelClick()
    })
  }

  const channels = document.createElement('div')
  channels.className = 'menubar-meter-channels'
  const left = buildChannelRow('L')
  const right = buildChannelRow('R')
  channels.append(left.row, right.row)

  const spectrum = buildSpectrum(SPECTRUM_BANDS)

  const clip = document.createElement('button')
  clip.type = 'button'
  clip.className = 'menubar-meter-clip'
  clip.textContent = 'CLIP'
  clip.title = '主输出过载指示（点击复位）'
  clip.addEventListener('click', () => clip.classList.remove('is-clipped'))

  bezel.append(channels, spectrum.container, clip)
  container.appendChild(bezel)

  const states = [createChannelState(left), createChannelState(right)]
  let stopped = false
  let rafHandle = null

  ;(async () => {
    while (!audioGraph.masterGain || !audioGraph.rawContext) {
      if (stopped) return
      await new Promise((resolve) => setTimeout(resolve, POLL_AUDIO_GRAPH_MS))
    }
    if (stopped) return

    const ctx = audioGraph.rawContext
    // 优先 tap master chain 输出节点——用户听到什么、表上读到什么；
    // chain 没起来（早期版本或异常）时退化到 masterGain，仍能工作
    const master = audioGraph.getMasterTapNode?.() || audioGraph.masterGain
    const splitter = ctx.createChannelSplitter(2)
    const analyserL = ctx.createAnalyser()
    const analyserR = ctx.createAnalyser()
    const analyserSpec = ctx.createAnalyser()
    analyserL.fftSize = FFT_SIZE
    analyserR.fftSize = FFT_SIZE
    analyserSpec.fftSize = FFT_SIZE
    analyserL.smoothingTimeConstant = 0
    analyserR.smoothingTimeConstant = 0
    analyserSpec.smoothingTimeConstant = 0.5
    const bufferL = new Float32Array(analyserL.fftSize)
    const bufferR = new Float32Array(analyserR.fftSize)
    const bufferSpec = new Float32Array(analyserSpec.frequencyBinCount)

    master.connect(splitter)
    splitter.connect(analyserL, 0)
    splitter.connect(analyserR, 1)
    master.connect(analyserSpec)

    const spectrumState = {
      bars: spectrum.bars,
      bands: buildFrequencyBands(SPECTRUM_BANDS, ctx.sampleRate, analyserSpec.fftSize),
      prev: new Array(SPECTRUM_BANDS).fill(0),
    }

    let lastTime = performance.now()
    const tick = () => {
      if (stopped) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastTime) / 1000)
      lastTime = now
      analyseChannel(states[0], analyserL, bufferL, dt, now, clip)
      analyseChannel(states[1], analyserR, bufferR, dt, now, clip)
      updateSpectrum(spectrumState, analyserSpec, bufferSpec, dt)
      rafHandle = requestAnimationFrame(tick)
    }
    rafHandle = requestAnimationFrame(tick)
  })()

  return () => {
    stopped = true
    if (rafHandle) cancelAnimationFrame(rafHandle)
    bezel.remove()
    delete container.dataset.meterInstalled
  }
}
