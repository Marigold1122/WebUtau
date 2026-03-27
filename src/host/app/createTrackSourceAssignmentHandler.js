import {
  getAssignedSourceLabel,
  getEffectiveSourceLabel,
  getRoleForAssignedSource,
  isVoiceRuntimeSource,
  normalizeAssignedSourceId,
} from '../project/trackSourceAssignment.js'
import {
  hasTracksRequiringVoiceLanguageSelection,
  requiresVoiceLanguageSelection,
} from '../project/voiceTrackLanguageGate.js'

const VOICE_LANGUAGE_TOAST_ID = 'voice-language-reminder'
const VOICE_LANGUAGE_TOAST =
  '还没有双击人声轨道选择语言触发合成咕！'

export function createTrackSourceAssignmentHandler({
  store,
  trackShellSessionController,
  transportCoordinator,
  refreshProjectPlayback = null,
  detachEditorFromTrack,
  onVoiceConversionInvalidated,
  render,
  logger,
  view,
}) {
  return async function handleTrackSourceAssigned(trackId, sourceId) {
    const track = trackShellSessionController.selectTrack(trackId, { closeSourcePicker: false })
    if (!track) return

    const shouldHotRefresh = transportCoordinator.isProjectPlaybackActive()
    const assignedSourceId = normalizeAssignedSourceId(sourceId)
    const previousSourceId = track.playbackState?.assignedSourceId || null
    const editorKindChanged = isVoiceRuntimeSource(previousSourceId) !== isVoiceRuntimeSource(assignedSourceId)
    if (previousSourceId === assignedSourceId) {
      trackShellSessionController.closeSourcePicker(trackId, 'source-unchanged')
      render('source-assignment-noop')
      return
    }

    if (editorKindChanged) {
      await detachEditorFromTrack?.(trackId, {
        previousSourceId,
        nextSourceId: assignedSourceId,
        reason: 'source-switch',
      })
    }

    const nextRole = getRoleForAssignedSource(assignedSourceId)
    store.updateTrackPlaybackState(trackId, { assignedSourceId })
    store.updateTrack(trackId, { role: nextRole })
    trackShellSessionController.closeSourcePicker(trackId, 'source-assigned')
    if (isVoiceRuntimeSource(previousSourceId) && !isVoiceRuntimeSource(assignedSourceId)) {
      await onVoiceConversionInvalidated?.(trackId, '当前轨已切换为非人声声源，转换结果已回退')
    }

    render('source-assigned')
    const updatedTrack = store.getTrack(trackId)
    if (!updatedTrack) return

    if (shouldHotRefresh) {
      if (refreshProjectPlayback) {
        await refreshProjectPlayback(`source-switch:${trackId}`)
      } else {
        await transportCoordinator.refreshProjectPlayback(`source-switch:${trackId}`)
      }
    }

    logger.sourceAssigned(updatedTrack, assignedSourceId, getEffectiveSourceLabel(assignedSourceId))
    const projectTracks = store.getProject()?.tracks || []
    if (requiresVoiceLanguageSelection(updatedTrack)) {
      view.showPlaybackToast(VOICE_LANGUAGE_TOAST, {
        toastId: VOICE_LANGUAGE_TOAST_ID,
        tone: 'danger',
        size: 'large',
        durationMs: 0,
      })
    } else if (!hasTracksRequiringVoiceLanguageSelection(projectTracks)) {
      view.hidePlaybackToast(VOICE_LANGUAGE_TOAST_ID)
    }

    if (!assignedSourceId) {
      view.setStatus(`已清除 ${updatedTrack.name} 的声源 | 播放回退到${getEffectiveSourceLabel(null)}`)
      return
    }

    view.setStatus(`已将 ${updatedTrack.name} 设为${getAssignedSourceLabel(assignedSourceId)}`)
  }
}
