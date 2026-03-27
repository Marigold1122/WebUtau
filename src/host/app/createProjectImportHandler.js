export function createProjectImportHandler({
  view,
  transportCoordinator,
  vocalManifestController,
  voiceConversionController,
  resetImportedAudioAssets = null,
  taskCoordinator,
  predictionGateController,
  prepWaiters,
  persistEditorSnapshot,
  bridge,
  focusSoloController,
  trackShellSessionController,
  importService,
  store,
  render,
}) {
  function hasExistingProjectContext(project) {
    if (!project) return false
    const hasTracks = Array.isArray(project.tracks) && project.tracks.length > 0
    const hasFileName = typeof project.fileName === 'string' && project.fileName.trim().length > 0
    const hasFocusedTrack = Boolean(project.selectedTrackId || project.editorTrackId)
    return hasTracks || hasFileName || hasFocusedTrack
  }

  return async function handleFileSelected(file) {
    if (!file) return

    try {
      view.setStatus('正在解析 MIDI...')
      view.hidePlaybackToast('voice-language-reminder')

      const previousProject = store.getProject()
      const hasCurrentProject = hasExistingProjectContext(previousProject)
      const importedProject = await importService.importFile(file)
      const hasImportedTiming = Boolean(
        importedProject?.tempoData?.hasTempoInfo
        || importedProject?.tempoData?.hasTimeSignatureInfo
        || importedProject?.tempoData?.hasKeySignatureInfo,
      )
      let nextProject = importedProject

      if (hasImportedTiming) {
        const timingChoice = await view.promptProjectTimingImport({
          fileName: importedProject.fileName,
          importedTempoData: importedProject.tempoData,
          currentTempoData: hasCurrentProject ? (previousProject?.tempoData || null) : null,
          hasCurrentProject,
        })
        if (!timingChoice) {
          view.setStatus('已取消导入')
          return
        }
        if (timingChoice === 'keep') {
          nextProject = importService.applyProjectTiming(importedProject, {
            tempoData: hasCurrentProject ? (previousProject?.tempoData || null) : null,
            ppq: hasCurrentProject ? (previousProject?.ppq || importedProject.ppq) : importedProject.ppq,
          })
        }
      }

      transportCoordinator.reset()
      vocalManifestController.resetProjectAssets()
      voiceConversionController?.reset?.()
      resetImportedAudioAssets?.()

      const cancelledTrack = await taskCoordinator.cancelConflictingTask(null, '已切换到新的项目')
      if (cancelledTrack && predictionGateController.getActiveTrackId() === cancelledTrack.id) {
        prepWaiters.resolve(cancelledTrack.id, { ok: false, error: '任务已取消' })
      }

      await persistEditorSnapshot()
      bridge.resetRuntime()
      taskCoordinator.clearRuntimeTrack()
      focusSoloController.clearCurrentTrack()
      trackShellSessionController.closeSourcePicker(null, 'project-import')

      store.setProject(nextProject)
      render('project-imported')
      view.setStatus(`已导入 ${nextProject.tracks.length} 条轨道，点击左侧 + 选择声源`)
    } catch (error) {
      console.error('MIDI 导入失败:', error)
      view.setStatus('MIDI 导入失败')
    } finally {
      view.refs.fileInput.value = ''
    }
  }
}
