/**
 * Mixer dock 单条通道条的 DOM 构造。
 *
 * 构造完后返回 `{ root, refs }`——MixerDockView 持有 refs，下次 render 时
 * 复用同一个 DOM、只写 textContent / class，避免每帧重建。
 *
 * 通道条**只渲染**，不绑任何 pointer 事件——交互（fader drag、knob、mute/solo）
 * 在后续 step（2.2-2.4）里单独装上。这一步先保证 layout 与 dark mode 全过
 *
 * 布局（自上至下）：
 *   1. 顶部色条（轨道色 4px 横条）
 *   2. 轨道名（ellipsis 截断）
 *   3. Send slot（占位 —— P3 接 reverb send）
 *   4. Insert slot（占位 —— P4 接 EQ/Comp）
 *   5. Pan knob（圆形小旋钮，下方显示 L/C/R/n%）
 *   6. Fader 区：纵向轨道槽 + 把手 + 双声道 meter 占位（P5 接真 meter）
 *   7. dB 数值显示
 *   8. Mute / Solo 按钮组
 */

import { normalizeTrackPan, normalizeTrackReverbSend, normalizeTrackVolume } from '../../project/trackPlaybackState.js'
import { t } from '../../../i18n/index.js'

const FADER_TRACK_HEIGHT = 96   // px；vertical fader 高度
const DB_FLOOR = -60            // 推子最底显示 -∞，超过这个值显示具体 dB

// 物理 fader 上的 0 ~ 1 等距位置 → dB 文本（log 化）
function volumeToDbText(volume) {
  const v = normalizeTrackVolume(volume)
  if (v <= 0.0001) return '-∞'
  const db = 20 * Math.log10(v)
  if (db <= DB_FLOOR) return '-∞'
  if (db >= 0) return `${db.toFixed(1)}`
  return db.toFixed(1)
}

function panToText(pan) {
  const p = normalizeTrackPan(pan)
  if (Math.abs(p) < 0.005) return 'C'
  const pct = Math.round(Math.abs(p) * 100)
  return p < 0 ? `L${pct}` : `R${pct}`
}

// pan 在 0 附近自动吸附到正中——和 trackShell 同样的约定（±0.05）
const PAN_SNAP_THRESHOLD = 0.05
function quantizeTrackPanLocal(value) {
  return Math.round(normalizeTrackPan(value) * 100) / 100
}
function snapTrackPanLocal(value) {
  const q = quantizeTrackPanLocal(value)
  return Math.abs(q) < PAN_SNAP_THRESHOLD ? 0 : q
}

function quantizeReverbSendLocal(value) {
  return Math.round(normalizeTrackReverbSend(value) * 100) / 100
}
function sendToText(value) {
  const v = quantizeReverbSendLocal(value)
  return `${Math.round(v * 100)}`
}

/**
 * @param {object} options
 * @param {object} options.track 轨道对象（含 id / name / playbackState）
 * @param {string} options.trackColor 主题色（用于色条）
 * @param {boolean} [options.isMaster=false] master strip 时为 true
 * @param {object} [options.handlers={}] 事件回调（onVolumeChanged 等）
 * @returns {{ root: HTMLElement, refs: object, update: (track) => void, setHandlers: (h) => void }}
 */
