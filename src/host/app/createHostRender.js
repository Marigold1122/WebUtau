import { resolveAudibleTrackIds } from '../monitor/TrackAudibilityResolver.js'

export function createHostRender({
  logger,
  store,
  sessionStore,
  view,
  getVoiceConversionState = null,
  getVstInsertState = null,
  onAfterRender = null,
}) {
  return function render(reason = 'state-changed') {
    const project = store.getProject()
    const selectedTrackId = project?.selectedTrackId || null
    const sessionState = sessionStore.getSnapshot()
    logger.render(reason, {
      selectedTrackId,
      editorTrackId: project?.editorTrackId || null,
      openSourcePickerTrackId: sessionStore.getOpenSourcePickerTrackId(),
    })
    view.render(project, {
      ...sessionState,
      audibleTrackIds: resolveAudibleTrackIds(store.getTracks(), sessionState),
      voiceConversion: getVoiceConversionState?.(selectedTrackId) || { visible: false },
      vstInsert: getVstInsertState?.() || { visible: false },
    })
    onAfterRender?.(reason)
  }
}
