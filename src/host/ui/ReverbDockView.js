import { DEFAULT_REVERB_PRESET_TAG } from '../project/ReverbPresetTags.js'
import { normalizeMasterChain } from '../project/masterChainState.js'
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
const MASTER_CHAIN_NOTE = '主控母带链作用于所有轨道汇总后的最终输出（EQ → 压缩 → 限幅）。默认开启以防爆音，追求原声请关闭。'
const MASTER_CHAIN_ONBOARDING_KEY = 'webutau:master-chain-onboarded'

function readOnboardingFlag() {
  try { return globalThis.localStorage?.getItem?.(MASTER_CHAIN_ONBOARDING_KEY) === '1' }
  catch (_e) { return true } // 拿不到 storage 就视作已引导过——别打扰用户
}

function writeOnboardingFlag() {
  try { globalThis.localStorage?.setItem?.(MASTER_CHAIN_ONBOARDING_KEY, '1') }
  catch (_e) { /* private mode 之类直接无视 */ }
}

export class ReverbDockView {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this.projectPresetTag = DEFAULT_REVERB_PRESET_TAG
    this.trackPresetTags = new Map()
    // 跨 render() 记忆上一次的 dock 状态，用来决定哪些动画该播：
    // - dock 闭→开 时整面 slide-up 动画
    // - 已经开着时新出现的 track 模块单独 slide-in，已存在的不重复动画
    this._wasVisible = false
    this._previousOpenTrackIds = new Set()
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
    if (!visible) {
      this._wasVisible = false
      this._previousOpenTrackIds = new Set()
      return false
    }

