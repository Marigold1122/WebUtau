const MIN_TRACK_VIEW_HEIGHT = 140
const MIN_EDITOR_HEIGHT = 320

export class WorkspaceSplitController {
  constructor(refs) {
    this.refs = refs
    this.editorVisible = false
    this.dragState = null
    this.resizeFrame = 0
    this._handlePointerMove = this._handlePointerMove.bind(this)
    this._handlePointerUp = this._handlePointerUp.bind(this)
  }

  init() {
    this.refs.panelResizer?.addEventListener('pointerdown', (event) => this._handlePointerDown(event))
    this.refs.workspace?.style.setProperty('--track-view-open-height', '180px')
  }

  setEditorVisible(visible) {
    this.editorVisible = visible
    this.refs.workspace?.classList.toggle('piano-hidden', !visible)
    this.scheduleRuntimeResize()
  }

  scheduleRuntimeResize() {
    cancelAnimationFrame(this.resizeFrame)
    this.resizeFrame = requestAnimationFrame(() => {
      const runtimeWindow = this.refs.voiceRuntimeFrame?.contentWindow
      runtimeWindow?.dispatchEvent(new Event('resize'))
    })
  }

  _handlePointerDown(event) {
    if (!this.editorVisible) return
    const workspaceRect = this.refs.workspace?.getBoundingClientRect()
    const trackViewRect = this.refs.trackView?.getBoundingClientRect()
    if (!workspaceRect || !trackViewRect) return
    this.dragState = {
      startY: event.clientY,
      startHeight: trackViewRect.height,
      workspaceHeight: workspaceRect.height,
    }
    window.addEventListener('pointermove', this._handlePointerMove)
    window.addEventListener('pointerup', this._handlePointerUp)
  }

  _handlePointerMove(event) {
    if (!this.dragState) return
    const delta = event.clientY - this.dragState.startY
    const maxHeight = Math.max(MIN_TRACK_VIEW_HEIGHT, this.dragState.workspaceHeight - MIN_EDITOR_HEIGHT)
    const nextHeight = Math.max(MIN_TRACK_VIEW_HEIGHT, Math.min(maxHeight, this.dragState.startHeight + delta))
    this.refs.workspace?.style.setProperty('--track-view-open-height', `${Math.round(nextHeight)}px`)
    this.scheduleRuntimeResize()
  }

  _handlePointerUp() {
    this.dragState = null
    window.removeEventListener('pointermove', this._handlePointerMove)
    window.removeEventListener('pointerup', this._handlePointerUp)
  }
}
