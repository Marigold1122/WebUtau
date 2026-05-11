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

import { normalizeTrackPan, normalizeTrackVolume } from '../../project/trackPlaybackState.js'
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

  // 2. Send 槽位（占位，P3 实现）
  const sendSlot = document.createElement('div')
  sendSlot.className = 'mixer-strip-slot mixer-strip-slot--send'
  if (!isMaster) {
    sendSlot.innerHTML = `<span class="mixer-strip-slot-label">${t('mixer.slot_send')}</span><span class="mixer-strip-slot-hint">—</span>`
  } else {
    // master 没 send 槽，留一个等高空白保持视觉对齐
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
    faderTrack, faderHandle, dbValue, meterL, meterR,
    btnMute, btnSolo,
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
    if (refs.panNeedle) {
      refs.panNeedle.style.transform = `rotate(${pan * 45}deg)`
    }
    if (refs.panKnob) refs.panKnob.setAttribute('aria-valuenow', String(Math.round(pan * 100)))
    if (refs.panValue) refs.panValue.textContent = panToText(pan)
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

  // 非 master 才接 fader 交互 —— master 由调用方在 Step 2.6 单独 wire 至 masterVolume
  const faderWire = isMaster ? null : wireFader()
  // 重写 update 让它在 sync volume 时调 faderWire.syncFromState（拖拽中不被覆盖）
  const originalUpdate = update
  function wrappedUpdate(nextTrack) {
    const tr = nextTrack || track
    if (tr && !isMaster && faderWire) {
      faderWire.syncFromState(normalizeTrackVolume(tr.playbackState?.volume))
    }
    originalUpdate(nextTrack)
  }

  return { root, refs, update: wrappedUpdate, setHandlers }
}