    // 闭→开 是"显著状态切换"——给 dock 一次 slide-up + fade 动画，让用户清楚看到入场。
    // requestAnimationFrame 双层包裹是为了避开 display:none→flex 同帧加 class 不重启动画的坑：
    // 第一帧让浏览器完成 display 变化的样式计算；下一帧再加 class，动画就一定会播
    const justOpened = !this._wasVisible
    if (justOpened) {
      dock.classList.remove('is-opening')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          dock.classList.add('is-opening')
          const handleAnimEnd = () => {
            dock.classList.remove('is-opening')
            dock.removeEventListener('animationend', handleAnimEnd)
          }
          dock.addEventListener('animationend', handleAnimEnd)
        })
      })
    }

    this._pruneTrackPresetTags(tracks)

    const trackMap = new Map((Array.isArray(tracks) ? tracks : []).map((track) => [track.id, track]))
    const openTrackIds = Array.isArray(viewState?.openReverbTrackIds) ? viewState.openReverbTrackIds : []
    const openTracks = openTrackIds
      .map((trackId) => trackMap.get(trackId))
      .filter(Boolean)
    const hasOpenTrack = openTracks.length > 0

    // 模块顺序根据用户进入意图变化：
    //  - 用户从顶栏电平表点进来（没打开任何单轨 fx）—— 主控母带链放最前
    //  - 用户从某轨 fx 按钮点进来（openTracks > 0）—— 单轨模块放最前，
    //    主控/工程模板退到后面，避免那条金色 banner 抢戏让用户误以为在调全局
    const nextOpenTrackIds = new Set()
    const newlyAddedTrackIds = []
    const trackModules = openTracks.map((track) => {
      const trackModule = this._buildTrackModule(track, project?.mixState?.reverb || null)
      if (!justOpened && !this._previousOpenTrackIds.has(track.id)) {
        newlyAddedTrackIds.push(track.id)
        trackModule.classList.add('is-entering')
        const handleEnterEnd = () => {
          trackModule.classList.remove('is-entering')
          trackModule.removeEventListener('animationend', handleEnterEnd)
        }
        trackModule.addEventListener('animationend', handleEnterEnd)
      }
      nextOpenTrackIds.add(track.id)
      return { id: track.id, node: trackModule }
    })

    const masterChainModule = this._buildMasterChainModule(project)
    const projectModule = this._buildProjectModule(project)

    if (hasOpenTrack) {
      // 单轨在前：让用户视线先落到自己刚点开的 fx
      trackModules.forEach(({ node }) => dock.appendChild(node))
      if (masterChainModule) dock.appendChild(masterChainModule)
      if (projectModule) dock.appendChild(projectModule)
    } else {
      // 没有打开的单轨——主控/工程模板正常显示，最后一个 placeholder 提示用户去点 fx
      if (masterChainModule) dock.appendChild(masterChainModule)
      if (projectModule) dock.appendChild(projectModule)
      dock.appendChild(createPlaceholderModule())
    }

    if (masterChainModule && !readOnboardingFlag()) {
      requestAnimationFrame(() => this._showMasterChainOnboarding(masterChainModule))
    }

    // 已经打开 dock 的状态下新增 track，把刚加的那块滚进视野；
    // 否则——整面新打开时——交给外部 (createHostApp 里 onBezelClick / track fx 触发器) 决定滚到哪儿
    if (!justOpened && newlyAddedTrackIds.length > 0) {
      const focusId = newlyAddedTrackIds[newlyAddedTrackIds.length - 1]
      const focusNode = trackModules.find((entry) => entry.id === focusId)?.node
      focusNode?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }

    this._wasVisible = true
    this._previousOpenTrackIds = nextOpenTrackIds
    return true
  }

  // 主控母带链模块：4 段 EQ gain + 5 个压缩参数 + 1 个限幅 ceiling，
  // 共 10 个 knob 在一个 fx-module 里 wrap 显示。整链一个开关，底部有预设下拉
  _buildMasterChainModule(project) {
    const chain = normalizeMasterChain(project?.mixState?.masterChain)
    const controls = []

    // EQ：4 段都有固定的频率中心点；label 用"频率 (中文位置)"格式
    const eqLabels = [
      { label: '80 Hz (低频)',     bandIndex: 0 },
      { label: '400 Hz (中低频)',  bandIndex: 1 },
      { label: '2.5 kHz (中高频)', bandIndex: 2 },
      { label: '10 kHz (高频)',    bandIndex: 3 },
    ]
    eqLabels.forEach(({ label, bandIndex }) => {
      const band = chain.eq.bands[bandIndex]
      controls.push(createFxKnobControl({
        label,
        min: -18, max: 18, step: 0.1,
        tone: 'green',
        value: band.gain,
        format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
        onInput: (v) => this.handlers.onMasterEqBandChanged?.(bandIndex, { gain: v }, { commit: false }),
        onCommit: (v) => this.handlers.onMasterEqBandChanged?.(bandIndex, { gain: v }, { commit: true }),
      }))
    })

    const comp = chain.compressor
    controls.push(createFxKnobControl({
      label: 'Threshold (压缩阈值)',
      min: -60, max: 0, step: 0.1, tone: 'orange',
      value: comp.threshold,
      format: (v) => `${v.toFixed(1)} dB`,
      onInput: (v) => this.handlers.onMasterCompressorChanged?.({ threshold: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterCompressorChanged?.({ threshold: v }, { commit: true }),
    }))
    controls.push(createFxKnobControl({
      label: 'Ratio (压缩比)',
      min: 1, max: 20, step: 0.1, tone: 'orange',
      value: comp.ratio,
      format: (v) => `${v.toFixed(1)}:1`,
      onInput: (v) => this.handlers.onMasterCompressorChanged?.({ ratio: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterCompressorChanged?.({ ratio: v }, { commit: true }),
    }))
    controls.push(createFxKnobControl({
      label: 'Attack (起音时间)',
      min: 0, max: 0.3, step: 0.001, tone: 'orange',
      value: comp.attack,
      format: (v) => `${Math.round(v * 1000)} ms`,
      onInput: (v) => this.handlers.onMasterCompressorChanged?.({ attack: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterCompressorChanged?.({ attack: v }, { commit: true }),
    }))
    controls.push(createFxKnobControl({
      label: 'Release (释放时间)',
      min: 0.01, max: 1, step: 0.001, tone: 'orange',
      value: comp.release,
      format: (v) => `${Math.round(v * 1000)} ms`,
      onInput: (v) => this.handlers.onMasterCompressorChanged?.({ release: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterCompressorChanged?.({ release: v }, { commit: true }),
    }))
    controls.push(createFxKnobControl({
      label: 'Makeup (补偿增益)',
      min: -12, max: 24, step: 0.1, tone: 'orange',
      value: comp.makeupGain,
      format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
      onInput: (v) => this.handlers.onMasterCompressorChanged?.({ makeupGain: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterCompressorChanged?.({ makeupGain: v }, { commit: true }),
    }))

    controls.push(createFxKnobControl({
      label: 'Ceiling (限幅天花板)',
      min: -12, max: 0, step: 0.1, tone: 'red',
      value: chain.limiter.threshold,
      format: (v) => `${v.toFixed(1)} dB`,
      onInput: (v) => this.handlers.onMasterLimiterChanged?.({ threshold: v }, { commit: false }),
      onCommit: (v) => this.handlers.onMasterLimiterChanged?.({ threshold: v }, { commit: true }),
    }))

    const presets = this.handlers.getMasterChainPresets?.() || []
    const footer = this._buildMasterChainPresetFooter(presets, chain.presetId)

    const module = createReverbDockModule({
      title: 'Master Chain (主控母带链)',
      powered: chain.enabled,
      onTogglePower: () => this.handlers.onMasterChainEnabledToggled?.(),
      controls,
      footer,
      note: MASTER_CHAIN_NOTE,
      scopeBadge: { text: '应用于所有轨道', tone: 'global' },
    })
    // 给外部钩子（首次提示 / D 方案聚焦）一个识别标识
    module.classList.add('fx-module--master-chain')
    module.dataset.masterChain = '1'
    // 在 header 之后插一条 banner，进一步强调"作用于全工程最终输出"——
    // 用户从顶栏电平表点进来时一眼能看出这跟单轨 fx 不一样
    const scopeBanner = document.createElement('div')
    scopeBanner.className = 'fx-module-scope-banner'
    scopeBanner.innerHTML = '<span class="fx-module-scope-banner-icon" aria-hidden="true">⌬</span>'
      + '<span class="fx-module-scope-banner-text">全局总线 · 作用于所有轨道汇总后的最终输出</span>'
    module.insertBefore(scopeBanner, module.children[1] || null)
    return module
  }

  // 状态式 preset 下拉：显示当前激活的预设名；用户调旋钮后预设失效自动回到 "Custom (自定义)"
  _buildMasterChainPresetFooter(presets, currentPresetId) {
    const root = document.createElement('div')
    root.className = 'fx-screen-row'

    const label = document.createElement('label')
    label.className = 'fx-screen-label'
    label.textContent = 'Preset (预设)'

    const select = document.createElement('select')
    select.className = 'fx-screen-select'
    select.disabled = !Array.isArray(presets) || presets.length === 0

    // 自定义占位选项——presetId 为 null 时（手动调过参的状态）显示
    const customOption = document.createElement('option')
    customOption.value = ''
    customOption.textContent = 'Custom (自定义)'
    select.appendChild(customOption)
    ;(presets || []).forEach((preset) => {
      const option = document.createElement('option')
      option.value = preset.id
      option.textContent = preset.name
      if (preset.description) option.title = preset.description
      select.appendChild(option)
    })

    // 反映当前 chain.presetId
    select.value = (typeof currentPresetId === 'string' && currentPresetId) ? currentPresetId : ''

    select.addEventListener('change', (event) => {
      const presetId = event.target.value
      if (!presetId) {
        // 用户手动选了 "Custom"，本身没什么有效语义——把 select 拉回真实状态
        select.value = (typeof currentPresetId === 'string' && currentPresetId) ? currentPresetId : ''
        return
      }
      this.handlers.onMasterChainPresetSelected?.(presetId)
    })

    root.append(label, select)
    return root
  }

  _showMasterChainOnboarding(module) {
    const powerButton = module.querySelector('.fx-power')
    if (!powerButton || !document.body) return
    if (document.body.querySelector('.master-chain-onboarding')) return // 别叠多层

    const tooltip = document.createElement('div')
    tooltip.className = 'master-chain-onboarding'
    tooltip.setAttribute('role', 'dialog')

    const text = document.createElement('div')
    text.className = 'master-chain-onboarding-text'
    text.textContent = '主控母带链默认开启，能自动防止爆音并把响度提升到商业级。如果追求原始声音不被处理，请点这里关闭。'

    const arrow = document.createElement('span')
    arrow.className = 'master-chain-onboarding-arrow'
    arrow.setAttribute('aria-hidden', 'true')

    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'master-chain-onboarding-dismiss'
    dismiss.textContent = '知道了'

    tooltip.append(text, dismiss, arrow)
    document.body.appendChild(tooltip)

    // 定位到 power button 上方居中（getBoundingClientRect 之后才能算真实位置）
    const positionTooltip = () => {
      const rect = powerButton.getBoundingClientRect()
      const tipRect = tooltip.getBoundingClientRect()
      const top = Math.max(8, rect.top - tipRect.height - 12)
      const left = Math.max(8, Math.min(
        window.innerWidth - tipRect.width - 8,
        rect.left + rect.width / 2 - tipRect.width / 2,
      ))
      tooltip.style.top = `${top}px`
      tooltip.style.left = `${left}px`
      // 箭头指向 power button 中心
      const arrowLeft = rect.left + rect.width / 2 - left
      arrow.style.left = `${Math.max(12, Math.min(tipRect.width - 12, arrowLeft))}px`
    }
    positionTooltip()
    // 让 tooltip 入场动画跑完后再二次定位（避免动画里的 transform 影响测量）
    requestAnimationFrame(() => requestAnimationFrame(positionTooltip))

    const close = () => {
      writeOnboardingFlag()
      tooltip.remove()
      window.removeEventListener('resize', positionTooltip)
    }
    dismiss.addEventListener('click', close)
    window.addEventListener('resize', positionTooltip)
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
      scopeBadge: { text: '工程模板', tone: 'project' },
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
      scopeBadge: { text: '单轨', tone: 'track' },
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
