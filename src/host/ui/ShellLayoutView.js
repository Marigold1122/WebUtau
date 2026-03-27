import { getLanguageLabel } from '../../config/languageOptions.js'
import { InspectorVoiceConversionSection } from './InspectorVoiceConversionSection.js'
import { MenubarTransportView } from './MenubarTransportView.js'
import { PlaybackToastView } from './PlaybackToastView.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { getTrackSourceInspectorText } from '../project/trackSourceAssignment.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { InstrumentEditorView } from './InstrumentEditorView.js'
import { ProjectTimingImportModal } from './ProjectTimingImportModal.js'
import { TrackLanguageModal } from './TrackLanguageModal.js'
import { TrackTimelinePlayheadView } from './TrackTimelinePlayheadView.js'
import { TrackSynthesisOverlay } from './TrackSynthesisOverlay.js'
import { TrackViewportController } from './TrackViewportController.js'
import { createShellLayoutRefs } from './createShellLayoutRefs.js'
import { getTrackTimelineMetrics } from './trackTimelineMetrics.js'
import {
  createRulerMetaMarker,
  buildTrackShellRowView,
  createRulerLine,
  createRulerMark,
  TRACK_ROW_HEIGHT,
} from './tracks/buildTrackShellViews.js'
import {
  getTrackInspectorStatusText,
  getTrackRenderClass,
  getTrackStatusText,
  normalizeShellStatusText,
} from './trackStatusText.js'
import { WorkspaceSplitController } from './WorkspaceSplitController.js'

