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
      ? '编辑器已关闭，可在上方继续选择轨道'
      : '编辑器已关闭，后台任务继续'
  }
}
