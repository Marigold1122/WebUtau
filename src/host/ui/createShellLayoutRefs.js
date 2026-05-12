import { t } from '../../i18n/index.js'

// 混响 / 混音器按钮：参考 Studio One / Logic 顶栏的"功能模块按钮"——
// 比普通"模式切换"按钮（如滚动 / 跟踪 / 翻页 / 推移）视觉更重，带专属图标 + 立体感，
// 让用户一眼看出这是"打开主功能"而非"切换模式"
const DOCK_BUTTON_ICONS = {
  // Mixer：3 条纵向推子的简化形——一眼联想到调音台 channel strip
  mixer: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">'
    + '<line x1="4" y1="2.5" x2="4" y2="13.5"/>'
    + '<line x1="8" y1="2.5" x2="8" y2="13.5"/>'
    + '<line x1="12" y1="2.5" x2="12" y2="13.5"/>'
    + '<rect x="2.4" y="4.5" width="3.2" height="2" rx="0.5" fill="currentColor" stroke="none"/>'
    + '<rect x="6.4" y="9" width="3.2" height="2" rx="0.5" fill="currentColor" stroke="none"/>'
    + '<rect x="10.4" y="6.5" width="3.2" height="2" rx="0.5" fill="currentColor" stroke="none"/>'
    + '</svg>',
  // Reverb：脉冲 + 衰减尾部——经典 reverb 可视化
  reverb: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">'
    + '<line x1="3" y1="3" x2="3" y2="13" stroke-width="1.6"/>'
    + '<line x1="5.5" y1="5" x2="5.5" y2="11" stroke-width="1.3"/>'
    + '<line x1="8" y1="6" x2="8" y2="10" stroke-width="1.1"/>'
    + '<line x1="10.5" y1="6.8" x2="10.5" y2="9.2" stroke-width="0.9"/>'
    + '<line x1="13" y1="7.3" x2="13" y2="8.7" stroke-width="0.7"/>'
    + '</svg>',
}

function ensureMenubarDockButton({ id, i18nKey, iconKey, position = 'prepend' }) {
  let button = document.getElementById(id)
  if (button) return button

  const tail = document.querySelector('.menubar-tail')
  if (!tail) return null

  button = document.createElement('button')
  button.type = 'button'
  button.className = 'menubar-dock-btn'
  button.id = id
  // 图标 + 文本结构 —— icon 元素吃 currentColor、自动跟随按钮文字色
  const iconSvg = DOCK_BUTTON_ICONS[iconKey] || ''
  if (iconSvg) {
    const iconWrap = document.createElement('span')
    iconWrap.className = 'menubar-dock-btn-icon'
    iconWrap.innerHTML = iconSvg
    button.appendChild(iconWrap)
  }
  const labelSpan = document.createElement('span')
  labelSpan.className = 'menubar-dock-btn-label'
  labelSpan.setAttribute('data-i18n', i18nKey)
  labelSpan.textContent = t(i18nKey)
  button.appendChild(labelSpan)
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
    iconKey: 'reverb',
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
    iconKey: 'mixer',
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
