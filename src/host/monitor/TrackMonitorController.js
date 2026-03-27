import { normalizeTrackVolume } from '../project/trackPlaybackState.js'

export class TrackMonitorController {
  constructor({
    store,
    sessionStore,
    focusSoloController,
    transportCoordinator,
    refreshProjectPlayback = null,
    render,
    view,
    logger = null,
  }) {
    this.store = store
    this.sessionStore = sessionStore
    this.focusSoloController = focusSoloController
    this.transportCoordinator = transportCoordinator
    this.refreshProjectPlayback = refreshProjectPlayback
    this.render = render
    this.view = view
    this.logger = logger
  }

  async toggleSelectedTrackSolo() {
    const track = this.store.getSelectedTrack()
    if (!track) return false
    return this.toggleTrackSolo(track.id)
  }

  async toggleSelectedTrackMute() {
    const track = this.store.getSelectedTrack()
    if (!track) return false
    return this.toggleTrackMute(track.id)
  }

  async toggleTrackSolo(trackId) {
    return this._togglePlaybackFlag(trackId, 'solo')
  }

  async toggleTrackMute(trackId) {
    return this._togglePlaybackFlag(trackId, 'mute')
  }

  async setTrackVolume(trackId, volume, { commit = true } = {}) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    const nextVolume = normalizeTrackVolume(volume, track.playbackState?.volume)
    const currentVolume = normalizeTrackVolume(track.playbackState?.volume)
    if (Math.abs(nextVolume - currentVolume) < 0.0001 && !commit) {
      return false
    }

    this.store.updateTrackPlaybackState(track.id, { volume: nextVolume })
    await this.transportCoordinator.setTrackVolume(track.id, nextVolume)

    if (commit) {
      this.render('track-volume-changed')
      this.view.setStatus(this._buildVolumeStatusText(track.name, nextVolume))
      this.logger?.info?.('轨道音量已更新', {
        trackId: track.id,
        trackName: track.name,
        volume: nextVolume,
      })
    }

    return true
  }

  async _togglePlaybackFlag(trackId, flagKey) {
    const track = this.store.getTrack(trackId)
    if (!track) return false

    this._promotePersistentMonitorState()

    const nextValue = !Boolean(track.playbackState?.[flagKey])
    this.store.setSelectedTrack(track.id)
    this.store.updateTrackPlaybackState(track.id, { [flagKey]: nextValue })
    this.render(`track-${flagKey}-toggled`)
    this.view.setStatus(this._buildStatusText(track.name, flagKey, nextValue))
    this.logger?.info?.(`轨道监听已更新 | ${flagKey}=${nextValue}`, {
      trackId: track.id,
      trackName: track.name,
    })
    if (this.refreshProjectPlayback) {
      await this.refreshProjectPlayback(`monitor-${flagKey}`)
    } else {
      await this.transportCoordinator.refreshProjectPlayback(`monitor-${flagKey}`)
    }
    return true
  }

  _promotePersistentMonitorState() {
    if (!this.sessionStore.hasFocusSoloTrack()) return
    this.focusSoloController.markPersistentMonitorChange()
    this.focusSoloController.clearCurrentTrack()
  }

  _buildStatusText(trackName, flagKey, enabled) {
    const actionLabel = flagKey === 'solo' ? '独奏' : '静音'
    return `${trackName} 已${enabled ? '开启' : '关闭'}${actionLabel}`
  }

  _buildVolumeStatusText(trackName, volume) {
    return `${trackName} 音量 ${Math.round(normalizeTrackVolume(volume) * 100)}%`
  }
}
