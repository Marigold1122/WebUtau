import { t } from '../../i18n/index.js'

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
  button.setAttribute('data-i18n', 'reverb.panel_button')
  button.textContent = t('reverb.panel_button')
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
  panel.setAttribute('data-i18n-attr', 'aria-label:reverb.panel_aria')
  panel.setAttribute('aria-label', t('reverb.panel_aria'))
  editorPanel.insertAdjacentElement('afterend', panel)
  return panel
}

// 拖拽手柄必须紧贴 reverb-dock 上方——dock 是 flex 末项，
// 把 resizer 插在 dock 之前就能与 panel-resizer 一致地"通过 ns-resize 改 flex 邻项的大小"
function ensureReverbDockResizer() {
  let resizer = document.getElementById('reverb-dock-resizer')
  if (resizer) return resizer

  const dock = ensureReverbDockPanel()
  if (!dock) return null

  resizer = document.createElement('div')
  resizer.id = 'reverb-dock-resizer'
  resizer.className = 'reverb-dock-resizer hidden'
  resizer.setAttribute('aria-hidden', 'true')
  dock.insertAdjacentElement('beforebegin', resizer)
  return resizer
}

export function createShellLayoutRefs() {
  return {
    workspace: document.getElementById('workspace'),
    fileInput: document.getElementById('midi-file-input'),
    audioFileInput: document.getElementById('audio-file-input'),
    ustxFileInput: document.getElementById('ustx-file-input'),
    btnImport: document.getElementById('btn-import'),
    menubarProjectPlate: document.getElementById('menubar-project-plate'),
    menubarProjectPlateName: document.getElementById('menubar-project-plate-name'),
    menubarProjectPlateDot: document.getElementById('menubar-project-plate-dot'),
    projectRecoveryModal: document.getElementById('project-recovery-modal'),
    projectRecoverySummary: document.getElementById('project-recovery-summary'),
    btnProjectRecoveryRestore: document.getElementById('btn-project-recovery-restore'),
    btnProjectRecoveryDiscard: document.getElementById('btn-project-recovery-discard'),
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
    selectedTrackName: document.getElementById('selected-track-name'),
    selectedTrackKind: document.getElementById('selected-track-kind'),
    selectedTrackLanguage: document.getElementById('selected-track-language'),
    selectedTrackVoicebank: document.getElementById('selected-track-voicebank'),
    selectedTrackStatus: document.getElementById('selected-track-status'),
    mainInspector: document.getElementById('main-inspector'),
    btnInspectorToggle: document.getElementById('btn-inspector-toggle'),
    // 手风琴 section（每个顶层 section 是 <details>；按轨道类型控制 hidden）
    inspectorSectionTrack: document.getElementById('inspector-section-track'),
    inspectorSectionVoicebank: document.getElementById('inspector-section-voicebank'),
    inspectorSectionTone: document.getElementById('inspector-section-tone'),
    inspectorSectionVc: document.getElementById('inspector-section-vc'),
    inspectorSectionShare: document.getElementById('inspector-section-share'),
    // 乐器音色的内容挂载点；父 section 可容纳多个子模块（当下只有吉他 Amp Sim 3）
    inspectorToneSlot: document.getElementById('inspector-tone-slot'),
    // 兼容老 ref 名（TrackTonePanelView 仍然用 inspectorTonePanel 读取）
    inspectorTonePanel: document.getElementById('inspector-tone-slot'),
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
    reverbDockResizer: ensureReverbDockResizer(),
    timeDisplay: document.getElementById('time-display'),
  }
}
