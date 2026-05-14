import { startInlineRenameEdit } from '../ui/inlineRenameEdit.js'
import { createHostBridgeHandlers } from './createHostBridgeHandlers.js'
import { createHostRender } from './createHostRender.js'
import { createPhraseMissHandler } from './createPhraseMissHandler.js'
import { createProjectImportHandler } from './createProjectImportHandler.js'
import { createProjectFileHandlers } from './createProjectFileHandlers.js'
import { ProjectAutoSave } from '../project/projectAutoSave.js'
import { createHostReverbController } from './createHostReverbController.js'
import { createRuntimeTransportSync } from './createRuntimeTransportSync.js'
import { createTrackSourceAssignmentHandler } from './createTrackSourceAssignmentHandler.js'
import { createTransportSeekHandler } from './createTransportSeekHandler.js'
import { createTransportStepHandler } from './createTransportStepHandler.js'
import { createVoiceConversionViewHandlers } from './createVoiceConversionViewHandlers.js'
import { createWaiterRegistry } from './createWaiterRegistry.js'
import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { installGlobalEscape } from './installGlobalEscape.js'
import { isKeyboardShortcutTargetEditable } from '../../shared/isKeyboardShortcutTargetEditable.js'
import { ImportedAudioAssetRegistry } from '../audio/ImportedAudioAssetRegistry.js'
import { ImportedAudioTrackScheduler } from '../audio/ImportedAudioTrackScheduler.js'
import { ProjectAudioGraph } from '../audio/ProjectAudioGraph.js'
import { InstrumentScheduler } from '../audio/instruments/InstrumentScheduler.js'
import { SamplerPool } from '../audio/instruments/SamplerPool.js'
import { getHostPlaybackSourceId } from '../audio/instruments/sourceCatalog.js'
import { EditorSessionController } from '../controllers/EditorSessionController.js'
import { FocusSoloController } from '../controllers/FocusSoloController.js'
import { ProjectMixController } from '../controllers/ProjectMixController.js'
import { TrackPredictionGateController } from '../controllers/TrackPredictionGateController.js'
import { TrackShellSessionController } from '../controllers/TrackShellSessionController.js'
import { TrackVoiceConversionController } from '../controllers/TrackVoiceConversionController.js'
import { VocalManifestController } from '../controllers/VocalManifestController.js'
import { VoiceBridgeController } from '../controllers/VoiceBridgeController.js'
import { createHostLogger } from '../logging/createHostLogger.js'
import { TrackMonitorController } from '../monitor/TrackMonitorController.js'
import { ProjectAudioMixPersistence } from '../project/ProjectAudioMixPersistence.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { ProjectDocumentStore } from '../project/ProjectDocumentStore.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { isTrackPrepReady } from '../project/trackPrepState.js'
import { buildPendingVoiceNoteEditState, hasPendingVoiceNoteEdits } from '../project/pendingVoiceNoteEdit.js'
import { HostSessionStore } from '../session/HostSessionStore.js'
import { ImportProjectService } from '../services/ImportProjectService.js'
import { RenderOutputGateway } from '../services/RenderOutputGateway.js'
import { SeedVcGateway } from '../services/SeedVcGateway.js'
import { TrackTaskCoordinator } from '../services/TrackTaskCoordinator.js'
import { TrackTaskRemoteGateway } from '../services/TrackTaskRemoteGateway.js'
import { HostShortcutRouter } from '../transport/HostShortcutRouter.js'
import { PlaybackMode } from '../transport/PlaybackMode.js'
import { ProjectTransportCoordinator } from '../transport/ProjectTransportCoordinator.js'
import { ProjectTransportStore } from '../transport/ProjectTransportStore.js'
import { ShellLayoutView } from '../ui/ShellLayoutView.js'
import { installMenubarMeter } from '../ui/menubarMeter.js'
import { parseUstxToWebUtau } from '../../formats/ustx-import.js'
import { serializeWebUtauToUstx } from '../../formats/ustx-export.js'
import { UstxExportModal } from '../../formats/UstxExportModal.js'
import { t } from '../../i18n/index.js'
import { ConvertedVocalAssetRegistry } from '../vocal/ConvertedVocalAssetRegistry.js'
import { ConvertedVocalScheduler } from '../vocal/ConvertedVocalScheduler.js'
import { HostVocalAssetRegistry } from '../vocal/HostVocalAssetRegistry.js'
import { HostVocalScheduler } from '../vocal/HostVocalScheduler.js'
import { OfflineAudioExporter } from '../audio/export/OfflineAudioExporter.js'
import { ExportAudioModal } from '../audio/export/ExportAudioModal.js'

const MIDI_RECORD_MIN_DURATION_SEC = 0.05
const MIDI_RECORD_MIN_DURATION_TICKS = 1

