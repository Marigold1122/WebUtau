import { isAudioTrack } from '../../project/trackContentType.js'
import { normalizeTrackPan, normalizeTrackReverbConfig, normalizeTrackReverbSend, normalizeTrackVolume } from '../../project/trackPlaybackState.js'
import { renderTrackPreviewCanvas } from '../renderTrackPreviewCanvas.js'
import { createTrackMonitorBadge } from './TrackMonitorBadge.js'
import { resolveTrackColor } from './trackColorPalette.js'
import { createTrackSourcePicker } from './TrackSourcePicker.js'

export const TRACK_ROW_HEIGHT = 64
const CLIP_TOP = 5
const CLIP_HEIGHT = 52
const CLIP_HEADER_HEIGHT = 16
const MIDI_PREVIEW_HEIGHT = CLIP_HEIGHT - CLIP_HEADER_HEIGHT - 1

// 单击 name 延后触发选中的窗口长度（与浏览器 dblclick 判定接近）。
// 在窗口内若发生原生 dblclick，撤销 pending 选中并改派重命名，
// 从而避免第一击立即 render 重建 DOM 把第二击打散。
const TRACK_NAME_CLICK_DEFER_MS = 250

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function hexToRgba(hexColor, alpha) {
  const hex = typeof hexColor === 'string' ? hexColor.replace('#', '') : ''
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return `rgba(59,139,136,${alpha})`
  const channels = hex.match(/.{2}/g) || []
  const [red, green, blue] = channels.map((channel) => Number.parseInt(channel, 16))
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function sampleValues(values = [], maxCount = 72) {
  if (!Array.isArray(values) || values.length === 0) return []
  if (values.length <= maxCount) return values
  const step = Math.max(1, Math.ceil(values.length / maxCount))
  return values.filter((_, index) => index % step === 0).slice(0, maxCount)
}

function quantizeTrackVolume(value) {
  return Math.round(normalizeTrackVolume(value) * 100) / 100
}

function formatTrackVolumePercent(value) {
  return Math.round(normalizeTrackVolume(value) * 100)
}

function quantizeTrackPan(value) {
  return Math.round(normalizeTrackPan(value) * 100) / 100
}

// pan 在 0 附近自动吸附到正中——拖动时手感更好，专业 DAW 通用约定
const PAN_SNAP_THRESHOLD = 0.05
function snapTrackPan(value) {
  const normalized = quantizeTrackPan(value)
  return Math.abs(normalized) < PAN_SNAP_THRESHOLD ? 0 : normalized
}

function formatTrackPanReadout(value) {
  const normalized = quantizeTrackPan(value)
  if (Math.abs(normalized) < 0.005) return 'C'
  const direction = normalized < 0 ? 'L' : 'R'
  return `${direction} ${Math.round(Math.abs(normalized) * 100)}`
}

function getNoteStartTick(note, axis) {
  if (Number.isFinite(note?.tick)) return Math.max(0, Math.round(note.tick))
  if (axis && Number.isFinite(note?.time)) return Math.max(0, Math.round(axis.timeToTick(note.time)))
  return 0
}

function getNoteEndTick(note, axis) {
  const startTick = getNoteStartTick(note, axis)
  if (Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)) {
    return Math.max(startTick, Math.round(note.tick + note.durationTicks))
  }
  if (axis && Number.isFinite(note?.time) && Number.isFinite(note?.duration)) {
    return Math.max(startTick, Math.round(axis.timeToTick(note.time + note.duration)))
  }
  return startTick
}

function getNoteStartTime(note, axis) {
  if (axis && Number.isFinite(note?.tick)) return Math.max(0, axis.tickToTime(note.tick))
  if (Number.isFinite(note?.time)) return Math.max(0, note.time)
  return 0
}

function getNoteEndTime(note, axis) {
  if (axis && Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)) {
    return Math.max(getNoteStartTime(note, axis), axis.tickToTime(note.tick + note.durationTicks))
  }
  if (Number.isFinite(note?.time) && Number.isFinite(note?.duration)) {
    return Math.max(getNoteStartTime(note, axis), note.time + note.duration)
  }
  return getNoteStartTime(note, axis)
}

function getNoteStartX(note, axis) {
  if (!axis) return 0
  if (Number.isFinite(note?.tick)) return Math.max(0, axis.tickToX(note.tick))
  if (Number.isFinite(note?.time)) return Math.max(0, axis.timeToX(note.time))
  return 0
}

