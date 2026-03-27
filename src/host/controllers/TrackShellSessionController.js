export class TrackShellSessionController {
  constructor(store, sessionStore, logger = null) {
    this.store = store
    this.sessionStore = sessionStore
    this.logger = logger
  }

  selectTrack(trackId, options = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    this.store.setSelectedTrack(trackId)
    if (options.closeSourcePicker !== false) {
      this.closeSourcePicker(null, options.closeReason || 'track-select')
    }
    return track
  }

  toggleSourcePicker(trackId) {
    const track = this.selectTrack(trackId, { closeSourcePicker: false })
    if (!track) return false
    if (this.sessionStore.isSourcePickerOpen(trackId)) {
      this.sessionStore.closeSourcePicker(trackId)
      this.logger?.sourcePickerToggled(track, false)
      return false
    }
    this.closeSourcePicker(null, 'switch-track')
    this.sessionStore.openSourcePicker(trackId)
    this.logger?.sourcePickerToggled(track, true)
    return true
  }

  closeSourcePicker(trackId = null, reason = 'dismiss') {
    const closedTrackId = this.sessionStore.closeSourcePicker(trackId)
    if (!closedTrackId) return false
    this.logger?.sourcePickerClosed(this.store.getTrack(closedTrackId), reason)
    return true
  }
}