function clampNonNegative(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function clampMidiVelocity(velocity) {
  if (!Number.isFinite(velocity)) return 0.8
  return Math.max(0, Math.min(1, velocity / 127))
}

function isInstrumentEditorTrack(track) {
  return Boolean(track) && !isAudioTrack(track)
}

function getNoteEditorMonitorSourceId(track) {
  if (!track || isAudioTrack(track)) return null
  return isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
    ? 'piano'
    : getHostPlaybackSourceId(track.playbackState?.assignedSourceId)
}

function isPreparedVoiceTrack(track) {
  return Boolean(
    track
    && !isAudioTrack(track)
    && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
    && isTrackPrepReady(track)
    && track.voiceSnapshot
    && track.jobRef?.jobId,
  )
}

function buildRecordedMidiNote(project, midi, velocity, startTime, endTime) {
  if (!project) return null
  const startSec = clampNonNegative(startTime)
  const stopSec = Math.max(startSec + MIDI_RECORD_MIN_DURATION_SEC, clampNonNegative(endTime, startSec))
  const axis = createTimelineAxis({
    tempoData: project.tempoData,
    ppq: project.ppq,
    totalTicks: 0,
  })
  const startTick = Math.max(0, Math.round(axis.timeToTick(startSec)))
  const endTick = Math.max(startTick + MIDI_RECORD_MIN_DURATION_TICKS, Math.round(axis.timeToTick(stopSec)))
  return {
    time: startSec,
    duration: stopSec - startSec,
    tick: startTick,
    durationTicks: endTick - startTick,
    midi: Math.max(0, Math.min(127, Math.round(midi))),
    velocity: clampMidiVelocity(velocity),
  }
}

function getBaseFileName(fileName = '', fallback = 'Track') {
  const normalized = String(fileName || '').trim().replace(/\.[^.]+$/, '')
  return normalized || fallback
}

function isUndoShortcut(event) {
  if (!event || event.repeat) return false
  if (event.altKey || event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  if (event.code !== 'KeyZ') return false
  return !isKeyboardShortcutTargetEditable(event.target)
}

// Cmd+Shift+Z（macOS / Linux 主流）以及 Ctrl+Y（Windows 习惯）都识别成 redo
function isRedoShortcut(event) {
  if (!event || event.repeat) return false
  if (event.altKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  if (event.code === 'KeyZ' && event.shiftKey) {
    return !isKeyboardShortcutTargetEditable(event.target)
  }
  if (event.code === 'KeyY' && !event.shiftKey) {
    return !isKeyboardShortcutTargetEditable(event.target)
  }
  return false
}

function triggerDownload(file) {
  if (!(file instanceof Blob)) return false
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = typeof file.name === 'string' && file.name ? file.name : 'download'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

function extractErrorDetails(error, fallback = t('hostStatus.unknown_error')) {
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : fallback
  const name = typeof error?.name === 'string' && error.name.trim()
    ? error.name.trim()
    : 'Error'
  const causeMessage = typeof error?.cause?.message === 'string' && error.cause.message.trim()
    ? error.cause.message.trim()
    : null
  return {
    name,
    message,
    cause: causeMessage,
    stack: typeof error?.stack === 'string' ? error.stack : null,
    summary: causeMessage && causeMessage !== message
      ? `${message} | cause: ${causeMessage}`
      : message,
  }
}

function buildAudioImportFailurePayload(file, error) {
  const details = extractErrorDetails(error, t('hostStatus.audio_import_failure_default'))
  return {
    fileName: typeof file?.name === 'string' && file.name ? file.name : null,
    fileType: typeof file?.type === 'string' && file.type ? file.type : null,
    fileSize: Number.isFinite(file?.size) ? file.size : null,
    ...details,
  }
}

function getAudioImportFailureMessage(error) {
  const details = extractErrorDetails(error, t('hostStatus.audio_import_failure_default'))
  const fingerprint = `${details.name} ${details.message} ${details.cause || ''}`.toLowerCase()
  if (fingerprint.includes('无法解码音频文件') || fingerprint.includes('encodingerror') || fingerprint.includes('decode')) {
    return t('hostStatus.cant_decode_audio')
  }
  return details.message
}

export function createHostApp() {
  let bridge = null
  let sourceAssignmentHandler = null
  let voiceConversionController = null
  const store = new ProjectDocumentStore()
  const sessionStore = new HostSessionStore()
  const transportStore = new ProjectTransportStore()
  const logger = createHostLogger()
  const importService = new ImportProjectService()
  const taskRemoteGateway = new TrackTaskRemoteGateway()
  const taskCoordinator = new TrackTaskCoordinator(store, taskRemoteGateway)
  const playbackMode = new PlaybackMode()
  const projectAudioGraph = new ProjectAudioGraph({ logger })
  const projectAudioMixPersistence = new ProjectAudioMixPersistence({ logger })
  const editorSessionController = new EditorSessionController(taskCoordinator)
  const focusSoloController = new FocusSoloController(sessionStore, logger)
  const projectMixController = new ProjectMixController({
    store,
    audioGraph: projectAudioGraph,
    logger,
    persistence: projectAudioMixPersistence,
  })
  // 顶栏主输出电平表：必须在 projectMixController 创建之后装（subscribeLufs 闭包引用了它）；
  // installMenubarMeter 内部会立刻调一次 subscribeLufs，早装会触发 TDZ ReferenceError 让页面卡死
  installMenubarMeter({
    container: document.getElementById('menubar-meter'),
    audioGraph: projectAudioGraph,
    // D 方案：点击电平表 bezel 打开 reverb dock 并高亮 master chain 模块。
    // 电平表显示问题（爆音 / 太响），master chain 是修问题的入口——一键直达。
    // 已经开着时再点一次直接收回 dock——toggle 行为，省得用户绕路去找 fx 关闭
    onBezelClick: () => {
      if (sessionStore.isReverbDockOpen()) {
        sessionStore.setReverbDockOpen(false)
        render('reverb-dock-closed')
        return
      }
      // 打开混音面板时收回编辑器——保持与 toggleReverbDock 一致的互斥策略
      clearEditorTrackState()
      sessionStore.setReverbDockOpen(true)
      render('master-chain-focus-requested')
      // render 之后 ReverbDockView 会重建 DOM，找到 master chain 模块加高亮
      requestAnimationFrame(() => {
        const masterModule = document.querySelector('.fx-module--master-chain')
        if (!masterModule) return
        masterModule.classList.remove('is-focus-pulse')
        // 强制 reflow 让动画可以从头来
        void masterModule.offsetWidth
        masterModule.classList.add('is-focus-pulse')
        masterModule.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      })
    },
    // 顶栏 LUFS 小读数 + 着色阈值——直接订阅同一个 LufsMeter，跟 master chain 模块共用数据
    subscribeLufs: (fn) => projectMixController.subscribeLufs(fn),
    getLoudnessTarget: () => projectMixController.getMasterChain()?.loudnessTarget,
  })
  const trackShellSessionController = new TrackShellSessionController(store, sessionStore, logger)
  const view = new ShellLayoutView({}, { logger })

  // === Dirty 跟踪：用 revision 计数器表达"自上次保存以来工程是否被改过" ===
  // 每次 render(reason) 触发后，如果 reason 不在 PRISTINE_RENDER_REASONS 白名单里，
  // 就把 currentRevision 自增；保存/打开/新建成功时调 markPristine 让 savedRevision 追上。
  // dirty 等价于 currentRevision !== savedRevision——简单且可靠，且无需侵入每个 mutator。
  // 白名单只列纯 UI 切换（选中、编辑器开关、传输停止、滚动模式 等），新增 reason 默认按 dirty 走，
  // 宁可"误报红点"也不能"漏报红点"，避免用户以为已保存其实没保存。
  const PRISTINE_RENDER_REASONS = new Set([
    'host-init',
    'audio-track-selected',
    'track-selected',
    'editor-closed',
    'editor-mode-note',
    'editor-open-requested',
    'editor-opened-after-prediction',
    'editor-detached-for-source-switch',
    'instrument-editor-opened',
    'playback-start-after-prediction',
    'transport-stopped',
    'playhead-follow-mode-changed',
    'prediction-gate-cancelled',
    'prediction-gate-editor-cleared',
    'prediction-gate-runtime-loaded',
    'reverb-dock-unavailable',
    'reverb-dock-opened',
    'reverb-dock-closed',
    'source-picker-dismissed',
    'source-picker-toggled',
    'source-assignment-noop',
    'runtime-track-loaded',
    'bridge-job-submitted',
    'bridge-prediction-ready',
    'bridge-render-complete',
    'bridge-render-failed',
    'voice-conversion-cancelled',
    'track-fx-opened',
    'track-fx-closed',
    'render-track-as-voice-opened',
    'master-chain-focus-requested',
    'master-chain-auto-fit-start',
    'master-chain-auto-fit-cancelled',
  ])
  let currentRevision = 0
  let savedRevision = 0
  const isDirty = () => currentRevision !== savedRevision
  const markPristine = () => { savedRevision = currentRevision }

  const render = createHostRender({
    logger,
    store,
    sessionStore,
    view,
    getVoiceConversionState: (trackId) => voiceConversionController?.buildInspectorState(trackId) || { visible: false },
    onAfterRender: (reason) => {
      const wasPristine = PRISTINE_RENDER_REASONS.has(reason)
      if (!wasPristine) currentRevision += 1
      // 调试钩子：DevTools 里搜 [webutau-dirty] 就能看到每次 render 是否触发了脏标记。
      // 如果某个 reason 应该 dirty 但没 dirty，说明它进了 PRISTINE 白名单需要剔除。
      // 用 console.info（不是 .debug）——Chrome DevTools 默认过滤掉 verbose/debug 级别
      if (typeof console !== 'undefined' && console.info) {
        console.info('[webutau-dirty]', { reason, wasPristine, dirty: isDirty(), currentRevision, savedRevision })
      }
      // 同步铭牌 + tab title——name 由 file handler 提供，dirty 由本闭包计算
      view.setProjectFileState?.({
        name: projectFileHandlers?.getCurrentProjectName?.() ?? null,
        dirty: isDirty(),
      })
      // 主动触发 autosave debounce：1 秒内没新动作就写一次快照。
      // 这样即使用户导入 MIDI 后 5 秒就关 tab，也已经有快照可恢复
      if (!wasPristine) projectAutoSave?.scheduleSave?.()
    },
  })
  const instrumentScheduler = new InstrumentScheduler(new SamplerPool({ audioGraph: projectAudioGraph }))
  const importedAudioAssetRegistry = new ImportedAudioAssetRegistry({ logger })
  const importedAudioScheduler = new ImportedAudioTrackScheduler(importedAudioAssetRegistry, {
    logger,
    audioGraph: projectAudioGraph,
  })
  const vocalAssetRegistry = new HostVocalAssetRegistry({ logger })
  const convertedVocalAssetRegistry = new ConvertedVocalAssetRegistry({ logger })
  const convertedVocalScheduler = new ConvertedVocalScheduler(convertedVocalAssetRegistry, {
    logger,
    audioGraph: projectAudioGraph,
  })
  const vocalManifestController = new VocalManifestController({ store, assetRegistry: vocalAssetRegistry, logger })
  const vocalScheduler = new HostVocalScheduler(vocalAssetRegistry, {
    logger,
    onPhraseMiss: (entry) => phraseMissHandler(entry),
    audioGraph: projectAudioGraph,
  })
  const runtimeTransportSync = createRuntimeTransportSync({ store, taskCoordinator, getBridge: () => bridge })
  const transportCoordinator = new ProjectTransportCoordinator({
    projectStore: store,
    sessionStore,
    transportStore,
    audioGraph: projectAudioGraph,
    instrumentScheduler,
    importedAudioScheduler,
    vocalScheduler,
    convertedVocalScheduler,
    runtimeTransportSync,
    view,
    logger,
    onPlaybackEndedNaturally: () => handleAutoFitNaturalEnd(),
  })

  // === LUFS 自动达标：完整播放一遍后才生效 ===
  // 状态由 projectMixController._autoFitState 持有；这里只编排"何时进 measuring、
  // 何时检测中断、何时 finalize"
  let autoFitInterruptWatcher = null
  function clearAutoFitWatcher() {
    if (autoFitInterruptWatcher != null) {
      clearInterval(autoFitInterruptWatcher)
      autoFitInterruptWatcher = null
    }
  }
  function handleAutoFitNaturalEnd() {
    if (!projectMixController.isAutoFitMeasuring()) return
    clearAutoFitWatcher()
    const result = projectMixController.finalizeAutoFitMeasurement()
    render('master-chain-auto-fit')
    if (!result || !result.ok) {
      view.setStatus(t('hostStatus.autofit_measure_failed'))
      return
    }
    if (result.alreadyOnTarget) {
      view.setStatus(t('hostStatus.autofit_already_target', { delta: result.deltaLu.toFixed(1) }))
      return
    }
    const sign = result.appliedDb >= 0 ? '+' : ''
    let msg = t('hostStatus.autofit_done_base', {
      sign,
      db: result.appliedDb.toFixed(1),
      target: result.chain.loudnessTarget,
    })
    if (result.hitLimit) msg += t('hostStatus.autofit_hit_limit')
    else if (result.largeAdjustment) msg += t('hostStatus.autofit_large')
    else msg += t('hostStatus.autofit_save_hint')
    view.setStatus(msg)
  }
  function cancelAutoFitDueToInterrupt() {
    if (!projectMixController.isAutoFitMeasuring()) return
    projectMixController.cancelAutoFitMeasurement()
    clearAutoFitWatcher()
    render('master-chain-auto-fit-cancelled')
    view.setStatus(t('hostStatus.autofit_canceled'))
  }
  // 中断检测：每 250ms 检查 transport 状态。若 measuring 期间 playing 突然变 false 而
  // 不是自然结束（自然结束会先调 onPlaybackEndedNaturally 把状态切到 idle），就算中断
  function startAutoFitWatcher() {
    clearAutoFitWatcher()
    autoFitInterruptWatcher = setInterval(() => {
      if (!projectMixController.isAutoFitMeasuring()) {
        clearAutoFitWatcher()
        return
      }
      const snap = transportCoordinator.getSnapshot()
      // 自然结束的路径会在 onPlaybackEndedNaturally 里把 _autoFitState 翻成 idle，
      // 所以走到这里仍 measuring 而 playing=false 必然是用户暂停 / 停止 / 拖动
      if (!snap.playing) {
        cancelAutoFitDueToInterrupt()
      }
    }, 250)
  }
  const phraseMissHandler = createPhraseMissHandler({ playbackMode, transportCoordinator, runtimeTransportSync, taskRemoteGateway, view, logger })
  voiceConversionController = new TrackVoiceConversionController({
    store,
    renderOutputGateway: new RenderOutputGateway(),
    seedVcGateway: new SeedVcGateway(),
    assetRegistry: convertedVocalAssetRegistry,
    transportCoordinator,
    refreshProjectPlayback: (reason) => refreshProjectPlaybackWithModeSync(reason),
    render,
    logger,
  })
  const invalidateVoiceConversion = (trackId, reason) => voiceConversionController?.invalidateConversion(trackId, reason)
  const handleTransportSeek = createTransportSeekHandler({ store, getBridge: () => bridge, logger, taskCoordinator, transportCoordinator })
  const handleTransportStep = createTransportStepHandler({ store, transportCoordinator, view, logger })
  const prepWaiters = createWaiterRegistry()
  const trackMonitorController = new TrackMonitorController({
    store,
    sessionStore,
    focusSoloController,
    transportCoordinator,
    persistence: projectAudioMixPersistence,
    refreshProjectPlayback: (reason) => refreshProjectPlaybackWithModeSync(reason),
    render,
    view,
    logger,
  })
  const reverbController = createHostReverbController({
    store,
    sessionStore,
    trackShellSessionController,
    projectMixController,
    trackMonitorController,
    render,
    view,
    // 混音面板与编辑器互斥；打开 dock 前先收回编辑器，注入 clearEditorTrackState 让 reverbController 自己决定时机
    closeEditorPanel: () => clearEditorTrackState(),
  })
  const shortcutRouter = new HostShortcutRouter({
    onTogglePlayback: handlePlay,
    onToggleSolo: () => trackMonitorController.toggleSelectedTrackSolo(),
    onToggleMute: () => trackMonitorController.toggleSelectedTrackMute(),
    // 用 lazy arrow 引用 projectFileHandlers——它在文件中后于 shortcutRouter 声明，
    // 但快捷键真正触发时（init 之后）那个 const 已经赋值好
    onProjectSave: () => projectFileHandlers.onProjectSave(),
    onProjectSaveAs: () => projectFileHandlers.onProjectSaveAs(),
    onProjectOpen: () => projectFileHandlers.onProjectOpen(),
  })
  const predictionGateController = new TrackPredictionGateController({
    store,
    view,
    importService,
    taskCoordinator,
    prepWaiters,
    onPlaybackRequested: () => startProjectPlaybackWithModeSync(),
    onEditorOpened: (trackId) => setEditorTrackState(trackId),
    onEditorCleared: () => clearEditorTrackState(),
    onTrackPreparationInvalidated: (trackId) => {
      vocalManifestController.resetTrackFromSnapshot(trackId)
      invalidateVoiceConversion(trackId, t('hostStatus.voicebank_changed'))
    },
    persistEditorSnapshot,
    render,
  })
  bridge = new VoiceBridgeController(view.refs.voiceRuntimeFrame, createHostBridgeHandlers({
    store,
    view,
    taskCoordinator,
    transportCoordinator,
    playbackMode,
    runtimeTransportSync,
    prepWaiters,
    vocalManifestController,
    getActiveGateTrackId: () => predictionGateController.getActiveTrackId(),
    onResumeBufferedPlayback: () => startProjectPlaybackWithModeSync(),
    onPlaybackShortcut: handlePlay,
    onHostShortcut: ({ intent }) => shortcutRouter.handleIntent(intent),
    onVoiceConversionInvalidated: invalidateVoiceConversion,
    syncLiveProjectMeta: () => view.syncProjectMeta(store.getProject(), sessionStore.getSnapshot()),
    render,
  }))
  predictionGateController.setBridge(bridge)
  sourceAssignmentHandler = createTrackSourceAssignmentHandler({
    store,
    trackShellSessionController,
    transportCoordinator,
    refreshProjectPlayback: (reason) => refreshProjectPlaybackWithModeSync(reason),
    detachEditorFromTrack,
    onVoiceConversionInvalidated: invalidateVoiceConversion,
    render,
    logger,
    view,
  })
  const handleFileSelected = createProjectImportHandler({
    view,
    transportCoordinator,
    projectMixController,
    projectAudioMixPersistence,
    sessionStore,
    vocalManifestController,
    voiceConversionController,
    resetImportedAudioAssets: () => importedAudioAssetRegistry.reset(),
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
  })
  // 工程文件 4 个动作（新建/打开/保存/另存为）+ 后台自动快照
  const projectAutoSave = new ProjectAutoSave({
    store,
    getProjectName: () => projectFileHandlers?.getCurrentProjectName?.() ?? null,
    getAudioAssets: () => importedAudioAssetRegistry.listEntries(),
    isDirty,
    logger,
  })
  const projectFileHandlers = createProjectFileHandlers({
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
    autoSave: projectAutoSave,
    // lazy arrow：resumeVoiceRendersAfterRestore 在文件中后于此处声明
    resumeVoiceRendersAfterRestore: () => resumeVoiceRendersAfterRestore(),
    markPristine,
    logger,
  })
  const voiceConversionViewHandlers = createVoiceConversionViewHandlers({
    store,
    view,
    controller: voiceConversionController,
  })
  const midiInputState = {
    access: null,
    boundInput: null,
    selectedInputId: '',
    recording: false,
    recordClockOwned: false,
    activeNotes: new Map(),
    previewNotes: new Map(),
    previewRequests: new Map(),
    previewRequestSerial: 0,
    captureStartTime: 0,
    captureStartPerf: 0,
  }

  function onTrackContentEdited(trackId, reason = t('hostStatus.track_content_changed')) {
    taskCoordinator.markTrackEdited(trackId)
    vocalManifestController.resetTrackFromSnapshot(trackId)
    invalidateVoiceConversion(trackId, reason)
  }

  function buildPlaybackDiagnosticPayload(extra = null) {
    return {
      editorTrackId: store.getEditorTrack()?.id || null,
      selectedTrackId: store.getSelectedTrack()?.id || null,
      focusSoloTrackId: sessionStore.getSnapshot().focusSoloTrackId || null,
      transport: transportCoordinator.getSnapshot(),
      playbackMode: playbackMode.getSnapshot(),
      ...(extra || {}),
    }
  }

  function canExportMidi(project = store.getProject()) {
    return Boolean((project?.tracks || []).some((track) => !isAudioTrack(track) && (track.previewNotes?.length || 0) > 0))
  }

  async function handleAudioFileSelected(file) {
    if (!file) return false
    view.refs.audioFileInput.value = ''

    try {
      view.setStatus(t('hostStatus.importing_audio'))
      const asset = await importedAudioAssetRegistry.registerFile(file)
      const selectedTrackId = store.getSelectedTrack()?.id || null
      const project = store.ensureProject({
        fileName: store.getProject()?.fileName || getBaseFileName(file.name, 'Audio Project'),
      })
      const track = store.createAudioTrack({
        name: getBaseFileName(file.name, `Audio ${project.tracks.length + 1}`),
        afterTrackId: selectedTrackId,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        duration: asset.duration,
        assetId: asset.assetId,
        waveformPeaks: asset.waveformPeaks,
      })
      importedAudioAssetRegistry.bindTrack(asset.assetId, track.id)
      projectAudioMixPersistence.saveProject(store.getProject())
      render('audio-track-imported')
      if (transportCoordinator.isProjectPlaybackActive()) {
        await refreshProjectPlaybackWithModeSync('audio-track-imported')
      }
      view.setStatus(t('hostStatus.audio_imported', { name: track.name }))
      return true
    } catch (error) {
      logger.error('Audio track import failed', buildAudioImportFailurePayload(file, error))
      view.setStatus(t('hostStatus.audio_import_failed', { detail: getAudioImportFailureMessage(error) }))
      return false
    }
  }

  async function handleExportMidi() {
    await persistEditorSnapshot()
    const project = store.getProject()
    const file = importService.buildProjectMidiFile(project)
    if (!file) {
      view.setStatus(t('hostStatus.no_midi_to_export'))
      return false
    }
    triggerDownload(file)
    view.setStatus(t('hostStatus.midi_exported', { file: file.name }))
    return true
  }

  async function handleUstxFileSelected(file) {
    if (!file) return
    try {
      view.setStatus(t('hostStatus.parsing_ustx'))
      view.hidePlaybackToast('voice-language-reminder')

      const yamlString = await file.text()
      const importedProject = parseUstxToWebUtau(yamlString)
      const incomingTracks = importedProject.tracks || []

      if (incomingTracks.length === 0) {
        view.setStatus(t('hostStatus.ustx_no_tracks'))
        return
      }

      const currentProject = store.getProject()
      const isFirstImport = !(currentProject?.tracks?.length > 0)

      if (isFirstImport) {
        // ── 空白工程：完整导入 ──
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
        trackShellSessionController.closeSourcePicker(null, 'project-import')

        const restoredProject = projectAudioMixPersistence?.restoreProject?.(importedProject) || importedProject
        store.setProject(restoredProject)
        projectAudioMixPersistence?.saveProject?.(store.getProject())
        projectMixController?.syncProjectState?.(store.getProject())
        render('project-imported')
        view.showEditorPlaceholder()
        view.setStatus(t('hostStatus.ustx_imported', { name: importedProject.fileName, count: incomingTracks.length }))
      } else {
        // ── 已有工程：追加模式 ──
        // 将导入轨道的 tick 重对齐到当前工程的曲速/拍号
        const timedProject = importService.applyProjectTiming(importedProject, {
          tempoData: currentProject.tempoData,
          ppq: currentProject.ppq,
        })
        const timedTracks = timedProject?.tracks || []

        if (timedTracks.length === 0) {
          view.setStatus(t('hostStatus.ustx_no_tracks'))
          return
        }

        let lastCreatedTrackId = null
        for (const incomingTrack of timedTracks) {
          const newTrack = store.createTrack({
            name: incomingTrack.name || '',
            languageCode: incomingTrack.languageCode || null,
            afterTrackId: lastCreatedTrackId,
          })
          lastCreatedTrackId = newTrack.id
          store.updateTrack(newTrack.id, {
            singerId: incomingTrack.singerId || null,
            color: incomingTrack.color || null,
            hasLyrics: incomingTrack.hasLyrics ?? true,
            role: incomingTrack.role || 'vocal',
            contentType: incomingTrack.contentType || 'midi',
            playbackState: incomingTrack.playbackState || newTrack.playbackState,
            sourcePhrases: incomingTrack.sourcePhrases,
            _extensions: incomingTrack._extensions,
          })
          // 填充音符（不重建 sourcePhrases，保留 USTX phrase 结构）
          store.replaceTrackPreviewNotes(newTrack.id, incomingTrack.previewNotes, {
            rebuildSourcePhrases: false,
            clearVoiceSnapshot: true,
            clearPendingVoiceEditState: false,
          })
        }

        projectAudioMixPersistence?.saveProject?.(store.getProject())
        projectMixController?.syncProjectState?.(store.getProject())
        render('ustx-appended')
        view.setStatus(t('hostStatus.ustx_appended', { count: timedTracks.length }))
      }
    } catch (error) {
      console.error('USTX 导入失败:', error)
      view.setStatus(t('hostStatus.ustx_import_failed', { message: error?.message || t('hostStatus.unknown_error') }))
    } finally {
      view.refs.ustxFileInput.value = ''
    }
  }

  async function handleExportUstx() {
    await persistEditorSnapshot()
    const project = store.getProject()
    if (!project) {
      view.setStatus(t('hostStatus.no_ustx_to_export'))
      return false
    }
    try {
      // 弹窗选择声乐轨道（按需 export 所需轨道，默认全选）
      const checkedTrackIds = await ustxExportModal.open(project.tracks || [])
      if (!checkedTrackIds || checkedTrackIds.length === 0) {
        return false
      }
      const filteredProject = {
        ...project,
        tracks: (project.tracks || []).filter((t) => checkedTrackIds.includes(t.id)),
      }
      const yamlString = serializeWebUtauToUstx(filteredProject, { projectName: project.fileName })
      const blob = new Blob([yamlString], { type: 'application/x-yaml' })
      const fileName = (project.fileName?.trim() || 'New Project') + '.ustx'
      const file = new File([blob], fileName, { type: 'application/x-yaml' })
      triggerDownload(file)
      view.setStatus(t('hostStatus.ustx_exported', { file: fileName }))
      return true
    } catch (error) {
      if (error === 'cancelled') return false
      console.error('USTX 导出失败:', error)
      view.setStatus(t('hostStatus.ustx_export_failed', { message: error?.message || t('hostStatus.unknown_error') }))
      return false
    }
  }

  const exportAudioModal = new ExportAudioModal()
  const ustxExportModal = new UstxExportModal()
  const offlineAudioExporter = new OfflineAudioExporter({
    projectStore: store,
    sessionStore,
    audioGraph: projectAudioGraph,
    vocalAssetRegistry: vocalAssetRegistry,
    importedAudioAssetRegistry,
    convertedVocalAssetRegistry,
    logger,
  })

  function checkVocalRenderBlocked(project) {
    const tracks = project?.tracks || []
    const vocalTracks = tracks.filter((t) => isVoiceRuntimeSource(t?.playbackState?.assignedSourceId))
    if (vocalTracks.length === 0) return null
    const incomplete = vocalTracks.filter((t) => {
      const rs = t?.renderState?.status
      return rs !== 'completed'
    })
    if (incomplete.length === 0) return null
    const names = incomplete.map((t) => t.name || t.id).join('、')
    return t('hostStatus.vocal_unfinished', { names })
  }

  async function handleExportAudio() {
    await persistEditorSnapshot()
    const project = store.getProject()
    if (!project?.tracks?.length) {
      view.setStatus(t('hostStatus.no_project_to_export'))
      return false
    }

    const selectedTrack = store.getSelectedTrack()
    const blockedReason = checkVocalRenderBlocked(project)
    let settings
    try {
      settings = await exportAudioModal.open({
        blocked: Boolean(blockedReason),
        blockedReason: blockedReason || '',
        selectedTrackName: selectedTrack?.name || '',
      })
    } catch (_error) {
      return false
    }

    const trackIds = settings.mode === 'selected' && selectedTrack
      ? [selectedTrack.id]
      : null
    const label = trackIds
      ? t('hostStatus.exporting_track_label', { name: selectedTrack.name })
      : t('hostStatus.exporting_project_label')
    view.setStatus(t('hostStatus.exporting_audio', { label }))
    try {
      const file = await offlineAudioExporter.exportWav({
        sampleRate: settings.sampleRate,
        bitDepth: settings.bitDepth,
        channels: settings.channels,
        trackIds,
        onProgress: (progress) => exportAudioModal.setProgress(progress),
      })
      triggerDownload(file)
      exportAudioModal.setProgress({ message: t('hostStatus.export_progress_done', { file: file.name }), percent: 100 })
      view.setStatus(t('hostStatus.audio_exported', { file: file.name }))
      setTimeout(() => exportAudioModal.close(), 1500)
      return true
    } catch (error) {
      const message = error?.message || t('hostStatus.audio_export_default_err')
      exportAudioModal.setProgress({ message: t('hostStatus.export_progress_failed', { message }), percent: 0 })
      view.setStatus(t('hostStatus.audio_export_failed', { message }))
      logger.error('Audio export failed', { error: message })
      return false
    }
  }

  function setEditorTrackState(trackId) {
    const track = store.getTrack(trackId)
    if (!track) return null
    const previousEditorTrack = store.getEditorTrack()
    if (previousEditorTrack?.id && previousEditorTrack.id !== track.id) {
      stopPreviewMidiNotes('editor-track-switched')
    }
    // 编辑器与混音面板互斥——同时显示意义不大且会争抢工作区高度，所以打开编辑器时静默收起混音面板
    if (sessionStore.isReverbDockOpen()) {
      sessionStore.setReverbDockOpen(false)
    }
    if (sessionStore.getOpenReverbTrackIds().length > 0) {
      sessionStore.setOpenReverbTrackIds([])
    }
    store.setEditorTrack(track.id)
    playbackMode.setEditorOpen(track.id)
    focusSoloController.enterTrack(track.id)
    logger.info('Editor track state opened', buildPlaybackDiagnosticPayload({ trackId: track.id }))
    return track
  }

  function clearEditorTrackState(trackId = null) {
    const editorTrack = store.getEditorTrack()
    if (trackId && editorTrack?.id !== trackId) {
      logger.info('Editor track state clear skipped', buildPlaybackDiagnosticPayload({
        requestedTrackId: trackId,
        currentEditorTrackId: editorTrack?.id || null,
      }))
      return editorTrack
    }
    stopPreviewMidiNotes('editor-track-cleared')
    store.setEditorTrack(null)
    playbackMode.setEditorClosed()
    logger.info('Editor track state cleared', buildPlaybackDiagnosticPayload({
      previousEditorTrackId: editorTrack?.id || null,
    }))
    return editorTrack
  }

  function getOpenInstrumentEditorTrack(trackId = null) {
    const track = trackId ? store.getTrack(trackId) : store.getEditorTrack()
    const editorState = view.getInstrumentEditorState?.()
    if (!track || !editorState || editorState.trackId !== track.id) return null
    return track
  }

  async function prepareInstrumentMonitor(track) {
    if (!isInstrumentEditorTrack(track)) return null
    const sourceId = getNoteEditorMonitorSourceId(track)
    if (!sourceId) return null
    try {
      await instrumentScheduler.samplerPool.prepareTrackSources([{
        trackId: track.id,
        sourceId,
        volume: track.playbackState?.volume,
        reverbSend: track.playbackState?.reverbSend,
        reverbConfig: track.playbackState?.reverbConfig,
      }])
      return sourceId
    } catch (error) {
      logger.info('Instrument MIDI monitor source prepare failed', {
        trackId: track.id,
        sourceId,
        error: error?.message || String(error),
      })
      return null
    }
  }

  function releasePreviewMidiNote(midi, audioTimeSec = instrumentScheduler.samplerPool.getAudioTime()) {
    const previewNote = midiInputState.previewNotes.get(midi)
    if (!previewNote) return false
    midiInputState.previewNotes.delete(midi)
    return instrumentScheduler.samplerPool.triggerRelease(previewNote.token, audioTimeSec)
  }

  async function previewMidiNoteOn(track, midi, velocity) {
    if (!isInstrumentEditorTrack(track)) return false
    const sourceId = getNoteEditorMonitorSourceId(track)
    if (!sourceId) return false

    const requestId = ++midiInputState.previewRequestSerial
    midiInputState.previewRequests.set(midi, {
      requestId,
      trackId: track.id,
      sourceId,
    })
    releasePreviewMidiNote(midi)

    const preparedSourceId = await prepareInstrumentMonitor(track)
    const pendingRequest = midiInputState.previewRequests.get(midi)
    const currentEditorTrack = store.getEditorTrack()
    const currentSourceId = getNoteEditorMonitorSourceId(currentEditorTrack)
    if (!pendingRequest || pendingRequest.requestId !== requestId) return false
    if (!currentEditorTrack || currentEditorTrack.id !== track.id || currentSourceId !== sourceId) return false
    if (preparedSourceId !== sourceId) return false

    const token = instrumentScheduler.samplerPool.triggerAttack(
      track.id,
      sourceId,
      midi,
      instrumentScheduler.samplerPool.getAudioTime(),
      {
        velocity,
        preview: true,
      },
    )
    if (!token) return false
    midiInputState.previewNotes.set(midi, {
      trackId: track.id,
      sourceId,
      token,
    })
    return true
  }

  function previewMidiNoteOff(midi) {
    midiInputState.previewRequests.delete(midi)
    return releasePreviewMidiNote(midi)
  }

  function stopPreviewMidiNotes(reason = 'preview-stop') {
    midiInputState.previewRequests.clear()
    if (midiInputState.previewNotes.size === 0) return 0

    const audioTimeSec = instrumentScheduler.samplerPool.getAudioTime()
    let releasedCount = 0
    ;[...midiInputState.previewNotes.keys()].forEach((midi) => {
      if (releasePreviewMidiNote(midi, audioTimeSec)) {
        releasedCount += 1
      }
    })
    if (releasedCount > 0) {
      logger.info('Instrument MIDI monitor notes cleared', { reason, releasedCount })
    }
    return releasedCount
  }

  async function persistVoiceEditorSnapshot(trackId = null) {
    const track = trackId ? store.getTrack(trackId) : store.getEditorTrack()
    if (!track) return false
    const snapshot = await bridge.requestSnapshot()
    if (!snapshot) return false
    store.replaceVoiceSnapshot(track.id, snapshot)
    logger.info('Voice editor snapshot persisted', {
      trackId: track.id,
      phraseCount: snapshot.phraseCount ?? null,
      noteCount: snapshot.noteCount ?? null,
    })
    return true
  }

  async function persistPreparedVoiceTrackNoteDraft(track, editorNotes, { silent = false, reason = 'voice-note-draft-save' } = {}) {
    const basePreviewNotes = track?.pendingVoiceEditState?.basePreviewNotes
      || track?.previewNotes
      || track?.voiceSnapshot?.previewNotes
      || []
    const basePhrases = track?.voiceSnapshot?.phrases || track?.sourcePhrases || []
    const basePhraseStates = track?.vocalManifest?.phraseStates
      || track?.voiceSnapshot?.renderManifest?.phraseStates
      || []
    const pendingState = buildPendingVoiceNoteEditState({
      basePreviewNotes,
      nextPreviewNotes: editorNotes || [],
      basePhrases,
      basePhraseStates,
      ppq: store.getProject()?.ppq,
    })

    store.replaceTrackPreviewNotes(track.id, pendingState.previewNotes, {
      rebuildSourcePhrases: false,
      clearVoiceSnapshot: false,
      clearPendingVoiceEditState: false,
    })
    store.updateTrack(track.id, {
      pendingVoiceEditState: pendingState.needsVoiceRerender ? structuredClone(pendingState) : null,
    })
    view.markInstrumentEditorSaved()
    invalidateVoiceConversion(track.id, t('hostStatus.notes_changed'))
    logger.info('Prepared voice track note draft persisted', {
      trackId: track.id,
      editCount: pendingState.edits.length,
      dirtyPhraseCount: pendingState.dirtyPhraseIndices.length,
      reason,
    })

    if (transportCoordinator.isProjectPlaybackActive()) {
      await refreshProjectPlaybackWithModeSync(reason)
    } else {
      render(reason)
    }
    if (!silent) {
      view.setStatus(
        pendingState.needsVoiceRerender
          ? t('hostStatus.voice_changed_pending', { name: track.name })
          : t('hostStatus.saved_track_notes', { name: track.name }),
      )
    }
    return true
  }

  function applyRuntimeNoteEditSnapshot(trackId, snapshot, affectedIndices = []) {
    if (!trackId || !snapshot) return false
    store.replaceVoiceSnapshot(trackId, snapshot)
    store.updateTrack(trackId, {
      pendingVoiceEditState: null,
    })
    vocalManifestController.applyNoteEditSnapshot(trackId, snapshot, affectedIndices)
    invalidateVoiceConversion(trackId, t('hostStatus.voice_notes_changed'))
    render('voice-note-edits-applied')
    return true
  }

  // 工程被持久化（autosave snapshot / .webutau）时，pruneTrack 会把 server-side 的
  // jobRef / vocalManifest / renderState 删掉——这些是当前会话的 server 任务引用，跨
  // 会话失效。但 prepState='ready' + voiceSnapshot.pitchData 是"前端可复算的内容"会
  // 留下来。所以恢复回来的人声轨长这样：pitch 预测过、却没有 server 任务、phrase
  // 音频也没了——HostVocalScheduler 看不到 manifest.phraseStates，整条轨直接静音。
  // 这里在恢复后逐条把它们的渲染任务重新跑起来；runtime 是单例，只能串行，发现用户
  // 已经开了别的任务就停手让用户优先。
  async function resumeVoiceRendersAfterRestore() {
    const candidates = (store.getProject()?.tracks || []).filter((track) => {
      if (!isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) return false
      if (track.prepState?.status !== 'ready') return false
      if (track.jobRef?.jobId) return false
      if (!track.languageCode || !track.singerId) return false
      return Boolean(track.voiceSnapshot?.pitchData?.pitchCurve?.length)
    })
    if (candidates.length === 0) return
    logger.info('恢复工程：自动重启人声渲染', { trackCount: candidates.length })

    for (const candidate of candidates) {
      // 用 intent 区分自家任务和用户接管：getActiveTrack 不区分意图，连我们上一轮
      // 留下的"timeout 还没归零"状态也会被当成阻塞。这里只在出现"非 resume 意图
      // 的 active 任务"时停手。
      const userTask = (store.getProject()?.tracks || []).find((t) => (
        t.jobRef?.status === 'active' && t.jobRef?.intent !== 'resume'
      ))
      if (userTask) {
        logger.info('恢复工程：用户已发起其它任务，停止后续自动恢复', { blockingTrackId: userTask.id })
        return
      }
      const fresh = store.getTrack(candidate.id)
      if (!fresh || fresh.jobRef?.jobId) continue
      try {
        await resumeOneVoiceRender(fresh)
      } catch (error) {
        logger.warn('恢复工程：单条轨道渲染失败', {
          trackId: fresh.id,
          error: error?.message || String(error),
        })
      }
    }
  }

  async function resumeOneVoiceRender(track) {
    // 复用 predictionGateController.run('resume')——它会把 TrackSynthesisOverlay
    // 顶上去盖住 runtime 那边的 PrepareOverlay，并复用 onRenderProgress → 进度条
    // 的现成链路。intent='resume' 跳过语言对话框、不切编辑器、不起播放，仅把渲染
    // 流程跑起来。
    const ok = await predictionGateController.run(track.id, 'resume')
    if (!ok) {
      cleanupHalfResumedTrack(track.id)
      return
    }
    // run() 只 await 到 prediction ready；后续音频渲染走 runtime 的轮询。必须等
    // 这条轨"渲染完成"才能切下一条：runtime resetRuntime() 会把上一条的轮询/下载
    // 链路掐掉，没下完的 phrase 音频就永远进不了 host vocalAssetRegistry。
    const completed = await waitForVoiceRenderCompleted(track.id)
    if (!completed) cleanupHalfResumedTrack(track.id)
  }

  // 把我们半截留下的"queued / active 但永不完工"状态归零，避免 UI 永远显示在排队，
  // 也避免下一轮循环被自家残留误判成"用户任务"。
  function cleanupHalfResumedTrack(trackId) {
    const fresh = store.getTrack(trackId)
    if (!fresh) return
    if (fresh.jobRef?.intent !== 'resume') return
    if (fresh.jobRef?.status !== 'active') return
    taskCoordinator.resetTrackTask(trackId)
    store.updateTrackPrepState(trackId, { status: 'ready', progress: 100, error: null })
    store.updateTrackRenderState(trackId, { status: 'idle', completed: 0, total: 0, error: null })
  }

  function waitForVoiceRenderCompleted(trackId, timeoutMs = 180_000) {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        if (Date.now() - start >= timeoutMs) return resolve(false)
        const fresh = store.getTrack(trackId)
        if (!fresh) return resolve(false)
        // 用户在中途接管（cancelConflictingTask 会把我们的 task 置 idle）就让出
        if (!taskCoordinator.matchesActiveTask(trackId)) return resolve(false)
        const status = fresh.renderState?.status
        if (status === 'completed') return resolve(true)
        if (status === 'failed') return resolve(false)
        setTimeout(tick, 500)
      }
      tick()
    })
  }

  async function persistInstrumentEditorDraft({ trackId = null, silent = false, reason = 'instrument-editor-save' } = {}) {
    const track = getOpenInstrumentEditorTrack(trackId)
    if (!track) return false
    if (midiInputState.recording) {
      await stopInstrumentMidiRecording({
        save: false,
        silent: true,
        reason: `${reason}:flush-recording`,
      })
    }
    const editorState = view.getInstrumentEditorState?.()
    if (!editorState || editorState.trackId !== track.id || !editorState.dirty) return false
    if (isPreparedVoiceTrack(track)) {
      return persistPreparedVoiceTrackNoteDraft(track, editorState.notes || [], { silent, reason })
    }

    store.replaceTrackNotes(track.id, editorState.notes || [])
    onTrackContentEdited(
      track.id,
      isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
        ? t('hostStatus.notes_need_voice_prep')
        : t('hostStatus.instrument_changed'),
    )
    view.markInstrumentEditorSaved()
    logger.info('Instrument editor draft persisted', {
      trackId: track.id,
      noteCount: editorState.notes?.length || 0,
      reason,
    })
    if (transportCoordinator.isProjectPlaybackActive()) {
      await refreshProjectPlaybackWithModeSync(reason)
    } else {
      render(reason)
    }
    if (!silent) {
      view.setStatus(t('hostStatus.instrument_saved', { name: track.name }))
    }
    return true
  }

  function syncPlaybackModeToTransport() {
    if (transportCoordinator.isTransportActive()) playbackMode.onPlayStart()
    else playbackMode.onPlayStop()
    logger.info('Playback mode synced to transport', buildPlaybackDiagnosticPayload())
  }

  async function toggleProjectPlaybackWithModeSync() {
    logger.info('Playback toggle requested', buildPlaybackDiagnosticPayload())
    const result = await transportCoordinator.toggleProjectPlayback()
    syncPlaybackModeToTransport()
    logger.info('Playback toggle completed', buildPlaybackDiagnosticPayload({ result }))
    return result
  }

  async function startProjectPlaybackWithModeSync() {
    if (transportCoordinator.isProjectPlaybackActive()) {
      playbackMode.onPlayStart()
      logger.info('Playback start skipped because transport already active', buildPlaybackDiagnosticPayload())
      return true
    }
    logger.info('Playback start requested', buildPlaybackDiagnosticPayload())
    const result = await transportCoordinator.toggleProjectPlayback()
    syncPlaybackModeToTransport()
    logger.info('Playback start completed', buildPlaybackDiagnosticPayload({ result }))
    return result
  }

  function pauseProjectPlaybackWithModeSync({ preserveBuffering = false } = {}) {
    logger.info('Playback pause requested', buildPlaybackDiagnosticPayload({ preserveBuffering }))
    const snapshot = transportCoordinator.pause()
    if (!preserveBuffering) playbackMode.onPlayStop()
    logger.info('Playback pause completed', buildPlaybackDiagnosticPayload({ preserveBuffering, pausedSnapshot: snapshot }))
    return snapshot
  }

  async function refreshProjectPlaybackWithModeSync(reason) {
    logger.info('Playback refresh requested', buildPlaybackDiagnosticPayload({ reason }))
    const result = await transportCoordinator.refreshProjectPlayback(reason)
    syncPlaybackModeToTransport()
    logger.info('Playback refresh completed', buildPlaybackDiagnosticPayload({ reason, result }))
    return result
  }

  function handlePlayheadFollowModeSelected(mode) {
    const nextMode = sessionStore.setPlayheadFollowMode(mode)
    void bridge?.setPlayheadFollowMode?.(nextMode)
    render('playhead-follow-mode-changed')
  }

  function getMidiInputDevices() {
    if (!midiInputState.access) return []
    return [...midiInputState.access.inputs.values()].map((input) => ({
      id: input.id,
      name: input.name || input.manufacturer || input.id,
    }))
  }

  function updateMidiInputView(enabled = true) {
    view.setMidiInputDevices(getMidiInputDevices(), midiInputState.selectedInputId, enabled)
  }

  function bindMidiInput(deviceId, options = {}) {
    const { silent = false } = options
    if (midiInputState.boundInput) {
      midiInputState.boundInput.onmidimessage = null
      midiInputState.boundInput = null
      stopPreviewMidiNotes('midi-input-rebound')
    }
    midiInputState.selectedInputId = ''
    if (!midiInputState.access || !deviceId) {
      stopPreviewMidiNotes('midi-input-disconnected')
      if (midiInputState.recording) {
        const capturedCount = finalizeActiveMidiNotes()
        midiInputState.recording = false
        if (midiInputState.recordClockOwned && transportCoordinator.isRecordClockActive()) {
          pauseProjectPlaybackWithModeSync()
        }
        midiInputState.recordClockOwned = false
        view.setMidiRecordingActive(false)
        view.setInstrumentEditorRecording(false)
        logger.info('MIDI recording stopped because input disconnected', { capturedCount })
      }
      updateMidiInputView(Boolean(midiInputState.access))
      if (!silent) view.setStatus(t('hostStatus.midi_input_disconnected'))
      return
    }
    const input = midiInputState.access.inputs.get(deviceId)
    if (!input) {
      stopPreviewMidiNotes('midi-input-missing')
      updateMidiInputView(Boolean(midiInputState.access))
      if (!silent) view.setStatus(t('hostStatus.midi_input_not_found'))
      return
    }
    input.onmidimessage = onMidiMessage
    midiInputState.boundInput = input
    midiInputState.selectedInputId = input.id
    updateMidiInputView(true)
    if (!silent) {
      view.setStatus(t('hostStatus.midi_input_connected', { name: input.name || input.id }))
    }
  }

  function refreshMidiDevices(options = {}) {
    const { silent = false } = options
    const devices = getMidiInputDevices()
    const keepCurrent = devices.some((input) => input.id === midiInputState.selectedInputId)
    const nextDeviceId = keepCurrent ? midiInputState.selectedInputId : (devices[0]?.id || '')
    bindMidiInput(nextDeviceId, { silent })
  }

  async function initMidiInput() {
    if (!navigator.requestMIDIAccess) {
      updateMidiInputView(false)
      logger.info('当前环境不支持 Web MIDI')
      return
    }
    try {
      midiInputState.access = await navigator.requestMIDIAccess()
      midiInputState.access.onstatechange = () => refreshMidiDevices({ silent: true })
      refreshMidiDevices({ silent: true })
    } catch (error) {
      updateMidiInputView(false)
      logger.warn('MIDI 设备初始化失败', {
        ...extractErrorDetails(error, t('hostStatus.web_midi_init_failed')),
        note: t('hostStatus.web_midi_note'),
      })
    }
  }

  function getMidiCaptureTime() {
    if (transportCoordinator.isProjectPlaybackActive()) {
      return clampNonNegative(transportCoordinator.getSnapshot().currentTime, 0)
    }
    const elapsed = (performance.now() - midiInputState.captureStartPerf) / 1000
    return midiInputState.captureStartTime + Math.max(0, elapsed)
  }

  function appendRecordedMidiNote(trackId, midi, velocity, startTime, endTime) {
    const track = getOpenInstrumentEditorTrack(trackId)
    const project = store.getProject()
    if (!track || !project) return false
    const note = buildRecordedMidiNote(project, midi, velocity, startTime, endTime)
    if (!note) return false
    const appended = view.appendInstrumentEditorRecordedNote(note)
    if (!appended) return false
    logger.info('Instrument MIDI note captured', {
      trackId,
      midi: note.midi,
      tick: note.tick,
      durationTicks: note.durationTicks,
    })
    return true
  }

  function finalizeActiveMidiNotes() {
    if (midiInputState.activeNotes.size === 0) return 0
    const endTime = getMidiCaptureTime()
    let capturedCount = 0
    ;[...midiInputState.activeNotes.entries()].forEach(([midi, activeNote]) => {
      if (appendRecordedMidiNote(activeNote.trackId, midi, activeNote.velocity, activeNote.startTime, endTime)) {
        capturedCount += 1
      }
    })
    midiInputState.activeNotes.clear()
    return capturedCount
  }

  async function startInstrumentMidiRecording() {
    const editorTrack = store.getEditorTrack()
    if (!isInstrumentEditorTrack(editorTrack)) {
      view.setStatus(t('hostStatus.open_editor_first'))
      return false
    }
    if (!midiInputState.boundInput) {
      view.setStatus(t('hostStatus.connect_midi_first'))
      return false
    }
    if (midiInputState.recording) return true

    midiInputState.recordClockOwned = false
    if (!transportCoordinator.isTransportActive()) {
      transportCoordinator.startRecordClock(transportCoordinator.getSnapshot().currentTime || 0)
      midiInputState.recordClockOwned = true
      syncPlaybackModeToTransport()
    }
    midiInputState.recording = true
    midiInputState.activeNotes.clear()
    midiInputState.captureStartTime = clampNonNegative(transportCoordinator.getSnapshot().currentTime, 0)
    midiInputState.captureStartPerf = performance.now()
    view.setMidiRecordingActive(true)
    view.setInstrumentEditorRecording(true)
    prepareInstrumentMonitor(editorTrack)
    view.setStatus(t('hostStatus.record_started', { name: editorTrack.name }))
    logger.info('Instrument MIDI recording started', {
      trackId: editorTrack.id,
      inputId: midiInputState.selectedInputId || null,
      captureStartTime: midiInputState.captureStartTime,
    })
    return true
  }

  async function stopInstrumentMidiRecording({ save = false, silent = false, reason = 'instrument-midi-stop' } = {}) {
    const editorTrack = store.getEditorTrack()
    if (!midiInputState.recording) {
      if (!save) return false
      return persistInstrumentEditorDraft({
        trackId: editorTrack?.id || null,
        silent,
        reason,
      })
    }
    const capturedCount = finalizeActiveMidiNotes()
    midiInputState.recording = false
    if (midiInputState.recordClockOwned && transportCoordinator.isRecordClockActive()) {
      pauseProjectPlaybackWithModeSync()
    }
    midiInputState.recordClockOwned = false
    stopPreviewMidiNotes(reason)
    view.setMidiRecordingActive(false)
    view.setInstrumentEditorRecording(false)
    logger.info('Instrument MIDI recording stopped', {
      trackId: editorTrack?.id || null,
      capturedCount,
      save,
      reason,
    })
    if (save) {
      return persistInstrumentEditorDraft({
        trackId: editorTrack?.id || null,
        silent,
        reason,
      })
    }
    if (!silent) {
      view.setStatus(capturedCount > 0
        ? t('hostStatus.record_stopped_count', { count: capturedCount })
        : t('hostStatus.record_stopped'))
    }
    return capturedCount > 0
  }

  async function toggleMidiRecording() {
    if (midiInputState.recording) {
      return stopInstrumentMidiRecording({
        save: false,
        silent: false,
        reason: 'toolbar-midi-toggle-stop',
      })
    }
    return startInstrumentMidiRecording()
  }

  function onMidiNoteOn(midi, velocity) {
    const editorTrack = store.getEditorTrack()
    if (!isInstrumentEditorTrack(editorTrack)) return
    previewMidiNoteOn(editorTrack, midi, clampMidiVelocity(velocity))
    if (!midiInputState.recording) return
    const now = getMidiCaptureTime()
    const previous = midiInputState.activeNotes.get(midi)
    if (previous) {
      appendRecordedMidiNote(previous.trackId, midi, previous.velocity, previous.startTime, now)
    }
    midiInputState.activeNotes.set(midi, {
      trackId: editorTrack.id,
      startTime: now,
      velocity,
    })
  }

  function onMidiNoteOff(midi) {
    previewMidiNoteOff(midi)
    if (!midiInputState.recording) return
    const activeNote = midiInputState.activeNotes.get(midi)
    if (!activeNote) return
    midiInputState.activeNotes.delete(midi)
    appendRecordedMidiNote(activeNote.trackId, midi, activeNote.velocity, activeNote.startTime, getMidiCaptureTime())
  }

  function onMidiMessage(event) {
    const [status, data1, data2] = event?.data || []
    if (!Number.isFinite(status) || !Number.isFinite(data1)) return
    const command = status & 0xF0
    if (command === 0x90 && Number(data2) > 0) {
      onMidiNoteOn(data1, data2)
      return
    }
    if (command === 0x80 || (command === 0x90 && Number(data2) === 0)) {
      onMidiNoteOff(data1)
    }
  }

  function removePendingMidiNotesForTrack(trackId) {
    if (!trackId) return
    for (const [midi, activeNote] of midiInputState.activeNotes.entries()) {
      if (activeNote.trackId === trackId) {
        midiInputState.activeNotes.delete(midi)
      }
    }
  }

  function handleEditorUndoShortcut(event) {
    const undo = isUndoShortcut(event)
    const redo = !undo && isRedoShortcut(event)
    if (!undo && !redo) return
    const editorTrack = store.getEditorTrack()
    if (!editorTrack || isAudioTrack(editorTrack)) return
    const editorMode = sessionStore.getEditorMode()

    if (editorMode === 'note') {
      if (undo) {
        if (!view.canUndoInstrumentEditorEdit?.()) return
        event.preventDefault()
        const handled = view.undoInstrumentEditorEdit?.()
        if (!handled) return
        render('instrument-editor-undo')
        view.setStatus(t('hostStatus.undo_done', { name: editorTrack.name }))
        return
      }
      // redo
      if (!view.canRedoInstrumentEditorEdit?.()) return
      event.preventDefault()
      const handled = view.redoInstrumentEditorEdit?.()
      if (!handled) return
      render('instrument-editor-redo')
      view.setStatus(t('hostStatus.redo_done', { name: editorTrack.name }))
      return
    }

    if (!isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) return
    if (!taskCoordinator.isRuntimeAttachedTo(editorTrack.id)) return
    event.preventDefault()
    // voice runtime 暂时只接 undo，redo 等做 voice runtime 端的 redo 栈再说
    if (undo) void bridge?.undoEditor?.()
  }

  function init() {
    bridge.init()
    view.init()
    exportAudioModal.init()
    ustxExportModal.init()
    void bridge.setPlayheadFollowMode(sessionStore.getPlayheadFollowMode())
    transportCoordinator.init()
    shortcutRouter.init()
    // 全局 ESC：关闭最顶层的浮层（modal / 快速填词 / 上下文菜单 / 底部 dock / 钢琴卷帘）
    installGlobalEscape()
    document.addEventListener('keydown', handleEditorUndoShortcut)
    initMidiInput()
    // 后台每 30s 把当前 store snapshot 写进 IndexedDB——浏览器异常关闭时的最后一道保险
    projectAutoSave.start()
    // 文件级快捷键（Cmd+S / Cmd+Shift+S / Cmd+O）走 HostShortcutRouter 现有 intent 管线，
    // host 和 voice-runtime iframe 两边的 keydown 都用 getHostShortcutIntent 统一识别——
    // 自动 preventDefault，不会再被浏览器拿去存 HTML
    // 离开守卫：dirty 或 IndexedDB 还存着自动快照（说明工作内容没被同步到磁盘文件）
    // 时 returnValue 设非空，浏览器自动弹原生确认（"离开此网站？更改可能不会保存"）。
    // 双信号是为了兜底——dirty 计数器万一漏检某次改动，hasPendingSnapshot 仍能拦下。
    window.addEventListener('beforeunload', (event) => {
      if (!isDirty() && !projectAutoSave.hasPendingSnapshot()) return
      event.preventDefault()
      event.returnValue = ''
      return ''
    })
    render('host-init')
    // 初始化铭牌为"未命名工程"——render 已经调过 onAfterRender，这里补一次保平安
    view.setProjectFileState({ name: null, dirty: false })
    view.setStatus(t('status.ready'))
    logger.info('宿主初始化完成')
    // 启动恢复：如果上次会话留下了未保存的自动快照，弹对话框让用户决定是否恢复
    void checkProjectRecoverySnapshot()
  }

  async function checkProjectRecoverySnapshot() {
    const snapshot = await projectAutoSave.loadLastSnapshot()
    if (typeof console !== 'undefined') {
      console.info('[webutau-recovery] checked', {
        hasSnapshot: Boolean(snapshot?.json),
        bytes: snapshot?.json?.length || 0,
        savedAt: snapshot?.savedAt || null,
        projectName: snapshot?.projectName || null,
      })
    }
    if (!snapshot?.json) return
    let trackCount = 0
    try {
      const parsed = JSON.parse(snapshot.json)
      trackCount = parsed?.project?.tracks?.length || 0
    } catch (_error) { /* 解析失败也照样弹，让用户决定 */ }
    if (typeof console !== 'undefined') {
      console.info('[webutau-recovery] parsed', { trackCount })
    }
    if (trackCount === 0) {
      // 空快照（比如自动保存触发时项目没轨道）—— 没必要打扰用户
      await projectAutoSave.clearSnapshot()
      return
    }
    if (typeof console !== 'undefined') {
      console.info('[webutau-recovery] showing recovery modal')
    }
    const choice = await view.promptProjectRecovery({
      projectName: snapshot.projectName,
      savedAt: snapshot.savedAt,
      trackCount,
    })
    if (typeof console !== 'undefined') {
      console.info('[webutau-recovery] user chose', { choice })
    }
    if (choice === 'restore') {
      const ok = await projectFileHandlers.restoreFromSnapshot(snapshot.json)
      if (!ok) {
        await projectAutoSave.clearSnapshot()
      } else {
        // 后台跑，不阻塞 UI；用户立刻动手会让我们 matchesActiveTask 失败、自行让步
        void resumeVoiceRendersAfterRestore()
      }
    } else {
      await projectAutoSave.clearSnapshot()
      view.setStatus(t('hostStatus.backup_discarded'))
    }
  }
  function handleTrackSelected(trackId) {
    if (trackShellSessionController.selectTrack(trackId)) render('track-selected')
  }

  function handleTrackContextCreate(afterTrackId = null) {
    const project = store.getProject()
    const wasBlank = !(project?.tracks?.length > 0)
    const anchorTrack = afterTrackId ? store.getTrack(afterTrackId) : store.getSelectedTrack()
    const createdTrack = store.createTrack({
      afterTrackId,
      languageCode: anchorTrack?.languageCode || null,
    })
    if (!createdTrack) return
    trackShellSessionController.closeSourcePicker(null, 'track-created')
    render('track-created')
    if (wasBlank) {
      view.showEditorPlaceholder()
    }
    view.setStatus(t('hostStatus.track_created', { name: createdTrack.name }))
  }

  async function handleTrackContextDelete(trackId) {
    const track = store.getTrack(trackId)
    if (!track) return
    const editorTrack = store.getEditorTrack()
    const wasEditorTrack = editorTrack?.id === trackId
    if (wasEditorTrack) {
      if (sessionStore.getEditorMode() !== 'note' && isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) {
        await persistVoiceEditorSnapshot(trackId)
      } else {
        await stopInstrumentMidiRecording({
          save: false,
          silent: true,
          reason: 'track-delete',
        })
      }
      clearEditorTrackState(trackId)
    }
    if (taskCoordinator.isRuntimeAttachedTo(trackId)) {
      bridge.resetRuntime()
      taskCoordinator.clearRuntimeTrack(trackId)
      logger.info('Detached runtime because track was deleted', { trackId })
    }
    if (predictionGateController.getActiveTrackId() === trackId) {
      prepWaiters.resolve(trackId, { ok: false, error: '轨道已删除' })
    }
    removePendingMidiNotesForTrack(trackId)
    importedAudioAssetRegistry.releaseTrack(trackId)
    instrumentScheduler.samplerPool.releaseTrack(trackId)
    projectAudioGraph.releaseTrack(trackId)
    focusSoloController.clearCurrentTrack(trackId)
    sessionStore.closeReverbTrack?.(trackId)
    trackShellSessionController.closeSourcePicker(trackId, 'track-deleted')
    const removedTrack = store.removeTrack(trackId)
    if (!removedTrack) return
    render('track-deleted')
    view.setStatus(t('hostStatus.track_removed', { name: removedTrack.name }))
    if (transportCoordinator.isProjectPlaybackActive()) {
      await refreshProjectPlaybackWithModeSync('track-deleted')
    }
  }

  function handleMidiInputSelected(deviceId) {
    bindMidiInput(deviceId, { silent: false })
  }

  function handleTrackSourcePickerToggled(trackId) {
    trackShellSessionController.toggleSourcePicker(trackId)
    render('source-picker-toggled')
  }

  async function handleEditorModeSelected(mode) {
    const track = store.getEditorTrack()
    if (!track || isAudioTrack(track)) return false
    const nextMode = mode === 'pitch' || mode === 'lyric' ? mode : 'note'

    if (nextMode === 'note') {
      if (sessionStore.getEditorMode() !== 'note') {
        await persistEditorSnapshot()
      }
      sessionStore.setEditorMode('note')
      render('editor-mode-note')
      view.setStatus(t('hostStatus.switched_note_mode', { name: track.name }))
      return true
    }

    if (!isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
      view.setStatus(t('hostStatus.not_voice_track'))
      return false
    }

    await persistEditorSnapshot()
    const refreshedTrack = store.getTrack(track.id)
    if (!refreshedTrack) return false

    if (hasPendingVoiceNoteEdits(refreshedTrack) && isPreparedVoiceTrack(refreshedTrack)) {
      view.showTrackSynthesisOverlay(
        refreshedTrack.name,
        '正在同步音符改动...',
        { title: t('predictionGate.rerender_title', { name: refreshedTrack.name }), initialPercent: 12 },
      )
      try {
        await ensureRuntimeAvailableForTrack(refreshedTrack.id)
        view.updateTrackSynthesisOverlay('正在载入人声运行时...', 0.2)
        await loadTrackIntoVoiceEditor(refreshedTrack.id, { editorMode: nextMode })
        view.updateTrackSynthesisOverlay('正在重新合成受影响的语句...', 0.42)
        const result = await bridge.applyNoteEdits(refreshedTrack.pendingVoiceEditState.edits)
        const affectedIndices = Array.isArray(result?.affectedIndices) ? result.affectedIndices : []
        if (result?.snapshot) {
          applyRuntimeNoteEditSnapshot(refreshedTrack.id, result.snapshot, affectedIndices)
        }
        view.updateTrackSynthesisOverlay('音高已更新，正在切换编辑视图...', 0.96)
        await bridge.setEditorMode(nextMode)
        view.setStatus(nextMode === 'pitch'
          ? t('hostStatus.switched_pitch', { name: refreshedTrack.name })
          : t('hostStatus.switched_lyric', { name: refreshedTrack.name }))
        return true
      } catch (error) {
        const details = extractErrorDetails(error, '音符改动提交失败')
        view.setStatus(t('hostStatus.switch_failed', { name: refreshedTrack.name, detail: details.summary }))
        logger.warn('Prepared voice track note edit apply failed', {
          trackId: refreshedTrack.id,
          ...details,
        })
        return false
      } finally {
        view.hideTrackSynthesisOverlay()
      }
    }

    if (predictionGateController.requires(refreshedTrack)) {
      const opened = await predictionGateController.run(refreshedTrack.id, 'open')
      if (opened) {
        sessionStore.setEditorMode(nextMode)
        render(`editor-mode-${nextMode}-after-prediction`)
        await bridge.setEditorMode(nextMode)
      }
      return opened
    }

    await ensureRuntimeAvailableForTrack(refreshedTrack.id)
    await loadTrackIntoVoiceEditor(refreshedTrack.id, { editorMode: nextMode })
    view.setStatus(nextMode === 'pitch'
      ? t('hostStatus.switched_pitch_simple', { name: refreshedTrack.name })
      : t('hostStatus.switched_lyric_simple', { name: refreshedTrack.name }))
    return true
  }

  async function handleRenderTrackAsVoice(trackId = null) {
    const targetTrack = (trackId ? store.getTrack(trackId) : store.getEditorTrack()) || store.getSelectedTrack()
    if (!targetTrack || isAudioTrack(targetTrack)) return false
    if (!isVoiceRuntimeSource(targetTrack.playbackState?.assignedSourceId)) {
      await sourceAssignmentHandler?.(targetTrack.id, 'vocal', {
        suppressVoiceLanguageReminder: true,
      })
    }

    const updatedTrack = store.getTrack(targetTrack.id)
    if (!updatedTrack || isAudioTrack(updatedTrack)) return false

    const opened = await predictionGateController.run(updatedTrack.id, 'open')
    if (!opened) return false

    sessionStore.setEditorMode('lyric')
    render('render-track-as-voice-opened')
    await bridge.setEditorMode('lyric')
    view.notifyRuntimeLayoutChanged()
    view.setStatus(t('hostStatus.voice_set_done', { name: updatedTrack.name }))
    return true
  }

  async function openTrackById(trackId) {
    const track = trackShellSessionController.selectTrack(trackId, { closeReason: 'track-open' })
    if (!track) return
    pauseProjectPlaybackWithModeSync()
    if (isAudioTrack(track)) {
      if (store.getEditorTrack()) {
        await closeEditor()
      }
      render('audio-track-selected')
      view.setStatus(t('hostStatus.audio_track_no_pianoroll', { name: track.name }))
      return
    }
    await loadTrackIntoInstrumentEditor(track.id)
    view.setStatus(t('hostStatus.opened_pianoroll', { name: track.name }))
  }

  async function closeEditor() {
    const track = store.getEditorTrack()
    if (!track) return
    logger.info('Close editor requested', buildPlaybackDiagnosticPayload({ trackId: track.id }))
    const isVoiceEditor = sessionStore.getEditorMode() !== 'note' && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)
    const hasAttachedRuntime = taskCoordinator.isRuntimeAttachedTo(track.id)
    let shouldResetRuntime = false
    if (isVoiceEditor) {
      await persistVoiceEditorSnapshot(track.id)
      shouldResetRuntime = editorSessionController.shouldResetRuntimeOnClose(track.id)
      if (shouldResetRuntime) {
        bridge.resetRuntime()
        taskCoordinator.clearRuntimeTrack(track.id)
      }
    } else {
      await stopInstrumentMidiRecording({
        save: false,
        silent: true,
        reason: 'editor-close',
      })
      await persistInstrumentEditorDraft({
        trackId: track.id,
        silent: true,
        reason: 'instrument-editor-close',
      })
      if (hasAttachedRuntime && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
        await persistVoiceEditorSnapshot(track.id)
        shouldResetRuntime = editorSessionController.shouldResetRuntimeOnClose(track.id)
        if (shouldResetRuntime) {
          bridge.resetRuntime()
          taskCoordinator.clearRuntimeTrack(track.id)
        }
      }
    }
    clearEditorTrackState(track.id)
    sessionStore.setEditorMode('note')
    trackShellSessionController.closeSourcePicker(null, 'close-editor')
    if (focusSoloController.clearOnEditorClose(track.id) && transportCoordinator.isProjectPlaybackActive()) {
      await refreshProjectPlaybackWithModeSync('editor-close-focus-solo')
    }
    logger.info('Editor close runtime detached', {
      trackId: track.id,
      runtimeSessionClosed: shouldResetRuntime,
      manifestRetained: true,
      assetRegistryRetained: true,
    })
    render('editor-closed')
    view.setStatus(isVoiceEditor
      ? editorSessionController.getCloseStatusText(track.id)
      : `已关闭 ${track.name} 的乐器卷帘`)
    logger.info('Close editor completed', buildPlaybackDiagnosticPayload({
      trackId: track.id,
      shouldResetRuntime,
      editorKind: isVoiceEditor ? 'voice' : 'instrument',
    }))
  }

  async function handlePlay() {
    const track = store.getEditorTrack()
    if (track && sessionStore.getEditorMode() === 'note') {
      await persistInstrumentEditorDraft({
        trackId: track.id,
        silent: true,
        reason: 'playback-note-editor-autosave',
      })
    }
    logger.info('Play button pressed', buildPlaybackDiagnosticPayload({
      branch: !track
        ? 'project-preview'
        : (sessionStore.getEditorMode() === 'note' ? 'note-editor' : 'voice-editor'),
      requestedTrackId: track?.id || null,
    }))
    if (!track || sessionStore.getEditorMode() === 'note' || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
      return toggleProjectPlaybackWithModeSync()
    }
    await ensureRuntimeAvailableForTrack(track.id)
    if (predictionGateController.requires(track)) return predictionGateController.run(track.id, 'play')
    return toggleProjectPlaybackWithModeSync()
  }

  async function handleStop() {
    if (midiInputState.recording) {
      await stopInstrumentMidiRecording({
        save: false,
        silent: true,
        reason: 'transport-stop',
      })
    }
    pauseProjectPlaybackWithModeSync()
    await transportCoordinator.seekToTime(0)
    syncPlaybackModeToTransport()

    const editorTrack = store.getEditorTrack()
    if (
      editorTrack
      && isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)
      && taskCoordinator.isRuntimeAttachedTo(editorTrack.id)
    ) {
      await bridge?.seekTo?.(0)
    }

    render('transport-stopped')
    view.setStatus(t('hostStatus.stopped'))
    logger.info('Transport stopped', buildPlaybackDiagnosticPayload())
    return true
  }

  async function handleTrackClipMoved(trackId, deltaTime) {
    const track = store.getTrack(trackId)
    if (!track) return false
    const shift = store.shiftTrackContent(trackId, deltaTime)
    if (!shift?.moved) return false

    if (!isAudioTrack(track)) {
      onTrackContentEdited(trackId, '轨道片段位置已变化，需要重新转换')
    }

    render('track-clip-moved')
    if (transportCoordinator.isProjectPlaybackActive()) {
      await refreshProjectPlaybackWithModeSync('track-clip-moved')
    }

    view.setStatus(t('hostStatus.moved', { name: track.name }))
    logger.info('Track clip moved', {
      trackId,
      deltaTime: shift.deltaTime,
      deltaTick: shift.deltaTick,
    })
    return true
  }

  async function ensureRuntimeAvailableForTrack(trackId) {
    const cancelledTrack = await taskCoordinator.cancelConflictingTask(trackId, `已切换到 ${store.getTrack(trackId)?.name || '新的轨道'} 的任务`)
    if (cancelledTrack && predictionGateController.getActiveTrackId() === cancelledTrack.id) {
      prepWaiters.resolve(cancelledTrack.id, { ok: false, error: '任务已取消' })
    }
  }

  async function loadTrackIntoVoiceEditor(trackId, { editorMode = null } = {}) {
    const track = store.getTrack(trackId)
    if (!track) return
    const alreadyAttached = taskCoordinator.isRuntimeAttachedTo(track.id)
    const preservePendingNoteDraft = hasPendingVoiceNoteEdits(track)
    await persistEditorSnapshot()
    const resolvedMode = editorMode === 'pitch' || editorMode === 'lyric'
      ? editorMode
      : (sessionStore.getEditorMode() === 'pitch' || sessionStore.getEditorMode() === 'lyric'
          ? sessionStore.getEditorMode()
          : 'lyric')
    sessionStore.setEditorMode(resolvedMode)
    setEditorTrackState(track.id)
    if (transportCoordinator.isProjectPlaybackActive()) await refreshProjectPlaybackWithModeSync('editor-open-focus-solo')
    trackShellSessionController.closeSourcePicker(null, 'editor-open')
    render('editor-open-requested')
    await new Promise((resolve) => requestAnimationFrame(resolve))
    view.notifyRuntimeLayoutChanged()
    if (alreadyAttached) {
      await bridge.setPlayheadFollowMode(sessionStore.getPlayheadFollowMode())
      await bridge.setEditorMode(resolvedMode)
      return runtimeTransportSync.syncState(transportCoordinator.getSnapshot())
    }
    const snapshot = importService.buildVoiceSnapshot(track, store.getProject()?.tempoData)
    await bridge.loadTrack(snapshot)
    taskCoordinator.setRuntimeTrack(track.id)
    if (!preservePendingNoteDraft) {
      store.replaceVoiceSnapshot(track.id, snapshot)
    }
    await bridge.setPlayheadFollowMode(sessionStore.getPlayheadFollowMode())
    await bridge.setEditorMode(resolvedMode)
    runtimeTransportSync.syncState(transportCoordinator.getSnapshot())
    render('runtime-track-loaded')
    view.notifyRuntimeLayoutChanged()
  }

  async function loadTrackIntoInstrumentEditor(trackId) {
    const track = store.getTrack(trackId)
    if (!track) return
    await persistEditorSnapshot()
    sessionStore.setEditorMode('note')
    setEditorTrackState(track.id)
    trackShellSessionController.closeSourcePicker(null, 'instrument-editor-open')
    render('instrument-editor-opened')
    await new Promise((resolve) => requestAnimationFrame(resolve))
    view.notifyRuntimeLayoutChanged()
    prepareInstrumentMonitor(track)
    logger.info('Instrument editor opened', buildPlaybackDiagnosticPayload({ trackId: track.id }))
  }

  async function persistEditorSnapshot() {
    const track = store.getEditorTrack()
    if (!track) return
    if (sessionStore.getEditorMode() !== 'note' && isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
      return persistVoiceEditorSnapshot(track.id)
    }
    return persistInstrumentEditorDraft({
      trackId: track.id,
      silent: true,
      reason: 'instrument-editor-autosave',
    })
  }

  async function detachEditorFromTrack(trackId, {
    previousSourceId = null,
    nextSourceId = null,
    reason = 'editor-detach',
  } = {}) {
    if (!store.getTrack(trackId)) return
    if (store.getEditorTrack()?.id !== trackId) return

    const previousWasVoiceRuntime = isVoiceRuntimeSource(previousSourceId)
    if (previousWasVoiceRuntime) {
      await persistVoiceEditorSnapshot(trackId)
      bridge.resetRuntime()
      taskCoordinator.clearRuntimeTrack(trackId)
    } else {
      await stopInstrumentMidiRecording({
        save: false,
        silent: true,
        reason: `${reason}:stop-midi`,
      })
      await persistInstrumentEditorDraft({
        trackId,
        silent: true,
        reason: `${reason}:save-instrument`,
      })
    }

    clearEditorTrackState(trackId)
    focusSoloController.clearCurrentTrack(trackId)
    render('editor-detached-for-source-switch')
    view.setStatus(previousWasVoiceRuntime
      ? '当前轨已切换为非人声声源，人声编辑器已关闭'
      : '当前轨已切换为人声声源，乐器卷帘已关闭')
    logger.info('Editor detached for source switch', {
      trackId,
      previousSourceId,
      nextSourceId,
      reason,
    })
  }
  view.setHandlers({
    onMidiFileSelected: handleFileSelected,
    onAudioFileSelected: handleAudioFileSelected,
    onUstxFileSelected: handleUstxFileSelected,
    onExportUstx: handleExportUstx,
    onProjectNew: projectFileHandlers.onProjectNew,
    onProjectOpen: projectFileHandlers.onProjectOpen,
    onProjectSave: projectFileHandlers.onProjectSave,
    onProjectSaveAs: projectFileHandlers.onProjectSaveAs,
    onExportMidi: handleExportMidi,
    onExportAudio: handleExportAudio,
    canExportMidi,
    getProjectReverbPresets: reverbController.getProjectReverbPresets,
    getProjectReverbPresetTags: reverbController.getProjectReverbPresetTags,
    onToggleReverbDock: reverbController.toggleReverbDock,
    onToggleMixerDock: reverbController.toggleMixerDock,
    onActiveDockTabChanged: reverbController.setActiveDockTab,
    onCloseBottomDock: reverbController.closeBottomDock,
    onToggleProjectReverbEnabled: reverbController.toggleProjectReverbEnabled,
    onProjectReverbPresetSelected: reverbController.handleProjectReverbPresetSelected,
    onProjectReverbConfigChanged: reverbController.handleProjectReverbConfigChanged,
    // ===== 主控母带链 =====
    // 调参时 commit:false 直接写 audioGraph 不发 render（跟单轨 reverb 一致避免拖动重建 UI）；
    // commit:true 一次 render('master-*-changed') 触发 dirty 红点 + autosave + 工程文件保存
    onMasterChainEnabledToggled: () => {
      const current = projectMixController.getMasterChain()
      projectMixController.setMasterChainEnabled(!current.enabled, { commit: true })
      render('master-chain-toggled')
      view.setStatus(current.enabled ? t('hostStatus.master_chain_off') : t('hostStatus.master_chain_on'))
    },
    onMasterEqBandChanged: (bandIndex, patch, options = {}) => {
      projectMixController.setMasterEqBand(bandIndex, patch, options)
      if (options.commit) render('master-eq-changed')
    },
    onMasterCompressorChanged: (patch, options = {}) => {
      projectMixController.setMasterCompressor(patch, options)
      if (options.commit) render('master-compressor-changed')
    },
    onMasterLimiterChanged: (patch, options = {}) => {
      projectMixController.setMasterLimiter(patch, options)
      if (options.commit) render('master-limiter-changed')
    },
    onMasterChainPresetSelected: (presetId) => {
      const result = projectMixController.setMasterChainPreset(presetId, { commit: true })
      if (!result) return
      render('master-chain-preset-applied')
      const preset = projectMixController.getMasterChainPresets().find((p) => p.id === presetId)
      if (preset) view.setStatus(t('hostStatus.preset_applied', { name: preset.name }))
    },
    onMasterChainLoudnessTargetChanged: (target) => {
      projectMixController.setMasterChainLoudnessTarget(target, { commit: true })
      render('master-loudness-target-changed')
      view.setStatus(t('hostStatus.loudness_target', { value: target }))
    },
    onLufsResetRequested: () => {
      projectMixController.resetLufsIntegrated()
      view.setStatus(t('hostStatus.integrated_reset'))
    },
    onLufsAutoFitRequested: async () => {
      // 已经在测了——再点视为"取消重来"，避免按钮卡住
      if (projectMixController.isAutoFitMeasuring()) {
        cancelAutoFitDueToInterrupt()
        return
      }
      const project = store.getProject()
      if (!project) {
        view.setStatus(t('hostStatus.autofit_open_project'))
        return
      }
      // 进 measuring → 重置 LUFS → 拖到 0 → 起播。要等 transport 启动完成再开 watcher，
      // 否则 watcher 第一帧就看到 playing=false（还没 toggle）会立刻误判为中断
      projectMixController.beginAutoFitMeasurement()
      render('master-chain-auto-fit-start')
      view.setStatus(t('hostStatus.autofit_measuring'))
      try {
        await transportCoordinator.seekToTime(0)
        // 此时 playing 仍是 false。toggle 会启动它（如果之前是暂停状态）
        const snap = transportCoordinator.getSnapshot()
        if (!snap.playing) {
          await transportCoordinator.toggleProjectPlayback()
        }
      } catch (error) {
        logger.warn?.('Auto-fit seek/play failed', { error: error?.message || String(error) })
        cancelAutoFitDueToInterrupt()
        return
      }
      // 给 toggle 发起的异步播放准备一点时间，再开启中断监测
      setTimeout(() => {
        if (!projectMixController.isAutoFitMeasuring()) return
        const snap = transportCoordinator.getSnapshot()
        if (!snap.playing) {
          // 准备过程失败 / 用户手太快又点了暂停——直接取消
          cancelAutoFitDueToInterrupt()
          return
        }
        startAutoFitWatcher()
      }, 800)
    },
    isAutoFitMeasuring: () => projectMixController.isAutoFitMeasuring(),
    getLastAutoFitResult: () => projectMixController.getLastAutoFitResult(),
    subscribeLufs: (fn) => projectMixController.subscribeLufs(fn),
    // 单轨 peak meter 读取——mixer dock 的 RAF 循环每帧调
    getTrackPeak: (trackId) => projectAudioGraph.getTrackPeak(trackId),
    getMasterChainPresets: () => projectMixController.getMasterChainPresets(),
    onTrackSelected: handleTrackSelected,
    onTrackContextCreate: handleTrackContextCreate,
    onTrackContextDelete: handleTrackContextDelete,
    canDeleteTrack: (trackId) => Boolean(trackId && store.getTrack(trackId)),
    onTrackOpened: openTrackById,
    onTrackRenameRequested: (trackId, nameEl) => {
      const track = store.getTrack(trackId)
      if (!track || !nameEl) return
      startInlineRenameEdit(nameEl, track.name || '', {
        onCommit: (nextName) => {
          store.updateTrack(trackId, { name: nextName })
          render('track-renamed')
        },
      })
    },
    onTrackColorChanged: (trackId, nextColor) => {
      if (!trackId || typeof nextColor !== 'string') return
      const normalized = nextColor.toLowerCase()
      if (!/^#[0-9a-f]{6}$/.test(normalized)) return
      const track = store.getTrack(trackId)
      if (!track || track.color === normalized) return
      store.updateTrack(trackId, { color: normalized })
      projectAudioMixPersistence.saveProject(store.getProject())
      render('track-color-changed')
    },
    onTrackClipMoved: handleTrackClipMoved,
    onTrackFxToggled: reverbController.toggleTrackFxPanel,
    onTrackSourcePickerToggled: handleTrackSourcePickerToggled,
    onTrackSourceAssigned: async (trackId, sourceId) => {
      await sourceAssignmentHandler?.(trackId, sourceId)
      const updatedTrack = store.getTrack(trackId)
      if (
        updatedTrack
        && store.getEditorTrack()?.id === trackId
        && !isVoiceRuntimeSource(updatedTrack.playbackState?.assignedSourceId)
        && sessionStore.getEditorMode() !== 'note'
      ) {
        sessionStore.setEditorMode('note')
        render('source-assigned-editor-mode-reset')
      }
      if (updatedTrack && !isVoiceRuntimeSource(updatedTrack.playbackState?.assignedSourceId) && taskCoordinator.isRuntimeAttachedTo(trackId)) {
        bridge.resetRuntime()
        taskCoordinator.clearRuntimeTrack(trackId)
      }
    },
    onTrackSoloToggled: (trackId) => trackMonitorController.toggleTrackSolo(trackId),
    onTrackMuteToggled: (trackId) => trackMonitorController.toggleTrackMute(trackId),
    onTrackVolumeChanged: (trackId, volume, options) => trackMonitorController.setTrackVolume(trackId, volume, options),
    onTrackPanChanged: (trackId, pan, options) => trackMonitorController.setTrackPan(trackId, pan, options),
    // Master fader：与 trackVolume 同款 commit:false（实时）/ commit:true（落定 + 存盘）
    onMasterVolumeChanged: (volume, options) => projectMixController.setMasterVolume(volume, options),
    onTrackGuitarToneChanged: (trackId, patch, options) => trackMonitorController.setTrackGuitarTone(trackId, patch, options),
    onVoicebankChanged: async (singerId) => {
      const selectedTrack = store.getSelectedTrack()
      if (!selectedTrack || isAudioTrack(selectedTrack) || !singerId) return
      const singerChanged = selectedTrack.singerId !== singerId
      if (!singerChanged) return
      store.updateTrack(selectedTrack.id, { singerId })
      render('voicebank-changed')
      if (
        store.getEditorTrack()?.id === selectedTrack.id
        && isVoiceRuntimeSource(selectedTrack.playbackState?.assignedSourceId)
        && isTrackPrepReady(selectedTrack)
        && selectedTrack.languageCode
      ) {
        taskCoordinator.resetTrackTask(selectedTrack.id)
        store.updateTrackPrepState(selectedTrack.id, { status: 'queued', progress: 8, error: null })
        store.updateTrackRenderState(selectedTrack.id, { status: 'queued', completed: 0, total: 0, error: null })
        vocalManifestController.resetTrackFromSnapshot(selectedTrack.id)
        invalidateVoiceConversion(selectedTrack.id, '声库已切换，需要重新转换')
        view.setStatus(t('hostStatus.rerendering_voicebank', { name: selectedTrack.name }))
        try {
          await bridge.startSynthesis({ languageCode: selectedTrack.languageCode, singerId })
        } catch (error) {
          view.setStatus(t('hostStatus.rerender_failed', { message: error?.message || t('hostStatus.unknown_error') }))
        }
      }
    },
    onPlayheadFollowModeSelected: handlePlayheadFollowModeSelected,
    onTrackReverbSendChanged: (trackId, sendAmount, options) => trackMonitorController.setTrackReverbSend(trackId, sendAmount, options),
    // 单轨 insert 链 patch（EQ band 调参 / Comp 调参 / 开关单槽）—— UI 拖旋钮调
    onTrackInsertChanged: (trackId, slotKey, patch, options) => trackMonitorController.setTrackInsert(trackId, slotKey, patch, options),
    onTrackReverbConfigChanged: (trackId, config, options) => reverbController.handleTrackReverbConfigChanged(trackId, config, options),
    onTrackReverbPresetSelected: (trackId, presetId) => reverbController.handleTrackReverbPresetSelected(trackId, presetId),
    onToggleTrackReverbEnabled: reverbController.toggleTrackReverbEnabled,
    onEditorModeSelected: handleEditorModeSelected,
    onQuickLyricOpen: async () => {
      if (view.quickLyricPanel.isOpen()) {
        view.closeQuickLyricPanel()
        return
      }
      const editorTrack = store.getEditorTrack()
      if (!editorTrack || isAudioTrack(editorTrack) || !isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) return
      // 通过 openTrackById 打开 MIDI 人声轨道时走的是 loadTrackIntoInstrumentEditor，
      // 它只 setEditorTrackState、不调 bridge.loadTrack——voice runtime 里没装这条
      // track 的 snapshot，requestSnapshot 拿不到东西，面板就开不起来。
      // 这里先确认 runtime 已挂上当前轨；没有就走 'lyric' 模式入口（带 prediction gate +
      // loadTrackIntoVoiceEditor），让用户不必手动点一下"音高/歌词"才能用快速填词
      if (!taskCoordinator.isRuntimeAttachedTo(editorTrack.id)) {
        const ready = await handleEditorModeSelected('lyric')
        if (!ready) return
      }
      try {
        const snapshot = await bridge.requestSnapshot()
        if (!snapshot?.phrases?.length) {
          view.setStatus(t('hostStatus.no_lyric_to_edit'))
          return
        }
        const project = store.getProject()
        const songName = project?.fileName?.replace(/\.[^.]+$/, '') || editorTrack.name
        // 用户上次填的官方歌词——AI 写词的"行结构"权威来源
        const savedOfficialLyrics = Array.isArray(editorTrack.officialLyrics) ? editorTrack.officialLyrics : null
        view.openQuickLyricPanel(snapshot, {
          languageCode: editorTrack.languageCode,
          songName,
          savedOfficialLyrics,
          onOfficialLyricsChanged: (lines) => {
            store.updateTrack(editorTrack.id, { officialLyrics: lines })
            // dirty reason 不在 PRISTINE 白名单，红点会亮、autosave 也会被触发
            render('official-lyrics-changed')
          },
          async onSave(edits) {
            if (!edits?.length) return
            const result = await bridge.applyNoteEdits(edits)
            const affectedIndices = Array.isArray(result?.affectedIndices) ? result.affectedIndices : []
            if (result?.snapshot) {
              applyRuntimeNoteEditSnapshot(editorTrack.id, result.snapshot, affectedIndices)
            }
            view.setStatus(t('hostStatus.lyric_updated', { name: editorTrack.name }))
          },
        })
      } catch (error) {
        view.setStatus(t('hostStatus.lyric_fetch_failed', { message: error?.message || t('hostStatus.unknown_error') }))
      }
    },
    onRenderTrackAsVoice: handleRenderTrackAsVoice,
    onDismissTransientUi: () => trackShellSessionController.closeSourcePicker(null, 'outside-click') && render('source-picker-dismissed'),
    onOpenSelectedTrack: async () => store.getSelectedTrack()?.id && openTrackById(store.getSelectedTrack().id),
    onCloseEditor: closeEditor,
    onPlay: handlePlay,
    onStop: handleStop,
    onMidiRecordToggle: toggleMidiRecording,
    onMidiInputSelected: handleMidiInputSelected,
    onTransportStep: handleTransportStep,
    onTransportSeek: (timelineX) => handleTransportSeek(timelineX),
    onInstrumentEditorPlay: handlePlay,
    onInstrumentEditorTransportStep: handleTransportStep,
    onInstrumentEditorSave: () => persistInstrumentEditorDraft({
      silent: false,
      reason: 'instrument-editor-save-click',
    }),
    onInstrumentEditorRecordStart: startInstrumentMidiRecording,
    onInstrumentEditorRecordStop: () => stopInstrumentMidiRecording({
      save: false,
      silent: false,
      reason: 'instrument-editor-record-stop-click',
    }),
    onInstrumentEditorSeek: (time) => transportCoordinator.seekToTime(time),
    onInstrumentEditorToolChanged: (tool) => logger.info('Instrument editor tool changed', {
      tool,
      trackId: store.getEditorTrack()?.id || null,
    }),
    ...voiceConversionViewHandlers,
  })
  return { init }
}