function getNoteEndX(note, axis) {
  if (!axis) return 0
  if (Number.isFinite(note?.tick) && Number.isFinite(note?.durationTicks)) {
    return Math.max(getNoteStartX(note, axis), axis.tickToX(note.tick + note.durationTicks))
  }
  if (Number.isFinite(note?.time) && Number.isFinite(note?.duration)) {
    return Math.max(getNoteStartX(note, axis), axis.timeToX(note.time + note.duration))
  }
  return getNoteStartX(note, axis)
}

function getTrackClipBounds(track, axis) {
  if (isAudioTrack(track)) {
    const startTime = Math.max(0, track.audioClip?.startTime || 0)
    const duration = Math.max(0, track.audioClip?.duration || 0)
    const startTick = axis ? Math.max(0, Math.round(axis.timeToTick(startTime))) : 0
    const endTick = axis ? Math.max(startTick, Math.round(axis.timeToTick(startTime + duration))) : startTick
    return duration > 0
      ? {
        startTime,
        endTime: startTime + duration,
        duration,
        startTick,
        endTick,
        startX: axis ? Math.max(0, axis.timeToX(startTime)) : 0,
        endX: axis ? Math.max(0, axis.timeToX(startTime + duration)) : 0,
      }
      : null
  }

  const notes = Array.isArray(track.previewNotes) ? track.previewNotes : []
  if (notes.length === 0) return null
  const startTime = notes.reduce((minValue, note) => Math.min(minValue, getNoteStartTime(note, axis)), Infinity)
  const endTime = notes.reduce((maxValue, note) => Math.max(maxValue, getNoteEndTime(note, axis)), 0)
  const startTick = notes.reduce((minValue, note) => Math.min(minValue, getNoteStartTick(note, axis)), Infinity)
  const endTick = notes.reduce((maxValue, note) => Math.max(maxValue, getNoteEndTick(note, axis)), 0)
  if (!Number.isFinite(startTime) || endTime <= startTime) return null
  return {
    startTime,
    endTime,
    duration: endTime - startTime,
    startTick,
    endTick,
    startX: axis ? Math.max(0, axis.tickToX(startTick)) : 0,
    endX: axis ? Math.max(0, axis.tickToX(endTick)) : 0,
  }
}

function applyTrackVolumeControlState(control, fill, knob, valueNode, volume) {
  const normalizedVolume = quantizeTrackVolume(volume)
  const percent = formatTrackVolumePercent(normalizedVolume)
  control.dataset.volume = normalizedVolume.toFixed(2)
  control.style.setProperty('--track-volume-position', `${normalizedVolume * 100}%`)
  fill.style.width = `${normalizedVolume * 100}%`
  knob.setAttribute('aria-valuenow', String(percent))
  knob.setAttribute('aria-valuetext', `${percent}%`)
  valueNode.textContent = String(percent)
}

// pan 的 fill 从 50% 中心向左/右延伸——L 时 left 收缩、width 增加；R 时 left 固定 50%、width 增加
function applyTrackPanControlState(control, fill, knob, valueNode, pan) {
  const normalizedPan = quantizeTrackPan(pan)
  const knobPercent = (normalizedPan + 1) * 50 // [-1,1] → [0,100]
  control.dataset.pan = normalizedPan.toFixed(2)
  control.style.setProperty('--track-pan-position', `${knobPercent}%`)
  if (normalizedPan < 0) {
    const fillStart = 50 + normalizedPan * 50
    fill.style.left = `${fillStart}%`
    fill.style.width = `${50 - fillStart}%`
  } else {
    fill.style.left = '50%'
    fill.style.width = `${normalizedPan * 50}%`
  }
  const ariaValue = Math.round(normalizedPan * 100)
  knob.setAttribute('aria-valuenow', String(ariaValue))
  knob.setAttribute('aria-valuetext', formatTrackPanReadout(normalizedPan))
  valueNode.textContent = formatTrackPanReadout(normalizedPan)
}

