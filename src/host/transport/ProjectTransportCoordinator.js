import { resolveAudibleTrackIds } from '../monitor/TrackAudibilityResolver.js'
import { normalizeTrackVolume } from '../project/trackPlaybackState.js'
import { getProjectDuration } from '../services/PreviewProjector.js'
import { TrackFxDispatchRouter } from './TrackFxDispatchRouter.js'

const HOST_PROJECT_DRIVER = 'host-project'
const HOST_RECORD_DRIVER = 'host-record'

function formatTransportTime(timeSec) {
  const safeTime = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0)
  const minutes = Math.floor(safeTime / 60)
  const seconds = Math.floor(safeTime % 60)
  const milliseconds = Math.floor((safeTime - Math.floor(safeTime)) * 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}

export class ProjectTransportCoordinator {
  constructor({
    projectStore,
    sessionStore,
    transportStore,
    audioGraph = null,
    instrumentScheduler,
    importedAudioScheduler = null,
    vocalScheduler,
    convertedVocalScheduler,
    runtimeTransportSync = null,
    view,
    logger = null,
  }) {
    this.projectStore = projectStore
    this.sessionStore = sessionStore
    this.transportStore = transportStore
    this.audioGraph = audioGraph
    this.instrumentScheduler = instrumentScheduler
    this.importedAudioScheduler = importedAudioScheduler
    this.vocalScheduler = vocalScheduler
    this.convertedVocalScheduler = convertedVocalScheduler
    this.trackFxDispatchRouter = new TrackFxDispatchRouter({
      projectStore,
      instrumentScheduler,
      importedAudioScheduler,
      vocalScheduler,
      convertedVocalScheduler,
    })
    this.runtimeTransportSync = runtimeTransportSync
    this.view = view
    this.logger = logger
    this.rafId = null
    this.clockStartedAtMs = 0
    this.clockStartedSongTime = 0
    this.refreshToken = 0
    this.lastTransportDisplayAtMs = 0
    this.lastFrameTraceAtMs = 0
    this.lastViewTickTraceAtMs = 0
  }

  init() {
    this._syncViewState(this.transportStore.getSnapshot())
  }

  getSnapshot() {
    return this.transportStore.getSnapshot()
  }

  isTransportActive() {
    return Boolean(this.transportStore.getSnapshot().playing)
  }

  isProjectPlaybackActive() {
    const snapshot = this.transportStore.getSnapshot()
    return snapshot.playing && snapshot.driver === HOST_PROJECT_DRIVER
  }

  isRecordClockActive() {
    const snapshot = this.transportStore.getSnapshot()
    return snapshot.playing && snapshot.driver === HOST_RECORD_DRIVER
  }

  async toggleProjectPlayback() {
    this._logTrace('toggleProjectPlayback:entry')
    if (this.isTransportActive()) {
      this._logTrace('toggleProjectPlayback:pause-branch')
      this.pause()
      return true
    }

    const project = this.projectStore.getProject()
    if (!project) {
      this._logTrace('toggleProjectPlayback:no-project')
      this.view.setStatus('请先导入 MIDI')
      return false
    }

    this.view.setStatus('正在加载项目播放资源...')
    const currentTime = this.transportStore.getSnapshot().currentTime || 0
    this._logTrace('toggleProjectPlayback:start-request', { requestedTime: currentTime })
    return this._startProjectPlaybackFromTime(currentTime, 'play')
  }

  async refreshProjectPlayback(reason = 'transport-refresh') {
    if (!this.isProjectPlaybackActive()) return false
    return this._startProjectPlaybackFromTime(this._getCurrentSongTime(), reason)
  }

  setTrackVolume(trackId, volume) {
    const nextVolume = normalizeTrackVolume(volume)
    return this.trackFxDispatchRouter.dispatch(trackId, 'setTrackVolume', nextVolume)
  }

  setTrackReverbSend(trackId, reverbSend) {
    return this.trackFxDispatchRouter.dispatch(trackId, 'setTrackReverbSend', reverbSend)
  }

  setTrackReverbConfig(trackId, reverbConfig) {
    return this.trackFxDispatchRouter.dispatch(trackId, 'setTrackReverbConfig', reverbConfig)
  }

  setTrackGuitarTone(trackId, guitarTone) {
    return this.trackFxDispatchRouter.dispatch(trackId, 'setTrackGuitarTone', guitarTone)
  }

