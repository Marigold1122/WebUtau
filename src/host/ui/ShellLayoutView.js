import { fetchVoicebanks } from '../../api/VoicebankApi.js'
import { getLanguageLabel } from '../../config/languageOptions.js'
import { PLAYHEAD_FOLLOW_MODE_LABELS, PLAYHEAD_FOLLOW_MODES, normalizePlayheadFollowMode } from '../../shared/playheadFollowMode.js'
import { AboutPanelView } from './AboutPanelView.js'
import { InspectorVoiceConversionSection } from './InspectorVoiceConversionSection.js'
import { MenubarTransportView } from './MenubarTransportView.js'
import { PlaybackToastView } from './PlaybackToastView.js'
import { ReverbDockView } from './ReverbDockView.js'
import { TrackTonePanelView } from './TrackTonePanelView.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { getTrackSourceInspectorText } from '../project/trackSourceAssignment.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { InstrumentEditorView } from './InstrumentEditorView.js'
import { ProjectTimingImportModal } from './ProjectTimingImportModal.js'
import { QuickLyricPanel } from './QuickLyricPanel.js'
import { TrackLanguageModal } from './TrackLanguageModal.js'
import { TrackTimelinePlayheadView } from './TrackTimelinePlayheadView.js'
import { TrackSynthesisOverlay } from './TrackSynthesisOverlay.js'
import { TrackViewportController } from './TrackViewportController.js'
import { createShellLayoutRefs } from './createShellLayoutRefs.js'
import { getTrackTimelineMetrics } from './trackTimelineMetrics.js'
import {
  createRulerMetaMarker,
  buildTrackShellRowView,
  buildTrackPreviewGridOverlay,
  createRulerLine,
  createRulerMark,
  TRACK_ROW_HEIGHT,
} from './tracks/buildTrackShellViews.js'
import { getTrackColorById } from './tracks/trackColorPalette.js'
import {
  getTrackInspectorStatusText,
  getTrackRenderClass,
  getTrackStatusText,
  normalizeShellStatusText,
} from './trackStatusText.js'
import { WorkspaceSplitController } from './WorkspaceSplitController.js'
import sharePanel from '../../ui/SharePanel.js'

const TRACK_HEADER_FALLBACK_WIDTH = 240

const DEMO_MIDI_FILES = [
  { label: 'God Knows', file: '[凉宫]God knows.mid' },
  { label: '海阔天空', file: '海阔天空.mid' },
]
export class ShellLayoutView {
  constructor(handlers = {}, options = {}) {
    this.handlers = handlers
    this.logger = options.logger || null
    this.refs = createShellLayoutRefs()
    this.trackLanguageModal = new TrackLanguageModal()
    this.projectTimingImportModal = new ProjectTimingImportModal()
    this.menubarTransportView = new MenubarTransportView(this.refs, {
      onPlay: () => this.handlers.onPlay?.(),
      onStop: () => this.handlers.onStop?.(),
      onRecord: () => this.handlers.onMidiRecordToggle?.(),
      onStep: (direction) => this.handlers.onTransportStep?.(direction),
    }, {
      logger: this.logger,
    })
    this.playbackToastView = new PlaybackToastView()
    this.timelinePlayheadView = new TrackTimelinePlayheadView({
      logger: this.logger,
      getViewportElement: () => this.refs.trackViewport,
      onSeekRequested: (timelineX) => this.handlers.onTransportSeek?.(timelineX),
    })
    this.timelinePlayheadTime = 0
    this.lastPlayheadTraceAtMs = 0
    this.trackSynthesisOverlay = new TrackSynthesisOverlay()
    this.voiceConversionSection = new InspectorVoiceConversionSection(this.refs.voiceConversionSection, handlers)
    this.trackViewportController = new TrackViewportController(this.refs, handlers)
    this.instrumentEditorView = new InstrumentEditorView(this.refs.instrumentEditorRoot, handlers)
    this.reverbDockView = new ReverbDockView(this.refs, handlers)
    this.trackTonePanelView = new TrackTonePanelView(this.refs, handlers)
    this.aboutPanelView = new AboutPanelView({ logger: this.logger })
    this.workspaceSplitController = new WorkspaceSplitController(this.refs)
    this.reverbDockVisible = false
    this.editorPlaceholderActive = false
    this._editorPlaceholderEl = null
    this.fileMenu = this._createFileMenu()
    this.trackContextMenu = this._createTrackContextMenu()
    this.trackContextTrackId = null
    this.playbackActive = false
    this._selectedTrackId = null
    this.playheadFollowMode = normalizePlayheadFollowMode(null)
    this.followModeControls = null
    this.followModeButtons = new Map()
    this.editorModeControls = null
    this.btnEditorNoteMode = null
    this.btnEditorLyricMode = null
    this.btnEditorPitchMode = null
    this.btnQuickLyric = null
    this.quickLyricPanel = new QuickLyricPanel()
    this.btnRenderTrackAsVoice = null
    this._handleDocumentPointerDown = (event) => {
      if (event.target?.closest?.('.file-menu')) return
      if (event.target?.closest?.('#btn-import')) return
      if (event.target?.closest?.('.track-source-picker')) return
      if (event.target?.closest?.('.track-context-menu')) return
      this._hideFileMenu()
      this._hideTrackContextMenu()
      this.handlers.onDismissTransientUi?.()
    }
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
    this.voiceConversionSection.setHandlers(handlers)
    this.trackViewportController.setHandlers(handlers)
    this.instrumentEditorView.setHandlers(handlers)
    this.reverbDockView.setHandlers(handlers)
    this.trackTonePanelView.setHandlers(handlers)
  }

