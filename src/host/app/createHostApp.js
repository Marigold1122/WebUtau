import { createHostBridgeHandlers } from './createHostBridgeHandlers.js'
import { createHostRender } from './createHostRender.js'
import { createPhraseMissHandler } from './createPhraseMissHandler.js'
import { createProjectImportHandler } from './createProjectImportHandler.js'
import { createRuntimeTransportSync } from './createRuntimeTransportSync.js'
import { createTrackSourceAssignmentHandler } from './createTrackSourceAssignmentHandler.js'
import { createTransportSeekHandler } from './createTransportSeekHandler.js'
import { createTransportStepHandler } from './createTransportStepHandler.js'
import { createVoiceConversionViewHandlers } from './createVoiceConversionViewHandlers.js'
import { createWaiterRegistry } from './createWaiterRegistry.js'
import { createTimelineAxis } from '../../shared/timelineAxis.js'
import { isKeyboardShortcutTargetEditable } from '../../shared/isKeyboardShortcutTargetEditable.js'
import { ImportedAudioAssetRegistry } from '../audio/ImportedAudioAssetRegistry.js'
import { ImportedAudioTrackScheduler } from '../audio/ImportedAudioTrackScheduler.js'
import { InstrumentScheduler } from '../audio/instruments/InstrumentScheduler.js'
import { SamplerPool } from '../audio/instruments/SamplerPool.js'
import { getHostPlaybackSourceId } from '../audio/instruments/sourceCatalog.js'
import { EditorSessionController } from '../controllers/EditorSessionController.js'
import { FocusSoloController } from '../controllers/FocusSoloController.js'
import { TrackPredictionGateController } from '../controllers/TrackPredictionGateController.js'
import { TrackShellSessionController } from '../controllers/TrackShellSessionController.js'
import { TrackVoiceConversionController } from '../controllers/TrackVoiceConversionController.js'
import { VocalManifestController } from '../controllers/VocalManifestController.js'
import { VoiceBridgeController } from '../controllers/VoiceBridgeController.js'
import { createHostLogger } from '../logging/createHostLogger.js'
import { TrackMonitorController } from '../monitor/TrackMonitorController.js'
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
import { ConvertedVocalAssetRegistry } from '../vocal/ConvertedVocalAssetRegistry.js'
import { ConvertedVocalScheduler } from '../vocal/ConvertedVocalScheduler.js'
import { HostVocalAssetRegistry } from '../vocal/HostVocalAssetRegistry.js'
import { HostVocalScheduler } from '../vocal/HostVocalScheduler.js'

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

function extractErrorDetails(error, fallback = '未知错误') {
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
  const details = extractErrorDetails(error, '音频轨导入失败')
  return {
    fileName: typeof file?.name === 'string' && file.name ? file.name : null,
    fileType: typeof file?.type === 'string' && file.type ? file.type : null,
    fileSize: Number.isFinite(file?.size) ? file.size : null,
    ...details,
  }
}

