// 音高节点/段浮窗：选中节点或段时出现；四种曲线形状一排，锚在节点/段右下。
//
// 触发：PITCH_EDITOR_SELECTION_CHANGED —— 有选中点/段就打开，没选中就关。
// 拖动也会保持选中，浮窗全程可见。
//
// 和 NoteEditPopover 的互斥：更高优先级 —— NoteEditPopover 内部检查
// `hasSelectedPoint() || hasSelectedSegment()`，是 true 就不开。

import inlinePopover from './InlinePopover.js'
import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import pitchEditor, { PITCH_POINT_SHAPES, PITCH_EDITOR_MODE } from '../modules/PitchEditor.js'
import viewport from './PianoRollViewport.js'
import { t } from '../i18n/index.js'

const POPOVER_ID = 'pitch-shape'

const SHAPE_ICONS = {
  [PITCH_POINT_SHAPES.IN_OUT]: `<svg viewBox="0 0 40 20" width="28" height="14" aria-hidden="true">
    <path d="M2 16 C 10 16, 14 4, 20 4 S 30 16, 38 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`,
  [PITCH_POINT_SHAPES.LINEAR]: `<svg viewBox="0 0 40 20" width="28" height="14" aria-hidden="true">
    <path d="M2 16 L 38 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`,
  [PITCH_POINT_SHAPES.IN]: `<svg viewBox="0 0 40 20" width="28" height="14" aria-hidden="true">
    <path d="M2 16 C 20 16, 28 4, 38 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`,
  [PITCH_POINT_SHAPES.OUT]: `<svg viewBox="0 0 40 20" width="28" height="14" aria-hidden="true">
    <path d="M2 16 C 12 4, 20 4, 38 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`,
}

const SHAPE_META = [
  { shape: PITCH_POINT_SHAPES.IN_OUT, get label() { return t('pitchShape.smooth') } },
  { shape: PITCH_POINT_SHAPES.LINEAR, get label() { return t('pitchShape.line') } },
  { shape: PITCH_POINT_SHAPES.IN, get label() { return t('pitchShape.ease_in') } },
  { shape: PITCH_POINT_SHAPES.OUT, get label() { return t('pitchShape.ease_out') } },
]

class PitchShapePopover {
  constructor() {
    this._handle = null
    this._buttons = new Map()
    this._active = false
    this._canvas = null
  }

  isOpen() {
    return Boolean(this._handle && this._handle.isOpen())
  }

  /** PianoRoll.init 调用一次；canvas 用于算 anchor 的 iframe 内视口坐标 */
  activate(canvas) {
    this._canvas = canvas
    if (this._active) return
    this._active = true

    const onSelection = () => this._refreshFromSelection()
    const onModeChanged = () => this._refreshFromSelection()
    const onTrackChanged = () => { if (this.isOpen()) this.close() }
    // 滚动 / 缩放时 anchor 坐标会变 —— 让浮窗重新定位
    const onViewportChanged = () => {
      if (this.isOpen()) inlinePopover.requestReposition(POPOVER_ID)
    }

    eventBus.on(EVENTS.PITCH_EDITOR_SELECTION_CHANGED, onSelection)
    eventBus.on(EVENTS.PITCH_EDITOR_MODE_CHANGED, onModeChanged)
    eventBus.on(EVENTS.TRACK_SELECTED, onTrackChanged)
    eventBus.on(EVENTS.PITCH_CHANGED, onViewportChanged)
    eventBus.on(EVENTS.PHRASES_EDITED, onViewportChanged)
  }

  close() {
    if (this.isOpen()) this._handle.close()
  }

  // ---------- 内部 ----------

  _refreshFromSelection() {
    const inPitchMode = pitchEditor.getMode() === PITCH_EDITOR_MODE.PITCH
    const hasTarget = pitchEditor.hasSelectedPoint() || pitchEditor.hasSelectedSegment()
    if (!inPitchMode || !hasTarget) {
      if (this.isOpen()) this.close()
      return
    }
    if (this.isOpen()) {
      this._syncActiveShape()
      this._handle.updateAnchor(this._computeAnchor())
    } else {
      this._open()
    }
  }

  _open() {
    const content = this._buildContent()
    this._handle = inlinePopover.open({
      id: POPOVER_ID,
      anchor: this._computeAnchor(),
      content,
      className: 'inline-popover--shape',
      onClose: () => this._handleClose(),
    })
    this._syncActiveShape()
  }

  _computeAnchor() {
    return () => {
      if (!this._canvas) return null
      const rect = this._canvas.getBoundingClientRect()
      // 优先用 selectedPoint；否则用 segment 中点
      const pointId = pitchEditor.getSelectedPointId?.()
      if (pointId) {
        const point = pitchEditor.getDisplayPoints().find((p) => p.id === pointId)
        if (point) {
          const cx = rect.left + viewport.timeToX(point.time)
          const cy = rect.top + viewport.pitchToY(point.pitch) + PIANO_ROLL.KEY_HEIGHT / 2
          const r = PIANO_ROLL.PITCH_POINT_HIT_RADIUS
          return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 }
        }
      }
      const segmentId = pitchEditor.getSelectedSegmentId?.()
      if (segmentId) {
        const segment = pitchEditor.getDisplaySegments().find((s) => s.id === segmentId)
        if (segment) {
          const midTime = (segment.startTime + segment.endTime) / 2
          const midPitch = (segment.startPitch + segment.endPitch) / 2
          const cx = rect.left + viewport.timeToX(midTime)
          const cy = rect.top + viewport.pitchToY(midPitch) + PIANO_ROLL.KEY_HEIGHT / 2
          return { x: cx - 6, y: cy - 6, width: 12, height: 12 }
        }
      }
      return null
    }
  }

  _buildContent() {
    this._buttons.clear()

    const wrap = document.createElement('div')
    wrap.className = 'inline-popover-section'

    const group = document.createElement('div')
    group.className = 'inline-popover-btn-group'
    for (const { shape, label } of SHAPE_META) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'inline-popover-btn inline-popover-btn-shape'
      btn.title = label
      btn.setAttribute('aria-label', label)
      btn.innerHTML = `
        ${SHAPE_ICONS[shape] || ''}
        <span class="inline-popover-btn-shape-label">${label}</span>
      `
      btn.addEventListener('pointerdown', (event) => event.preventDefault())
      btn.addEventListener('click', () => this._applyShape(shape))
      this._buttons.set(shape, btn)
      group.appendChild(btn)
    }
    wrap.appendChild(group)

    return wrap
  }

  _syncActiveShape() {
    const currentShape = pitchEditor.getSelectedSegmentShape()
    for (const [shape, btn] of this._buttons.entries()) {
      btn.classList.toggle('is-active', currentShape === shape)
    }
  }

  async _applyShape(shape) {
    try {
      await pitchEditor.setSelectedSegmentShape(shape)
    } catch (error) {
      console.error('[PitchShapePopover] 设置形状失败:', error)
    }
    this._syncActiveShape()
  }

  _handleClose() {
    this._buttons.clear()
    this._handle = null
  }
}

export default new PitchShapePopover()