function createTrackVolumeControl(track, trackColor, handlers) {
  const control = document.createElement('div')
  control.className = 'th-volume'
  control.style.setProperty('--track-color', trackColor)

  const shell = document.createElement('div')
  shell.className = 'th-volume-shell'

  const scale = document.createElement('div')
  scale.className = 'th-volume-scale'
  const fill = document.createElement('span')
  fill.className = 'th-volume-fill'
  scale.appendChild(fill)

  const knob = document.createElement('button')
  knob.type = 'button'
  knob.className = 'th-volume-knob'
  knob.setAttribute('role', 'slider')
  knob.setAttribute('aria-label', `${track.name} 音量`)
  knob.setAttribute('aria-valuemin', '0')
  knob.setAttribute('aria-valuemax', '100')
  knob.setAttribute('aria-orientation', 'horizontal')

  const indicator = document.createElement('span')
  indicator.className = 'th-volume-indicator'
  knob.appendChild(indicator)
  shell.append(scale, knob)

  const readout = document.createElement('div')
  readout.className = 'th-volume-readout'
  const valueNode = document.createElement('span')
  valueNode.className = 'th-volume-value'
  readout.appendChild(valueNode)

  control.append(shell, readout)

  let currentVolume = quantizeTrackVolume(track.playbackState?.volume)
  applyTrackVolumeControlState(control, fill, knob, valueNode, currentVolume)

  const commitVolume = (nextVolume, { commit = true } = {}) => {
    const quantizedVolume = quantizeTrackVolume(nextVolume)
    if (Math.abs(quantizedVolume - currentVolume) < 0.0001 && !commit) return false
    currentVolume = quantizedVolume
    applyTrackVolumeControlState(control, fill, knob, valueNode, currentVolume)
    handlers.onTrackVolumeChanged?.(track.id, quantizedVolume, { commit })
    return true
  }

  const resolvePointerVolume = (clientX) => {
    const rect = scale.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || rect.width <= 0) return currentVolume
    return quantizeTrackVolume((clientX - rect.left) / rect.width)
  }

  const stopEvent = (event) => {
    event.stopPropagation()
  }

  control.addEventListener('click', stopEvent)
  control.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  // 与时间轴 clip 拖动一致的阈值：未超过则视作单击。
  const VOLUME_DRAG_THRESHOLD = 3

  const beginVolumeEdit = () => {
    if (control.classList.contains('editing')) return
    control.classList.add('editing')

    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'numeric'
    input.className = 'th-volume-input'
    input.value = String(formatTrackVolumePercent(currentVolume))
    input.setAttribute('aria-label', `${track.name} 音量百分比`)
    input.maxLength = 5

    valueNode.style.display = 'none'
    readout.appendChild(input)
    // 等到当前事件循环结束后再 focus，避开同帧 pointerup 引发的 blur 抖动。
    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })

    let finished = false
    const finish = (cancel) => {
      if (finished) return
      finished = true
      control.classList.remove('editing')
      if (input.parentNode) input.parentNode.removeChild(input)
      valueNode.style.display = ''
      if (cancel) return
      const numeric = Number.parseFloat(input.value)
      if (!Number.isFinite(numeric)) return
      commitVolume(clamp(numeric, 0, 100) / 100, { commit: true })
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
      } else {
        // 阻断全局快捷键（如空格触发播放）。
        event.stopPropagation()
      }
    })
    input.addEventListener('blur', () => finish(false))
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('dblclick', (event) => event.stopPropagation())
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    // 编辑中再次按下时（点 input 自身已 stopPropagation，所以这里多半是按到 shell 别处），
    // 直接交给 input 自己处理 blur，跳过常规拖动初始化。
    if (control.classList.contains('editing')) return
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    let dragging = false

    const enterDrag = (clientX) => {
      dragging = true
      control.classList.add('dragging')
      knob.focus({ preventScroll: true })
      commitVolume(resolvePointerVolume(clientX), { commit: false })
    }

    const handlePointerMove = (moveEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < VOLUME_DRAG_THRESHOLD) return
        enterDrag(moveEvent.clientX)
        return
      }
      commitVolume(resolvePointerVolume(moveEvent.clientX), { commit: false })
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      if (dragging) {
        control.classList.remove('dragging')
        handlers.onTrackVolumeChanged?.(track.id, currentVolume, { commit: true })
        return
      }
      beginVolumeEdit()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }

  shell.addEventListener('pointerdown', handlePointerDown)

  control.addEventListener('wheel', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const delta = event.deltaY < 0 ? 0.04 : -0.04
    commitVolume(currentVolume + delta, { commit: true })
  }, { passive: false })

  knob.addEventListener('keydown', (event) => {
    let nextVolume = currentVolume
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      nextVolume += 0.02
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      nextVolume -= 0.02
    } else if (event.key === 'PageUp') {
      nextVolume += 0.1
    } else if (event.key === 'PageDown') {
      nextVolume -= 0.1
    } else if (event.key === 'Home') {
      nextVolume = 0
    } else if (event.key === 'End') {
      nextVolume = 1
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    commitVolume(nextVolume, { commit: true })
  })

  return control
}

