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
 * @returns {{ root: HTMLElement, refs: object, update: (track) => void }}
 */
export function buildMixerChannelStrip({ track, trackColor, isMaster = false } = {}) {
  const root = document.createElement('div')
  root.className = isMaster ? 'mixer-strip mixer-strip--master' : 'mixer-strip'
  root.dataset.trackId = track?.id || ''
  if (trackColor) root.style.setProperty('--mixer-strip-color', trackColor)

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
    // fader 把手 y 位置：0(底) ~ FADER_TRACK_HEIGHT(顶)；CSS 用 bottom 定位
    const faderPct = Math.max(0, Math.min(1, volume / 1.5)) * 100
    refs.faderHandle.style.bottom = `${faderPct}%`
    refs.faderHandle.setAttribute('aria-valuenow', String(Math.round(faderPct)))
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

  return { root, refs, update }
}