  pause() {
    const snapshot = this.transportStore.getSnapshot()
    this._logTrace('pause:entry')
    if (!snapshot.playing) return snapshot

    const currentTime = this._getCurrentSongTime()
    this._cancelFrame()
    this.instrumentScheduler.stop()
    this.importedAudioScheduler?.stop?.()
    this.vocalScheduler.stop()
    this.convertedVocalScheduler?.stop?.()
    const nextSnapshot = this.transportStore.patch({
      playing: false,
      currentTime,
      duration: Math.max(snapshot.duration || 0, currentTime),
    })
    this._syncViewState(nextSnapshot)
    this.view.setStatus(snapshot.driver === HOST_RECORD_DRIVER ? '已暂停录制定位' : '已暂停项目预览')
    this._logTrace('pause:completed', {
      pausedAt: currentTime,
    })
    return nextSnapshot
  }

  reset() {
    this.refreshToken += 1
    this._cancelFrame()
    this.instrumentScheduler.stop()
    this.importedAudioScheduler?.stop?.()
    this.vocalScheduler.stop()
    this.convertedVocalScheduler?.stop?.()
    const snapshot = this.transportStore.reset()
    this._syncViewState(snapshot)
    return snapshot
  }

  async seekToTime(timeSec) {
    const project = this.projectStore.getProject()
    if (!project) return false

    const snapshot = this.transportStore.getSnapshot()
    const duration = Math.max(snapshot.duration || 0, getProjectDuration(project.tracks))
    const targetTime = Math.min(Math.max(0, Number.isFinite(timeSec) ? timeSec : 0), duration)
    this._logTrace('seekToTime:entry', {
      requestedTime: timeSec,
      targetTime,
    })

    if (this.isProjectPlaybackActive()) {
      this._logTrace('seekToTime:restart-project-playback', { targetTime })
      return this._startProjectPlaybackFromTime(targetTime, 'seek')
    }

    if (this.isRecordClockActive()) {
      this.clockStartedAtMs = performance.now()
      this.clockStartedSongTime = targetTime
      const nextSnapshot = this.transportStore.patch({
        currentTime: targetTime,
        duration: Math.max(duration, targetTime),
      })
      this._syncViewState(nextSnapshot)
      this.logger?.info?.('宿主录制时钟定位完成', {
        driver: snapshot.driver,
        playing: snapshot.playing,
        currentTime: targetTime,
      })
      this._logTrace('seekToTime:record-clock-updated', { targetTime })
      return true
    }

    const nextSnapshot = this.transportStore.patch({
      currentTime: targetTime,
      duration,
    })
    this._syncViewState(nextSnapshot)
    this.logger?.info?.('宿主定位完成', {
      driver: snapshot.driver,
      playing: snapshot.playing,
      currentTime: targetTime,
    })
    this._logTrace('seekToTime:completed', { targetTime })
    return true
  }

  isInstrumentPlaybackActive() {
    return this.isProjectPlaybackActive()
  }

  startRecordClock(currentTime = null) {
    const snapshot = this.transportStore.getSnapshot()
    const project = this.projectStore.getProject()
    const targetTime = Number.isFinite(currentTime)
      ? Math.max(0, currentTime)
      : Math.max(0, snapshot.currentTime || 0)
    const duration = Math.max(snapshot.duration || 0, getProjectDuration(project?.tracks || []), targetTime)

    this.refreshToken += 1
    this._cancelFrame()
    this.instrumentScheduler.stop()
    this.importedAudioScheduler?.stop?.()
    this.vocalScheduler.stop()
    this.convertedVocalScheduler?.stop?.()
    this.transportStore.replace({
      driver: HOST_RECORD_DRIVER,
      playing: true,
      currentTime: targetTime,
      duration,
    })
    this.clockStartedAtMs = performance.now()
    this.clockStartedSongTime = targetTime
    this._scheduleFrame()
    this._syncViewState(this.transportStore.getSnapshot())
    this.view.setStatus('MIDI 录制已启动')
    this.logger?.info?.('宿主录制时钟已启动', {
      currentTime: targetTime,
      duration,
    })
    return true
  }

