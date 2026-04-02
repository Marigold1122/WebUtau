function ensureReverbDockToggleButton() {
  let button = document.getElementById('btn-toggle-reverb-dock')
  if (button) return button

  const toolsCenter = document.querySelector('.tools-center')
  const anchor = document.getElementById('btn-open-track')
  if (!toolsCenter || !anchor) return null

  button = document.createElement('button')
  button.type = 'button'
  button.className = anchor.className
  button.id = 'btn-toggle-reverb-dock'
  button.textContent = '混响 Reverb'
  toolsCenter.appendChild(button)
  return button
}

function ensureReverbDockPanel() {
  let panel = document.getElementById('reverb-dock')
  if (panel) return panel

  const workspace = document.getElementById('workspace')
  const editorPanel = document.getElementById('editor-panel')
  if (!workspace || !editorPanel) return null

  panel = document.createElement('section')
  panel.id = 'reverb-dock'
  panel.className = 'bottom-fx-panel hidden'
  panel.setAttribute('aria-label', '混响面板 Reverb panel')
  editorPanel.insertAdjacentElement('afterend', panel)
  return panel
}

export function createShellLayoutRefs() {
  return {
    workspace: document.getElementById('workspace'),
    fileInput: document.getElementById('midi-file-input'),
    audioFileInput: document.getElementById('audio-file-input'),
    btnImport: document.getElementById('btn-import'),
    btnOpenTrack: document.getElementById('btn-open-track'),
    btnToggleReverbDock: ensureReverbDockToggleButton(),
    btnCloseEditor: document.getElementById('btn-close-editor'),
    btnPlay: document.getElementById('btn-play'),
    btnTopPrev: document.getElementById('btn-top-prev'),
    btnTopPlay: document.getElementById('btn-top-play'),
    btnTopStop: document.getElementById('btn-top-stop'),
    btnTopRecord: document.getElementById('btn-top-record'),
    btnTopNext: document.getElementById('btn-top-next'),
    menubarFollowTools: document.getElementById('menubar-follow-tools'),
    bpmDisplay: document.getElementById('bpm-display'),
    renderBadge: document.getElementById('render-status-badge'),
    statusText: document.getElementById('status-text'),
    statusBar: document.getElementById('status-bar'),
    projectFileName: document.getElementById('project-file-name'),
    projectTrackCount: document.getElementById('project-track-count'),
    selectedTrackName: document.getElementById('selected-track-name'),
    selectedTrackKind: document.getElementById('selected-track-kind'),
    selectedTrackStats: document.getElementById('selected-track-stats'),
    selectedTrackLength: document.getElementById('selected-track-length'),
    selectedTrackLanguage: document.getElementById('selected-track-language'),
    selectedTrackVoicebank: document.getElementById('selected-track-voicebank'),
    selectedTrackStatus: document.getElementById('selected-track-status'),
    mainInspector: document.getElementById('main-inspector'),
    btnInspectorToggle: document.getElementById('btn-inspector-toggle'),
    inspectorTabPanels: {
      info: document.getElementById('inspector-tab-info'),
      voicebank: document.getElementById('inspector-tab-voicebank'),
      vc: document.getElementById('inspector-tab-vc'),
      about: document.getElementById('inspector-tab-about'),
    },
    inspectorTabButtons: {
      info: document.getElementById('btn-tab-info'),
      voicebank: document.getElementById('btn-tab-voicebank'),
      vc: document.getElementById('btn-tab-vc'),
      about: document.getElementById('btn-tab-about'),
    },
    voiceConversionSection: document.getElementById('voice-conversion-section'),
    trackView: document.getElementById('track-view'),
    editorPanel: document.getElementById('editor-panel'),
    panelResizer: document.getElementById('panel-resizer'),
    editorTrackName: document.getElementById('active-track-name'),
    editorRuntimeTools: document.getElementById('editor-runtime-tools'),
    emptyHint: document.getElementById('track-empty-hint'),
    trackViewport: document.getElementById('track-viewport'),
    trackTimelineContent: document.getElementById('track-timeline-content'),
    trackRuler: document.getElementById('track-ruler'),
    trackRulerInner: document.getElementById('track-ruler-inner'),
    voiceRuntimeFrame: document.getElementById('voice-runtime-frame'),
    instrumentEditorRoot: document.getElementById('instrument-editor-root'),
    reverbDock: ensureReverbDockPanel(),
    timeDisplay: document.getElementById('time-display'),
  }
}