// pan 控件：跟 volume 一致的交互模型（拖动 + 滚轮 + 方向键 + 单击精准输入），
// 但 fill 从中心向两侧伸展、拖动时 |pan| < 0.05 自动吸附到 0
function createTrackPanControl(track, trackColor, handlers) {
  const control = document.createElement('div')
  control.className = 'th-pan'
  control.style.setProperty('--track-color', trackColor)

  const shell = document.createElement('div')
  shell.className = 'th-pan-shell'

  const scale = document.createElement('div')
  scale.className = 'th-pan-scale'
  const fill = document.createElement('span')
  fill.className = 'th-pan-fill'
  const center = document.createElement('span')
  center.className = 'th-pan-center'
  scale.append(fill, center)

  const knob = document.createElement('button')
  knob.type = 'button'
  knob.className = 'th-pan-knob'
  knob.setAttribute('role', 'slider')
  knob.setAttribute('aria-label', `${track.name} 声像`)
  knob.setAttribute('aria-valuemin', '-100')
  knob.setAttribute('aria-valuemax', '100')
  knob.setAttribute('aria-orientation', 'horizontal')
  shell.append(scale, knob)

  const readout = document.createElement('div')
  readout.className = 'th-pan-readout'
  const valueNode = document.createElement('span')
  valueNode.className = 'th-pan-value'
  readout.appendChild(valueNode)

  control.append(shell, readout)

  let currentPan = quantizeTrackPan(track.playbackState?.pan)
  applyTrackPanControlState(control, fill, knob, valueNode, currentPan)

  const commitPan = (nextPan, { commit = true, snap = true } = {}) => {
    const candidate = snap ? snapTrackPan(nextPan) : quantizeTrackPan(nextPan)
    if (Math.abs(candidate - currentPan) < 0.0001 && !commit) return false
    currentPan = candidate
    applyTrackPanControlState(control, fill, knob, valueNode, currentPan)
    handlers.onTrackPanChanged?.(track.id, candidate, { commit })
    return true
  }

  const resolvePointerPan = (clientX) => {
    const rect = scale.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || rect.width <= 0) return currentPan
    const ratio = (clientX - rect.left) / rect.width
    return snapTrackPan(ratio * 2 - 1) // [0,1] → [-1,1]
  }

  control.addEventListener('click', (event) => event.stopPropagation())
  control.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  const PAN_DRAG_THRESHOLD = 3

  const beginPanEdit = () => {
    if (control.classList.contains('editing')) return
    control.classList.add('editing')

    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'numeric'
    input.className = 'th-pan-input'
    // 编辑时显示带符号的纯数字（-100 ~ 100），方便精确输入
    input.value = String(Math.round(currentPan * 100))
    input.setAttribute('aria-label', `${track.name} 声像 -100 到 100`)
    input.maxLength = 5

    valueNode.style.display = 'none'
    readout.appendChild(input)
    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })

    let finished = false
    const finish = (cancel) => {
      if (finished) return
      finished = true
      control.classList.remove('editing')
      if (input.parentNode) input.parentNode.removeChild(input)
      valueNode.style.display = ''
      if (cancel) return
      const numeric = Number.parseFloat(input.value)
      if (!Number.isFinite(numeric)) return
      // 精准输入不走 snap——用户敲了 3 就给 3，不要被吸附到 0
      commitPan(clamp(numeric, -100, 100) / 100, { commit: true, snap: false })
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
      } else {
        event.stopPropagation()
      }
    })
    input.addEventListener('blur', () => finish(false))
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('dblclick', (event) => event.stopPropagation())
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    if (control.classList.contains('editing')) return
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    let dragging = false

    const enterDrag = (clientX) => {
      dragging = true
      control.classList.add('dragging')
      knob.focus({ preventScroll: true })
      commitPan(resolvePointerPan(clientX), { commit: false })
    }

    const handlePointerMove = (moveEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < PAN_DRAG_THRESHOLD) return
        enterDrag(moveEvent.clientX)
        return
      }
      commitPan(resolvePointerPan(moveEvent.clientX), { commit: false })
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      if (dragging) {
        control.classList.remove('dragging')
        handlers.onTrackPanChanged?.(track.id, currentPan, { commit: true })
        return
      }
      beginPanEdit()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }

  shell.addEventListener('pointerdown', handlePointerDown)

  control.addEventListener('wheel', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const delta = event.deltaY < 0 ? 0.04 : -0.04
    commitPan(currentPan + delta, { commit: true, snap: false })
  }, { passive: false })

  knob.addEventListener('keydown', (event) => {
    let nextPan = currentPan
    if (event.key === 'ArrowRight') nextPan += 0.02
    else if (event.key === 'ArrowLeft') nextPan -= 0.02
    else if (event.key === 'PageUp') nextPan += 0.1
    else if (event.key === 'PageDown') nextPan -= 0.1
    else if (event.key === 'Home') nextPan = -1
    else if (event.key === 'End') nextPan = 1
    else if (event.key === 'Enter' || event.key === ' ') nextPan = 0
    else return
    event.preventDefault()
    event.stopPropagation()
    commitPan(nextPan, { commit: true, snap: false })
  })

  return control
}

