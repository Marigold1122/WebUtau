const MIN_TRACK_VIEW_HEIGHT = 140
const MIN_EDITOR_HEIGHT = 320
const MIN_REVERB_DOCK_HEIGHT = 200
// dock 第一次打开时按"占工作区一半"对待——与编辑器开启时的视觉占比保持一致
const REVERB_DOCK_DEFAULT_RATIO = 0.5

export class WorkspaceSplitController {
  constructor(refs) {
    this.refs = refs
    this.editorVisible = false
    this.reverbDockVisible = false
    // dock 用户拖拽过的高度——一旦拖过就保留，关掉再开仍用上次的值；未拖过时按"工作区一半"重算
    this.reverbDockUserHeight = null
    this.dragState = null
    this.resizeFrame = 0
    this._handlePointerMove = this._handlePointerMove.bind(this)
    this._handlePointerUp = this._handlePointerUp.bind(this)
  }

  init() {
    this.refs.panelResizer?.addEventListener('pointerdown', (event) => this._handlePointerDown(event, 'editor'))
    this.refs.reverbDockResizer?.addEventListener('pointerdown', (event) => this._handlePointerDown(event, 'reverbDock'))
    this.refs.workspace?.style.setProperty('--track-view-open-height', '180px')
  }

  setEditorVisible(visible) {
    this.editorVisible = visible
    this.refs.workspace?.classList.toggle('piano-hidden', !visible)
    this.scheduleRuntimeResize()
  }

  // dock 由 ReverbDockView 自行 toggle .hidden；本控制器只负责高度变量与 resizer 显示
  setReverbDockVisible(visible) {
    const becomingVisible = visible && !this.reverbDockVisible
    this.reverbDockVisible = visible
    this.refs.reverbDockResizer?.classList.toggle('hidden', !visible)
    if (becomingVisible) {
      this._applyDefaultReverbDockHeight()
    }
    this.scheduleRuntimeResize()
  }