const TRACK_HEADER_FALLBACK_WIDTH = 240
const SNAP_LABELS = {
  4: '1/16',
}

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
    })
    this.timelinePlayheadTime = 0
    this.lastPlayheadTraceAtMs = 0
    this.trackSynthesisOverlay = new TrackSynthesisOverlay()
    this.voiceConversionSection = new InspectorVoiceConversionSection(this.refs.voiceConversionSection, handlers)
    this.trackViewportController = new TrackViewportController(this.refs, handlers)
    this.instrumentEditorView = new InstrumentEditorView(this.refs.instrumentEditorRoot, handlers)
    this.workspaceSplitController = new WorkspaceSplitController(this.refs)
    this.fileMenu = this._createFileMenu()
    this.trackContextMenu = this._createTrackContextMenu()
    this.trackContextTrackId = null
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
  }

  init() {
    this.trackLanguageModal.init()
    this.projectTimingImportModal.init()
    this.menubarTransportView.init()
    this.playbackToastView.init()
    this.voiceConversionSection.init()
    this.instrumentEditorView.init()
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
  }

  render(project, viewState = {}) {
    this._syncFileMenuState(project)
    this._hideFileMenu()
    this._hideTrackContextMenu()
    const tracks = project?.tracks || []
    const selectedTrack = tracks.find((track) => track.id === project?.selectedTrackId) || null
    const editorTrack = tracks.find((track) => track.id === project?.editorTrackId) || null
    const renderBadgeTrack = editorTrack || tracks.find((track) => track?.jobRef?.status === 'active') || null
    const timelineMetrics = getTrackTimelineMetrics(project)
    const timelineViewMetrics = tracks.length > 0 ? timelineMetrics : { ...timelineMetrics, axis: null }

    this._renderProjectMeta(project, selectedTrack, editorTrack, renderBadgeTrack, viewState)
    this.voiceConversionSection.render(viewState?.voiceConversion || { visible: false })
    this._renderTracks(tracks, selectedTrack?.id, editorTrack?.id, timelineViewMetrics, viewState)
    this._renderRuler(timelineViewMetrics, project?.tempoData || null)
    this.trackViewportController.syncRulerOffset()
    this._syncTimelinePlayhead(timelineViewMetrics)
    this._setEditorVisible(Boolean(editorTrack))
    this._syncEditorSurface(project, editorTrack)
    this.setMidiRecordingEnabled(Boolean(editorTrack) && !isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId))
  }

  setStatus(text) {
    const nextText = normalizeShellStatusText(text)
    this.refs.statusText.textContent = nextText
    this.refs.statusBar?.classList.toggle('is-empty', nextText.length === 0)
  }

  setTransportTime(text) {
    if (!this.refs.timeDisplay) return
    this.refs.timeDisplay.textContent = typeof text === 'string' && text ? text : '00:00.000'
  }

  setTimelinePlayheadTime(time) {
    this.timelinePlayheadTime = Number.isFinite(time) ? Math.max(0, time) : 0
    this.timelinePlayheadView.setTime(this.timelinePlayheadTime)
    this.instrumentEditorView.setPlaybackTime(this.timelinePlayheadTime)
    const now = performance.now()
    if (this.logger?.info && now - this.lastPlayheadTraceAtMs >= 200) {
      this.lastPlayheadTraceAtMs = now
      this.logger.info('ShellLayout 播放头时间下发', {
        time: this.timelinePlayheadTime,
      })
    }
  }

  setPlaybackActive(active) {
    this.menubarTransportView.setPlaybackActive(active)
    this.instrumentEditorView.setPlaybackActive(Boolean(active))
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

  markInstrumentEditorSaved() {
    this.instrumentEditorView.markSaved()
  }

  promptTrackLanguage(trackName, languageCode, options = {}) { return this.trackLanguageModal.prompt(trackName, languageCode, options) }
  promptProjectTimingImport(options = {}) { return this.projectTimingImportModal.prompt(options) }
  showTrackSynthesisOverlay(trackName, text, options = {}) { this.trackSynthesisOverlay.show(trackName, text, options) }
  updateTrackSynthesisOverlay(text, ratio = null) { this.trackSynthesisOverlay.update(text, ratio) }
  hideTrackSynthesisOverlay() { this.trackSynthesisOverlay.hide() }
  showPlaybackToast(text, options = {}) { this.playbackToastView.show(text, options) }
  hidePlaybackToast(toastId = null) { this.playbackToastView.hide(toastId) }
  notifyRuntimeLayoutChanged() { this.workspaceSplitController.scheduleRuntimeResize() }

  _bindEvents() {
    this.refs.btnImport?.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this._toggleFileMenu()
    })
    this.refs.fileInput?.addEventListener('change', (event) => this.handlers.onMidiFileSelected?.(event.target.files?.[0] || null))
    this.refs.audioFileInput?.addEventListener('change', (event) => this.handlers.onAudioFileSelected?.(event.target.files?.[0] || null))
    this.refs.btnOpenTrack?.addEventListener('click', () => this.handlers.onOpenSelectedTrack?.())
    this.refs.btnCloseEditor?.addEventListener('click', () => this.handlers.onCloseEditor?.())
    this.refs.midiInputSelect?.addEventListener('change', (event) => this.handlers.onMidiInputSelected?.(event.target.value || ''))
    this.refs.btnInspectorToggle?.addEventListener('click', () => this.setInspectorCollapsed(!this.isInspectorCollapsed()))
    this.refs.trackViewport?.addEventListener('contextmenu', (event) => this._handleTrackViewportContextMenu(event))
    this.refs.mainInspector?.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'width') return
      this.notifyRuntimeLayoutChanged()
    })
  }

  _renderProjectMeta(project, selectedTrack, editorTrack, renderBadgeTrack, viewState) {
    this.refs.projectFileName.textContent = project?.fileName || '—'
    this.refs.projectTrackCount.textContent = String(project?.tracks?.length || 0)
    this.refs.selectedTrackName.textContent = selectedTrack?.name || '—'
    this.refs.selectedTrackKind.textContent = selectedTrack
      ? (isAudioTrack(selectedTrack) ? '音频轨' : getTrackSourceInspectorText(selectedTrack.playbackState?.assignedSourceId))
      : '-'
    this.refs.selectedTrackStats.textContent = selectedTrack
      ? (isAudioTrack(selectedTrack)
        ? `${selectedTrack.audioClip?.fileName || '导入音频'} / 1 片段`
        : `${selectedTrack.noteCount || 0} 音符 / ${selectedTrack.phraseCount ?? '-'} 语句`)
      : '-'
    this.refs.selectedTrackLength.textContent = selectedTrack
      ? `${(isAudioTrack(selectedTrack) ? (selectedTrack.audioClip?.duration || 0) : (selectedTrack.duration || 0)).toFixed(2)}s`
      : '-'
    this.refs.selectedTrackLanguage.textContent = selectedTrack
      ? (isAudioTrack(selectedTrack) ? '—' : getLanguageLabel(selectedTrack.languageCode))
      : '未设置'
    this.refs.selectedTrackStatus.textContent = selectedTrack ? getTrackInspectorStatusText(selectedTrack) : '-'
    this.refs.renderBadge.textContent = renderBadgeTrack ? getTrackStatusText(renderBadgeTrack) : ''
    this.refs.renderBadge.className = `render-status ${renderBadgeTrack ? getTrackRenderClass(renderBadgeTrack) : 'idle'}`
    this.refs.activeTrackCaption.textContent = viewState?.focusSoloTrackId && selectedTrack?.id === viewState.focusSoloTrackId
      ? `${selectedTrack.name} · 专注监听`
      : selectedTrack?.name || '—'
    this.refs.editorTrackName.textContent = editorTrack?.name || '—'
    const bpm = project?.tempoData?.tempos?.[0]?.bpm || 120
    this.refs.bpmDisplay.textContent = String(Math.round(bpm))
    if (this.refs.gridSnapDisplay) {
      const division = getTrackTimelineMetrics(project).snapDivision || 4
      this.refs.gridSnapDisplay.textContent = `SNAP: ${SNAP_LABELS[division] || '1/16'}`
    }
  }

  _renderTracks(tracks, selectedTrackId, editorTrackId, timelineMetrics, viewState) {
    const contentHeight = tracks.length > 0 ? tracks.length * TRACK_ROW_HEIGHT : 220
    this.refs.trackTimelineContent.innerHTML = ''
    this.refs.trackTimelineContent.style.width = `calc(var(--track-header-width) + ${timelineMetrics.timelineWidth}px)`
    this.refs.trackTimelineContent.style.height = `${contentHeight}px`
    this.refs.trackTimelineContent.style.minHeight = tracks.length > 0 ? `${contentHeight}px` : '100%'
    this.refs.trackTimelineContent.style.setProperty('--track-preview-width', `${timelineMetrics.timelineWidth}px`)
    this.refs.emptyHint.style.display = tracks.length === 0 ? 'flex' : 'none'
    if (tracks.length === 0) {
      this.refs.emptyHint.textContent = '暂无轨道\n右键左侧空白区可新建轨道，右键轨道头可删除轨道'
    }

    tracks.forEach((track, index) => {
      this.refs.trackTimelineContent.appendChild(buildTrackShellRowView({
        track,
        index,
        timelineMetrics,
        selectedTrackId,
        editorTrackId,
        viewState,
        handlers: this.handlers,
      }))
    })
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
  }

  _syncEditorSurface(project, editorTrack) {
    const voiceFrame = this.refs.voiceRuntimeFrame
    const instrumentRoot = this.refs.instrumentEditorRoot
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

    if (isVoiceRuntimeSource(editorTrack.playbackState?.assignedSourceId)) {
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
    this.refs.editorPanel.classList.toggle('hidden', !visible)
    this.workspaceSplitController.setEditorVisible(visible)
  }

  isInspectorCollapsed() {
    return this.refs.mainInspector?.classList.contains('collapsed') || false
  }

  setInspectorCollapsed(collapsed) {
    this.refs.mainInspector?.classList.toggle('collapsed', Boolean(collapsed))
    this._updateInspectorToggleButton(Boolean(collapsed))
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

  _syncFileMenuState(project) {
    if (!this.fileMenuExportButton) return
    this.fileMenuExportButton.disabled = !(this.handlers.canExportMidi?.(project) ?? false)
  }

  _createFileMenu() {
    const menu = document.createElement('div')
    menu.className = 'track-context-menu file-menu'

    const importMidiButton = document.createElement('button')
    importMidiButton.type = 'button'
    importMidiButton.className = 'track-context-menu-item'
    importMidiButton.textContent = '导入 MIDI'
    importMidiButton.addEventListener('click', () => {
      this._hideFileMenu()
      this.refs.fileInput?.click()
    })

    const importAudioButton = document.createElement('button')
    importAudioButton.type = 'button'
    importAudioButton.className = 'track-context-menu-item'
    importAudioButton.textContent = '导入音频轨'
    importAudioButton.addEventListener('click', () => {
      this._hideFileMenu()
      this.refs.audioFileInput?.click()
    })

    const exportMidiButton = document.createElement('button')
    exportMidiButton.type = 'button'
    exportMidiButton.className = 'track-context-menu-item'
    exportMidiButton.textContent = '导出 MIDI'
    exportMidiButton.disabled = true
    exportMidiButton.addEventListener('click', () => {
      this._hideFileMenu()
      this.handlers.onExportMidi?.()
    })

    menu.append(importMidiButton, importAudioButton, exportMidiButton)
    this.fileMenuExportButton = exportMidiButton
    return menu
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