export function buildTrackPreviewGridOverlay({ timelineMetrics, contentHeight }) {
  const grid = document.createElement('div')
  grid.className = 'track-preview-grid-overlay'
  grid.style.height = `${Math.max(0, Math.round(contentHeight || 0))}px`
  grid.style.width = `${timelineMetrics?.timelineWidth || 0}px`
  const marks = timelineMetrics?.axis?.getRulerMarks?.({
    subdivisionsPerBeat: timelineMetrics?.snapDivision || 4,
  }) || []
  if (marks.length === 0) return grid

  const fragment = document.createDocumentFragment()
  marks.forEach((mark) => {
    const line = document.createElement('span')
    line.className = `track-preview-grid-line ${mark.kind}`
    line.style.left = `${Math.round(mark.x)}px`
    fragment.appendChild(line)
  })
  grid.appendChild(fragment)
  return grid
}

function snapTickToGrid(tick, snapTicks) {
  const safeSnapTicks = Number.isFinite(snapTicks) && snapTicks > 0 ? snapTicks : 1
  return Math.max(0, Math.round(Math.round((Number.isFinite(tick) ? tick : 0) / safeSnapTicks) * safeSnapTicks))
}

function isTrackAudible(track, viewState) {
  return !viewState?.audibleTrackIds || viewState.audibleTrackIds.has(track.id)
}

function isSourcePickerOpenTrack(track, viewState) {
  return viewState?.openSourcePickerTrackId === track.id
}

function applyTrackStateClasses(element, track, viewState) {
  element.classList.toggle('focus-solo', viewState?.focusSoloTrackId === track.id)
  element.classList.toggle('soloed', Boolean(track.playbackState?.solo))
  element.classList.toggle('muted', Boolean(track.playbackState?.mute))
  element.classList.toggle('dimmed', !isTrackAudible(track, viewState))
}

