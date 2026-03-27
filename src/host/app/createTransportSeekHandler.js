import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { getTrackTimelineMetrics } from '../ui/trackTimelineMetrics.js'

function getSeekTime(project, timelineX) {
  const axis = getTrackTimelineMetrics(project).axis
  return axis ? axis.xToTime(timelineX) : 0
}

export function createTransportSeekHandler({
  store,
  getBridge,
  logger = null,
  taskCoordinator,
  transportCoordinator,
}) {
  return async function handleTransportSeek(timelineX) {
    const project = store.getProject()
    if (!project) return false

    const targetTime = getSeekTime(project, timelineX)
    logger?.info?.('时间轴定位请求', {
      timelineX,
      targetTime,
      snapshot: transportCoordinator?.getSnapshot?.() || null,
    })
    const moved = await transportCoordinator.seekToTime(targetTime)

    const editorTrack = store.getEditorTrack()
    const canSyncRuntime = editorTrack
      && isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)
      && taskCoordinator.isRuntimeAttachedTo(editorTrack.id)

    if (!canSyncRuntime) return moved

    const bridge = getBridge?.()
    if (!bridge) return moved

    await bridge.seekTo(targetTime)
    logger?.info?.('运行时定位同步完成', {
      trackId: editorTrack.id,
      targetTime,
    })
    return moved
  }
}
