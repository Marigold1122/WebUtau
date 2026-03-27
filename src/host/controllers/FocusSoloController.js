export class FocusSoloController {
  constructor(sessionStore, logger = null) {
    this.sessionStore = sessionStore
    this.logger = logger
  }

  enterTrack(trackId) {
    this.sessionStore.setFocusSoloTrack(trackId)
    this.logger?.focusSolo('enter', trackId)
  }

  clearCurrentTrack(trackId = null) {
    if (!trackId || this.sessionStore.hasFocusSoloTrack(trackId)) {
      this.sessionStore.clearFocusSoloTrack()
      this.logger?.focusSolo('clear', trackId)
    }
  }

  clearOnEditorClose(trackId) {
    if (!this.sessionStore.shouldClearFocusSoloOnEditorClose(trackId)) return false
    this.sessionStore.clearFocusSoloTrack()
    this.logger?.focusSolo('clear-on-editor-close', trackId)
    return true
  }

  markPersistentMonitorChange() {
    this.sessionStore.markMonitorDirtySinceFocus()
    this.logger?.focusSolo('mark-persistent-monitor-change', this.sessionStore.getSnapshot().focusSoloTrackId)
  }
}