function createTrackItem({ track, index, selectedTrackId, viewState, handlers }) {
  const trackColor = resolveTrackColor(track, index)
  const item = document.createElement('div')
  item.className = `track-item${track.id === selectedTrackId ? ' active' : ''}`
  applyTrackStateClasses(item, track, viewState)
  item.dataset.trackId = track.id

  const top = document.createElement('div')
  top.className = 'th-top'

  const nameWrap = document.createElement('div')
  nameWrap.className = 'th-name'

  // 轨道号色块本身就是该轨道的"颜色身份"标识；点击该色块会打开原生取色器，
  // 通过盖在上面的透明 input[type=color] 接管点击 → 不需要任何额外按钮。
  const trackNumber = document.createElement('span')
  trackNumber.className = 'trk-num'
  trackNumber.style.background = trackColor
  trackNumber.title = '点击更改轨道颜色'

  const trackNumberLabel = document.createElement('span')
  trackNumberLabel.className = 'trk-num-label'
  trackNumberLabel.textContent = String(index + 1).padStart(2, '0')

  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.className = 'trk-num-picker'
  colorInput.value = trackColor
  colorInput.setAttribute('aria-label', '轨道颜色')
  // 阻断点击冒泡，避免触发 row.click → onTrackSelected → 立刻 render 重建 DOM
  // 把取色器对话框打散
  colorInput.addEventListener('click', (event) => event.stopPropagation())
  colorInput.addEventListener('pointerdown', (event) => event.stopPropagation())
  // 实时预览：用户在原生面板里拖动色相时 swatch 立刻跟着变
  colorInput.addEventListener('input', (event) => {
    trackNumber.style.background = event.target.value
  })
  colorInput.addEventListener('change', (event) => {
    handlers.onTrackColorChanged?.(track.id, event.target.value)
  })

  trackNumber.append(trackNumberLabel, colorInput)
  nameWrap.appendChild(trackNumber)

  const name = document.createElement('span')
  name.className = 'track-name'
  name.textContent = track.name
  name.style.setProperty('--track-color', trackColor)
  name.title = '双击重命名'
  // 单击 name 时阻止冒泡到 row.click，把"选中"挂在延迟 timer 上；
  // 若紧接着触发原生 dblclick，把 pending timer 撤掉、改派重命名。
  // 这样既保证单击能选中（无闪烁），又让双击重命名稳定生效——
  // 期间不会发生 render 重建打散第二击。同时阻断 row.dblclick 的"打开编辑器"。
  let pendingSelectTimer = null
  const cancelPendingSelect = () => {
    if (pendingSelectTimer) {
      clearTimeout(pendingSelectTimer)
      pendingSelectTimer = null
    }
  }
  name.addEventListener('click', (event) => {
    event.stopPropagation()
    cancelPendingSelect()
    pendingSelectTimer = setTimeout(() => {
      pendingSelectTimer = null
      handlers.onTrackSelected?.(track.id)
    }, TRACK_NAME_CLICK_DEFER_MS)
  })
  name.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
    cancelPendingSelect()
    handlers.onTrackRenameRequested?.(track.id, name)
  })
  nameWrap.appendChild(name)
  top.appendChild(nameWrap)
  top.appendChild(createTrackSourcePicker(track, {
    isOpen: isSourcePickerOpenTrack(track, viewState),
    onToggle: handlers.onTrackSourcePickerToggled,
    onAssignSource: handlers.onTrackSourceAssigned,
  }))

  const bottom = document.createElement('div')
  bottom.className = 'track-item-footer'
  const openReverbTrackIds = Array.isArray(viewState?.openReverbTrackIds) ? viewState.openReverbTrackIds : []
  const reverbConfig = normalizeTrackReverbConfig(track.playbackState?.reverbConfig)
  bottom.appendChild(createTrackMonitorBadge(track, {
    onToggleSolo: handlers.onTrackSoloToggled,
    onToggleMute: handlers.onTrackMuteToggled,
    onToggleFx: handlers.onTrackFxToggled,
    fxOpen: Boolean(viewState?.reverbDockOpen) && openReverbTrackIds.includes(track.id),
    fxEnabled: (
      normalizeTrackReverbSend(track.playbackState?.reverbSend) > 0.0001
      && Number(reverbConfig?.returnGain || 0) > 0.0001
    ),
  }))
  // 把 pan + volume 在右侧竖直堆叠——pan 占上方一行细滑块，volume 占下方常规滑块
  const mixStack = document.createElement('div')
  mixStack.className = 'th-mix'
  mixStack.appendChild(createTrackPanControl(track, trackColor, handlers))
  mixStack.appendChild(createTrackVolumeControl(track, trackColor, handlers))
  bottom.appendChild(mixStack)
  item.append(top, bottom)
  return item
}

function createAudioBars(track, clipWidth, trackColor) {
  const wave = document.createElement('div')
  wave.className = 'clip-wave clip-wave--audio'
  const values = sampleValues(track.audioClip?.waveformPeaks || [], Math.max(24, Math.round(clipWidth / 6)))
  values.forEach((value) => {
    const bar = document.createElement('span')
    bar.className = 'wave-bar'
    bar.style.height = `${Math.max(8, Math.round(clamp(value, 0.04, 1) * 100))}%`
    bar.style.background = trackColor
    wave.appendChild(bar)
  })
  return wave
}

