import { createProjectMixState } from '../projectMixState.js'
import { createTrackPlaybackState, normalizeTrackReverbConfig, normalizeTrackReverbSend } from '../trackPlaybackState.js'

const EPSILON = 0.0001

function cloneProject(project = null) {
  if (!project || typeof project !== 'object') return project
  if (typeof structuredClone === 'function') {
    return structuredClone(project)
  }
  return JSON.parse(JSON.stringify(project))
}

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function nearlyEqual(left, right, epsilon = EPSILON) {
  return Math.abs(toFiniteNumber(left) - toFiniteNumber(right)) < epsilon
}

function isSameReverbConfig(left = {}, right = {}) {
  const keys = ['decaySec', 'decayCurve', 'preDelaySec', 'lowCutHz', 'highCutHz', 'returnGain']
  return keys.every((key) => nearlyEqual(left?.[key], right?.[key]))
}

function isSameTrackReverbState(before = {}, after = {}) {
  if (!before?.reverb || !after?.reverb) return false
  if (before.reverb?.engineId !== after.reverb?.engineId) return false
  if (before.reverb?.presetId !== after.reverb?.presetId) return false
  if (Boolean(before.reverb?.enabled) !== Boolean(after.reverb?.enabled)) return false
  if (!nearlyEqual(before.reverb?.send, after.reverb?.send)) return false
  if (!isSameReverbConfig(before.reverb?.config, after.reverb?.config)) return false
  if (before.reverbPresetId !== after.reverbPresetId) return false
  if (!nearlyEqual(before.reverbSend, after.reverbSend)) return false
  if (!isSameReverbConfig(before.reverbConfig, after.reverbConfig)) return false
  return true
}

function buildPlaybackDefaults(mixState = null) {
  const defaultConfig = normalizeTrackReverbConfig(mixState?.reverb)
  return {
    reverbPresetId: mixState?.reverbPresetId,
    reverbConfig: defaultConfig,
    reverb: {
      presetId: mixState?.reverbPresetId,
      send: normalizeTrackReverbSend(0),
      enabled: Number(defaultConfig?.returnGain || 0) > EPSILON,
      config: defaultConfig,
    },
  }
}

export function migrateProjectReverbState(project = null) {
  if (!project || typeof project !== 'object') {
    return { project, changed: false, warnings: ['project-not-object'] }
  }

  const warnings = []
  const migratedProject = cloneProject(project)
  const mixState = createProjectMixState(migratedProject?.mixState)
  const playbackDefaults = buildPlaybackDefaults(mixState)
  let changed = false

  migratedProject.mixState = mixState
  if (!Array.isArray(migratedProject?.tracks)) {
    warnings.push('tracks-not-array')
    return {
      project: migratedProject,
      changed: mixState !== project?.mixState,
      warnings,
    }
  }

  migratedProject.tracks = migratedProject.tracks.map((track) => {
    if (!track || typeof track !== 'object') {
      warnings.push('track-not-object')
      return track
    }
    const beforePlayback = track?.playbackState || {}
    const afterPlayback = createTrackPlaybackState(beforePlayback, playbackDefaults)
    if (!isSameTrackReverbState(beforePlayback, afterPlayback)) {
      changed = true
    }
    return {
      ...track,
      playbackState: afterPlayback,
    }
  })

  return {
    project: migratedProject,
    changed,
    warnings,
  }
}
