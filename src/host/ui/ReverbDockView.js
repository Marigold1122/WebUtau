import { DEFAULT_REVERB_PRESET_TAG } from '../project/ReverbPresetTags.js'
import { normalizeTrackReverbConfig, normalizeTrackReverbSend } from '../project/trackPlaybackState.js'
import { LEGACY_REVERB_ENGINE_ID } from '../audio/reverb/ReverbParameterSchema.js'
import {
  getProjectModuleDefinitions,
  getTrackModuleDefinitions,
} from './reverb/reverbDockDefinitions.js'
import {
  createFxKnobControl,
  createPlaceholderModule,
  createPresetControl,
  createReverbDockModule,
} from './reverb/reverbDockDom.js'

const PROJECT_TEMPLATE_NOTE = 'This template only seeds new tracks and does not overwrite existing track settings.'
const TRACK_TEMPLATE_NOTE = 'This track uses an independent reverb. Send, decay, pre-delay, damp, and return only affect this track.'

export class ReverbDockView {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this.projectPresetTag = DEFAULT_REVERB_PRESET_TAG
    this.trackPresetTags = new Map()
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    this.refs.btnToggleReverbDock?.addEventListener('click', () => {
      this.handlers.onToggleReverbDock?.()
    })
  }

  render({ project = null, tracks = [], viewState = {} } = {}) {
    const dock = this.refs.reverbDock
    const toggleButton = this.refs.btnToggleReverbDock
    if (!dock) return false

    const visible = Boolean(project && viewState?.reverbDockOpen)
    if (toggleButton) {
      toggleButton.disabled = !project
      toggleButton.classList.toggle('accent', visible)
      toggleButton.setAttribute('aria-pressed', String(visible))
    }

    dock.classList.toggle('hidden', !visible)
    dock.replaceChildren()
    if (!visible) return false

    this._pruneTrackPresetTags(tracks)
    const projectModule = this._buildProjectModule(project)
    if (projectModule) dock.appendChild(projectModule)

    const trackMap = new Map((Array.isArray(tracks) ? tracks : []).map((track) => [track.id, track]))
    const openTrackIds = Array.isArray(viewState?.openReverbTrackIds) ? viewState.openReverbTrackIds : []
    const openTracks = openTrackIds
      .map((trackId) => trackMap.get(trackId))
      .filter(Boolean)

    if (openTracks.length === 0) {
      dock.appendChild(createPlaceholderModule())
      return true
    }

    openTracks.forEach((track) => {
      dock.appendChild(this._buildTrackModule(track, project?.mixState?.reverb || null))
    })
    return true
  }

  _buildProjectModule(project) {
    const mixState = project?.mixState || null
    const reverb = mixState?.reverb || null
    if (!reverb) return null
    const engineId = mixState?.reverbEngineId || LEGACY_REVERB_ENGINE_ID

    const controls = this._buildConfigControls({
      definitions: getProjectModuleDefinitions(engineId),
      reverb,
      onInput: (patch) => this.handlers.onProjectReverbConfigChanged?.(patch, { commit: false }),
      onCommit: (patch) => this.handlers.onProjectReverbConfigChanged?.(patch, { commit: true }),
    })

    const presets = this.handlers.getProjectReverbPresets?.() || []
    const presetTags = this.handlers.getProjectReverbPresetTags?.() || []
    const selectedTag = this._resolvePresetTag(this.projectPresetTag, presetTags)
    this.projectPresetTag = selectedTag
    const activePreset = presets.find((preset) => preset.id === mixState?.reverbPresetId) || null
    const footer = createPresetControl({
      presets,
      presetTags,
      selectedTag,
      selectedPresetId: mixState?.reverbPresetId || '',
      onTagChange: (tag) => {
        this.projectPresetTag = this._resolvePresetTag(tag, presetTags)
      },
      onChange: (presetId) => this.handlers.onProjectReverbPresetSelected?.(presetId),
    })

    return createReverbDockModule({
      title: `Default Template - ${activePreset?.name || 'Reverb'}`,
      powered: Number(reverb?.returnGain || 0) > 0.0001,
      onTogglePower: () => this.handlers.onToggleProjectReverbEnabled?.(),
      controls,
      footer,
      note: PROJECT_TEMPLATE_NOTE,
    })
  }

  _buildTrackModule(track, defaultReverb = null) {
    const sendAmount = normalizeTrackReverbSend(track?.playbackState?.reverbSend)
    const reverb = normalizeTrackReverbConfig(track?.playbackState?.reverbConfig, defaultReverb)
    const engineId = track?.playbackState?.reverb?.engineId || LEGACY_REVERB_ENGINE_ID
    const presets = this.handlers.getProjectReverbPresets?.() || []
    const presetTags = this.handlers.getProjectReverbPresetTags?.() || []
    const selectedTag = this._getTrackPresetTag(track.id, presetTags)
    const activePreset = presets.find((preset) => preset.id === track?.playbackState?.reverbPresetId) || null

    const controls = getTrackModuleDefinitions(engineId).map((definition) => {
      if (definition.key === 'reverbSend') {
        return createFxKnobControl({
          label: definition.label,
          min: definition.min,
          max: definition.max,
          step: definition.step,
          tone: definition.tone,
          value: sendAmount,
          format: definition.format,
          onInput: (nextValue) => this.handlers.onTrackReverbSendChanged?.(track.id, nextValue, { commit: false }),
          onCommit: (nextValue) => this.handlers.onTrackReverbSendChanged?.(track.id, nextValue, { commit: true }),
        })
      }

      const value = definition.readValue ? definition.readValue(reverb) : reverb?.[definition.key]
      return createFxKnobControl({
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        tone: definition.tone,
        value,
        format: definition.format,
        onInput: (nextValue) => {
          this.handlers.onTrackReverbConfigChanged?.(
            track.id,
            this._buildConfigPatch(definition, nextValue),
            { commit: false },
          )
        },
        onCommit: (nextValue) => {
          this.handlers.onTrackReverbConfigChanged?.(
            track.id,
            this._buildConfigPatch(definition, nextValue),
            { commit: true },
          )
        },
      })
    })

    const footer = createPresetControl({
      presets,
      presetTags,
      selectedTag,
      selectedPresetId: track?.playbackState?.reverbPresetId || '',
      onTagChange: (tag) => this._setTrackPresetTag(track.id, tag, presetTags),
      onChange: (presetId) => this.handlers.onTrackReverbPresetSelected?.(track.id, presetId),
    })

    return createReverbDockModule({
      title: `Reverb - ${track?.name || 'Track'}`,
      powered: Number(reverb?.returnGain || 0) > 0.0001,
      onTogglePower: () => this.handlers.onToggleTrackReverbEnabled?.(track.id),
      controls,
      footer,
      note: activePreset?.description || TRACK_TEMPLATE_NOTE,
    })
  }

  _buildConfigControls({
    definitions = [],
    reverb = {},
    onInput = null,
    onCommit = null,
  } = {}) {
    return (Array.isArray(definitions) ? definitions : []).map((definition) => {
      const value = definition.readValue ? definition.readValue(reverb) : reverb?.[definition.key]
      return createFxKnobControl({
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        tone: definition.tone,
        value,
        format: definition.format,
        onInput: (nextValue) => onInput?.(this._buildConfigPatch(definition, nextValue)),
        onCommit: (nextValue) => onCommit?.(this._buildConfigPatch(definition, nextValue)),
      })
    })
  }

  _buildConfigPatch(definition, nextValue) {
    return definition?.toConfig
      ? definition.toConfig(nextValue)
      : { [definition.key]: nextValue }
  }

  _resolvePresetTag(tag, presetTags = []) {
    const options = Array.isArray(presetTags) ? presetTags : []
    const optionIds = new Set(options.map((option) => option?.id).filter(Boolean))
    if (optionIds.size === 0) return DEFAULT_REVERB_PRESET_TAG
    if (typeof tag === 'string' && optionIds.has(tag)) return tag
    if (optionIds.has(DEFAULT_REVERB_PRESET_TAG)) return DEFAULT_REVERB_PRESET_TAG
    return options[0]?.id || DEFAULT_REVERB_PRESET_TAG
  }

  _getTrackPresetTag(trackId, presetTags = []) {
    const cachedTag = this.trackPresetTags.get(trackId)
    const resolvedTag = this._resolvePresetTag(cachedTag, presetTags)
    this.trackPresetTags.set(trackId, resolvedTag)
    return resolvedTag
  }

  _setTrackPresetTag(trackId, tag, presetTags = []) {
    if (!trackId) return
    this.trackPresetTags.set(trackId, this._resolvePresetTag(tag, presetTags))
  }

  _pruneTrackPresetTags(tracks = []) {
    const aliveTrackIds = new Set((Array.isArray(tracks) ? tracks : []).map((track) => track?.id).filter(Boolean))
    this.trackPresetTags.forEach((_value, trackId) => {
      if (!aliveTrackIds.has(trackId)) this.trackPresetTags.delete(trackId)
    })
  }
}
