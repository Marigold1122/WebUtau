/**
 * 单轨 insert 效果参数浮窗（EQ4 / Comp）。
 *
 * 设计要点：
 *   - 非模态浮窗：点击外部 / Esc / X 都关；用户能边调边看其它通道
 *   - 锚定到点击的 insert 按钮，优先弹在通道条**上方**；上方放不下贴下方
 *   - 复用 reverb dock 的 createFxKnobControl —— 视觉跟主链调参一致
 *   - bypass 开关在浮窗顶部：单击按钮 = 打开浮窗，浮窗里开关 enabled
 *
 * 一次只允许开一个浮窗——再开新的会自动关旧的
 */

import { createFxKnobControl } from '../reverb/reverbDockDom.js'
import { normalizeTrackInsertChain, TRACK_INSERT_SLOT_COMP, TRACK_INSERT_SLOT_EQ4 } from '../../project/trackInsertChainState.js'
import { t } from '../../../i18n/index.js'

// 浮窗单例引用——确保同一时间只有一个浮窗存在
let activePopover = null

function closeActive() {
  if (activePopover) {
    try { activePopover.destroy() } catch (_e) {}
    activePopover = null
  }
}

/**
 * @param {object} options
 * @param {'eq4'|'comp'} options.slotKey
 * @param {object} options.track  完整 track 对象（用于读 playbackState.inserts 当前值）
 * @param {HTMLElement} options.anchor  锚定的 button（用于定位）
 * @param {(slotKey, patch, opts) => void} options.onPatch  插件参数变更回调（接 onTrackInsertChanged）
 * @returns {{ destroy: () => void }}
 */
export function openInsertPopover({ slotKey, track, anchor, onPatch } = {}) {
  closeActive()
  if (!slotKey || !track || !anchor) return null

  const root = document.createElement('div')
  root.className = `mixer-insert-popover mixer-insert-popover--${slotKey}`
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', t(`mixer.insert_${slotKey === 'eq4' ? 'eq4' : 'comp'}_title`, { name: track?.name || '' }))

  const chain = normalizeTrackInsertChain(track?.playbackState?.inserts)

  // ── 头部：标题 + bypass 开关 + 关闭按钮 ─────────────────
  const head = document.createElement('div')
  head.className = 'mixer-insert-popover-head'
  const title = document.createElement('span')
  title.className = 'mixer-insert-popover-title'
  title.textContent = t(slotKey === TRACK_INSERT_SLOT_EQ4 ? 'mixer.insert_eq4_title' : 'mixer.insert_comp_title', {
    name: track?.name || '',
  })
  const bypassWrap = document.createElement('label')
  bypassWrap.className = 'mixer-insert-popover-bypass'
  const bypassInput = document.createElement('input')
  bypassInput.type = 'checkbox'
  bypassInput.checked = Boolean(chain[slotKey]?.enabled)
  const bypassLabel = document.createElement('span')
  bypassLabel.textContent = t('mixer.insert_enabled')
  bypassWrap.append(bypassInput, bypassLabel)
  bypassInput.addEventListener('change', () => {
    onPatch?.(slotKey, { enabled: bypassInput.checked }, { commit: true })
  })
  const btnClose = document.createElement('button')
  btnClose.type = 'button'
  btnClose.className = 'mixer-insert-popover-close'
  btnClose.setAttribute('aria-label', t('modal.common.close'))
  btnClose.textContent = '×'
  btnClose.addEventListener('click', (e) => { e.preventDefault(); closeActive() })
  head.append(title, bypassWrap, btnClose)
  root.appendChild(head)

  // ── 控件区 ─────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'mixer-insert-popover-body'
  if (slotKey === TRACK_INSERT_SLOT_EQ4) {
    body.classList.add('mixer-insert-popover-body--eq4')
    body.append(...buildEq4Knobs(chain.eq4, onPatch))
  } else {
    body.classList.add('mixer-insert-popover-body--comp')
    body.append(...buildCompKnobs(chain.comp, onPatch))
  }
  root.appendChild(body)

  document.body.appendChild(root)

  // ── 定位：优先上方，不够上方就贴下方 ─────────────────
  const positionPopover = () => {
    const aRect = anchor.getBoundingClientRect()
    const pRect = root.getBoundingClientRect()
    const margin = 8
    let top = aRect.top - pRect.height - margin
    if (top < 8) top = aRect.bottom + margin     // 上方放不下 → 贴下方
    let left = aRect.left + aRect.width / 2 - pRect.width / 2
    left = Math.max(8, Math.min(window.innerWidth - pRect.width - 8, left))
    root.style.top = `${Math.round(top)}px`
    root.style.left = `${Math.round(left)}px`
  }
  positionPopover()
  // 入场动画 + 二次定位（保证 transform / 字体加载后的高度变化也准）
  requestAnimationFrame(() => requestAnimationFrame(positionPopover))

  // ── 关闭机制：点击外部 / Esc / 窗口 resize 重定位 ────
  const onDocClick = (event) => {
    if (root.contains(event.target) || anchor.contains(event.target)) return
    closeActive()
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeActive() }
  }
  const onWindowResize = () => positionPopover()

  // 下一帧再监听 click —— 避免当前 click（打开浮窗的那一下）的 bubble 立刻关掉它
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onWindowResize)
  }, 0)

  const destroy = () => {
    document.removeEventListener('click', onDocClick, true)
    document.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', onWindowResize)
    if (root.parentNode) root.parentNode.removeChild(root)
  }
  activePopover = { destroy, root }
  return { destroy }
}