  init() {
    this.trackLanguageModal.init()
    this.projectTimingImportModal.init()
    this.menubarTransportView.init()
    this.playbackToastView.init()
    this.voiceConversionSection.init()
    this.instrumentEditorView.init()
    this.reverbDockView.init()
    this.trackTonePanelView.init()
    this.aboutPanelView.init()
    this._bindEvents()
    this.trackViewportController.init()
    this._updateInspectorToggleButton(false)
    this.setTransportTime('00:00.000')
    this.setTimelinePlayheadTime(0)
    this.setPlaybackActive(false)
    this.setMidiInputDevices([], '', false)
    this.setMidiRecordingActive(false)
    this.setMidiRecordingEnabled(false)
    this.refs.statusBar?.classList.add('is-empty')
    this._loadInspectorVoicebanks()
    sharePanel.init(document.getElementById('share-tunnel-section'))
    this.workspaceSplitController.init()
    if (!this.fileMenu.isConnected) {
      document.body.appendChild(this.fileMenu)
    }
    if (!this.trackContextMenu.isConnected) {
      document.body.appendChild(this.trackContextMenu)
    }
    document.addEventListener('pointerdown', this._handleDocumentPointerDown)
    if (this.refs.voiceRuntimeFrame) {
      this.refs.voiceRuntimeFrame.src = '/voice-runtime.html?embedded=1'
    }
    this._mountMenubarFollowControls()
    this._mountEditorModeControls()
  }

  render(project, viewState = {}) {
    this._syncFileMenuState(project)
    this._hideFileMenu()
    this._hideTrackContextMenu()
    const { tracks, selectedTrack, editorTrack, renderBadgeTrack } = this._resolveProjectViewTracks(project)
    const timelineMetrics = getTrackTimelineMetrics(project)
    const timelineViewMetrics = tracks.length > 0 ? timelineMetrics : { ...timelineMetrics, axis: null }

    this._renderProjectMeta(project, selectedTrack, editorTrack, renderBadgeTrack, viewState)
    const vcState = viewState?.voiceConversion || { visible: false }
    this.voiceConversionSection.render(vcState)
    // 外层 <details> 与内部 section 的可见性同步，避免"标题在、内容空"的残影
    if (this.refs.inspectorSectionVc) {
      this.refs.inspectorSectionVc.hidden = !vcState.visible
    }
    const toneSupported = this.trackTonePanelView.render({
      project,
      selectedTrack,
      viewState,
    })
    // "乐器音色"父级 section 仅在当前轨道支持某种乐器音色时显示
    if (this.refs.inspectorSectionTone) {
      this.refs.inspectorSectionTone.hidden = !toneSupported
    }
    this._renderTracks(tracks, selectedTrack?.id, editorTrack?.id, timelineViewMetrics, viewState)
    this._renderRuler(timelineViewMetrics, project?.tempoData || null)
    this.trackViewportController.syncRulerOffset()
    this._syncTimelinePlayhead(timelineViewMetrics)
    this._setEditorVisible(Boolean(editorTrack))
    this._renderEditorModeControls(editorTrack, viewState)
    this._syncEditorSurface(project, editorTrack, viewState)
    const reverbDockVisible = this.reverbDockView.render({
      project,
      tracks,
      viewState,
    })
    if (this.reverbDockVisible !== reverbDockVisible) {
      this.reverbDockVisible = reverbDockVisible
      this.notifyRuntimeLayoutChanged()
    }
    this.setMidiRecordingEnabled(Boolean(editorTrack) && !isAudioTrack(editorTrack) && viewState?.editorMode === 'note')
  }

  syncProjectMeta(project, viewState = {}) {
    const { selectedTrack, editorTrack, renderBadgeTrack } = this._resolveProjectViewTracks(project)
    this._renderProjectMeta(project, selectedTrack, editorTrack, renderBadgeTrack, viewState)
  }

  setStatus(text) {
    const nextText = normalizeShellStatusText(text)
    this.refs.statusText.textContent = nextText
    this.refs.statusBar?.classList.toggle('is-empty', nextText.length === 0)
  }

  // 把"当前工程名 + 是否未保存"同步到菜单栏铭牌 + 浏览器 tab 标题。
  // 这是用户随时能看到的"工程文件状态总指示"——铭牌上红点 + 标签页 ● 都跟它走
  setProjectFileState({ name = null, dirty = false } = {}) {
    const plate = this.refs.menubarProjectPlate
    const nameEl = this.refs.menubarProjectPlateName
    if (!plate || !nameEl) return
    const displayName = (typeof name === 'string' && name.trim()) ? name.trim() : '未命名工程'
    nameEl.textContent = displayName
    plate.classList.toggle('is-untitled', !(typeof name === 'string' && name.trim()))
    plate.classList.toggle('is-dirty', Boolean(dirty))
    plate.title = dirty ? `${displayName} · 有未保存的改动（点击保存）` : `${displayName}（点击保存）`
    // tab 标题：dirty 时前缀加 ● 让用户在多标签场景下也能一眼看到状态
    const titleParts = []
    if (dirty) titleParts.push('●')
    titleParts.push(displayName)
    titleParts.push('WebUtau')
    document.title = titleParts.join(' · ')
  }

  promptProjectRecovery({ projectName = null, savedAt = null, trackCount = 0 } = {}) {
    const overlay = this.refs.projectRecoveryModal
    const summary = this.refs.projectRecoverySummary
    const restoreBtn = this.refs.btnProjectRecoveryRestore
    const discardBtn = this.refs.btnProjectRecoveryDiscard
    if (!overlay || !restoreBtn || !discardBtn) return Promise.resolve('discard')

    if (summary) {
      const lines = []
      lines.push(`工程名：${projectName || '未命名工程'}`)
      lines.push(`轨道数：${trackCount}`)
      if (savedAt) {
        const date = typeof savedAt === 'number' ? new Date(savedAt) : new Date(savedAt)
        if (!Number.isNaN(date.getTime())) {
          lines.push(`备份时间：${date.toLocaleString()}`)
        }
      }
      summary.textContent = lines.join('\n')
      summary.style.whiteSpace = 'pre-line'
    }

    // 注意：modal-overlay 的真实显示触发是 `.is-open`（host-dialog.css 里定义），
    // 不是 `.visible`——后者只有 export-audio-modal 那个特例用，别的 modal 用了
    // 会直接静默失败（display: none 不变）
    overlay.classList.add('is-open')
    overlay.setAttribute('aria-hidden', 'false')
    document.body.classList.add('modal-open')

    return new Promise((resolve) => {
      const close = (choice) => {
        overlay.classList.remove('is-open')
        overlay.setAttribute('aria-hidden', 'true')
        document.body.classList.remove('modal-open')
        restoreBtn.removeEventListener('click', onRestore)
        discardBtn.removeEventListener('click', onDiscard)
        resolve(choice)
      }
      const onRestore = () => close('restore')
      const onDiscard = () => close('discard')
      restoreBtn.addEventListener('click', onRestore)
      discardBtn.addEventListener('click', onDiscard)
    })
  }