  _scheduleFrame() {
    this._cancelFrame()
    this._logTrace('scheduleFrame:armed')
    const tick = () => {
      const snapshot = this.transportStore.getSnapshot()
      if (!snapshot.playing) return

      const currentTime = this._getCurrentSongTime()
      const now = performance.now()
      if (now - this.lastFrameTraceAtMs >= 250) {
        this.lastFrameTraceAtMs = now
        this._logTrace('scheduleFrame:tick', {
          computedCurrentTime: currentTime,
          driver: snapshot.driver,
        })
      }

      if (snapshot.driver === HOST_PROJECT_DRIVER) {
        const clampedTime = Math.min(currentTime, snapshot.duration || currentTime)
        this.instrumentScheduler.tick(clampedTime)
        this.importedAudioScheduler?.tick?.(clampedTime)
        this.vocalScheduler.tick(clampedTime)
        this.convertedVocalScheduler?.tick?.(clampedTime)

        if (snapshot.duration > 0 && clampedTime >= snapshot.duration) {
          this.transportStore.replace({
            driver: 'idle',
            playing: false,
            currentTime: 0,
            duration: snapshot.duration,
          })
          this.instrumentScheduler.stop()
          this.importedAudioScheduler?.stop?.()
          this.vocalScheduler.stop()
          this.convertedVocalScheduler?.stop?.()
          this._syncViewState(this.transportStore.getSnapshot())
          this.view.setStatus('项目预览播放结束')
          this._logTrace('scheduleFrame:project-ended', {
            clampedTime,
          })
          return
        }

        const nextSnapshot = this.transportStore.patch({ currentTime: clampedTime })
        this._syncViewTick(nextSnapshot)
        this.rafId = requestAnimationFrame(tick)
        return
      }

      if (snapshot.driver !== HOST_RECORD_DRIVER) {
        this._logTrace('scheduleFrame:unexpected-driver', {
          driver: snapshot.driver,
        })
        this._syncViewState(this.transportStore.patch({ playing: false }))
        return
      }

      const nextSnapshot = this.transportStore.patch({
        currentTime,
        duration: Math.max(snapshot.duration || 0, currentTime),
      })
      this._syncViewTick(nextSnapshot)
      this.rafId = requestAnimationFrame(tick)
    }

    this.rafId = requestAnimationFrame(tick)
  }

