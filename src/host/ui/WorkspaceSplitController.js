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
      const dockRect = this.refs.reverbDock?.getBoundingClientRect()
      if (!workspaceRect || !dockRect) return
      this.dragState = {
        target: 'reverbDock',
        startY: event.clientY,
        startHeight: dockRect.height,
        workspaceHeight: workspaceRect.height,
      }
    } else {
      return
    }
    window.addEventListener('pointermove', this._handlePointerMove)
    window.addEventListener('pointerup', this._handlePointerUp)
  }

  _handlePointerMove(event) {
    if (!this.dragState) return
    const delta = event.clientY - this.dragState.startY
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
    this.dragState = null
    window.removeEventListener('pointermove', this._handlePointerMove)
    window.removeEventListener('pointerup', this._handlePointerUp)
  }
}