/** EQ4：4 段 × 1 gain 旋钮（freq / Q 用预设值，不让用户调，避免 UI 过载） */
function buildEq4Knobs(eq4, onPatch) {
  const bandLabels = [
    t('mixer.eq_band_low'),
    t('mixer.eq_band_lomid'),
    t('mixer.eq_band_himid'),
    t('mixer.eq_band_high'),
  ]
  // createFxKnobControl 返回 { root, input, syncValue }，**必须取 .root** 才是 DOM
  return eq4.bands.map((band, bandIndex) => createFxKnobControl({
    label: bandLabels[bandIndex],
    min: -18, max: 18, step: 0.1, tone: 'green',
    value: band.gain,
    format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
    onInput: (v) => onPatch?.('eq4', { bandIndex, band: { gain: v } }, { commit: false }),
    onCommit: (v) => onPatch?.('eq4', { bandIndex, band: { gain: v } }, { commit: true }),
  }).root)
}

/** Compressor：6 个旋钮 */
function buildCompKnobs(comp, onPatch) {
  const make = (key, label, min, max, step, tone, format) => createFxKnobControl({
    label, min, max, step, tone,
    value: comp[key],
    format,
    onInput: (v) => onPatch?.('comp', { [key]: v }, { commit: false }),
    onCommit: (v) => onPatch?.('comp', { [key]: v }, { commit: true }),
  }).root  // 同上：取 .root
  return [
    make('threshold',  t('mixer.comp_threshold'),  -60, 0,     0.1,   'orange', (v) => `${v.toFixed(1)} dB`),
    make('ratio',      t('mixer.comp_ratio'),      1,   20,    0.1,   'orange', (v) => `${v.toFixed(1)}:1`),
    make('attack',     t('mixer.comp_attack'),     0,   0.3,   0.001, 'orange', (v) => `${Math.round(v * 1000)} ms`),
    make('release',    t('mixer.comp_release'),    0.01, 1,    0.001, 'orange', (v) => `${Math.round(v * 1000)} ms`),
    make('knee',       t('mixer.comp_knee'),       0,   40,    0.5,   'orange', (v) => `${v.toFixed(1)} dB`),
    make('makeupGain', t('mixer.comp_makeup'),     -12, 24,    0.1,   'orange', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`),
  ]
}

/** 给外部主动关浮窗的接口（mixer dock 关闭 / tab 切换时调） */
export function closeMixerInsertPopover() {
  closeActive()
}
