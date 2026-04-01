import { normalizePlayheadFollowMode } from '../../shared/playheadFollowMode.js'

export class HostSessionStore {
  constructor() {
    this._focusSoloTrackId = null
    this._monitorDirtySinceFocus = false
    this._openSourcePickerTrackId = null
    this._editorMode = 'note'
    this._playheadFollowMode = normalizePlayheadFollowMode(null)
    this._reverbDockOpen = false
    this._openReverbTrackIds = []
  }

  getSnapshot() {
    return {
      focusSoloTrackId: this._focusSoloTrackId,
      monitorDirtySinceFocus: this._monitorDirtySinceFocus,
      openSourcePickerTrackId: this._openSourcePickerTrackId,
      editorMode: this._editorMode,
      playheadFollowMode: this._playheadFollowMode,
      reverbDockOpen: this._reverbDockOpen,
      openReverbTrackIds: [...this._openReverbTrackIds],
    }
  }

  getEditorMode() {
    return this._editorMode
  }

  setEditorMode(mode) {
    this._editorMode = mode === 'lyric' || mode === 'pitch' ? mode : 'note'
    return this._editorMode
  }

  getPlayheadFollowMode() {
    return this._playheadFollowMode
  }

  setPlayheadFollowMode(mode) {
    this._playheadFollowMode = normalizePlayheadFollowMode(mode)
    return this._playheadFollowMode
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

  isReverbDockOpen() {
    return this._reverbDockOpen
  }

  setReverbDockOpen(open) {
    this._reverbDockOpen = Boolean(open)
    return this._reverbDockOpen
  }

  toggleReverbDock() {
    this._reverbDockOpen = !this._reverbDockOpen
    return this._reverbDockOpen
  }

  getOpenReverbTrackIds() {
    return [...this._openReverbTrackIds]
  }

  isReverbTrackOpen(trackId) {
    return Boolean(trackId) && this._openReverbTrackIds.includes(trackId)
  }

  setOpenReverbTrackIds(trackIds = []) {
    const nextTrackIds = Array.isArray(trackIds)
      ? [...new Set(trackIds.filter((trackId) => typeof trackId === 'string' && trackId))]
      : []
    this._openReverbTrackIds = nextTrackIds
    return this.getOpenReverbTrackIds()
  }

  openReverbTrack(trackId) {
    if (!trackId || this.isReverbTrackOpen(trackId)) return this.getOpenReverbTrackIds()
    this._openReverbTrackIds = [...this._openReverbTrackIds, trackId]
    return this.getOpenReverbTrackIds()
  }

  closeReverbTrack(trackId) {
    if (!trackId || !this.isReverbTrackOpen(trackId)) return this.getOpenReverbTrackIds()
    this._openReverbTrackIds = this._openReverbTrackIds.filter((openTrackId) => openTrackId !== trackId)
    return this.getOpenReverbTrackIds()
  }

  toggleReverbTrack(trackId) {
    if (!trackId) return false
    if (this.isReverbTrackOpen(trackId)) {
      this.closeReverbTrack(trackId)
      return false
    }
    this.openReverbTrack(trackId)
    return true
  }
}