function createMidiPreviewCanvas(track, clipBounds, clipWidth, timelineMetrics, trackColor) {
  const notes = Array.isArray(track.previewNotes) ? track.previewNotes : []
  if (notes.length === 0) return null
  const canvas = document.createElement('canvas')
  canvas.className = 'track-midi-preview-canvas'
  renderTrackPreviewCanvas(
    canvas,
    notes,
    clipWidth,
    timelineMetrics.ppq,
    timelineMetrics.beatWidth,
    trackColor,
    MIDI_PREVIEW_HEIGHT,
    timelineMetrics.axis,
    null,
    {
      xOrigin: Number.isFinite(clipBounds?.startX) ? clipBounds.startX : 0,
    },
  )
  return canvas
}

function createPendingVoiceDirtyOverlays(track, clipBounds, clipWidth, timelineMetrics) {
  const dirtyRanges = Array.isArray(track?.pendingVoiceEditState?.dirtyRanges)
    ? track.pendingVoiceEditState.dirtyRanges
    : []
  const axis = timelineMetrics?.axis
  if (!axis || !clipBounds || dirtyRanges.length === 0) return []

  return dirtyRanges
    .map((range) => {
      const startX = Math.max(0, axis.timeToX(range.startTime) - clipBounds.startX)
      const endX = Math.max(startX + 10, axis.timeToX(range.endTime) - clipBounds.startX)
      const width = Math.max(12, Math.min(clipWidth - startX, endX - startX))
      if (!Number.isFinite(startX) || !Number.isFinite(width) || width <= 0 || startX >= clipWidth) {
        return null
      }
      const overlay = document.createElement('span')
      overlay.className = 'clip-dirty-range'
      overlay.style.left = `${Math.max(0, Math.round(startX))}px`
      overlay.style.width = `${Math.round(width)}px`
      return overlay
    })
    .filter(Boolean)
}

function bindClipInteractions(clip, track, clipBounds, timelineMetrics, handlers) {
  const axis = timelineMetrics.axis
  if (!axis) return

  clip.addEventListener('click', (event) => {
    event.stopPropagation()
    handlers.onTrackSelected?.(track.id)
  })

  clip.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
    handlers.onTrackOpened?.(track.id)
  })

  clip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    if (!event.target?.closest?.('.clip-header')) return
    event.preventDefault()
    event.stopPropagation()

    const baseX = axis.timeToX(clipBounds.startTime)
    const baseTick = Number.isFinite(clipBounds.startTick)
      ? clipBounds.startTick
      : Math.max(0, Math.round(axis.timeToTick(clipBounds.startTime)))
    const snapTicks = timelineMetrics.snapTicks || 1
    const minDeltaX = -baseX
    let currentDeltaX = 0
    let moved = false

    clip.classList.add('dragging')

    const handlePointerMove = (moveEvent) => {
      currentDeltaX = Math.max(minDeltaX, moveEvent.clientX - event.clientX)
      const rawTargetX = Math.max(0, baseX + currentDeltaX)
      const snappedTargetTick = snapTickToGrid(axis.xToTick(rawTargetX), snapTicks)
      const snappedTargetX = axis.tickToX(snappedTargetTick)
      moved = moved || Math.abs(snappedTargetX - baseX) >= 3
      clip.style.transform = `translateX(${Math.round(snappedTargetX - baseX)}px)`
    }

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      clip.classList.remove('dragging')
      clip.style.transform = ''
      if (!moved) return
      const targetX = Math.max(0, baseX + currentDeltaX)
      const snappedTargetTick = snapTickToGrid(axis.xToTick(targetX), snapTicks)
      const deltaTime = axis.tickToTime(snappedTargetTick) - axis.tickToTime(baseTick)
      if (Math.abs(deltaTime) < 0.0005) return
      handlers.onTrackClipMoved?.(track.id, deltaTime)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  })
}

