import eventBus from '../../core/EventBus.js'
import phraseStore from '../../core/PhraseStore.js'
import playbackEngine from '../../modules/PlaybackEngine.js'
import playheadController from '../../modules/PlayheadController.js'
import renderCache from '../../modules/RenderCache.js'
import midiEncoder from '../../modules/MidiEncoder.js'
import renderJobManager from '../../modules/RenderJobManager.js'
import noteEditManager from '../../modules/NoteEditManager.js'
import transportControl from '../../modules/TransportControl.js'
import pianoRoll from '../../ui/PianoRoll.js'
import trackSelector from '../../ui/TrackSelector.js'
import prepareOverlay from '../../ui/PrepareOverlay.js'
import { DEFAULT_LANGUAGE_CODE } from '../../config/languageOptions.js'
import { EVENTS, PLAYHEAD_STATE } from '../../config/constants.js'
import { HOST_SHORTCUT_INTENTS, getHostShortcutIntent } from '../../shared/hostShortcutIntents.js'
import { createRuntimeEventBindings } from './createRuntimeEventBindings.js'
import phraseRenderStateStore from './phraseRenderStateStore.js'
import { EmbeddedPlaybackMirror } from './embeddedPlaybackMirror.js'
import { buildRuntimeSnapshot, cloneSnapshot } from './runtimeSnapshot.js'
import { resolveSingerId, selectRuntimeSnapshotFromImport } from './runtimeImportWorkflow.js'

function getRuntimeRefs() {
  return {
    btnPlay: document.getElementById('btn-play'),
    btnImport: document.getElementById('btn-import'),
    fileInput: document.getElementById('midi-file-input'),
    statusText: document.getElementById('status-text'),
    pianoRollContainer: document.getElementById('piano-roll-container'),
    playhead: document.getElementById('playhead'),
  }
}

function getEmbeddedMode() {
  const query = new URLSearchParams(window.location.search)
  return query.get('embedded') === '1'
}

function resetRuntimeState() {
  renderJobManager.reset()
  renderCache.clear()
  phraseStore.setJobId(null)
  phraseStore.setTempoData(null)
  phraseStore.setPitchData(null)
  phraseStore.setPhrases([])
  transportControl.resetForNewTrack([])
  playbackEngine.stop()
}

function getPhraseDuration(phrases = []) {
  return phrases.reduce((maxValue, phrase) => Math.max(maxValue, phrase?.endTime || 0), 0)
}

function loadSnapshotIntoRuntime(snapshot) {
  const phrases = cloneSnapshot(snapshot.phrases) || []
  const tempoData = cloneSnapshot(snapshot.tempoData)
  const bpm = snapshot.bpm || tempoData?.tempos?.[0]?.bpm || 120
  const timeSignature = tempoData?.timeSignatures?.[0]?.timeSignature || [4, 4]
  const encodedMidi = snapshot.encodedMidi || midiEncoder.encode(phrases, bpm, timeSignature)

  phraseStore.setBpm(bpm)
  phraseStore.setJobId(snapshot.jobId || null)
  phraseStore.setTempoData(tempoData)
  phraseStore.setMidiFile(encodedMidi)
  phraseStore.setPhrases(phrases)
  phraseStore.setPitchData(cloneSnapshot(snapshot.pitchData))
  transportControl.resetForNewTrack(phrases)
  eventBus.emit(EVENTS.TRACK_SELECTED, {
    phrases,
    trackIndex: snapshot.trackIndex,
    tempoData,
  })
}

