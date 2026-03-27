export class HostSessionStore {
  constructor() {
    this._focusSoloTrackId = null
    this._monitorDirtySinceFocus = false
    this._openSourcePickerTrackId = null
  }

  getSnapshot() {
    return {
      focusSoloTrackId: this._focusSoloTrackId,
      monitorDirtySinceFocus: this._monitorDirtySinceFocus,
      openSourcePickerTrackId: this._openSourcePickerTrackId,
    }
  }

  getOpenSourcePickerTrackId() {
    return this._openSourcePickerTrackId
  }

  isSourcePickerOpen(trackId) {
    return Boolean(trackId) && this._openSourcePickerTrackId === trackId
  }

  openSourcePicker(trackId) {
    this._openSourcePickerTrackId = trackId || null
    return this._openSourcePickerTrackId
  }

  closeSourcePicker(trackId = null) {
    if (!this._openSourcePickerTrackId) return null
    if (trackId && this._openSourcePickerTrackId !== trackId) return null
    const closedTrackId = this._openSourcePickerTrackId
    this._openSourcePickerTrackId = null
    return closedTrackId
  }

  setFocusSoloTrack(trackId) {
    this._focusSoloTrackId = trackId || null
    this._monitorDirtySinceFocus = false
  }

  clearFocusSoloTrack() {
    this._focusSoloTrackId = null
    this._monitorDirtySinceFocus = false
  }

  hasFocusSoloTrack(trackId = null) {
    if (!this._focusSoloTrackId) return false
    if (!trackId) return true
    return this._focusSoloTrackId === trackId
  }

  markMonitorDirtySinceFocus() {
    if (!this._focusSoloTrackId) return
    this._monitorDirtySinceFocus = true
  }

  shouldClearFocusSoloOnEditorClose(trackId = null) {
    if (!this.hasFocusSoloTrack(trackId)) return false
    return !this._monitorDirtySinceFocus
  }
}