  setTransportTime(text) {
    if (!this.refs.timeDisplay) return
    this.refs.timeDisplay.textContent = typeof text === 'string' && text ? text : '00:00.000'
  }

  setTimelinePlayheadTime(time) {
    this.timelinePlayheadTime = Number.isFinite(time) ? Math.max(0, time) : 0
    this.timelinePlayheadView.setTime(this.timelinePlayheadTime)
    this.instrumentEditorView.setPlaybackTime(this.timelinePlayheadTime)
    if (this.playbackActive) this._syncPlaybackFollow()
    const now = performance.now()
    if (this.logger?.debug && now - this.lastPlayheadTraceAtMs >= 200) {
      this.lastPlayheadTraceAtMs = now
      this.logger.debug('playhead', 'ShellLayout 播放头时间下发', {
        time: this.timelinePlayheadTime,
      })
    }
  }

  setPlaybackActive(active) {
    this.playbackActive = Boolean(active)
    this.menubarTransportView.setPlaybackActive(active)
    this.instrumentEditorView.setPlaybackActive(this.playbackActive)
    if (this.playbackActive) this._syncPlaybackFollow()
  }

  setPlayheadFollowMode(mode) {
    this.playheadFollowMode = normalizePlayheadFollowMode(mode)
    this.trackViewportController.setPlayheadFollowMode(this.playheadFollowMode)
    this.instrumentEditorView.setPlayheadFollowMode(this.playheadFollowMode)
    this._renderMenubarFollowControls()
    if (this.playbackActive) this._syncPlaybackFollow()
    return this.playheadFollowMode
  }

  setMidiInputDevices(inputs = [], selectedInputId = '', enabled = true) {
    const select = this.refs.midiInputSelect
    if (!select) return
    const safeInputs = Array.isArray(inputs) ? inputs : []
    select.innerHTML = ''
    const noneOption = document.createElement('option')
    noneOption.value = ''
    noneOption.textContent = enabled ? 'MIDI: 无' : 'MIDI: 不可用'
    select.appendChild(noneOption)
    safeInputs.forEach((input) => {
      const option = document.createElement('option')
      option.value = input.id
      option.textContent = input.name || input.id
      select.appendChild(option)
    })
    select.disabled = !enabled
    const hasSelectedOption = selectedInputId && safeInputs.some((input) => input.id === selectedInputId)
    select.value = hasSelectedOption ? selectedInputId : ''
  }

  setMidiRecordingActive(active) {
    this.menubarTransportView.setRecordingActive(Boolean(active))
  }

  setMidiRecordingEnabled(enabled) {
    this.menubarTransportView.setRecordingEnabled(Boolean(enabled))
  }

  setInstrumentEditorRecording(active) {
    this.instrumentEditorView.setRecording(active)
  }

  getInstrumentEditorState() {
    return this.instrumentEditorView.getState()
  }

  isInstrumentEditorDirty() {
    return this.instrumentEditorView.isDirty()
  }

  isInstrumentEditorRecording() {
    return this.instrumentEditorView.isRecording()
  }

  appendInstrumentEditorRecordedNote(note) {
    return this.instrumentEditorView.appendRecordedNote(note)
  }

  canUndoInstrumentEditorEdit() {
    return this.instrumentEditorView.canUndo()
  }

  undoInstrumentEditorEdit() {
    return this.instrumentEditorView.undo()
  }

  getEditorMode() {
    if (this.btnEditorPitchMode?.classList.contains('active')) return 'pitch'
    if (this.btnEditorLyricMode?.classList.contains('active')) return 'lyric'
    return 'note'
  }

  markInstrumentEditorSaved() {
    this.instrumentEditorView.markSaved()
  }

  openQuickLyricPanel(snapshot, { onSave, languageCode }) {
    const container = this.refs.editorRuntimeTools || this.refs.editorPanel
    if (!container) return
    this.quickLyricPanel.open(snapshot, container, {
      onSave,
      onClose: () => this.btnQuickLyric?.classList.remove('active'),
      languageCode,
      anchor: this.refs.trackView || container,
    })
    this.btnQuickLyric?.classList.add('active')
  }

  closeQuickLyricPanel() {
    this.quickLyricPanel.close()
    this.btnQuickLyric?.classList.remove('active')
  }

  promptTrackLanguage(trackName, languageCode, options = {}) { return this.trackLanguageModal.prompt(trackName, languageCode, options) }
  promptProjectTimingImport(options = {}) { return this.projectTimingImportModal.prompt(options) }
  showTrackSynthesisOverlay(trackName, text, options = {}) { this.trackSynthesisOverlay.show(trackName, text, options) }
  updateTrackSynthesisOverlay(text, ratio = null) { this.trackSynthesisOverlay.update(text, ratio) }
  hideTrackSynthesisOverlay() { this.trackSynthesisOverlay.hide() }
  showPlaybackToast(text, options = {}) { this.playbackToastView.show(text, options) }
  hidePlaybackToast(toastId = null) { this.playbackToastView.hide(toastId) }
  notifyRuntimeLayoutChanged() { this.workspaceSplitController.scheduleRuntimeResize() }