  // 默认让 dock 占工作区一半——首次开启时与轨道编辑界面观感一致；用户拖过则保留其手动值
  _applyDefaultReverbDockHeight() {
    const workspace = this.refs.workspace
    if (!workspace) return
    const workspaceHeight = workspace.getBoundingClientRect().height
    const userHeight = this.reverbDockUserHeight
    let nextHeight
    if (Number.isFinite(userHeight) && userHeight > 0) {
      // 工作区可能因为窗口尺寸变化导致旧值越界，重新约束到合法范围
      const maxHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, workspaceHeight - MIN_TRACK_VIEW_HEIGHT)
      nextHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, Math.min(maxHeight, userHeight))
    } else {
      const half = Math.round(workspaceHeight * REVERB_DOCK_DEFAULT_RATIO)
      const maxHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, workspaceHeight - MIN_TRACK_VIEW_HEIGHT)
      nextHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, Math.min(maxHeight, half))
    }
    workspace.style.setProperty('--reverb-dock-open-height', `${nextHeight}px`)
  }

  scheduleRuntimeResize() {
    cancelAnimationFrame(this.resizeFrame)
    this.resizeFrame = requestAnimationFrame(() => {
      const runtimeWindow = this.refs.voiceRuntimeFrame?.contentWindow
      runtimeWindow?.dispatchEvent(new Event('resize'))
    })
  }

  _handlePointerDown(event, target) {
    if (target === 'editor') {
      if (!this.editorVisible) return
      const workspaceRect = this.refs.workspace?.getBoundingClientRect()
      const trackViewRect = this.refs.trackView?.getBoundingClientRect()
      if (!workspaceRect || !trackViewRect) return
      this.dragState = {
        target: 'editor',
        startY: event.clientY,
        startHeight: trackViewRect.height,
        workspaceHeight: workspaceRect.height,
      }
    } else if (target === 'reverbDock') {
      if (!this.reverbDockVisible) return
      const workspaceRect = this.refs.workspace?.getBoundingClientRect()
      // 当前哪个 dock 可见就读哪个的高度——mixer 和 reverb 共用同一份
      // CSS 高度变量；隐藏的 dock display:none 后 getBoundingClientRect 返 0 高度，
      // 不能拿它做 startHeight（之前 mixer tab 下拖 resizer "拖不动"就是这个 bug）
      const reverbRect = this.refs.reverbDock?.getBoundingClientRect()
      const mixerRect = this.refs.mixerDock?.getBoundingClientRect()
      let startHeight = 0
      if (reverbRect && reverbRect.height > 0) startHeight = reverbRect.height
      else if (mixerRect && mixerRect.height > 0) startHeight = mixerRect.height
      else {
        const cssVar = this.refs.workspace
          ? getComputedStyle(this.refs.workspace).getPropertyValue('--reverb-dock-open-height')
          : ''
        const parsed = parseFloat(cssVar)
        if (Number.isFinite(parsed)) startHeight = parsed
      }
      if (!workspaceRect || !(startHeight > 0)) return
      this.dragState = {
        target: 'reverbDock',
        startY: event.clientY,
        startHeight,
        workspaceHeight: workspaceRect.height,
      }
    } else {
      return
    }
    window.addEventListener('pointermove', this._handlePointerMove)
    window.addEventListener('pointerup', this._handlePointerUp)
    // 跨组件信号：告诉 mixer dock 的 meter RAF 循环"现在在拖 dock，
    // 跳过 DOM 写入"。和 RAF 节流相加才能让 14 条 strip 的拖拽达到 reverb dock 同款顺滑度
    document.body.dataset.dockResizing = '1'
  }

  _handlePointerMove(event) {
    if (!this.dragState) return
    // pointermove 在 Mac 触控板 / 高刷新鼠标下可达 120-240Hz；
    // 我们一帧最多 commit 一次 —— 用 RAF 节流。同一帧多次事件只保留**最后一次** clientY，
    // 下一帧统一刷一次 style + 触发一次 runtime resize。
    // 之前没节流时，mixer dock 14 条 strip 每帧多次 reflow → 拖拽卡顿
    this._pendingPointerY = event.clientY
    if (this._dragMoveRaf) return
    this._dragMoveRaf = requestAnimationFrame(() => {
      this._dragMoveRaf = 0
      this._flushPendingDragMove()
    })
  }

  _flushPendingDragMove() {
    if (!this.dragState || this._pendingPointerY == null) return
    const delta = this._pendingPointerY - this.dragState.startY
    if (this.dragState.target === 'editor') {
      const maxHeight = Math.max(MIN_TRACK_VIEW_HEIGHT, this.dragState.workspaceHeight - MIN_EDITOR_HEIGHT)
      const nextHeight = Math.max(MIN_TRACK_VIEW_HEIGHT, Math.min(maxHeight, this.dragState.startHeight + delta))
      this.refs.workspace?.style.setProperty('--track-view-open-height', `${Math.round(nextHeight)}px`)
    } else if (this.dragState.target === 'reverbDock') {
      // resizer 在 dock 上方，鼠标向下拖代表 dock 顶边下移 → dock 缩小，所以减号
      const maxHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, this.dragState.workspaceHeight - MIN_TRACK_VIEW_HEIGHT)
      const nextHeight = Math.max(MIN_REVERB_DOCK_HEIGHT, Math.min(maxHeight, this.dragState.startHeight - delta))
      const rounded = Math.round(nextHeight)
      this.refs.workspace?.style.setProperty('--reverb-dock-open-height', `${rounded}px`)
      this.reverbDockUserHeight = rounded
    }
    this.scheduleRuntimeResize()
  }

  _handlePointerUp() {
    // 抬手时如果还有挂起的 RAF，先把最后一次位置 flush 出去再清理；
    // 不然鼠标抬起的最终位置可能比"上一次 RAF 提交时"晚 1 帧、停在错的高度
    if (this._dragMoveRaf) {
      cancelAnimationFrame(this._dragMoveRaf)
      this._dragMoveRaf = 0
      this._flushPendingDragMove()
    }
    this._pendingPointerY = null
    this.dragState = null
    delete document.body.dataset.dockResizing
    window.removeEventListener('pointermove', this._handlePointerMove)
    window.removeEventListener('pointerup', this._handlePointerUp)
  }
}