function getAudioImportFailureMessage(error) {
  const details = extractErrorDetails(error, '音频轨导入失败')
  const fingerprint = `${details.name} ${details.message} ${details.cause || ''}`.toLowerCase()
  if (fingerprint.includes('无法解码音频文件') || fingerprint.includes('encodingerror') || fingerprint.includes('decode')) {
    return '浏览器无法解码这个音频文件，请优先换成 WAV 或常规 MP3'
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
  const editorSessionController = new EditorSessionController(taskCoordinator)
  const focusSoloController = new FocusSoloController(sessionStore, logger)
  const trackShellSessionController = new TrackShellSessionController(store, sessionStore, logger)
  const view = new ShellLayoutView({}, { logger })
  const render = createHostRender({
    logger,
    store,
    sessionStore,
    view,
    getVoiceConversionState: (trackId) => voiceConversionController?.buildInspectorState(trackId) || { visible: false },
  })
  const instrumentScheduler = new InstrumentScheduler(new SamplerPool())
  const importedAudioAssetRegistry = new ImportedAudioAssetRegistry({ logger })
  const importedAudioScheduler = new ImportedAudioTrackScheduler(importedAudioAssetRegistry, { logger })
  const vocalAssetRegistry = new HostVocalAssetRegistry({ logger })
  const convertedVocalAssetRegistry = new ConvertedVocalAssetRegistry({ logger })
  const convertedVocalScheduler = new ConvertedVocalScheduler(convertedVocalAssetRegistry, { logger })
  const vocalManifestController = new VocalManifestController({ store, assetRegistry: vocalAssetRegistry, logger })
  const vocalScheduler = new HostVocalScheduler(vocalAssetRegistry, {
    logger,
    onPhraseMiss: (entry) => phraseMissHandler(entry),
  })
  const runtimeTransportSync = createRuntimeTransportSync({ store, taskCoordinator, getBridge: () => bridge })
  const transportCoordinator = new ProjectTransportCoordinator({
    projectStore: store,
    sessionStore,
    transportStore,
    instrumentScheduler,
    importedAudioScheduler,
    vocalScheduler,
    convertedVocalScheduler,
    runtimeTransportSync,
    view,
    logger,
  })
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
    refreshProjectPlayback: (reason) => refreshProjectPlaybackWithModeSync(reason),
    render,
    view,
    logger,
  })
  const shortcutRouter = new HostShortcutRouter({
    onTogglePlayback: handlePlay,
    onToggleSolo: () => trackMonitorController.toggleSelectedTrackSolo(),
    onToggleMute: () => trackMonitorController.toggleSelectedTrackMute(),
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
      invalidateVoiceConversion(trackId, '轨道语言或准备状态已变化，需要重新转换')
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

  function onTrackContentEdited(trackId, reason = '轨道内容已变更，需要重新转换') {
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
      view.setStatus('正在导入音频轨...')
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
      render('audio-track-imported')
      if (transportCoordinator.isProjectPlaybackActive()) {
        await refreshProjectPlaybackWithModeSync('audio-track-imported')
      }
      view.setStatus(`已导入音频轨 ${track.name}`)
      return true
    } catch (error) {
      logger.error('Audio track import failed', buildAudioImportFailurePayload(file, error))
      view.setStatus(`音频轨导入失败：${getAudioImportFailureMessage(error)}`)
      return false
    }
  }

  async function handleExportMidi() {
    await persistEditorSnapshot()
    const project = store.getProject()
    const file = importService.buildProjectMidiFile(project)
    if (!file) {
      view.setStatus('当前项目没有可导出的 MIDI 音符轨')
      return false
    }
    triggerDownload(file)
    view.setStatus(`已导出 MIDI：${file.name}`)
    return true
  }

  function setEditorTrackState(trackId) {
    const track = store.getTrack(trackId)
    if (!track) return null
    const previousEditorTrack = store.getEditorTrack()
    if (previousEditorTrack?.id && previousEditorTrack.id !== track.id) {
      stopPreviewMidiNotes('editor-track-switched')
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
      await instrumentScheduler.samplerPool.prepareSources([sourceId])
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
      sourceId,
      midi,
      instrumentScheduler.samplerPool.getAudioTime(),
      {
        velocity,
        preview: true,
        trackVolume: track.playbackState?.volume,
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
    invalidateVoiceConversion(track.id, '音符已改动，现有转换结果需要重新生成')
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
          ? `${track.name} 的音符已修改，受影响片段先按钢琴预览；切到歌词或音高以重新生成人声`
          : `已保存 ${track.name} 的音符调整`,
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
    invalidateVoiceConversion(trackId, '人声音符已更新，需要重新转换')
    render('voice-note-edits-applied')
    return true
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
        ? '音符已更新，需要重新进行人声准备'
        : '乐器卷帘已更新，需要重新转换',
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
      view.setStatus(`已保存 ${track.name} 的乐器卷帘`)
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
      if (!silent) view.setStatus('MIDI 输入已断开')
      return
    }
    const input = midiInputState.access.inputs.get(deviceId)
    if (!input) {
      stopPreviewMidiNotes('midi-input-missing')
      updateMidiInputView(Boolean(midiInputState.access))
      if (!silent) view.setStatus('未找到指定的 MIDI 输入设备')
      return
    }
    input.onmidimessage = onMidiMessage
    midiInputState.boundInput = input
    midiInputState.selectedInputId = input.id
    updateMidiInputView(true)
    if (!silent) {
      view.setStatus(`已连接 MIDI 设备：${input.name || input.id}`)
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
        ...extractErrorDetails(error, 'Web MIDI 初始化失败'),
        note: '通常是浏览器拒绝了 Web MIDI 权限，或者当前没有可访问的 MIDI 设备',
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
      view.setStatus('请先打开一个可编辑音符的卷帘')
      return false
    }
    if (!midiInputState.boundInput) {
      view.setStatus('请先连接 MIDI 输入设备')
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
    view.setStatus(`已开始录制 ${editorTrack.name} 的 MIDI`)
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
      view.setStatus(capturedCount > 0 ? `已停止录制，捕获 ${capturedCount} 个音符` : 'MIDI 录制已停止')
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
    if (!isUndoShortcut(event)) return
    const editorTrack = store.getEditorTrack()
    if (!editorTrack || isAudioTrack(editorTrack)) return
    const editorMode = sessionStore.getEditorMode()

    if (editorMode === 'note') {
      if (!view.canUndoInstrumentEditorEdit?.()) return
      event.preventDefault()
      const handled = view.undoInstrumentEditorEdit?.()
      if (!handled) return
      render('instrument-editor-undo')
      view.setStatus(`已撤回 ${editorTrack.name} 的音符编辑`)
      return
    }

    if (!isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) return
    if (!taskCoordinator.isRuntimeAttachedTo(editorTrack.id)) return
    event.preventDefault()
    void bridge?.undoEditor?.()
  }

  function init() {
    bridge.init()
    view.init()
    void bridge.setPlayheadFollowMode(sessionStore.getPlayheadFollowMode())
    transportCoordinator.init()
    shortcutRouter.init()
    document.addEventListener('keydown', handleEditorUndoShortcut)
    initMidiInput()
    render('host-init')
    view.setStatus('系统就绪')
    logger.info('宿主初始化完成')
  }
  function handleTrackSelected(trackId) {
    if (trackShellSessionController.selectTrack(trackId)) render('track-selected')
  }

  function handleTrackContextCreate(afterTrackId = null) {
    const anchorTrack = afterTrackId ? store.getTrack(afterTrackId) : store.getSelectedTrack()
    const createdTrack = store.createTrack({
      afterTrackId,
      languageCode: anchorTrack?.languageCode || null,
    })
    if (!createdTrack) return
    trackShellSessionController.closeSourcePicker(null, 'track-created')
    render('track-created')
    view.setStatus(`已新建轨道 ${createdTrack.name}`)
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
    focusSoloController.clearCurrentTrack(trackId)
    trackShellSessionController.closeSourcePicker(trackId, 'track-deleted')
    const removedTrack = store.removeTrack(trackId)
    if (!removedTrack) return
    render('track-deleted')
    view.setStatus(`已删除轨道 ${removedTrack.name}`)
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
      view.setStatus(`已切到 ${track.name} 的音符模式`)
      return true
    }

    if (!isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) {
      view.setStatus('该轨道尚未设为人声，无法进入歌词或音高模式')
      return false
    }

    await persistEditorSnapshot()
    const refreshedTrack = store.getTrack(track.id)
    if (!refreshedTrack) return false

    if (hasPendingVoiceNoteEdits(refreshedTrack) && isPreparedVoiceTrack(refreshedTrack)) {
      view.showTrackSynthesisOverlay(
        refreshedTrack.name,
        '正在同步音符改动...',
        { title: `${refreshedTrack.name} 正在重新预测音高`, initialPercent: 12 },
      )
      try {
        await ensureRuntimeAvailableForTrack(refreshedTrack.id)
        view.updateTrackSynthesisOverlay('正在载入人声运行时...', 0.2)
        await loadTrackIntoVoiceEditor(refreshedTrack.id, { editorMode: nextMode })
        view.updateTrackSynthesisOverlay('正在重新预测受影响语句的音高...', 0.42)
        const result = await bridge.applyNoteEdits(refreshedTrack.pendingVoiceEditState.edits)
        const affectedIndices = Array.isArray(result?.affectedIndices) ? result.affectedIndices : []
        if (result?.snapshot) {
          applyRuntimeNoteEditSnapshot(refreshedTrack.id, result.snapshot, affectedIndices)
        }
        view.updateTrackSynthesisOverlay('音高已更新，正在切换编辑视图...', 0.96)
        await bridge.setEditorMode(nextMode)
        view.setStatus(`已切到 ${refreshedTrack.name} 的${nextMode === 'pitch' ? '音高' : '歌词'}模式，受影响语句音频继续后台重渲`)
        return true
      } catch (error) {
        const details = extractErrorDetails(error, '音符改动提交失败')
        view.setStatus(`切换失败: ${refreshedTrack.name} | ${details.summary}`)
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
    view.setStatus(`已切到 ${refreshedTrack.name} 的${nextMode === 'pitch' ? '音高' : '歌词'}模式`)
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
    view.setStatus(`已将 ${updatedTrack.name} 设为人声并打开歌词模式`)
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
      view.setStatus(`${track.name} 是音频轨，当前不支持卷帘编辑`)
      return
    }
    await loadTrackIntoInstrumentEditor(track.id)
    view.setStatus(`已打开 ${track.name} 的通用卷帘`)
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
    view.setStatus('已停止')
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

    view.setStatus(`已移动 ${track.name}`)
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
    onExportMidi: handleExportMidi,
    canExportMidi,
    onTrackSelected: handleTrackSelected,
    onTrackContextCreate: handleTrackContextCreate,
    onTrackContextDelete: handleTrackContextDelete,
    canDeleteTrack: (trackId) => Boolean(trackId && store.getTrack(trackId)),
    onTrackOpened: openTrackById,
    onTrackClipMoved: handleTrackClipMoved,
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
        view.setStatus(`正在使用新声库重新合成 ${selectedTrack.name}...`)
        try {
          await bridge.startSynthesis({ languageCode: selectedTrack.languageCode, singerId })
        } catch (error) {
          view.setStatus(`重新合成失败: ${error?.message || '未知错误'}`)
        }
      }
    },
    onPlayheadFollowModeSelected: handlePlayheadFollowModeSelected,
    onEditorModeSelected: handleEditorModeSelected,
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
