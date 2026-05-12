import { t } from '../../i18n/index.js'

// 混响 / 混音器按钮统一放在顶栏 .menubar-tail 的最左侧——
// 历史上有过 .tools-center 锚点，但 index.html 里没有这个元素，导致按钮一直创建失败；
// 现在锚定到顶栏 .menubar-tail（主题切换、follow 模式所在区），用户能直接看见
function ensureMenubarDockButton({ id, i18nKey, position = 'prepend' }) {
  let button = document.getElementById(id)
  if (button) return button

  const tail = document.querySelector('.menubar-tail')
  if (!tail) return null

  button = document.createElement('button')
  button.type = 'button'
  button.className = 'menubar-dock-btn'
  button.id = id
  button.setAttribute('data-i18n', i18nKey)
  button.textContent = t(i18nKey)
  if (position === 'prepend') {
    tail.insertAdjacentElement('afterbegin', button)
  } else {
    tail.appendChild(button)
  }
  return button
}

function ensureReverbDockToggleButton() {
  return ensureMenubarDockButton({
    id: 'btn-toggle-reverb-dock',
    i18nKey: 'reverb.panel_button',
    position: 'prepend',
  })
}

// Mixer 按钮要在 Reverb **前面**（左到右阅读顺序：Mixer 优先）
function ensureMixerDockToggleButton() {
  // 先确保 Reverb 已存在，再 prepend Mixer，让它落在 Reverb 之前
  ensureReverbDockToggleButton()
  return ensureMenubarDockButton({
    id: 'btn-toggle-mixer-dock',
    i18nKey: 'mixer.panel_button',
    position: 'prepend',
  })
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

// Mixer dock 面板：和 reverb-dock 是平级 sibling，**紧贴 reverb-dock 之后**；
// tab 切换通过显隐控制（不互相覆盖、不挪 DOM）
function ensureMixerDockPanel() {
  let panel = document.getElementById('mixer-dock')
  if (panel) return panel

  const reverbDock = ensureReverbDockPanel()
  if (!reverbDock) return null

  panel = document.createElement('section')
  panel.id = 'mixer-dock'
  panel.className = 'bottom-fx-panel mixer-dock hidden'
  panel.setAttribute('data-i18n-attr', 'aria-label:mixer.panel_aria')
  panel.setAttribute('aria-label', t('mixer.panel_aria'))
  reverbDock.insertAdjacentElement('afterend', panel)
  return panel
}

// 底部 dock tab 栏：插在 reverb-dock 上方（在 resizer 之后）。
// 两个 tab 按钮：Mixer / Reverb，点击切换 activeDockTab
function ensureBottomDockTabbar() {
  let tabbar = document.getElementById('bottom-dock-tabbar')
  if (tabbar) return tabbar

  const reverbDock = ensureReverbDockPanel()
  if (!reverbDock) return null

  tabbar = document.createElement('div')
  tabbar.id = 'bottom-dock-tabbar'
  tabbar.className = 'bottom-dock-tabbar hidden'
  tabbar.setAttribute('role', 'tablist')

  const makeTab = (tabKey, i18nKey) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'bottom-dock-tab'
    btn.id = `bottom-dock-tab-${tabKey}`
    btn.dataset.tab = tabKey
    btn.setAttribute('role', 'tab')
    btn.setAttribute('data-i18n', i18nKey)
    btn.textContent = t(i18nKey)
    return btn
  }
  tabbar.appendChild(makeTab('mixer', 'mixer.tab_label'))
  tabbar.appendChild(makeTab('reverb', 'reverb.tab_label'))

  // 关闭按钮：紧贴 tabbar 右端、独立 flex 推到最右
  const btnClose = document.createElement('button')
  btnClose.type = 'button'
  btnClose.id = 'bottom-dock-close'
  btnClose.className = 'bottom-dock-close'
  btnClose.setAttribute('data-i18n-attr', 'aria-label:modal.common.close')
  btnClose.setAttribute('aria-label', t('modal.common.close'))
  btnClose.textContent = '×'
  tabbar.appendChild(btnClose)

  reverbDock.insertAdjacentElement('beforebegin', tabbar)
  return tabbar
}

// 拖拽手柄必须紧贴底部 dock 上方——以前是 reverb-dock 之前；现在改为 tabbar 之前
// （tabbar + dock content 整体作为底部面板，resizer 在最上方）
function ensureReverbDockResizer() {
  let resizer = document.getElementById('reverb-dock-resizer')
  if (resizer) return resizer

  // 现在 tabbar 在 dock 之前，所以 resizer 应插在 tabbar 之前——保持原本"在底部 dock 上方"语义
  const tabbar = ensureBottomDockTabbar()
  const dock = ensureReverbDockPanel()
  if (!dock) return null

  resizer = document.createElement('div')
  resizer.id = 'reverb-dock-resizer'
  resizer.className = 'reverb-dock-resizer hidden'
  resizer.setAttribute('aria-hidden', 'true')
  ;(tabbar || dock).insertAdjacentElement('beforebegin', resizer)
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
    btnToggleReverbDock: ensureReverbDockToggleButton(),
    btnToggleMixerDock: ensureMixerDockToggleButton(),
    btnCloseEditor: document.getElementById('btn-close-editor'),
    btnTopPrev: document.getElementById('btn-top-prev'),
    btnTopPlay: document.getElementById('btn-top-play'),
    btnTopStop: document.getElementById('btn-top-stop'),
    btnTopRecord: document.getElementById('btn-top-record'),
    btnTopNext: document.getElementById('btn-top-next'),
    menubarFollowTools: document.getElementById('menubar-follow-tools'),
    renderBadge: document.getElementById('render-status-badge'),
    statusText: document.getElementById('status-text'),
    statusBar: document.getElementById('status-bar'),
    statusContext: document.getElementById('status-context'),
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
    mixerDock: ensureMixerDockPanel(),
    bottomDockTabbar: ensureBottomDockTabbar(),
  }
}