function createTrackPreview({
  track,
  index,
  timelineMetrics,
  selectedTrackId,
  editorTrackId,
  viewState,
  handlers,
}) {
  const trackColor = resolveTrackColor(track, index)
  const clipBounds = getTrackClipBounds(track, timelineMetrics.axis)
  const preview = document.createElement('div')
  preview.className = 'track-row track-lane'
  preview.dataset.trackId = track.id
  preview.classList.toggle('selected', track.id === selectedTrackId)
  preview.classList.toggle('open', track.id === editorTrackId)
  applyTrackStateClasses(preview, track, viewState)

  if (clipBounds && clipBounds.duration > 0) {
    const startX = Math.max(0, Number.isFinite(clipBounds.startX)
      ? clipBounds.startX
      : (timelineMetrics.axis?.timeToX(clipBounds.startTime) || 0))
    const endX = Math.max(startX + 28, Number.isFinite(clipBounds.endX)
      ? clipBounds.endX
      : (timelineMetrics.axis?.timeToX(clipBounds.endTime) || startX + 28))
    const clipWidth = Math.max(48, Math.round(endX - startX))
    const clip = document.createElement('div')
    clip.className = `clip${isAudioTrack(track) ? ' clip-audio' : ' clip-midi'}`
    clip.style.left = `${Math.round(startX)}px`
    clip.style.width = `${clipWidth}px`
    clip.style.borderColor = hexToRgba(trackColor, 0.6)
    clip.style.background = hexToRgba(trackColor, 0.22)

    const header = document.createElement('div')
    header.className = 'clip-header'
    header.style.background = hexToRgba(trackColor, 0.18)
    header.textContent = isAudioTrack(track)
      ? (track.audioClip?.fileName || track.name)
      : track.name

    const body = isAudioTrack(track)
      ? createAudioBars(track, clipWidth, trackColor)
      : Object.assign(document.createElement('div'), { className: 'clip-wave clip-wave--midi' })
    if (!isAudioTrack(track)) {
      const midiCanvas = createMidiPreviewCanvas(track, clipBounds, clipWidth, timelineMetrics, trackColor)
      if (midiCanvas) body.appendChild(midiCanvas)
      createPendingVoiceDirtyOverlays(track, clipBounds, clipWidth, timelineMetrics)
        .forEach((overlay) => body.appendChild(overlay))
    }
    clip.append(header, body)
    bindClipInteractions(clip, track, clipBounds, timelineMetrics, handlers)
    preview.appendChild(clip)
  }

  return preview
}

export function buildTrackShellRowView({
  track,
  index,
  timelineMetrics,
  selectedTrackId,
  editorTrackId,
  viewState,
  handlers,
}) {
  const sourcePickerOpen = isSourcePickerOpenTrack(track, viewState)
  const row = document.createElement('div')
  row.className = `track-shell-row${sourcePickerOpen ? ' source-picker-open' : ''}`
  row.dataset.trackId = track.id
  row.style.setProperty('--track-preview-width', `${timelineMetrics.timelineWidth}px`)

  const itemCell = document.createElement('div')
  itemCell.className = `track-item-cell${sourcePickerOpen ? ' source-picker-open' : ''}`
  itemCell.appendChild(createTrackItem({ track, index, selectedTrackId, viewState, handlers }))

  const preview = createTrackPreview({
    track,
    index,
    timelineMetrics,
    selectedTrackId,
    editorTrackId,
    viewState,
    handlers,
  })

  row.appendChild(itemCell)
  row.appendChild(preview)
  row.addEventListener('click', () => handlers.onTrackSelected?.(track.id))
  row.addEventListener('dblclick', () => handlers.onTrackOpened?.(track.id))
  return row
}

export function createRulerMark(left, barNumber) {
  const mark = document.createElement('span')
  mark.className = 'ruler-mark bar'
  mark.style.left = `${left + 4}px`
  mark.textContent = String(barNumber)
  return mark
}

export function createBeatMark(left, barNumber, beatNumber) {
  const mark = document.createElement('span')
  mark.className = 'ruler-mark beat'
  mark.style.left = `${left + 4}px`
  mark.textContent = `${barNumber}.${beatNumber}`
  return mark
}

export function createRulerMetaMarker(left, text, kind = 'tempo') {
  const marker = document.createElement('span')
  marker.className = `ruler-meta-marker ${kind}`
  marker.style.left = `${left + 6}px`
  marker.textContent = text
  return marker
}

export function createRulerLine(left, kind = 'beat') {
  const line = document.createElement('span')
  line.className = `ruler-line ${kind}`
  line.style.left = `${left}px`
  return line
}