export function buildMixerChannelStrip({ track, trackColor, isMaster = false, handlers: initialHandlers = {} } = {}) {
  const root = document.createElement('div')
  root.className = isMaster ? 'mixer-strip mixer-strip--master' : 'mixer-strip'
  // 用 dataset.mixerTrackId 而不是 trackId —— trackShell 那边或其他地方可能有
  // `[data-track-id]` 的 CSS / 全局监听，重名会让点击 mixer strip 时触发它们
  if (track?.id) root.dataset.mixerTrackId = track.id
  if (trackColor) root.style.setProperty('--mixer-strip-color', trackColor)

  // 整条 strip 上的 pointer / click / mousedown / dblclick 全部止冒 ——
  // 防御性：保证 strip 内任何点击都不会渗出去触发 trackShell / workspace 层的逻辑
  // （比如轨道选中、播放头跳转、面板关闭等）
  const swallowEvent = (event) => event.stopPropagation()
  ;['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((evt) => {
    root.addEventListener(evt, swallowEvent)
  })

  // 1. 色条 + 名（master 没有色条，但有 "MASTER" 标）
  const head = document.createElement('div')
  head.className = 'mixer-strip-head'
  if (isMaster) {
    const masterLabel = document.createElement('div')
    masterLabel.className = 'mixer-strip-master-label'
    masterLabel.textContent = 'MASTER'
    head.appendChild(masterLabel)
  } else {
    const stripeWrap = document.createElement('div')
    stripeWrap.className = 'mixer-strip-stripe'
    head.appendChild(stripeWrap)
  }
  const name = document.createElement('div')
  name.className = 'mixer-strip-name'
  name.textContent = isMaster ? t('mixer.master_label') : (track?.name || '')
  name.title = name.textContent
  head.appendChild(name)
  root.appendChild(head)

  // 1.5  Master strip 专属：紧凑 LUFS 面板（I 大字号 + M / S 副 + delta bar）
  // 普通轨没有 LUFS（LUFS 是 master 输出层的概念）
  let lufsRefs = null
  if (isMaster) {
    const lufsPanel = document.createElement('div')
    lufsPanel.className = 'mixer-strip-lufs'

    const integratedRow = document.createElement('div')
    integratedRow.className = 'mixer-strip-lufs-integrated'
    const integratedLabel = document.createElement('span')
    integratedLabel.className = 'mixer-strip-lufs-integrated-label'
    integratedLabel.textContent = 'I'
    const integratedValue = document.createElement('span')
    integratedValue.className = 'mixer-strip-lufs-integrated-value'
    integratedValue.textContent = '—'
    integratedRow.append(integratedLabel, integratedValue)

    const subRow = document.createElement('div')
    subRow.className = 'mixer-strip-lufs-sub'
    const momentaryCell = document.createElement('span')
    momentaryCell.className = 'mixer-strip-lufs-cell'
    momentaryCell.innerHTML = '<span class="mixer-strip-lufs-cell-label">M</span><span class="mixer-strip-lufs-cell-value">—</span>'
    const shortTermCell = document.createElement('span')
    shortTermCell.className = 'mixer-strip-lufs-cell'
    shortTermCell.innerHTML = '<span class="mixer-strip-lufs-cell-label">S</span><span class="mixer-strip-lufs-cell-value">—</span>'
    subRow.append(momentaryCell, shortTermCell)

    // delta 条：±10 LU 映射 0..100%；中点 50% = 达标；居中绿、外圈黄→红/蓝
    const deltaRow = document.createElement('div')
    deltaRow.className = 'mixer-strip-lufs-delta'
    const deltaFill = document.createElement('div')
    deltaFill.className = 'mixer-strip-lufs-delta-fill'
    deltaRow.appendChild(deltaFill)

    lufsPanel.append(integratedRow, subRow, deltaRow)
    root.appendChild(lufsPanel)

    lufsRefs = {
      integratedValue,
      momentaryValue: momentaryCell.querySelector('.mixer-strip-lufs-cell-value'),
      shortTermValue: shortTermCell.querySelector('.mixer-strip-lufs-cell-value'),
      deltaFill,
      panel: lufsPanel,
    }
  }

  // 2. Send 旋钮：reverb send，范围 [0, 1]，0 = 干（不送）
  // master strip 没 send（master 是终点），保留同高空白维持视觉对齐
  let sendKnob = null
  let sendValue = null
  let sendNeedle = null
  const sendSlot = document.createElement('div')
  sendSlot.className = 'mixer-strip-slot mixer-strip-slot--send'
  if (!isMaster) {
    sendSlot.classList.add('mixer-strip-slot--knob')
    const sendLabel = document.createElement('span')
    sendLabel.className = 'mixer-strip-slot-label'
    sendLabel.textContent = t('mixer.slot_send')
    sendKnob = document.createElement('div')
    sendKnob.className = 'mixer-strip-send-knob'
    sendKnob.setAttribute('role', 'slider')
    sendKnob.setAttribute('aria-label', t('mixer.send_aria', { name: track?.name || '' }))
    sendKnob.setAttribute('aria-valuemin', '0')
    sendKnob.setAttribute('aria-valuemax', '100')
    sendKnob.setAttribute('aria-valuenow', '0')
    sendKnob.tabIndex = 0
    sendNeedle = document.createElement('span')
    sendNeedle.className = 'mixer-strip-send-needle'
    sendKnob.appendChild(sendNeedle)
    sendValue = document.createElement('span')
    sendValue.className = 'mixer-strip-slot-hint mixer-strip-send-value'
    sendValue.textContent = '0'
    sendSlot.append(sendLabel, sendKnob, sendValue)
  } else {
    sendSlot.classList.add('is-blank')
  }
  root.appendChild(sendSlot)

  // 3. Insert 槽位（占位，P4 实现）
  const insertSlot = document.createElement('div')
  insertSlot.className = 'mixer-strip-slot mixer-strip-slot--insert'
  insertSlot.innerHTML = `<span class="mixer-strip-slot-label">${t('mixer.slot_insert')}</span><span class="mixer-strip-slot-hint">—</span>`
  root.appendChild(insertSlot)

  // 4. Pan 旋钮（master 无 pan）
  let panKnob = null
  let panValue = null
  if (!isMaster) {
    const panRow = document.createElement('div')
    panRow.className = 'mixer-strip-pan-row'
    panKnob = document.createElement('div')
    panKnob.className = 'mixer-strip-pan-knob'
    panKnob.setAttribute('role', 'slider')
    panKnob.setAttribute('aria-label', t('mixer.pan_aria', { name: track?.name || '' }))
    panKnob.setAttribute('aria-valuemin', '-100')
    panKnob.setAttribute('aria-valuemax', '100')
    panKnob.setAttribute('aria-valuenow', '0')
    panKnob.tabIndex = 0
    const panNeedle = document.createElement('span')
    panNeedle.className = 'mixer-strip-pan-needle'
    panKnob.appendChild(panNeedle)
    panValue = document.createElement('span')
    panValue.className = 'mixer-strip-pan-value'
    panValue.textContent = 'C'
    panRow.append(panKnob, panValue)
    root.appendChild(panRow)
  }

  // 5. Fader + meter 占位
  const faderRow = document.createElement('div')
  faderRow.className = 'mixer-strip-fader-row'

  // meter 占位（P5 接真 AnalyserNode）—— 双声道
  const meterWrap = document.createElement('div')
  meterWrap.className = 'mixer-strip-meter'
  const meterL = document.createElement('div')
  meterL.className = 'mixer-strip-meter-channel'
  const meterR = document.createElement('div')
  meterR.className = 'mixer-strip-meter-channel'
  meterWrap.append(meterL, meterR)

  const faderTrack = document.createElement('div')
  faderTrack.className = 'mixer-strip-fader-track'
  faderTrack.style.setProperty('--fader-track-height', `${FADER_TRACK_HEIGHT}px`)
  const faderHandle = document.createElement('button')
  faderHandle.type = 'button'
  faderHandle.className = 'mixer-strip-fader-handle'
  faderHandle.setAttribute('role', 'slider')
  faderHandle.setAttribute('aria-label', isMaster
    ? t('mixer.master_volume_aria')
    : t('mixer.volume_aria', { name: track?.name || '' }))
  faderHandle.setAttribute('aria-valuemin', '0')
  faderHandle.setAttribute('aria-valuemax', '100')
  faderHandle.tabIndex = 0
  faderTrack.appendChild(faderHandle)

  faderRow.append(meterWrap, faderTrack)
  root.appendChild(faderRow)

  // 6. dB 数值
  const dbValue = document.createElement('div')
  dbValue.className = 'mixer-strip-db'
  dbValue.textContent = '0.0'
  root.appendChild(dbValue)

  // 7. Mute / Solo 按钮（master 无 mute/solo）
  let btnMute = null
  let btnSolo = null
  if (!isMaster) {
    const btnRow = document.createElement('div')
    btnRow.className = 'mixer-strip-btn-row'
    btnMute = document.createElement('button')
    btnMute.type = 'button'
    btnMute.className = 'mixer-strip-btn mixer-strip-btn--mute'
    btnMute.textContent = 'M'
    btnMute.title = t('trackBadge.mute_tip')
    btnSolo = document.createElement('button')
    btnSolo.type = 'button'
    btnSolo.className = 'mixer-strip-btn mixer-strip-btn--solo'
    btnSolo.textContent = 'S'
    btnSolo.title = t('trackBadge.solo_tip')
    btnRow.append(btnMute, btnSolo)
    root.appendChild(btnRow)
  }

  const refs = {
    head, name, sendSlot, insertSlot,
    panKnob, panValue, panNeedle: panKnob?.querySelector('.mixer-strip-pan-needle') || null,
    sendKnob, sendValue, sendNeedle,
    faderTrack, faderHandle, dbValue, meterL, meterR,
    btnMute, btnSolo,
    lufs: lufsRefs,   // master strip 独有；非 master 为 null
  }

  // 公开一个 update —— 让 dock 复用 DOM，只写 textContent / 位置
  function update(nextTrack) {
    const tr = nextTrack || track
    if (!tr || isMaster) return
    if (refs.name && refs.name.textContent !== (tr.name || '')) {
      refs.name.textContent = tr.name || ''
      refs.name.title = tr.name || ''
    }
    const volume = normalizeTrackVolume(tr.playbackState?.volume)
    const pan = normalizeTrackPan(tr.playbackState?.pan)
    // fader 把手 y 位置：volume ∈ [0,1] 直接映射到 [0%,100%]；用 bottom 定位
    // 拖拽过程中不接受外部 update —— 由调用方设置 _isDragging 控制
    if (!refs.faderHandle.dataset.dragging) {
      const faderPct = Math.max(0, Math.min(1, volume)) * 100
      refs.faderHandle.style.bottom = `${faderPct}%`
      refs.faderHandle.setAttribute('aria-valuenow', String(Math.round(volume * 100)))
    }
    refs.dbValue.textContent = volumeToDbText(volume)
    // pan needle 角度：-1 → -45°；0 → 0°；+1 → +45°
    // 同 fader：拖拽中不接受外部 update —— panKnob.dataset.dragging 控制
    if (refs.panKnob && !refs.panKnob.dataset.dragging) {
      if (refs.panNeedle) refs.panNeedle.style.transform = `rotate(${pan * 45}deg)`
      refs.panKnob.setAttribute('aria-valuenow', String(Math.round(pan * 100)))
      if (refs.panValue) refs.panValue.textContent = panToText(pan)
    }
    // send 旋钮：[0,1] → 角度 [-135°, +135°]（270° sweep，标准旋钮范围）
    // 同 fader / pan：拖拽中不接受外部 update
    if (refs.sendKnob && !refs.sendKnob.dataset.dragging) {
      const send = quantizeReverbSendLocal(tr.playbackState?.reverbSend)
      const angle = -135 + send * 270
      if (refs.sendNeedle) refs.sendNeedle.style.transform = `rotate(${angle}deg)`
      refs.sendKnob.setAttribute('aria-valuenow', String(Math.round(send * 100)))
      if (refs.sendValue) refs.sendValue.textContent = sendToText(send)
    }
    // mute / solo 视觉 active
    refs.btnMute?.classList.toggle('is-active', Boolean(tr.playbackState?.mute))
    refs.btnSolo?.classList.toggle('is-active', Boolean(tr.playbackState?.solo))
  }

  update(track)

  // ── fader 拖拽 / 滚轮 / 键盘 ────────────────────────────────────
  let currentHandlers = initialHandlers
  const setHandlers = (next) => { currentHandlers = next || {} }

  // 当前的 trackId / volume / pan 由闭包获取 —— update 时已 sync 到 DOM
  // 拖拽路径：所有 commit 都走 currentHandlers.onVolumeChanged，
  // 这是个 callback：mixer dock 把它 wire 到 onTrackVolumeChanged 或 master 的 onMasterVolumeChanged
  const wireFader = () => {
    const { faderTrack, faderHandle } = refs
    if (!faderTrack || !faderHandle) return

    const DRAG_THRESHOLD = 2
    let currentVolume = normalizeTrackVolume(track?.playbackState?.volume)

    const updateCurrentVolume = (v) => {
      currentVolume = Math.max(0, Math.min(1, v))
      const pct = currentVolume * 100
      faderHandle.style.bottom = `${pct}%`
      faderHandle.setAttribute('aria-valuenow', String(Math.round(currentVolume * 100)))
      refs.dbValue.textContent = volumeToDbText(currentVolume)
    }

    const resolveVolumeFromY = (clientY) => {
      const rect = faderTrack.getBoundingClientRect()
      if (!Number.isFinite(rect.height) || rect.height <= 0) return currentVolume
      // 上 = 大；y 越小 volume 越大 —— 把鼠标 y 距离顶端的比例反过来
      const fromTop = (clientY - rect.top) / rect.height
      return 1 - Math.max(0, Math.min(1, fromTop))
    }

    const commit = (v, { commit: isCommit }) => {
      updateCurrentVolume(v)
      currentHandlers.onVolumeChanged?.(currentVolume, { commit: isCommit })
    }

    // pointerdown 在 track 或 handle 都接 —— 鼠标按下立刻把推子拖到光标处
    const onPointerDown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      // pointerdown 自带 preventDefault 会阻止浏览器默认 focus 行为 ——
      // 必须显式 focus，否则键盘箭头 / Home / End 没法用
      faderHandle.focus({ preventScroll: true })
      faderHandle.dataset.dragging = '1'   // 防止 update() 在拖拽中重写位置
      const startY = event.clientY
      let entered = false

      const enterDrag = (clientY) => {
        entered = true
        commit(resolveVolumeFromY(clientY), { commit: false })
      }

      const onMove = (moveEvent) => {
        if (!entered) {
          if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) return
          enterDrag(moveEvent.clientY)
          return
        }
        commit(resolveVolumeFromY(moveEvent.clientY), { commit: false })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        delete faderHandle.dataset.dragging
        if (entered) {
          commit(currentVolume, { commit: true })
        } else {
          // 没有移动 —— 视作"点击轨道某处直接跳到那个位置"，commit 一次
          commit(resolveVolumeFromY(event.clientY), { commit: true })
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    }
    faderTrack.addEventListener('pointerdown', onPointerDown)
    faderHandle.addEventListener('pointerdown', onPointerDown)

    // click / mousedown / dblclick 都拦下 —— 避免冒泡到 track-shell 的"选中轨道"逻辑
    // trackShell 监听这些事件做选中态切换，不拦就会让点 fader 也选轨
    const swallow = (event) => event.stopPropagation()
    faderTrack.addEventListener('click', swallow)
    faderTrack.addEventListener('mousedown', swallow)
    faderTrack.addEventListener('dblclick', swallow)
    faderHandle.addEventListener('click', swallow)
    faderHandle.addEventListener('mousedown', swallow)
    faderHandle.addEventListener('dblclick', swallow)

    // 滚轮：上 = 增 / 下 = 减；±0.04 每次
    const onWheel = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY < 0 ? 0.04 : -0.04
      commit(currentVolume + delta, { commit: true })
    }
    faderHandle.addEventListener('wheel', onWheel, { passive: false })
    faderTrack.addEventListener('wheel', onWheel, { passive: false })

    // 键盘：Up/Right=+0.02、Down/Left=-0.02、PageUp/Down=±0.1、Home=0、End=1
    const onKeyDown = (event) => {
      let next = currentVolume
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += 0.02
      else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= 0.02
      else if (event.key === 'PageUp') next += 0.1
      else if (event.key === 'PageDown') next -= 0.1
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = 1
      else return
      event.preventDefault()
      commit(next, { commit: true })
    }
    faderHandle.addEventListener('keydown', onKeyDown)

    // update() 路径同步外部新值（不拖拽中时）
    const syncFromState = (v) => {
      if (faderHandle.dataset.dragging) return
      updateCurrentVolume(v)
    }
    return { syncFromState }
  }

  // ── pan knob 拖拽 / 双击居中 / 滚轮 / 键盘 ───────────────────────
  const wirePan = () => {
    const { panKnob, panNeedle, panValue } = refs
    if (!panKnob) return null

    // 旋钮垂直拖：120px 鼠标位移覆盖全 pan 范围 [-1, 1]
    const PAN_DRAG_PIXELS_PER_RANGE = 120
    const DRAG_THRESHOLD = 2

    let currentPan = quantizeTrackPanLocal(track?.playbackState?.pan)

    const updateCurrentPan = (v, { snap = true } = {}) => {
      currentPan = snap ? snapTrackPanLocal(v) : quantizeTrackPanLocal(v)
      if (panNeedle) panNeedle.style.transform = `rotate(${currentPan * 45}deg)`
      panKnob.setAttribute('aria-valuenow', String(Math.round(currentPan * 100)))
      if (panValue) panValue.textContent = panToText(currentPan)
    }

    const commit = (v, { commit: isCommit, snap = true } = {}) => {
      updateCurrentPan(v, { snap })
      currentHandlers.onPanChanged?.(currentPan, { commit: isCommit })
    }

    // 拖拽
    const onPointerDown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      panKnob.focus({ preventScroll: true })
      panKnob.dataset.dragging = '1'
      const startY = event.clientY
      const startPan = currentPan
      let entered = false

      const onMove = (moveEvent) => {
        const dy = moveEvent.clientY - startY
        if (!entered) {
          if (Math.abs(dy) < DRAG_THRESHOLD) return
          entered = true
        }
        // 拖上 = pan 增；拖下 = pan 减
        const deltaPan = -dy / PAN_DRAG_PIXELS_PER_RANGE
        commit(startPan + deltaPan, { commit: false })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        delete panKnob.dataset.dragging
        if (entered) commit(currentPan, { commit: true })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    }
    panKnob.addEventListener('pointerdown', onPointerDown)

    // 双击居中（标准 DAW 习惯）
    panKnob.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      commit(0, { commit: true })
    })

    // 滚轮：±0.04
    panKnob.addEventListener('wheel', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY < 0 ? 0.04 : -0.04
      commit(currentPan + delta, { commit: true })
    }, { passive: false })

    // 键盘
    panKnob.addEventListener('keydown', (event) => {
      let next = currentPan
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += 0.02
      else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= 0.02
      else if (event.key === 'PageUp') next += 0.1
      else if (event.key === 'PageDown') next -= 0.1
      else if (event.key === 'Home') next = -1
      else if (event.key === 'End') next = 1
      else return
      event.preventDefault()
      commit(next, { commit: true })
    })

    const syncFromState = (v) => {
      if (panKnob.dataset.dragging) return
      updateCurrentPan(v)
    }
    return { syncFromState }
  }

  // ── Mute / Solo 按钮 ──────────────────────────────────────────
  // 行为：点击 → 调既有 onToggleMute/Solo handler → ProjectMixController.toggleTrackMute/Solo
  //       → 改 store.playbackState.{mute,solo} → 重启播放（TrackMonitorController 内部
  //       走 refreshProjectPlayback 让新 audibility set 生效）
  // 视觉的 .is-active 由 update() 在每次 render 时根据 playbackState 同步 —— 这里不动 class
  // 注意：mixer 上的 M/S 和 trackShell 左侧的 M/S 都是同一份 store 的视图，
  //      点哪边都会同步反映另一边（render 流过两个视图）
  const wireMuteSolo = () => {
    if (refs.btnMute) {
      refs.btnMute.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        currentHandlers.onToggleMute?.()
      })
    }
    if (refs.btnSolo) {
      refs.btnSolo.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        currentHandlers.onToggleSolo?.()
      })
    }
  }

  // ── Send 旋钮（reverb send）拖拽 / 双击归零 / 滚轮 / 键盘 ──────────
  const wireSend = () => {
    const { sendKnob, sendNeedle, sendValue } = refs
    if (!sendKnob) return null

    const SEND_DRAG_PIXELS_PER_RANGE = 120
    const DRAG_THRESHOLD = 2

    let currentSend = quantizeReverbSendLocal(track?.playbackState?.reverbSend)

    const updateCurrentSend = (v) => {
      currentSend = quantizeReverbSendLocal(v)
      const angle = -135 + currentSend * 270
      if (sendNeedle) sendNeedle.style.transform = `rotate(${angle}deg)`
      sendKnob.setAttribute('aria-valuenow', String(Math.round(currentSend * 100)))
      if (sendValue) sendValue.textContent = sendToText(currentSend)
    }
    const commit = (v, { commit: isCommit }) => {
      updateCurrentSend(v)
      currentHandlers.onSendChanged?.(currentSend, { commit: isCommit })
    }

    sendKnob.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      sendKnob.focus({ preventScroll: true })
      sendKnob.dataset.dragging = '1'
      const startY = event.clientY
      const startSend = currentSend
      let entered = false

      const onMove = (moveEvent) => {
        const dy = moveEvent.clientY - startY
        if (!entered) {
          if (Math.abs(dy) < DRAG_THRESHOLD) return
          entered = true
        }
        // 拖上 = 送增；拖下 = 送减
        commit(startSend - dy / SEND_DRAG_PIXELS_PER_RANGE, { commit: false })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        delete sendKnob.dataset.dragging
        if (entered) commit(currentSend, { commit: true })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    })

    sendKnob.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      commit(0, { commit: true })  // 双击归零（干 / 不送）
    })

    sendKnob.addEventListener('wheel', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY < 0 ? 0.04 : -0.04
      commit(currentSend + delta, { commit: true })
    }, { passive: false })

    sendKnob.addEventListener('keydown', (event) => {
      let next = currentSend
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += 0.02
      else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= 0.02
      else if (event.key === 'PageUp') next += 0.1
      else if (event.key === 'PageDown') next -= 0.1
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = 1
      else return
      event.preventDefault()
      commit(next, { commit: true })
    })

    const syncFromState = (v) => {
      if (sendKnob.dataset.dragging) return
      updateCurrentSend(v)
    }
    return { syncFromState }
  }

  // 非 master：fader / pan / send / mute / solo 全套接
  // master：只接 fader（其他都无意义）
  const faderWire = wireFader()
  const panWire = isMaster ? null : wirePan()
  const sendWire = isMaster ? null : wireSend()
  if (!isMaster) wireMuteSolo()

  // ── LUFS 实时显示（master strip 专属） ─────────────────────────
  // 把 LufsMeter 推过来的 snapshot 写到 DOM；非 master 时是 no-op
  // 着色规则与 master chain 面板里那一套同源：
  //   |Δ| ≤ 1 LU = good（绿）；≤ 3 LU = warn（橙）；外圈 = too-loud（红）/ too-quiet（蓝）
  function setLufsSnapshot(snapshot, target = -14) {
    if (!isMaster || !lufsRefs) return
    const safeTarget = Number.isFinite(target) ? target : -14
    const toneOf = (v) => {
      if (!Number.isFinite(v)) return 'idle'
      const d = v - safeTarget
      const a = Math.abs(d)
      if (a <= 1) return 'good'
      if (a <= 3) return 'warn'
      return d > 0 ? 'too-loud' : 'too-quiet'
    }
    const fmt = (v) => Number.isFinite(v) ? v.toFixed(1) : '—'

    const integrated = snapshot?.integrated
    const momentary = snapshot?.momentary
    const shortTerm = snapshot?.shortTerm

    lufsRefs.integratedValue.textContent = fmt(integrated)
    lufsRefs.integratedValue.dataset.tone = toneOf(integrated)
    lufsRefs.momentaryValue.textContent = fmt(momentary)
    lufsRefs.momentaryValue.dataset.tone = toneOf(momentary)
    lufsRefs.shortTermValue.textContent = fmt(shortTerm)
    lufsRefs.shortTermValue.dataset.tone = toneOf(shortTerm)

    // delta 条按 integrated（成品响度）决定；±10 LU 范围
    if (Number.isFinite(integrated)) {
      const d = integrated - safeTarget
      const clamped = Math.max(-10, Math.min(10, d))
      const halfPct = Math.abs(clamped) / 10 * 50  // 0..50%
      // 居中 + 单向延伸：超出右侧（响）就向右延、左侧（轻）就向左延
      lufsRefs.deltaFill.style.left = clamped >= 0 ? '50%' : `${50 - halfPct}%`
      lufsRefs.deltaFill.style.width = `${halfPct}%`
      lufsRefs.deltaFill.dataset.tone = toneOf(integrated)
    } else {
      lufsRefs.deltaFill.style.width = '0'
      lufsRefs.deltaFill.dataset.tone = 'idle'
    }
  }
  // 重写 update 让它在 sync volume / pan / send 时分别走 wire 的 syncFromState
  // 拖拽中的控件不被外部 render 覆盖（dataset.dragging 标记）
  const originalUpdate = update
  function wrappedUpdate(nextTrack) {
    const tr = nextTrack || track
    if (tr && !isMaster) {
      if (faderWire) faderWire.syncFromState(normalizeTrackVolume(tr.playbackState?.volume))
      if (panWire) panWire.syncFromState(normalizeTrackPan(tr.playbackState?.pan))
      if (sendWire) sendWire.syncFromState(normalizeTrackReverbSend(tr.playbackState?.reverbSend))
    }
    originalUpdate(nextTrack)
  }

  // 让外部（master strip 调用方）能直接 sync fader 位置 —— 非 master 通过
  // wrappedUpdate(tr) 自动跟随 track.playbackState.volume；master 没 track，
  // 走 setVolume(mixState.masterVolume)
  function setVolume(value) {
    if (faderWire) faderWire.syncFromState(normalizeTrackVolume(value))
  }

  return { root, refs, update: wrappedUpdate, setHandlers, setLufsSnapshot, setVolume }
}