  _cancelFrame() {
    if (this.rafId == null) return
    cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  _getCurrentSongTime() {
    return this.clockStartedSongTime + (performance.now() - this.clockStartedAtMs) / 1000
  }

  async _startProjectPlaybackFromTime(currentTime, reason = 'play') {
    const token = ++this.refreshToken
    this._cancelFrame()
    this._logTrace('startProjectPlaybackFromTime:entry', {
      reason,
      requestedTime: currentTime,
      token,
    })
    try {
      const prepared = await this._prepareProjectPlayback(currentTime)
      if (token !== this.refreshToken) {
        this._logTrace('startProjectPlaybackFromTime:stale-token-abort', {
          reason,
          requestedTime: currentTime,
          token,
        })
        return false
      }
      if (!prepared.hasProjectDuration) {
        this._logTrace('startProjectPlaybackFromTime:no-project-duration', {
          reason,
          requestedTime: currentTime,
          token,
        })
        return false
      }

      this.transportStore.replace({
        driver: HOST_PROJECT_DRIVER,
        playing: true,
        currentTime,
        duration: prepared.duration,
      })
      this.clockStartedAtMs = performance.now()
      this.clockStartedSongTime = currentTime
      this._scheduleFrame()
      this._syncViewState(this.transportStore.getSnapshot())
      this.view.setStatus(this._buildPlaybackStatusText(prepared))
      this.logger?.info?.(`宿主播放已同步 | 原因=${reason}`, {
        currentTime,
        instrumentSourceIds: prepared.instrumentSourceIds,
        importedAudioTrackIds: prepared.importedAudioTrackIds,
        vocalTrackIds: prepared.vocalTrackIds,
      })
      this._logTrace('startProjectPlaybackFromTime:started', {
        reason,
        requestedTime: currentTime,
        duration: prepared.duration,
        instrumentTrackCount: prepared.instrumentSourceIds.length,
        importedAudioTrackCount: prepared.importedAudioTrackIds.length,
        vocalTrackCount: prepared.vocalTrackIds.length,
        convertedTrackCount: prepared.convertedTrackIds.length,
      })
      return true
    } catch (error) {
      this._logTrace('startProjectPlaybackFromTime:error', {
        reason,
        requestedTime: currentTime,
        token,
        error: error?.message || String(error),
      })
      throw error
    }
  }

  async _prepareProjectPlayback(fromTimeSec) {
    const project = this.projectStore.getProject()
    if (!project) {
      this._logTrace('prepareProjectPlayback:no-project', {
        fromTimeSec,
      })
      return this._emptyPreparedState()
    }

    this._logTrace('prepareProjectPlayback:entry', {
      fromTimeSec,
      trackCount: project.tracks?.length || 0,
    })

    const audibleTrackIds = resolveAudibleTrackIds(project.tracks, this.sessionStore.getSnapshot())
    const convertedPrepared = await this.convertedVocalScheduler.prepare({
      tracks: project.tracks,
      audibleTrackIds,
      fromTimeSec,
    })
    const [instrumentPrepared, importedAudioPrepared, vocalPrepared] = await Promise.all([
      this.instrumentScheduler.prepare({
        tracks: project.tracks,
        audibleTrackIds,
        fromTimeSec,
      }),
      this.importedAudioScheduler?.prepare?.({
        tracks: project.tracks,
        audibleTrackIds,
        fromTimeSec,
      }) || Promise.resolve({
        hasPlayableAudioTracks: false,
        duration: 0,
        trackIds: [],
      }),
      this.vocalScheduler.prepare({
        tracks: project.tracks,
        audibleTrackIds,
        excludedTrackIds: new Set(convertedPrepared.trackIds || []),
        fromTimeSec,
      }),
    ])

    const duration = Math.max(
      getProjectDuration(project.tracks),
      instrumentPrepared.duration || 0,
      importedAudioPrepared.duration || 0,
      vocalPrepared.duration || 0,
      convertedPrepared.duration || 0,
      0,
    )

    this.logger?.info?.('HostTransport playback sources resolved', {
      instrumentTrackCount: instrumentPrepared.sourceIds?.length || 0,
      importedAudioTrackCount: importedAudioPrepared.trackIds?.length || 0,
      vocalTrackCount: vocalPrepared.trackIds?.length || 0,
      convertedVocalTrackCount: convertedPrepared.trackIds?.length || 0,
      audibleTrackIds: [...audibleTrackIds],
    })

    if (duration <= 0) {
      this.transportStore.patch({ driver: 'idle', playing: false, duration: 0 })
      this._syncViewState(this.transportStore.getSnapshot())
      this.view.setStatus('当前没有可播放的轨道内容')
      return {
        ...this._emptyPreparedState(),
        instrumentSourceIds: instrumentPrepared.sourceIds || [],
        importedAudioTrackIds: importedAudioPrepared.trackIds || [],
        vocalTrackIds: vocalPrepared.trackIds || [],
        convertedTrackIds: convertedPrepared.trackIds || [],
      }
    }

    return {
      duration,
      hasProjectDuration: true,
      instrumentSourceIds: instrumentPrepared.sourceIds || [],
      importedAudioTrackIds: importedAudioPrepared.trackIds || [],
      vocalTrackIds: vocalPrepared.trackIds || [],
      convertedTrackIds: convertedPrepared.trackIds || [],
    }
  }

  _emptyPreparedState() {
    return {
      duration: 0,
      hasProjectDuration: false,
      instrumentSourceIds: [],
      importedAudioTrackIds: [],
      vocalTrackIds: [],
      convertedTrackIds: [],
    }
  }

  _buildPlaybackStatusText(prepared) {
    const labels = []
    if (prepared.instrumentSourceIds.length > 0) labels.push(prepared.instrumentSourceIds.join(' / '))
    if (prepared.importedAudioTrackIds.length > 0) labels.push(`${prepared.importedAudioTrackIds.length} 条音频`)
    if (prepared.vocalTrackIds.length > 0) labels.push(`${prepared.vocalTrackIds.length} 条人声`)
    if (prepared.convertedTrackIds.length > 0) labels.push(`${prepared.convertedTrackIds.length} 条已转换人声`)
    return labels.length > 0
      ? `正在播放项目预览 | ${labels.join(' / ')}`
      : '正在播放项目预览'
  }

  _syncViewState(snapshot) {
    this.view.setTransportTime(formatTransportTime(snapshot.currentTime))
    this.lastTransportDisplayAtMs = performance.now()
    this.view.setTimelinePlayheadTime?.(snapshot.currentTime)
    this.view.setPlaybackActive(snapshot.playing)
    this.runtimeTransportSync?.syncState?.(snapshot)
    this._logTrace('syncViewState', {
      viewTime: snapshot.currentTime,
      driver: snapshot.driver,
    })
  }

  _syncViewTick(snapshot) {
    this.view.setTimelinePlayheadTime?.(snapshot.currentTime)
    const now = performance.now()
    if (now - this.lastTransportDisplayAtMs >= 50) {
      this.view.setTransportTime(formatTransportTime(snapshot.currentTime))
      this.lastTransportDisplayAtMs = now
    }
    this.runtimeTransportSync?.syncTick?.(snapshot)
    if (now - this.lastViewTickTraceAtMs >= 250) {
      this.lastViewTickTraceAtMs = now
      this._logTrace('syncViewTick', {
        viewTime: snapshot.currentTime,
        driver: snapshot.driver,
      })
    }
  }

  _logTrace(message, extra = null) {
    const snapshot = this.transportStore.getSnapshot()
    this.logger?.debug?.('transport', `[TransportTrace] ${message}`, {
      driver: snapshot.driver,
      playing: snapshot.playing,
      currentTime: snapshot.currentTime,
      duration: snapshot.duration,
      clockStartedSongTime: this.clockStartedSongTime,
      rafActive: this.rafId != null,
      refreshToken: this.refreshToken,
      ...(extra || {}),
    })
  }
}