export function createVoiceRuntimeApp(callbacks = {}) {
  const refs = getRuntimeRefs()
  const embedded = getEmbeddedMode()
  const state = {
    embedded,
    trackId: null,
    trackIndex: null,
    trackName: '未加载轨道',
    languageCode: DEFAULT_LANGUAGE_CODE,
    tempoData: null,
  }
  let suppressDirtyNotifications = 0
  const playbackMirror = new EmbeddedPlaybackMirror()
  const bindRuntimeEvents = createRuntimeEventBindings({
    callbacks,
    embedded,
    state,
    setStatus,
    buildPlaybackPayload,
    buildSeekPayload,
    emitPlaybackState,
  })

  if (embedded) document.body.classList.add('runtime-embedded')
  pianoRoll.init(refs.pianoRollContainer)
  playheadController.init(refs.playhead)
  trackSelector.init()
  transportControl.init()
  transportControl.setLocalInputEnabled(!embedded)
  prepareOverlay.init()
  phraseRenderStateStore.init()

  function setStatus(text) {
    refs.statusText.textContent = text
  }

  function buildPlaybackPayload(currentTime = playheadController.getPosition()) {
    const playheadState = playheadController.getState()
    return {
      trackId: state.trackId,
      playing: playheadState !== PLAYHEAD_STATE.STOPPED,
      currentTime,
      duration: getPhraseDuration(phraseStore.getPhrases()),
      state: playheadState,
    }
  }

  function buildSeekPayload(currentTime = playheadController.getPosition()) {
    return {
      trackId: state.trackId,
      currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
    }
  }

  function emitPlaybackState(currentTime = playheadController.getPosition()) {
    if (embedded) return
    callbacks.onPlaybackState?.(buildPlaybackPayload(currentTime))
  }

  function notifyDirty() {
    if (suppressDirtyNotifications > 0) return
    if (typeof callbacks.onEditorDirty !== 'function' || state.trackId == null) return
    callbacks.onEditorDirty(buildRuntimeSnapshot(state, phraseStore))
  }

  async function loadTrack(snapshot) {
    resetRuntime()
    state.trackId = snapshot.trackId
    state.trackIndex = snapshot.trackIndex ?? null
    state.trackName = snapshot.trackName || '未命名轨道'
    state.languageCode = snapshot.languageCode || DEFAULT_LANGUAGE_CODE
    state.tempoData = cloneSnapshot(snapshot.tempoData)
    phraseRenderStateStore.hydrateFromManifest(snapshot.renderManifest)
    loadSnapshotIntoRuntime(snapshot)
    console.log('[RuntimeSession] Runtime loadTrack', {
      trackId: state.trackId,
      snapshotJobId: snapshot.jobId || null,
      manifestPhraseCount: snapshot.renderManifest?.phraseStates?.length || 0,
    })
    emitPlaybackState(0)
    setStatus(`已加载 ${state.trackName} | 等待合成`)
  }

  async function startSynthesis(options = {}) {
    const languageCode = options.languageCode || state.languageCode || DEFAULT_LANGUAGE_CODE
    const phrases = cloneSnapshot(phraseStore.getPhrases()) || []
    if (phrases.length === 0) throw new Error('当前没有可合成的音符数据')

    const tempoData = state.tempoData
    const bpm = tempoData?.tempos?.[0]?.bpm || phraseStore.getBpm() || 120
    const timeSignature = tempoData?.timeSignatures?.[0]?.timeSignature || [4, 4]
    const encodedMidi = midiEncoder.encode(phrases, bpm, timeSignature)

    phraseStore.setMidiFile(encodedMidi)
    state.languageCode = languageCode
    setStatus(`已提交 ${state.trackName} 的合成任务`)
    const singerId = await resolveSingerId()
    await renderJobManager.submitMidi(encodedMidi, singerId, languageCode)
  }

  async function applyNoteEdits(edits = []) {
    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        affectedIndices: [],
        snapshot: buildRuntimeSnapshot(state, phraseStore),
      }
    }
    setStatus(`正在提交 ${state.trackName} 的音符改动...`)
    suppressDirtyNotifications += 1
    try {
      const result = await noteEditManager.applyEdits(edits)
      return {
        ...result,
        snapshot: buildRuntimeSnapshot(state, phraseStore),
      }
    } finally {
      suppressDirtyNotifications = Math.max(0, suppressDirtyNotifications - 1)
    }
  }

  async function importMidiFromFile(file) {
    const snapshot = await selectRuntimeSnapshotFromImport(file)
    if (!snapshot) {
      setStatus('未找到可用轨道')
      return
    }
    await loadTrack(snapshot)
    await startSynthesis({ languageCode: snapshot.languageCode })
  }

  function requestSnapshot() {
    return buildRuntimeSnapshot(state, phraseStore)
  }

  function seekTo(time) {
    if (embedded) {
      playbackMirror.seekTo(time)
      return
    }
    eventBus.emit(EVENTS.TRANSPORT_SEEK, {
      time: Number.isFinite(time) ? Math.max(0, time) : 0,
    })
  }

  function togglePlayback() {
    if (embedded) {
      callbacks.onHostShortcut?.({
        intent: HOST_SHORTCUT_INTENTS.TOGGLE_PLAYBACK,
        trackId: state.trackId,
        source: 'runtime-toolbar',
      })
      return
    }
    transportControl.togglePlayback('宿主')
    emitPlaybackState()
  }

  function setEditorMode(mode) {
    pianoRoll.setEditorMode?.(mode)
  }

  function resetRuntime() {
    const previousTrackId = state.trackId
    resetRuntimeState()
    phraseRenderStateStore.clear()
    playbackMirror.reset()
    state.trackId = null
    state.trackIndex = null
    state.trackName = '未加载轨道'
    state.languageCode = DEFAULT_LANGUAGE_CODE
    state.tempoData = null
    console.log('[RuntimeSession] Runtime close', {
      snapshotSaved: Boolean(previousTrackId),
      localCacheCleared: true,
    })
    emitPlaybackState(0)
    setStatus(embedded ? '运行时已就绪，等待宿主加载轨道' : '系统就绪')
  }

  function bindStandaloneImport() {
    if (embedded || !refs.btnImport || !refs.fileInput) return
    refs.btnImport.addEventListener('click', () => refs.fileInput.click())
    refs.fileInput.addEventListener('change', handleFileInputChange)
  }

  async function handleFileInputChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setStatus('正在解析 MIDI...')
      await importMidiFromFile(file)
    } catch (error) {
      console.error('MIDI 导入失败:', error)
      setStatus('MIDI 导入失败')
    } finally {
      refs.fileInput.value = ''
    }
  }

  function bindEmbeddedShortcutForwarding() {
    if (!embedded) return
    document.addEventListener('keydown', handleEmbeddedShortcut)
    refs.btnPlay?.addEventListener('click', () => {
      callbacks.onHostShortcut?.({
        intent: HOST_SHORTCUT_INTENTS.TOGGLE_PLAYBACK,
        trackId: state.trackId,
        source: 'runtime-toolbar',
      })
    })
  }

  function handleEmbeddedShortcut(event) {
    const intent = getHostShortcutIntent(event)
    if (!intent) return
    event.preventDefault()
    callbacks.onHostShortcut?.({
      intent,
      trackId: state.trackId,
      source: 'runtime-keyboard',
    })
  }

  function syncHostPlaybackState(payload = {}) {
    if (!embedded) return
    if (payload.trackId && payload.trackId !== state.trackId) return
    playbackMirror.applyState(payload)
  }

  function syncHostPlaybackTick(payload = {}) {
    if (!embedded) return
    if (payload.trackId && payload.trackId !== state.trackId) return
    playbackMirror.applyTick(payload)
  }

  bindStandaloneImport()
  bindRuntimeEvents(notifyDirty)
  bindEmbeddedShortcutForwarding()
  setStatus(embedded ? '运行时已就绪，等待宿主加载轨道' : '系统就绪')

  return {
    loadTrack,
    requestSnapshot,
    reset: resetRuntime,
    startSynthesis,
    applyNoteEdits,
    seekTo,
    setEditorMode,
    syncHostPlaybackState,
    syncHostPlaybackTick,
    togglePlayback,
  }
}