  showEditorPlaceholder() {
    this.editorPlaceholderActive = true
    this._ensureEditorPlaceholder()
    this._editorPlaceholderEl.hidden = false
    this.refs.editorPanel.classList.remove('hidden')
    const workspace = this.refs.workspace
    if (workspace) {
      const half = Math.round(workspace.getBoundingClientRect().height / 2)
      workspace.style.setProperty('--track-view-open-height', `${half}px`)
    }
    this.workspaceSplitController.setEditorVisible(true)
    if (this.refs.voiceRuntimeFrame) this.refs.voiceRuntimeFrame.hidden = true
    if (this.refs.instrumentEditorRoot) this.refs.instrumentEditorRoot.hidden = true
    this.instrumentEditorView.clear()
    this.refs.editorTrackName.textContent = '—'
  }

  hideEditorPlaceholder() {
    if (!this.editorPlaceholderActive) return
    this.editorPlaceholderActive = false
    if (this._editorPlaceholderEl) this._editorPlaceholderEl.hidden = true
  }

  _ensureEditorPlaceholder() {
    if (this._editorPlaceholderEl) return this._editorPlaceholderEl
    const el = document.createElement('div')
    el.className = 'editor-placeholder'
    el.textContent = '请双击音轨开始编辑'
    el.hidden = true
    const editorBody = this.refs.editorPanel?.querySelector('.editor-body')
    if (editorBody) editorBody.appendChild(el)
    this._editorPlaceholderEl = el
    return el
  }

