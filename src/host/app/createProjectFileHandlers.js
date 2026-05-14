// 工程文件 4 个动作的真实实现：新建 / 打开 / 保存 / 另存为
// 同时管理"当前打开的文件句柄 / 工程名"——这两个值是名牌 UI（步骤 3）也要消费的状态

import {
  serializeProject,
  deserializeProject,
  resolveDisplayProjectName,
  WEBUTAU_PROJECT_EXTENSION,
} from '../project/projectFile.js'
import {
  supportsFileSystemAccessApi,
  pickSaveFileHandle,
  pickOpenFileHandle,
  writeJsonToHandle,
  readJsonFromHandle,
  getHandleName,
  downloadBlobFile,
  pickFileViaInput,
  readJsonFromFile,
  UserCancelledError,
} from '../project/projectStorage.js'
import { t } from '../../i18n/index.js'

export function createProjectFileHandlers({
  view,
  store,
  render,
  transportCoordinator,
  vocalManifestController,
  voiceConversionController,
  importedAudioAssetRegistry,
  taskCoordinator,
  predictionGateController,
  prepWaiters,
  persistEditorSnapshot,
  bridge,
  focusSoloController,
  trackShellSessionController,
  sessionStore,
  projectAudioMixPersistence,
  projectMixController,
  autoSave,
  resumeVoiceRendersAfterRestore = null,
  markPristine = () => {},
  logger = null,
}) {
  // 当前打开的工程文件状态——FSA 句柄能记住，让"保存"覆盖原文件
  let currentFileHandle = null
  let currentProjectName = null

  function getCurrentFileHandle() { return currentFileHandle }
  function getCurrentProjectName() { return currentProjectName }
  function setCurrentFileHandle(handle) {
    currentFileHandle = handle || null
    const name = getHandleName(handle)
    if (name) currentProjectName = name.replace(/\.[^.]+$/, '')
  }
  function setCurrentProjectName(name) { currentProjectName = name || null }

  function suggestedFileName() {
    const base = currentProjectName?.trim() || '未命名工程'
    return `${base}${WEBUTAU_PROJECT_EXTENSION}`
  }

  // 跟 createProjectImportHandler 里的 teardown 序列保持一致——任何"项目重置"
  // 都必须把传输 / 渲染缓存 / 预测任务 / iframe 桥接 / focus solo / 弹窗状态都关掉，
  // 否则旧项目残留的 jobId 会污染新项目。
  // audioAssets：从 .webutau 文件解出来的音频字节，必须在 setProject 之前注册回 registry，
  //              这样调度器一加载新轨道就能立刻找到对应 buffer
  // mergeFromLocalStorage：MIDI 重导入时打开（沿用上次会话的混音调整）；
  //                        打开 .webutau 时**关闭**——文件本身已经是 source of truth，
  //                        再叠 localStorage 旧快照会把文件里的真值反向覆盖（damping 被默认值盖掉就是这个 bug）
  async function tearDownAndAdoptProject(nextProject, {
    reason,
    audioAssets = null,
    mergeFromLocalStorage = true,
  } = {}) {
    transportCoordinator.reset()
    vocalManifestController.resetProjectAssets()
    voiceConversionController?.reset?.()
    importedAudioAssetRegistry?.reset?.()

    const cancelledTrack = await taskCoordinator.cancelConflictingTask(null, '已切换到新的项目')
    if (cancelledTrack && predictionGateController.getActiveTrackId() === cancelledTrack.id) {
      prepWaiters.resolve(cancelledTrack.id, { ok: false, error: '任务已取消' })
    }
    await persistEditorSnapshot()
    bridge.resetRuntime()
    taskCoordinator.clearRuntimeTrack()
    focusSoloController.clearCurrentTrack()
    sessionStore?.setReverbDockOpen?.(false)
    sessionStore?.setOpenReverbTrackIds?.([])
    trackShellSessionController.closeSourcePicker(null, reason)

    if (audioAssets) await restoreAudioAssets(audioAssets)

    const adopted = mergeFromLocalStorage
      ? (projectAudioMixPersistence?.restoreProject?.(nextProject) || nextProject)
      : nextProject
    store.setProject(adopted)
    // saveProject 会以新状态写回 localStorage——保证后续按 fingerprint 找到的快照
    // 和当前 store 一致，下次 MIDI 重导入也不会再被旧值污染
    projectAudioMixPersistence?.saveProject?.(store.getProject())
    projectMixController?.syncProjectState?.(store.getProject())
    render(reason)
  }

  // 单条 asset 解码失败不阻断整个工程加载——继续加载其他轨道，
  // 失败的轨道用户能看到（轨道还在）但听不到（buffer 缺）；状态栏会提示有几条失败
  async function restoreAudioAssets(audioAssets) {
    const ids = Object.keys(audioAssets)
    if (ids.length === 0) return
    let failed = 0
    for (const assetId of ids) {
      const asset = audioAssets[assetId]
      try {
        await importedAudioAssetRegistry.registerSerializedAsset({
          assetId,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          rawBytes: asset.rawBytes,
        })
      } catch (error) {
        failed += 1
        logger?.warn?.('Audio asset restore failed', {
          assetId,
          fileName: asset?.fileName,
          error: error?.message || String(error),
        })
      }
    }
    if (failed > 0) {
      view.setStatus(t('hostStatus.project_open_partial', { failed }))
    }
  }

  // ===== 新建 =====
  async function handleProjectNew() {
    try {
      await tearDownAndAdoptProject({
        fileName: '',
        ppq: null,
        tempoData: null,
        mixState: null,
        tracks: [],
        selectedTrackId: null,
        editorTrackId: null,
      }, {
        reason: 'project-new',
        // 新建工程要的是真正的"空"，别拉旧 localStorage 进来
        mergeFromLocalStorage: false,
      })
      currentFileHandle = null
      currentProjectName = null
      view.showEditorPlaceholder()
      await autoSave?.clearSnapshot?.()
      view.setStatus(t('hostStatus.blank_project_created'))
    } catch (error) {
      logger?.error?.('Project new failed', { error: error?.message || String(error) })
      view.setStatus(t('hostStatus.blank_project_failed'))
    }
  }

  // ===== 打开 =====
  async function handleProjectOpen() {
    let jsonString = null
    let nextHandle = null
    let nextDisplayName = null
    try {
      if (supportsFileSystemAccessApi()) {
        const handle = await pickOpenFileHandle()
        if (!handle) return
        jsonString = await readJsonFromHandle(handle)
        nextHandle = handle
        nextDisplayName = stripExtension(getHandleName(handle))
      } else {
        const file = await pickFileViaInput()
        jsonString = await readJsonFromFile(file)
        nextDisplayName = stripExtension(file.name)
      }
    } catch (error) {
      if (error instanceof UserCancelledError) return
      logger?.error?.('Project open: pick failed', { error: error?.message || String(error) })
      view.setStatus(t('hostStatus.open_project_failed', { message: error?.message || t('hostStatus.unknown_error') }))
      return
    }

    let parsed
    try {
      parsed = deserializeProject(jsonString)
    } catch (error) {
      logger?.error?.('Project open: parse failed', { error: error?.message || String(error) })
      view.setStatus(t('hostStatus.open_project_failed', { message: error?.message || t('hostStatus.open_project_parse_failed') }))
      return
    }

    try {
      await tearDownAndAdoptProject(parsed.project, {
        reason: 'project-opened',
        audioAssets: parsed.audioAssets || null,
        // .webutau 文件自带完整状态，绝不叠 localStorage 旧快照
        mergeFromLocalStorage: false,
      })
      currentFileHandle = nextHandle
      currentProjectName = resolveDisplayProjectName({
        fileHandleName: getHandleName(nextHandle),
        projectName: parsed.projectName,
        project: parsed.project,
      }) || nextDisplayName || null
      const trackCount = parsed.project?.tracks?.length || 0
      view.setStatus(t('hostStatus.project_opened', { name: currentProjectName || '', count: trackCount }))
      // 刚加载的工程跟磁盘文件一致——重置 dirty 让红点不显示
      markPristine()
      view.setProjectFileState?.({ name: currentProjectName, dirty: false })
      // 打开成功后立刻把 IndexedDB 里的旧自动快照清掉，避免"恢复上次未保存"误触发
      await autoSave?.clearSnapshot?.()
      // 跟"恢复工程"走一样的人声渲染重启路径：保存的 .webutau 里人声轨的
      // prepState='ready' + voiceSnapshot.pitchData 留下来了，但 server 任务和
      // phrase 音频跨会话失效，HostVocalScheduler 看不到 manifest.phraseStates 会
      // 整条轨静音——这里后台逐条把渲染任务跑起来
      if (typeof resumeVoiceRendersAfterRestore === 'function') {
        void resumeVoiceRendersAfterRestore()
      }
    } catch (error) {
      logger?.error?.('Project open: load failed', { error: error?.message || String(error) })
      view.setStatus(t('hostStatus.open_failed_generic'))
    }
  }

  // ===== 保存 =====
  async function handleProjectSave() {
    const project = store.getProject()
    if (!project) { view.setStatus(t('hostStatus.no_project_to_save')); return }

    // 没有缓存的句柄 → 行为退化为"另存为"（首次保存时弹位置选择器）
    if (!currentFileHandle && supportsFileSystemAccessApi()) {
      return handleProjectSaveAs()
    }

    const jsonString = serializeProject({
      project,
      projectName: currentProjectName,
      audioAssets: importedAudioAssetRegistry?.listEntries?.() || [],
    })

    if (currentFileHandle) {
      try {
        await writeJsonToHandle(currentFileHandle, jsonString)
        view.setStatus(t('hostStatus.saved_to', { name: getHandleName(currentFileHandle) || t('hostStatus.save_default_name') }))
        markPristine()
        view.setProjectFileState?.({ name: currentProjectName, dirty: false })
        // 已经保存到磁盘 → 自动快照不再需要
        await autoSave?.clearSnapshot?.()
      } catch (error) {
        if (error instanceof UserCancelledError) return
        logger?.error?.('Project save failed', { error: error?.message || String(error) })
        view.setStatus(t('hostStatus.save_failed', { message: error?.message || t('hostStatus.unknown_error') }))
      }
      return
    }

    // 浏览器不支持 FSA → 走下载兜底
    downloadBlobFile({ jsonString, suggestedName: suggestedFileName() })
    view.setStatus(t('hostStatus.download_saved', { name: suggestedFileName() }))
    markPristine()
    view.setProjectFileState?.({ name: currentProjectName, dirty: false })
    await autoSave?.clearSnapshot?.()
  }

  // ===== 另存为 =====
  async function handleProjectSaveAs() {
    const project = store.getProject()
    if (!project) { view.setStatus(t('hostStatus.no_project_to_saveas')); return }
    const jsonString = serializeProject({
      project,
      projectName: currentProjectName,
      audioAssets: importedAudioAssetRegistry?.listEntries?.() || [],
    })

    if (supportsFileSystemAccessApi()) {
      try {
        const handle = await pickSaveFileHandle({ suggestedName: suggestedFileName() })
        await writeJsonToHandle(handle, jsonString)
        currentFileHandle = handle
        currentProjectName = stripExtension(getHandleName(handle))
        view.setStatus(t('hostStatus.saveas_done', { name: getHandleName(handle) }))
        markPristine()
        view.setProjectFileState?.({ name: currentProjectName, dirty: false })
        await autoSave?.clearSnapshot?.()
      } catch (error) {
        if (error instanceof UserCancelledError) return
        logger?.error?.('Project saveAs failed', { error: error?.message || String(error) })
        view.setStatus(t('hostStatus.saveas_failed', { message: error?.message || t('hostStatus.unknown_error') }))
      }
      return
    }

    // 兜底：直接下载
    downloadBlobFile({ jsonString, suggestedName: suggestedFileName() })
    view.setStatus(t('hostStatus.download_done', { name: suggestedFileName() }))
    markPristine()
    view.setProjectFileState?.({ name: currentProjectName, dirty: false })
    await autoSave?.clearSnapshot?.()
  }

  // ===== 启动恢复：根据 IndexedDB 自动快照重建工程 =====
  async function restoreFromSnapshot(jsonString) {
    try {
      const parsed = deserializeProject(jsonString)
      await tearDownAndAdoptProject(parsed.project, {
        reason: 'project-restored-from-snapshot',
        audioAssets: parsed.audioAssets || null,
        // 快照本身就是完整状态，不再叠 localStorage
        mergeFromLocalStorage: false,
      })
      currentFileHandle = null
      currentProjectName = parsed.projectName ?? null
      // 故意 *不* markPristine——快照是"未保存的工作"，恢复后红点应该继续显示，
      // 提示用户记得保存到真实文件
      view.setProjectFileState?.({ name: currentProjectName, dirty: true })
      const trackCount = parsed.project?.tracks?.length || 0
      view.setStatus(t('hostStatus.restored_snapshot', { count: trackCount }))
      return true
    } catch (error) {
      logger?.error?.('Project restore from snapshot failed', { error: error?.message || String(error) })
      view.setStatus(t('hostStatus.restore_failed'))
      return false
    }
  }

  return {
    onProjectNew: handleProjectNew,
    onProjectOpen: handleProjectOpen,
    onProjectSave: handleProjectSave,
    onProjectSaveAs: handleProjectSaveAs,
    restoreFromSnapshot,
    getCurrentFileHandle,
    getCurrentProjectName,
    setCurrentFileHandle,
    setCurrentProjectName,
  }
}

function stripExtension(name) {
  if (typeof name !== 'string' || !name) return null
  return name.replace(/\.[^.]+$/, '').trim() || name
}
