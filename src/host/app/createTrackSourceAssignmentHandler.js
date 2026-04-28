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
import { t } from '../../i18n/index.js'

const VOICE_LANGUAGE_TOAST_ID = 'voice-language-reminder'

export function createTrackSourceAssignmentHandler({
  store,
  trackShellSessionController,
  transportCoordinator,
  refreshProjectPlayback = null,
  onVoiceConversionInvalidated,
  render,
  logger,
  view,
}) {
  return async function handleTrackSourceAssigned(trackId, sourceId, options = {}) {
    const suppressVoiceLanguageReminder = Boolean(options?.suppressVoiceLanguageReminder)
    const track = trackShellSessionController.selectTrack(trackId, { closeSourcePicker: false })
    if (!track) return

    const shouldHotRefresh = transportCoordinator.isProjectPlaybackActive()
    const assignedSourceId = normalizeAssignedSourceId(sourceId)
    const previousSourceId = track.playbackState?.assignedSourceId || null
    if (previousSourceId === assignedSourceId) {
      trackShellSessionController.closeSourcePicker(trackId, 'source-unchanged')
      render('source-assignment-noop')
      return
    }

    const nextRole = getRoleForAssignedSource(assignedSourceId)
    store.updateTrackPlaybackState(trackId, { assignedSourceId })
    store.updateTrack(trackId, {
      role: nextRole,
      pendingVoiceEditState: isVoiceRuntimeSource(assignedSourceId) ? track.pendingVoiceEditState || null : null,
    })
    trackShellSessionController.closeSourcePicker(trackId, 'source-assigned')
    if (isVoiceRuntimeSource(previousSourceId) && !isVoiceRuntimeSource(assignedSourceId)) {
      await onVoiceConversionInvalidated?.(trackId, t('hostStatus.voicebank_changed'))
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
    if (!suppressVoiceLanguageReminder && requiresVoiceLanguageSelection(updatedTrack)) {
      view.showPlaybackToast(t('hostStatus.voice_language_reminder'), {
        toastId: VOICE_LANGUAGE_TOAST_ID,
        tone: 'danger',
        size: 'large',
        durationMs: 0,
      })
    } else if (!hasTracksRequiringVoiceLanguageSelection(projectTracks)) {
      view.hidePlaybackToast(VOICE_LANGUAGE_TOAST_ID)
    }

    if (!assignedSourceId) {
      view.setStatus(t('hostStatus.track_source_cleared', { name: updatedTrack.name, fallback: getEffectiveSourceLabel(null) }))
      return
    }

    view.setStatus(t('hostStatus.track_source_assigned', { name: updatedTrack.name, source: getAssignedSourceLabel(assignedSourceId) }))
  }
}
