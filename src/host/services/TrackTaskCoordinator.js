import { hasActiveTrackJob, hasOngoingTrackWork } from '../project/trackJobRef.js'

export class TrackTaskCoordinator {
  constructor(store, remoteGateway = null) {
    this.store = store
    this.remoteGateway = remoteGateway
    this.taskSeed = 0
    this.runtimeTrackId = null
  }

  beginPrediction(trackId, intent) {
    const track = this.store.getTrack(trackId)
    if (!track) return null
    if (hasActiveTrackJob(track)) return track.jobRef?.taskId || null
    const taskId = `task-${++this.taskSeed}`
    this.store.updateTrackJobRef(trackId, {
      taskId,
      kind: 'prediction',
      phase: 'preparing',
      intent,
      revision: track.revision,
      status: 'active',
      startedAt: new Date().toISOString(),
      error: null,
    })
    return taskId
  }

  setRuntimeTrack(trackId) {
    this.runtimeTrackId = trackId || null
  }

  clearRuntimeTrack(trackId = null) {
    if (trackId && this.runtimeTrackId !== trackId) return
    this.runtimeTrackId = null
  }

  isRuntimeAttachedTo(trackId) {
    return Boolean(trackId) && this.runtimeTrackId === trackId
  }

  getActiveTrack(exceptTrackId = null) {
    return this.store.getTracks().find((track) => {
      if (exceptTrackId && track.id === exceptTrackId) return false
      return hasActiveTrackJob(track)
    }) || null
  }

  matchesActiveTask(trackId, jobId = undefined) {
    const track = this.store.getTrack(trackId)
    if (!track || !hasActiveTrackJob(track)) return false
    if (track.jobRef?.revision !== track.revision) return false
    if (jobId === undefined) return true
    if (jobId == null) return track.jobRef?.jobId == null
    return track.jobRef?.jobId === jobId
  }

  attachJobId(trackId, jobId) {
    if (!jobId || !this.matchesActiveTask(trackId, null)) return false
    this.store.updateTrackJobRef(trackId, { jobId })
    return true
  }

  markPredictionReady(trackId, snapshot) {
    const track = this.store.getTrack(trackId)
    if (!track || !this.matchesActiveTask(trackId, snapshot?.jobId || null)) return false
    this.store.updateTrackJobRef(trackId, {
      jobId: snapshot?.jobId || track.jobRef?.jobId || null,
      phase: 'rendering',
      status: 'active',
      error: null,
    })
    return true
  }

  markRenderCompleted(trackId, snapshot) {
    const track = this.store.getTrack(trackId)
    if (!track || !this.matchesActiveTask(trackId, snapshot?.jobId || null)) return false
    this.store.updateTrackJobRef(trackId, {
      jobId: snapshot?.jobId || track.jobRef?.jobId || null,
      phase: 'completed',
      status: 'completed',
      error: null,
    })
    return true
  }

  markFailed(trackId, error, jobId = null) {
    if (!this.matchesActiveTask(trackId, jobId)) return false
    this.store.updateTrackJobRef(trackId, {
      phase: 'failed',
      status: 'failed',
      error: error || null,
    })
    return true
  }

  markTrackEdited(trackId) {
    const track = this.store.getTrack(trackId)
    if (!track) return false
    const nextRevision = this.store.incrementTrackRevision(trackId)
    if (nextRevision == null) return false

    if (hasActiveTrackJob(track)) {
      this.store.updateTrackJobRef(trackId, {
        revision: nextRevision,
        error: null,
      })
      return true
    }

    this.store.updateTrackPrepState(trackId, { status: 'idle', progress: 0, error: null })
    this.store.updateTrackRenderState(trackId, { status: 'idle', completed: 0, total: 0, error: null })
    this.store.updateTrackJobRef(trackId, {
      taskId: null,
      jobId: null,
      kind: null,
      phase: 'idle',
      intent: null,
      revision: nextRevision,
      status: 'idle',
      startedAt: null,
      error: null,
    })
    return true
  }

  resetTrackTask(trackId) {
    const track = this.store.getTrack(trackId)
    if (!track) return
    this.store.updateTrackJobRef(trackId, {
      taskId: null,
      jobId: null,
      kind: null,
      phase: 'idle',
      intent: null,
      revision: track.revision,
      status: 'idle',
      startedAt: null,
      error: null,
    })
  }

  async cancelConflictingTask(nextTrackId, reason = '已替换为新的轨道任务') {
    const activeTrack = this.getActiveTrack(nextTrackId)
    if (!activeTrack) return null
    await this.cancelTrackTask(activeTrack.id, reason)
    return activeTrack
  }

  async cancelTrackTask(trackId, reason = '任务已取消') {
    const track = this.store.getTrack(trackId)
    if (!track) return false
    const jobId = track.jobRef?.jobId
    if (jobId) {
      await this.remoteGateway?.cancelJob(jobId)
    }
    this.store.updateTrackPrepState(trackId, { status: 'idle', progress: 0, error: null })
    this.store.updateTrackRenderState(trackId, { status: 'idle', completed: 0, total: 0, error: null })
    this.store.updateTrackJobRef(trackId, {
      taskId: null,
      jobId: null,
      kind: null,
      phase: 'idle',
      intent: null,
      revision: track.revision,
      status: 'idle',
      startedAt: null,
      error: reason,
    })
    this.clearRuntimeTrack(trackId)
    return true
  }

  shouldKeepRuntimeAlive(trackId) {
    return hasOngoingTrackWork(this.store.getTrack(trackId))
  }
}