  _bindEvents() {
    this.refs.btnImport?.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this._toggleFileMenu()
    })
    this.refs.fileInput?.addEventListener('change', (event) => this.handlers.onMidiFileSelected?.(event.target.files?.[0] || null))
    this.refs.audioFileInput?.addEventListener('change', (event) => this.handlers.onAudioFileSelected?.(event.target.files?.[0] || null))
    this.refs.btnCloseEditor?.addEventListener('click', () => {
      if (this.editorPlaceholderActive) {
        this.hideEditorPlaceholder()
        this._setEditorVisible(false)
        return
      }
      this.handlers.onCloseEditor?.()
    })
    this.refs.midiInputSelect?.addEventListener('change', (event) => this.handlers.onMidiInputSelected?.(event.target.value || ''))
    this.refs.selectedTrackVoicebank?.addEventListener('change', (event) => {
      this.handlers.onVoicebankChanged?.(event.target.value || null)
    })
    this.refs.btnInspectorToggle?.addEventListener('click', () => this.setInspectorCollapsed(!this.isInspectorCollapsed()))
    // 名牌点击 = 保存；Alt/Option + 点击 = 另存为（跟 Pr / Logic 的"保存指示器一键保存"约定一致）
    this.refs.menubarProjectPlate?.addEventListener('click', (event) => {
      event.preventDefault()
      if (event.altKey) this.handlers.onProjectSaveAs?.()
      else this.handlers.onProjectSave?.()
    })
    this.refs.selectedTrackName?.addEventListener('click', () => {
      const trackId = this._selectedTrackId
      if (!trackId) return
      this.handlers.onTrackRenameRequested?.(trackId, this.refs.selectedTrackName)
    })
    this.refs.trackViewport?.addEventListener('contextmenu', (event) => this._handleTrackViewportContextMenu(event))
    this.refs.mainInspector?.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'width') return
      this._syncPlaybackFollow()
      this.notifyRuntimeLayoutChanged()
    })
  }

  _mountMenubarFollowControls() {
    const host = this.refs.menubarFollowTools
    if (!host || this.followModeControls) return

    const controls = document.createElement('div')
    controls.className = 'menubar-follow-mode-group'

    const label = document.createElement('span')
    label.className = 'menubar-follow-label'
    label.textContent = '滚动'
    controls.appendChild(label)

    for (const mode of [
      PLAYHEAD_FOLLOW_MODES.FOLLOW,
      PLAYHEAD_FOLLOW_MODES.PAGE,
      PLAYHEAD_FOLLOW_MODES.PUSH,
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menubar-follow-btn'
      button.textContent = PLAYHEAD_FOLLOW_MODE_LABELS[mode]
      button.title = `播放时使用${PLAYHEAD_FOLLOW_MODE_LABELS[mode]}滚动`
      button.addEventListener('click', () => this.handlers.onPlayheadFollowModeSelected?.(mode))
      this.followModeButtons.set(mode, button)
      controls.appendChild(button)
    }

    this.followModeControls = controls
    host.appendChild(controls)
    this._renderMenubarFollowControls()
  }

  _renderMenubarFollowControls() {
    for (const [mode, button] of this.followModeButtons.entries()) {
      button.classList.toggle('active', this.playheadFollowMode === mode)
    }
  }

  _mountEditorModeControls() {
    const host = this.refs.editorRuntimeTools
    if (!host || this.editorModeControls) return

    const modeGroup = document.createElement('div')
    modeGroup.className = 'piano-roll-editor-mode-group host-editor-mode-group'

    const createModeButton = (label, mode) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'piano-roll-editor-btn'
      button.textContent = label
      button.addEventListener('click', () => this.handlers.onEditorModeSelected?.(mode))
      return button
    }

    this.btnEditorNoteMode = createModeButton('音符', 'note')
    this.btnEditorLyricMode = createModeButton('歌词', 'lyric')
    this.btnEditorPitchMode = createModeButton('音高', 'pitch')
    modeGroup.append(this.btnEditorNoteMode, this.btnEditorLyricMode, this.btnEditorPitchMode)

    const actions = document.createElement('div')
    actions.className = 'piano-roll-editor-control-group host-editor-action-group'

    this.btnQuickLyric = document.createElement('button')
    this.btnQuickLyric.type = 'button'
    this.btnQuickLyric.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnQuickLyric.dataset.tour = 'quick-lyric-open'
    this.btnQuickLyric.textContent = '快速填词'
    this.btnQuickLyric.addEventListener('click', () => this.handlers.onQuickLyricOpen?.())
    actions.appendChild(this.btnQuickLyric)

    this.btnRenderTrackAsVoice = document.createElement('button')
    this.btnRenderTrackAsVoice.type = 'button'
    this.btnRenderTrackAsVoice.className = 'piano-roll-editor-btn piano-roll-editor-btn--secondary'
    this.btnRenderTrackAsVoice.dataset.tour = 'render-as-voice'
    this.btnRenderTrackAsVoice.textContent = '将该轨道渲染为人声'
    this.btnRenderTrackAsVoice.addEventListener('click', () => {
      const trackId = this.refs.editorPanel?.dataset?.trackId || null
      this.handlers.onRenderTrackAsVoice?.(trackId)
    })
    actions.appendChild(this.btnRenderTrackAsVoice)

    this.editorModeControls = document.createElement('div')
    this.editorModeControls.className = 'editor-mode-controls'
    this.editorModeControls.append(modeGroup, actions)
    host.appendChild(this.editorModeControls)
  }

  _renderEditorModeControls(editorTrack, viewState = {}) {
    const isMidiTrack = Boolean(editorTrack) && !isAudioTrack(editorTrack)
    const isVocalTrack = isVoiceRuntimeSource(editorTrack?.playbackState?.assignedSourceId)
    const mode = viewState?.editorMode === 'pitch' || viewState?.editorMode === 'lyric'
      ? viewState.editorMode
      : 'note'

    if (this.refs.editorPanel) {
      this.refs.editorPanel.dataset.trackId = editorTrack?.id || ''
    }

    if (this.btnEditorNoteMode) {
      this.btnEditorNoteMode.disabled = !isMidiTrack
      this.btnEditorNoteMode.classList.toggle('active', mode === 'note')
    }
    if (this.btnEditorLyricMode) {
      this.btnEditorLyricMode.disabled = !(isMidiTrack && isVocalTrack)
      this.btnEditorLyricMode.classList.toggle('active', isVocalTrack && mode === 'lyric')
    }
    if (this.btnEditorPitchMode) {
      this.btnEditorPitchMode.disabled = !(isMidiTrack && isVocalTrack)
      this.btnEditorPitchMode.classList.toggle('active', isVocalTrack && mode === 'pitch')
    }
    if (this.btnQuickLyric) {
      this.btnQuickLyric.disabled = !(isMidiTrack && isVocalTrack)
      this.btnQuickLyric.hidden = !isMidiTrack
      if (this.btnQuickLyric.disabled && this.quickLyricPanel.isOpen()) {
        this.quickLyricPanel.close()
      }
    }
    if (this.btnRenderTrackAsVoice) {
      this.btnRenderTrackAsVoice.disabled = !(isMidiTrack && !isVocalTrack)
      this.btnRenderTrackAsVoice.hidden = !isMidiTrack
    }
  }

  async _loadInspectorVoicebanks() {
    const select = this.refs.selectedTrackVoicebank
    if (!select) return
    try {
      const voicebanks = await fetchVoicebanks()
      select.innerHTML = ''
      voicebanks.forEach((vb) => {
        const option = document.createElement('option')
        option.value = vb.id
        option.textContent = vb.name || vb.id
        select.appendChild(option)
      })
    } catch {
      select.innerHTML = '<option value="">无法加载声库</option>'
    }
  }

  _renderProjectMeta(project, selectedTrack, editorTrack, renderBadgeTrack, viewState) {
    this.setPlayheadFollowMode(viewState?.playheadFollowMode)
    this._selectedTrackId = selectedTrack?.id || null
    const trackSection = this.refs.inspectorSectionTrack
    if (trackSection) {
      const trackColor = selectedTrack
        ? getTrackColorById(selectedTrack.id, project?.tracks || [])
        : null
      if (trackColor) {
        trackSection.style.setProperty('--track-color', trackColor)
      } else {
        trackSection.style.removeProperty('--track-color')
      }
    }
    this.refs.selectedTrackName.textContent = selectedTrack?.name || '—'
    this.refs.selectedTrackKind.textContent = selectedTrack
      ? (isAudioTrack(selectedTrack) ? '音频轨' : getTrackSourceInspectorText(selectedTrack.playbackState?.assignedSourceId))
      : '-'
    this.refs.selectedTrackLanguage.textContent = selectedTrack
      ? (isAudioTrack(selectedTrack) ? '—' : getLanguageLabel(selectedTrack.languageCode))
      : '未设置'
    const isVoiceTrack = selectedTrack && !isAudioTrack(selectedTrack) && isVoiceRuntimeSource(selectedTrack.playbackState?.assignedSourceId)
    if (this.refs.selectedTrackVoicebank) {
      const voicebankSelect = this.refs.selectedTrackVoicebank
      voicebankSelect.disabled = !isVoiceTrack
      if (isVoiceTrack && selectedTrack.singerId) {
        voicebankSelect.value = selectedTrack.singerId
      }
    }
    // 仅人声轨道才展示"声库"section
    if (this.refs.inspectorSectionVoicebank) {
      this.refs.inspectorSectionVoicebank.hidden = !isVoiceTrack
    }
    this.refs.selectedTrackStatus.textContent = selectedTrack ? getTrackInspectorStatusText(selectedTrack) : '-'
    this.refs.renderBadge.textContent = renderBadgeTrack ? getTrackStatusText(renderBadgeTrack) : ''
    this.refs.renderBadge.className = `render-status ${renderBadgeTrack ? getTrackRenderClass(renderBadgeTrack) : 'idle'}`
    this.refs.editorTrackName.textContent = editorTrack?.name || '—'
    const bpm = project?.tempoData?.tempos?.[0]?.bpm || 120
    this.refs.bpmDisplay.textContent = String(Math.round(bpm))
  }

  _resolveProjectViewTracks(project) {
    const tracks = project?.tracks || []
    const selectedTrack = tracks.find((track) => track.id === project?.selectedTrackId) || null
    const editorTrack = tracks.find((track) => track.id === project?.editorTrackId) || null
    const renderBadgeTrack = editorTrack || tracks.find((track) => track?.jobRef?.status === 'active') || null
    return {
      tracks,
      selectedTrack,
      editorTrack,
      renderBadgeTrack,
    }
  }

  _renderTracks(tracks, selectedTrackId, editorTrackId, timelineMetrics, viewState) {
    const rowCount = Math.max(1, tracks.length + 1)
    const contentHeight = Math.max(220, rowCount * TRACK_ROW_HEIGHT)
    this.refs.trackTimelineContent.innerHTML = ''
    this.refs.trackTimelineContent.style.width = `calc(var(--track-header-width) + ${timelineMetrics.timelineWidth}px)`
    this.refs.trackTimelineContent.style.height = `${contentHeight}px`
    this.refs.trackTimelineContent.style.minHeight = tracks.length > 0 ? `${contentHeight}px` : '100%'
    this.refs.trackTimelineContent.style.setProperty('--track-preview-width', `${timelineMetrics.timelineWidth}px`)
    this.refs.emptyHint.style.display = tracks.length === 0 ? 'flex' : 'none'
    if (tracks.length === 0) {
      this.refs.emptyHint.innerHTML = ''
      const line1 = document.createElement('div')
      line1.dataset.tour = 'empty-hint-primary'
      line1.textContent = '点击左侧加号新建轨道，通过钢琴卷帘或MIDI设备进行编辑'
      const line2 = document.createElement('div')
      line2.className = 'track-empty-hint-import'
      const label = document.createElement('span')
      label.textContent = '或导入MIDI文件'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'track-empty-hint-import-button'
      btn.textContent = '导入'
      btn.addEventListener('click', () => this.refs.fileInput?.click())
      line2.append(label, btn)
      const demoFiles = DEMO_MIDI_FILES
      if (demoFiles.length > 0) {
        const line3 = document.createElement('div')
        line3.className = 'track-empty-hint-import'
        line3.dataset.tour = 'demo-row'
        const demoLabel = document.createElement('span')
        demoLabel.textContent = '也可加载示例midi快速体验'
        const loadDemo = (button, url, fileName) => {
          const originalLabel = button.textContent
          button.disabled = true
          button.textContent = '加载中…'
          fetch(url)
            .then((res) => res.blob())
            .then((blob) => {
              const file = new File([blob], fileName, { type: 'audio/midi' })
              this.handlers.onMidiFileSelected?.(file)
              // 文件已交给 handler 处理：若加载真正成功，空态区域会被重绘而使此按钮消失；
              // 若用户随后取消下游弹窗（如时序导入），按钮仍保留在 DOM 中且需可再次点击
              button.textContent = originalLabel
              button.disabled = false
            })
            .catch(() => {
              button.textContent = '失败'
              button.disabled = false
            })
        }
        for (const demo of demoFiles) {
          const demoBtn = document.createElement('button')
          demoBtn.type = 'button'
          demoBtn.className = 'track-empty-hint-import-button'
          demoBtn.dataset.tour = 'demo-btn'
          demoBtn.dataset.tourDemo = demo.label
          demoBtn.textContent = demo.label
          demoBtn.addEventListener('click', () => loadDemo(demoBtn, demo.file, demo.file))
          line3.appendChild(demoBtn)
        }
        line3.prepend(demoLabel)
        this.refs.emptyHint.append(line1, line2, line3)
      } else {
        this.refs.emptyHint.append(line1, line2)
      }
    }

    const fragment = document.createDocumentFragment()
    tracks.forEach((track, index) => {
      fragment.appendChild(buildTrackShellRowView({
        track,
        index,
        timelineMetrics,
        selectedTrackId,
        editorTrackId,
        viewState,
        handlers: this.handlers,
      }))
    })
    fragment.appendChild(this._buildTrackCreateRow(timelineMetrics, tracks[tracks.length - 1]?.id || null))
    const sharedGrid = buildTrackPreviewGridOverlay({
      timelineMetrics,
      contentHeight,
    })
    if (sharedGrid) fragment.appendChild(sharedGrid)
    this.refs.trackTimelineContent.appendChild(fragment)
  }

  _buildTrackCreateRow(timelineMetrics, afterTrackId = null) {
    const row = document.createElement('div')
    row.className = 'track-shell-row track-shell-row--adder'
    row.style.setProperty('--track-preview-width', `${timelineMetrics.timelineWidth}px`)

    const itemCell = document.createElement('div')
    itemCell.className = 'track-item-cell track-item-cell--adder'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'track-add-button'
    button.setAttribute('aria-label', '新建轨道')
    button.innerHTML = '<span class="track-add-button-plus">+</span><span class="track-add-button-label">新建轨道</span>'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.handlers.onTrackContextCreate?.(afterTrackId)
    })

    itemCell.appendChild(button)

    const preview = document.createElement('div')
    preview.className = 'track-row track-row--adder'
    preview.setAttribute('aria-hidden', 'true')

    row.append(itemCell, preview)
    return row
  }

  _renderRuler(timelineMetrics, tempoData = null) {
    this.refs.trackRulerInner.innerHTML = ''
    this.refs.trackRulerInner.style.width = `${timelineMetrics.timelineWidth}px`
    const axis = timelineMetrics.axis
    if (!axis) return
    const marks = axis.getRulerMarks({
      subdivisionsPerBeat: timelineMetrics.snapDivision || 4,
    }) || []
    marks.forEach((mark) => {
      const left = Math.round(mark.x)
      this.refs.trackRulerInner.appendChild(createRulerLine(left, mark.kind))
      if (mark.isBar) this.refs.trackRulerInner.appendChild(createRulerMark(left, mark.barNumber))
    })

    const timeSignaturePoints = axis.timeSignaturePoints || []
    timeSignaturePoints.forEach((point, index) => {
      if (index === 0 && point.ticks === 0) return
      const signature = Array.isArray(point.timeSignature) ? point.timeSignature.join('/') : '4/4'
      this.refs.trackRulerInner.appendChild(createRulerMetaMarker(
        Math.round(axis.tickToX(point.ticks)),
        signature,
        'signature',
      ))
    })

    const tempoPoints = axis.tempoPoints || []
    tempoPoints.forEach((point, index) => {
      if (index === 0 && point.ticks === 0) return
      this.refs.trackRulerInner.appendChild(createRulerMetaMarker(
        Math.round(axis.tickToX(point.ticks)),
        `${Math.round(point.bpm)} BPM`,
        'tempo',
      ))
    })

    ;(tempoData?.keySignatures || []).forEach((point, index) => {
      if (index === 0 && (point.ticks || 0) === 0) return
      const label = `${point.key}${point.scale === 'minor' ? 'm' : ''}`
      this.refs.trackRulerInner.appendChild(createRulerMetaMarker(
        Math.round(axis.tickToX(point.ticks || 0)),
        label,
        'key',
      ))
    })
  }

  _syncTimelinePlayhead(timelineMetrics) {
    this.timelinePlayheadView.syncContainers({
      rulerInner: this.refs.trackRulerInner,
      timelineContent: this.refs.trackTimelineContent,
    })
    this.timelinePlayheadView.setAxis(timelineMetrics?.axis || null)
    this.timelinePlayheadView.setTime(this.timelinePlayheadTime)
    if (this.playbackActive) this._syncPlaybackFollow()
  }

  _syncEditorSurface(project, editorTrack, viewState = {}) {
    const voiceFrame = this.refs.voiceRuntimeFrame
    const instrumentRoot = this.refs.instrumentEditorRoot
    if (editorTrack && this.editorPlaceholderActive) {
      this.hideEditorPlaceholder()
    }
    if (this.editorPlaceholderActive) return
    if (!editorTrack) {
      if (voiceFrame) voiceFrame.hidden = true
      if (instrumentRoot) instrumentRoot.hidden = true
      this.instrumentEditorView.clear()
      return
    }

    if (isAudioTrack(editorTrack)) {
      if (voiceFrame) voiceFrame.hidden = true
      if (instrumentRoot) instrumentRoot.hidden = true
      this.instrumentEditorView.clear()
      return
    }

    const editorMode = viewState?.editorMode === 'pitch' || viewState?.editorMode === 'lyric'
      ? viewState.editorMode
      : 'note'
    const shouldShowVoiceSurface = editorMode !== 'note' && isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)

    if (shouldShowVoiceSurface) {
      if (voiceFrame) voiceFrame.hidden = false
      if (instrumentRoot) instrumentRoot.hidden = true
      this.instrumentEditorView.clear()
      return
    }

    if (voiceFrame) voiceFrame.hidden = true
    this.instrumentEditorView.setTrack(editorTrack, project)
    this.instrumentEditorView.setVisible(true)
  }

  _setEditorVisible(visible) {
    if (!visible && this.editorPlaceholderActive) return
    this.refs.editorPanel.classList.toggle('hidden', !visible)
    this.workspaceSplitController.setEditorVisible(visible)
  }

  isInspectorCollapsed() {
    return this.refs.mainInspector?.classList.contains('collapsed') || false
  }

  setInspectorCollapsed(collapsed) {
    this.refs.mainInspector?.classList.toggle('collapsed', Boolean(collapsed))
    this._updateInspectorToggleButton(Boolean(collapsed))
    this._syncPlaybackFollow()
    this.notifyRuntimeLayoutChanged()
  }

  _updateInspectorToggleButton(collapsed) {
    const button = this.refs.btnInspectorToggle
    if (!button) return
    button.classList.toggle('active', !collapsed)
    button.dataset.collapsed = String(Boolean(collapsed))
    button.setAttribute('aria-pressed', String(!collapsed))
    button.title = collapsed ? '展开右侧面板' : '收起右侧面板'
    button.setAttribute('aria-label', button.title)
  }

  _syncPlaybackFollow() {
    const axis = this.timelinePlayheadView.axis
    if (!axis || this.timelinePlayheadView.isDraggingPlayhead?.()) return
    const playheadX = axis.timeToX(this.timelinePlayheadTime)
    this.trackViewportController.syncPlaybackFollow(playheadX)
  }

  _syncFileMenuState(project) {
    if (!this.fileMenuExportButton) return
    this.fileMenuExportButton.disabled = !(this.handlers.canExportMidi?.(project) ?? false)
    const hasProject = Boolean(project?.tracks?.length)
    if (this.fileMenuExportAudioButton) {
      this.fileMenuExportAudioButton.disabled = !hasProject
    }
  }

  _createFileMenu() {
    const menu = document.createElement('div')
    menu.className = 'track-context-menu file-menu'

    const newProjectButton = this._buildFileMenuItem({
      label: '新建工程',
      shortcut: this._formatShortcut('N'),
      onClick: () => this.handlers.onProjectNew?.(),
    })
    const openProjectButton = this._buildFileMenuItem({
      label: '打开工程',
      shortcut: this._formatShortcut('O'),
      onClick: () => this.handlers.onProjectOpen?.(),
    })

    const saveProjectButton = this._buildFileMenuItem({
      label: '保存工程',
      shortcut: this._formatShortcut('S'),
      onClick: () => this.handlers.onProjectSave?.(),
    })
    const saveProjectAsButton = this._buildFileMenuItem({
      label: '工程另存为',
      shortcut: this._formatShortcut('S', { shift: true }),
      onClick: () => this.handlers.onProjectSaveAs?.(),
    })

    const importMidiButton = this._buildFileMenuItem({
      label: '导入 MIDI',
      onClick: () => this.refs.fileInput?.click(),
    })
    const importAudioButton = this._buildFileMenuItem({
      label: '导入音频轨',
      onClick: () => this.refs.audioFileInput?.click(),
    })

    const exportMidiButton = this._buildFileMenuItem({
      label: '导出 MIDI',
      onClick: () => this.handlers.onExportMidi?.(),
    })
    exportMidiButton.disabled = true
    const exportAudioButton = this._buildFileMenuItem({
      label: '导出音频',
      onClick: () => this.handlers.onExportAudio?.(),
    })
    exportAudioButton.disabled = true

    menu.append(
      newProjectButton,
      openProjectButton,
      this._buildFileMenuDivider(),
      saveProjectButton,
      saveProjectAsButton,
      this._buildFileMenuDivider(),
      importMidiButton,
      importAudioButton,
      this._buildFileMenuDivider(),
      exportMidiButton,
      exportAudioButton,
    )
    this.fileMenuExportButton = exportMidiButton
    this.fileMenuExportAudioButton = exportAudioButton
    return menu
  }

  // 构建一个标准菜单项：左侧 label，右侧 shortcut hint（可选）；点击会先收起菜单再回调
  _buildFileMenuItem({ label, shortcut = null, onClick }) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'track-context-menu-item'
    if (shortcut) button.classList.add('has-shortcut')

    const labelEl = document.createElement('span')
    labelEl.className = 'track-context-menu-label'
    labelEl.textContent = label
    button.appendChild(labelEl)

    if (shortcut) {
      const shortcutEl = document.createElement('span')
      shortcutEl.className = 'track-context-menu-shortcut'
      shortcutEl.textContent = shortcut
      button.appendChild(shortcutEl)
    }

    button.addEventListener('click', () => {
      this._hideFileMenu()
      onClick?.()
    })
    return button
  }

  _buildFileMenuDivider() {
    const divider = document.createElement('div')
    divider.className = 'file-menu-divider'
    divider.setAttribute('aria-hidden', 'true')
    return divider
  }

  // macOS 用 ⌘，Windows/Linux 用 Ctrl —— 把肌肉记忆呈现给用户
  _formatShortcut(key, { shift = false } = {}) {
    const isMac = typeof navigator !== 'undefined'
      && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
    const meta = isMac ? '⌘' : 'Ctrl'
    const shiftSymbol = isMac ? '⇧' : 'Shift'
    const sep = isMac ? '' : '+'
    return shift ? `${meta}${sep}${shiftSymbol}${sep}${key}` : `${meta}${sep}${key}`
  }

  _createTrackContextMenu() {
    const menu = document.createElement('div')
    menu.className = 'track-context-menu'
    const createButton = document.createElement('button')
    createButton.type = 'button'
    createButton.className = 'track-context-menu-item'
    createButton.textContent = '新建轨道'
    createButton.addEventListener('click', () => {
      const targetTrackId = this.trackContextTrackId
      this._hideTrackContextMenu()
      this.handlers.onTrackContextCreate?.(targetTrackId)
    })

    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'track-context-menu-item'
    deleteButton.textContent = '删除轨道'
    deleteButton.addEventListener('click', () => {
      if (deleteButton.disabled) return
      const targetTrackId = this.trackContextTrackId
      this._hideTrackContextMenu()
      this.handlers.onTrackContextDelete?.(targetTrackId)
    })

    menu.appendChild(createButton)
    menu.appendChild(deleteButton)
    this.trackContextCreateButton = createButton
    this.trackContextDeleteButton = deleteButton
    return menu
  }

  _toggleFileMenu() {
    if (this.fileMenu.classList.contains('visible')) {
      this._hideFileMenu()
      return
    }
    const anchor = this.refs.btnImport
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    this.fileMenu.classList.add('visible')
    this.fileMenu.style.left = '0px'
    this.fileMenu.style.top = '0px'
    const menuRect = this.fileMenu.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))
    const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8))
    this.fileMenu.style.left = `${left}px`
    this.fileMenu.style.top = `${top}px`
    this.refs.btnImport?.classList.add('active')
  }

  _resolveTrackHeaderWidth() {
    const rootStyles = getComputedStyle(document.documentElement)
    const cssValue = Number.parseFloat(rootStyles.getPropertyValue('--track-header-width'))
    return Number.isFinite(cssValue) && cssValue > 0 ? cssValue : TRACK_HEADER_FALLBACK_WIDTH
  }

  _handleTrackViewportContextMenu(event) {
    const viewport = this.refs.trackViewport
    if (!viewport) return
    const row = event.target?.closest?.('.track-shell-row') || null
    const itemCell = event.target?.closest?.('.track-item-cell') || null
    const viewportRect = viewport.getBoundingClientRect()
    const pointerInsideHeader = event.clientX <= viewportRect.left + this._resolveTrackHeaderWidth()
    if (!itemCell && !pointerInsideHeader) return

    event.preventDefault()
    event.stopPropagation()

    const trackId = row?.dataset?.trackId || null
    if (trackId) {
      this.handlers.onTrackSelected?.(trackId)
    }
    this._showTrackContextMenu({
      x: event.clientX,
      y: event.clientY,
      trackId,
      canDelete: this.handlers.canDeleteTrack?.(trackId) ?? Boolean(trackId),
    })
  }

  _showTrackContextMenu({ x, y, trackId = null, canDelete = false }) {
    this.trackContextTrackId = trackId
    this.trackContextDeleteButton.disabled = !canDelete
    this.trackContextMenu.classList.add('visible')
    this.trackContextMenu.style.left = '0px'
    this.trackContextMenu.style.top = '0px'
    const rect = this.trackContextMenu.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    this.trackContextMenu.style.left = `${left}px`
    this.trackContextMenu.style.top = `${top}px`
  }

  _hideTrackContextMenu() {
    this.trackContextTrackId = null
    this.trackContextMenu.classList.remove('visible')
  }

  _hideFileMenu() {
    this.fileMenu.classList.remove('visible')
    this.refs.btnImport?.classList.remove('active')
  }
}

