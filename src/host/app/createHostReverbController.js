import { normalizeTrackReverbConfig } from '../project/trackPlaybackState.js'

export function createHostReverbController({
  store,
  sessionStore,
  trackShellSessionController,
  projectMixController,
  trackMonitorController,
  render,
  view,
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
    view.setStatus(`已切换默认混响模板到 ${presetName} / Default reverb template switched to ${presetName}`)
    return mixState
  }

  function handleProjectReverbConfigChanged(config, { commit = true } = {}) {
    const mixState = projectMixController.setProjectReverbConfig(config, { commit })
    if (commit) {
      render('project-reverb-config-changed')
      view.setStatus('默认混响模板已更新 / Default reverb template updated')
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
      view.setStatus('请先导入项目 / Import a project first')
      return false
    }

    const nextOpen = sessionStore.toggleReverbDock()
    render(nextOpen ? 'reverb-dock-opened' : 'reverb-dock-closed')
    view.setStatus(buildDockStatusText(nextOpen))
    return nextOpen
  }

  function toggleTrackFxPanel(trackId) {
    const track = trackId ? store.getTrack(trackId) : null
    if (!track) return false

    trackShellSessionController.selectTrack(trackId, { closeReason: 'track-fx-toggle' })
    const trackModuleOpen = sessionStore.toggleReverbTrack(trackId)
    const nextDockOpen = sessionStore.getOpenReverbTrackIds().length > 0
      ? sessionStore.setReverbDockOpen(true)
      : sessionStore.setReverbDockOpen(false)
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
    toggleTrackFxPanel,
    toggleProjectReverbEnabled,
    toggleTrackReverbEnabled,
  }
}
