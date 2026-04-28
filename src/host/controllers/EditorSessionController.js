import { t } from '../../i18n/index.js'

export class EditorSessionController {
  constructor(taskCoordinator) {
    this.taskCoordinator = taskCoordinator
  }

  shouldResetRuntimeOnClose(trackId) {
    if (!trackId) return true
    return !this.taskCoordinator.shouldKeepRuntimeAlive(trackId)
  }

  getCloseStatusText(trackId) {
    return this.shouldResetRuntimeOnClose(trackId)
      ? t('editorSession.closed_with_track')
      : t('editorSession.closed_idle')
  }
}
