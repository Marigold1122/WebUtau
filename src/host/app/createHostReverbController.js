import { normalizeTrackReverbConfig } from '../project/trackPlaybackState.js'
import { t } from '../../i18n/index.js'

export function createHostReverbController({
  store,
  sessionStore,
  trackShellSessionController,
  projectMixController,
  trackMonitorController,
  render,
  view,
  closeEditorPanel = null,
}) {
  const trackReverbReturnResumeValues = new Map()
  let projectReverbResumeValue = null

  function buildDockStatusText(open) {
    return open
      ? '已打开混响面板 / Reverb panel opened'
      : '已关闭混响面板 / Reverb panel closed'
  }

  function buildTrackRackStatusText(trackName, open) {
    return open
      ? `已打开 ${trackName} 的混响模块 / Opened ${trackName} reverb module`
      : `已关闭 ${trackName} 的混响模块 / Closed ${trackName} reverb module`
  }

  function getProjectReverbPresets(options = {}) {
    return projectMixController.getAvailableReverbPresets(options)
  }

  function getProjectReverbPresetTags() {
    return projectMixController.getAvailableReverbPresetTags()
  }

  function handleProjectReverbPresetSelected(presetId) {
    const mixState = projectMixController.setProjectReverbPreset(presetId)
    const presetName = getProjectReverbPresets()
      .find((preset) => preset.id === mixState.reverbPresetId)
      ?.name || mixState.reverbPresetId
    render('project-reverb-preset-changed')
    view.setStatus(t('hostStatus.reverb_template_switched', { name: presetName }))
    return mixState
  }

  function handleProjectReverbConfigChanged(config, { commit = true } = {}) {
    const mixState = projectMixController.setProjectReverbConfig(config, { commit })
    if (commit) {
      render('project-reverb-config-changed')
      view.setStatus(t('hostStatus.reverb_template_updated'))
    }
    return mixState
  }

  function handleTrackReverbConfigChanged(trackId, config, options = {}) {
    return trackMonitorController.setTrackReverbConfig(trackId, config, options)
  }

  function handleTrackReverbPresetSelected(trackId, presetId) {
    return trackMonitorController.setTrackReverbPreset(trackId, presetId)
  }

  function toggleReverbDock() {
    if (!store.getProject()) {
      sessionStore.setReverbDockOpen(false)
      render('reverb-dock-unavailable')
      view.setStatus(t('hostStatus.import_project_first'))
      return false
    }

    // dock 是 tab 容器：点击"混响"按钮的语义是
    //   - 已在 reverb tab 且 dock 开 → 关闭 dock
    //   - 否则 → 打开 dock + 切到 reverb tab
    const dockOpen = sessionStore.isReverbDockOpen()
    const currentTab = sessionStore.getActiveDockTab()
    const alreadyShowingReverb = dockOpen && currentTab === 'reverb'
    const nextOpen = !alreadyShowingReverb
    sessionStore.setReverbDockOpen(nextOpen)
    sessionStore.setActiveDockTab('reverb')
    // 打开 dock 时关闭编辑器——两个面板互斥，避免高度争抢
    if (nextOpen) closeEditorPanel?.()
    render(nextOpen ? 'reverb-dock-opened' : 'reverb-dock-closed')
    view.setStatus(buildDockStatusText(nextOpen))
    return nextOpen
  }

  function toggleMixerDock() {
    if (!store.getProject()) {
      sessionStore.setReverbDockOpen(false)
      render('mixer-dock-unavailable')
      view.setStatus(t('hostStatus.import_project_first'))
      return false
    }
    const dockOpen = sessionStore.isReverbDockOpen()
    const currentTab = sessionStore.getActiveDockTab()
    const alreadyShowingMixer = dockOpen && currentTab === 'mixer'
    const nextOpen = !alreadyShowingMixer
    sessionStore.setReverbDockOpen(nextOpen)
    sessionStore.setActiveDockTab('mixer')
    if (nextOpen) closeEditorPanel?.()
    render(nextOpen ? 'mixer-dock-opened' : 'mixer-dock-closed')
    view.setStatus(buildDockStatusText(nextOpen))
    return nextOpen
  }

  // tab 切换：dock 不关，只切内部活动 tab
  function setActiveDockTab(tab) {
    const next = sessionStore.setActiveDockTab(tab)
    render(`active-dock-tab-${next}`)
    return next
  }

  // 关 dock 入口（tabbar 右端的 × 按钮调）：不论当前在哪个 tab 都关
  function closeBottomDock() {
    if (!sessionStore.isReverbDockOpen()) return false
    sessionStore.setReverbDockOpen(false)
    render('bottom-dock-closed')
    return false
  }

  function toggleTrackFxPanel(trackId) {
    const track = trackId ? store.getTrack(trackId) : null
    if (!track) return false

    trackShellSessionController.selectTrack(trackId, { closeReason: 'track-fx-toggle' })
    const trackModuleOpen = sessionStore.toggleReverbTrack(trackId)
    const nextDockOpen = sessionStore.getOpenReverbTrackIds().length > 0
      ? sessionStore.setReverbDockOpen(true)
      : sessionStore.setReverbDockOpen(false)
    // 点击单轨 fx 按钮的语义是"打开混响并调参"——强制切到 reverb tab，
    // 否则用户从 mixer tab 点 fx 后 dock 没变化、混响参数也没出来，体验断裂
    if (nextDockOpen) sessionStore.setActiveDockTab('reverb')
    // 单轨 fx 让 dock 打开时也走互斥——编辑器若开着会被收回
    if (nextDockOpen) closeEditorPanel?.()
    render(trackModuleOpen ? 'track-fx-opened' : 'track-fx-closed')
    view.setStatus(trackModuleOpen
      ? buildTrackRackStatusText(track.name, true)
      : (nextDockOpen
          ? buildTrackRackStatusText(track.name, false)
          : buildDockStatusText(false)))
    return trackModuleOpen
  }

  function toggleProjectReverbEnabled() {
    const mixState = projectMixController.getMixState()
    const currentReturnGain = Number(mixState?.reverb?.returnGain) || 0
    if (currentReturnGain > 0.0001) {
      projectReverbResumeValue = currentReturnGain
      handleProjectReverbConfigChanged({ returnGain: 0 }, { commit: true })
      return false
    }

    const presetReturnGain = getProjectReverbPresets()
      .find((preset) => preset.id === mixState?.reverbPresetId)
      ?.config?.returnGain
    const nextReturnGain = projectReverbResumeValue ?? presetReturnGain ?? 0.9
    handleProjectReverbConfigChanged({ returnGain: nextReturnGain }, { commit: true })
    return true
  }

  async function toggleTrackReverbEnabled(trackId) {
    const track = store.getTrack(trackId)
    if (!track) return false

    const currentConfig = normalizeTrackReverbConfig(track.playbackState?.reverbConfig)
    const currentReturnGain = Number(currentConfig?.returnGain) || 0
    if (currentReturnGain > 0.0001) {
      trackReverbReturnResumeValues.set(trackId, currentReturnGain)
      await trackMonitorController.setTrackReverbConfig(trackId, { returnGain: 0 }, { commit: true })
      return false
    }

    const presetReturnGain = getProjectReverbPresets()
      .find((preset) => preset.id === track?.playbackState?.reverbPresetId)
      ?.config?.returnGain
    const nextReturnGain = trackReverbReturnResumeValues.get(trackId) ?? presetReturnGain ?? 0.9
    await trackMonitorController.setTrackReverbConfig(trackId, { returnGain: nextReturnGain }, { commit: true })
    return true
  }

  return {
    getProjectReverbPresets,
    getProjectReverbPresetTags,
    handleProjectReverbPresetSelected,
    handleProjectReverbConfigChanged,
    handleTrackReverbConfigChanged,
    handleTrackReverbPresetSelected,
    toggleReverbDock,
    toggleMixerDock,
    setActiveDockTab,
    closeBottomDock,
    toggleTrackFxPanel,
    toggleProjectReverbEnabled,
    toggleTrackReverbEnabled,
  }
}
