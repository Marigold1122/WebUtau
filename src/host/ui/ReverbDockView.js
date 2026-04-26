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
    // LUFS 仪表订阅句柄；render() 重建 DOM 时要先撤回，避免向已经从 DOM 摘掉的旧 refs 写
    this._lufsUnsubscribe = null
    this._lufsRefs = null
    this._lufsTarget = -14
  }

  _cleanupLufsSubscription() {
    if (this._lufsUnsubscribe) {
      try { this._lufsUnsubscribe() } catch (_e) {}
      this._lufsUnsubscribe = null
    }
    this._lufsRefs = null
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

    // 旧 DOM 被丢弃前先撤掉对它的 LUFS 订阅，否则下一帧推过来还会写到悬空的 ref 上
    this._cleanupLufsSubscription()

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

    // LUFS 仪表面板：放在 footer 之后、note 之前。
    // 用户在母带阶段就能看到"当前响度 vs 目标响度"，知道还差几 LU 到流媒体标准
    const lufsPanel = this._buildLufsPanel(chain.loudnessTarget)
    // note 是 createReverbDockModule 的最后一个子元素（如果有）；插到它之前
    const noteNode = module.querySelector('.fx-module-note')
    if (noteNode) {
      module.insertBefore(lufsPanel.root, noteNode)
    } else {
      module.appendChild(lufsPanel.root)
    }
    this._lufsRefs = lufsPanel.refs
    this._lufsTarget = chain.loudnessTarget
    // 用初始快照立即写一次（订阅时 LufsMeter 会推一帧），之后每 100ms 推一次
    this._lufsUnsubscribe = this.handlers.subscribeLufs?.((snapshot) => {
      this._writeLufsSnapshot(snapshot)
    }) || null

    return module
  }

  // LUFS 面板：M / S / I 三档读数 + 目标响度选择 + 状态行 + 自动达标 / 重置 / 帮助。
  // 入参 target 决定颜色阈值——按 ITU-R 推荐 ±1 LU 绿、±3 LU 橙、之外红/蓝
  _buildLufsPanel(loudnessTarget) {
    const root = document.createElement('div')
    root.className = 'fx-lufs-panel'

    const head = document.createElement('div')
    head.className = 'fx-lufs-head'
    const heading = document.createElement('span')
    heading.className = 'fx-lufs-heading'
    heading.textContent = '响度 LUFS'

    // 帮助 (?) 按钮：点开浮窗讲解 LUFS 是什么 + 各平台目标
    const helpBtn = document.createElement('button')
    helpBtn.type = 'button'
    helpBtn.className = 'fx-lufs-help'
    helpBtn.textContent = '?'
    helpBtn.title = '什么是 LUFS？'
    helpBtn.setAttribute('aria-label', '关于响度 LUFS 的说明')
    helpBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this._toggleLufsHelp(helpBtn)
    })

    const headLeft = document.createElement('span')
    headLeft.className = 'fx-lufs-head-left'
    headLeft.append(heading, helpBtn)
    head.appendChild(headLeft)

    // 目标响度下拉：常见流媒体标准
    const targetWrap = document.createElement('label')
    targetWrap.className = 'fx-lufs-target'
    const targetLabel = document.createElement('span')
    targetLabel.className = 'fx-lufs-target-label'
    targetLabel.textContent = '目标'
    const targetSelect = document.createElement('select')
    targetSelect.className = 'fx-lufs-target-select'
    targetSelect.title = '选择成品响度目标——仪表按此着色，自动达标按此调整'
    const targetOptions = [
      { value: -14, text: '-14 LUFS（Spotify / B站 / YouTube / 网易 / QQ 音乐）' },
      { value: -16, text: '-16 LUFS（Apple Music）' },
      { value: -23, text: '-23 LUFS（EBU R128 广播 / 电视）' },
    ]
    targetOptions.forEach(({ value, text }) => {
      const option = document.createElement('option')
      option.value = String(value)
      option.textContent = text
      if (Number(value) === Number(loudnessTarget)) option.selected = true
      targetSelect.appendChild(option)
    })
    targetSelect.addEventListener('change', () => {
      const next = Number.parseFloat(targetSelect.value)
      if (Number.isFinite(next)) {
        this.handlers.onMasterChainLoudnessTargetChanged?.(next)
      }
    })
    targetWrap.append(targetLabel, targetSelect)
    head.appendChild(targetWrap)

    root.appendChild(head)

    // 三个读数：M（瞬时 400ms）、S（短时 3s）、I（积分整段）
    const grid = document.createElement('div')
    grid.className = 'fx-lufs-grid'
    const cells = ['momentary', 'shortTerm', 'integrated'].map((kind, index) => {
      const cell = document.createElement('div')
      cell.className = `fx-lufs-cell fx-lufs-cell--${kind}`
      const label = document.createElement('span')
      label.className = 'fx-lufs-cell-label'
      label.textContent = ['M (瞬时)', 'S (短时)', 'I (积分)'][index]
      const value = document.createElement('span')
      value.className = 'fx-lufs-cell-value'
      value.textContent = '—'
      cell.append(label, value)
      grid.appendChild(cell)
      return { kind, valueNode: value, cellNode: cell }
    })
    root.appendChild(grid)

    // 偏差条：integrated 相对目标的偏差，范围 ±10 LU 映射 0..100%
    const delta = document.createElement('div')
    delta.className = 'fx-lufs-delta'
    const deltaLabel = document.createElement('span')
    deltaLabel.className = 'fx-lufs-delta-label'
    deltaLabel.textContent = '偏差'
    const deltaTrack = document.createElement('div')
    deltaTrack.className = 'fx-lufs-delta-track'
    const deltaFill = document.createElement('div')
    deltaFill.className = 'fx-lufs-delta-fill'
    deltaTrack.appendChild(deltaFill)
    const deltaText = document.createElement('span')
    deltaText.className = 'fx-lufs-delta-text'
    deltaText.textContent = '—'
    delta.append(deltaLabel, deltaTrack, deltaText)
    root.appendChild(delta)

    // 白话状态行：傻瓜用户的主信息渠道——根据当前 integrated 自动写
    //   未播放 / 数据不足 / 已达标 / 偏轻（平台会调响）/ 偏响（平台会调小）
    const statusRow = document.createElement('div')
    statusRow.className = 'fx-lufs-status'
    statusRow.dataset.tone = 'idle'
    statusRow.textContent = '请按播放，让仪表读取实际响度'
    root.appendChild(statusRow)

    // 行动按钮组：左侧"成功横幅"（autofit 完成后的醒目提示）+ 右侧两个按钮
    const actions = document.createElement('div')
    actions.className = 'fx-lufs-actions'

    // 成功横幅：autofit 完成时显示，平时隐藏。比下面的 statusRow 更显眼，
    // 让傻瓜用户在按钮旁边一眼看到"成功了"
    const successBanner = document.createElement('div')
    successBanner.className = 'fx-lufs-success-banner'
    successBanner.dataset.visible = '0'
    successBanner.dataset.tone = 'good'

    const autoFitBtn = document.createElement('button')
    autoFitBtn.type = 'button'
    autoFitBtn.className = 'fx-lufs-autofit'
    autoFitBtn.textContent = '📐 自动达标'
    autoFitBtn.title = '一键调整 makeup gain，让 integrated 落到目标响度附近'
    autoFitBtn.disabled = true // 起始无数据 → 不可点
    autoFitBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // 防抖：调用过程中先 disable，render 后会重新构建按钮 / 按 snapshot 决定
      autoFitBtn.disabled = true
      this.handlers.onLufsAutoFitRequested?.()
    })

    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'fx-lufs-reset'
    resetBtn.textContent = '↻ 重置积分'
    resetBtn.title = '清空 Integrated（积分响度）累计——重新从头播放前点'
    resetBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.handlers.onLufsResetRequested?.()
    })

    actions.append(successBanner, autoFitBtn, resetBtn)
    root.appendChild(actions)

    return {
      root,
      refs: {
        cells: Object.fromEntries(cells.map((entry) => [entry.kind, entry])),
        deltaFill,
        deltaText,
        targetSelect,
        statusRow,
        successBanner,
        autoFitBtn,
      },
    }
  }

  // LUFS 帮助浮窗——一份覆盖主流平台的白话讲解
  _toggleLufsHelp(anchorBtn) {
    const existing = document.body.querySelector('.fx-lufs-help-popup')
    if (existing) {
      existing.remove()
      return
    }
    const popup = document.createElement('div')
    popup.className = 'fx-lufs-help-popup'
    popup.setAttribute('role', 'dialog')
    popup.setAttribute('aria-label', '关于 LUFS')

    popup.innerHTML = `
      <div class="fx-lufs-help-title">📚 什么是 LUFS？</div>
      <div class="fx-lufs-help-body">
        <p><strong>LUFS</strong> 是按"人耳听感"测出来的响度，单位"响度单位"。它跟左边的"峰值表"测的不是一回事——
        峰值表只看声音瞬间最高冲到哪里，LUFS 看的是整体听感有多响。</p>
        <p><strong>为什么重要？</strong>因为你上传到 Spotify、B 站等平台后，平台会自动把响度调到统一标准。
        如果你的歌响度跟标准差太多，平台会"动手"调，要么压低、要么调响，最终听感跟你做的可能完全不同。</p>
        <div class="fx-lufs-help-section">主流平台目标响度：</div>
        <table class="fx-lufs-help-table">
          <tbody>
            <tr><td>Spotify</td><td>-14 LUFS</td></tr>
            <tr><td>Apple Music</td><td>-16 LUFS</td></tr>
            <tr><td>YouTube / YouTube Music</td><td>-14 LUFS</td></tr>
            <tr><td>TikTok / 抖音</td><td>≈ -14 LUFS</td></tr>
            <tr><td>Tidal</td><td>-14 LUFS</td></tr>
            <tr><td>Amazon Music</td><td>-14 LUFS</td></tr>
            <tr><td>SoundCloud</td><td>-14 LUFS</td></tr>
            <tr><td>Pandora / Deezer</td><td>-14 / -15 LUFS</td></tr>
            <tr><td>哔哩哔哩 (B 站)</td><td>≈ -14 LUFS</td></tr>
            <tr><td>网易云音乐 / QQ 音乐</td><td>≈ -14 LUFS</td></tr>
            <tr><td>EBU R128（欧洲广播 / 电视）</td><td>-23 LUFS</td></tr>
            <tr><td>ATSC A/85（美洲广播 / 电视）</td><td>-24 LUFS</td></tr>
          </tbody>
        </table>
        <div class="fx-lufs-help-section">三档读数怎么看？</div>
        <ul class="fx-lufs-help-list">
          <li><strong>M（瞬时）</strong>：最近 0.4 秒，看"副歌那一瞬间多响"</li>
          <li><strong>S（短时）</strong>：最近 3 秒，看"这一段平均多响"</li>
          <li><strong>I（积分）</strong>：从重置那一刻起到现在，看"整首歌平均多响"——
          <em>这就是平台用来判断的数</em></li>
        </ul>
        <div class="fx-lufs-help-section">傻瓜操作流程：</div>
        <ol class="fx-lufs-help-list">
          <li>选好你要发的平台（默认 Spotify -14 LUFS）</li>
          <li>把播放头拖到歌的开头，按播放</li>
          <li>等歌跑完一遍，看"I"那个数字</li>
          <li>如果颜色不是绿色，点 <strong>📐 自动达标</strong> —— 系统会自动帮你调，再播一次验证</li>
          <li>看到绿色"✓ 已达 XX 标准"就可以保存上传了</li>
        </ol>
      </div>
      <button type="button" class="fx-lufs-help-close" aria-label="关闭">关闭</button>
    `

    document.body.appendChild(popup)
    // 定位到按钮上方居中
    const positionPopup = () => {
      const rect = anchorBtn.getBoundingClientRect()
      const popRect = popup.getBoundingClientRect()
      // 优先放上方；上方放不下就贴下方
      const margin = 12
      let top = rect.top - popRect.height - margin
      if (top < 8) top = rect.bottom + margin
      let left = rect.left + rect.width / 2 - popRect.width / 2
      left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left))
      popup.style.top = `${top}px`
      popup.style.left = `${left}px`
    }
    positionPopup()
    requestAnimationFrame(() => requestAnimationFrame(positionPopup))

    const close = () => {
      popup.remove()
      document.removeEventListener('click', outsideClick, true)
      window.removeEventListener('resize', positionPopup)
      window.removeEventListener('keydown', escClose)
    }
    const outsideClick = (e) => {
      if (popup.contains(e.target) || anchorBtn.contains(e.target)) return
      close()
    }
    const escClose = (e) => { if (e.key === 'Escape') close() }
    popup.querySelector('.fx-lufs-help-close')?.addEventListener('click', close)
    // 推到下一个事件循环再监听，避免当前点 ? 按钮的事件触发关闭
    setTimeout(() => {
      document.addEventListener('click', outsideClick, true)
      window.addEventListener('resize', positionPopup)
      window.addEventListener('keydown', escClose)
    }, 0)
  }

  _writeLufsSnapshot(snapshot) {
    const refs = this._lufsRefs
    if (!refs || !snapshot) return
    const target = Number.isFinite(this._lufsTarget) ? this._lufsTarget : -14

    const formatLufs = (lufs) => {
      if (!Number.isFinite(lufs)) return '—'
      return lufs.toFixed(1)
    }
    const toneFor = (lufs) => {
      if (!Number.isFinite(lufs)) return 'idle'
      const delta = lufs - target
      const abs = Math.abs(delta)
      if (abs <= 1) return 'good'
      if (abs <= 3) return 'warn'
      return delta > 0 ? 'too-loud' : 'too-quiet'
    }

    ;['momentary', 'shortTerm', 'integrated'].forEach((kind) => {
      const cell = refs.cells?.[kind]
      if (!cell) return
      const value = snapshot[kind]
      cell.valueNode.textContent = formatLufs(value)
      cell.cellNode.dataset.tone = toneFor(value)
    })

    // 偏差条按 integrated 来——这是用户最关心的"成品响度"
    const integrated = snapshot.integrated
    if (Number.isFinite(integrated)) {
      const delta = integrated - target
      const clamped = Math.max(-10, Math.min(10, delta))
      // -10..+10 映射到 0..100%；中点 50% 是"达标"
      const pct = ((clamped + 10) / 20) * 100
      refs.deltaFill.style.left = '50%'
      refs.deltaFill.style.width = `${Math.abs(pct - 50)}%`
      refs.deltaFill.style.transform = pct >= 50 ? 'translateX(0)' : 'translateX(-100%)'
      refs.deltaText.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} LU`
      refs.deltaText.dataset.tone = toneFor(integrated)
    } else {
      refs.deltaFill.style.width = '0'
      refs.deltaText.textContent = '—'
      refs.deltaText.dataset.tone = 'idle'
    }

    // 白话状态行 + 成功横幅 + 自动达标按钮可用性
    const measuring = Boolean(this.handlers.isAutoFitMeasuring?.())
    const lastAutoFit = !measuring ? this.handlers.getLastAutoFitResult?.() : null

    // autofit 刚完成 → 在按钮左侧显示醒目横幅；statusRow 这时不再显示同样的信息
    if (refs.successBanner) {
      if (lastAutoFit) {
        const banner = this._buildAutoFitBanner(lastAutoFit, target)
        refs.successBanner.innerHTML = banner.html
        refs.successBanner.dataset.tone = banner.tone
        refs.successBanner.dataset.visible = '1'
      } else {
        refs.successBanner.innerHTML = ''
        refs.successBanner.dataset.visible = '0'
      }
    }

    if (refs.statusRow) {
      if (lastAutoFit) {
        // autofit 完成后 statusRow 让位给上方横幅；这里压成一行简洁的"调整前 / 调整后"对比
        const before = lastAutoFit.beforeIntegrated
        const after = lastAutoFit.predictedIntegrated
        const beforeStr = Number.isFinite(before) ? `${before.toFixed(1)}` : '—'
        const afterStr = Number.isFinite(after) ? `${after.toFixed(1)}` : '—'
        refs.statusRow.textContent = `调整前 I = ${beforeStr} LUFS  →  调整后预计 I = ${afterStr} LUFS（基于线性预测，重新播放可精确验证）`
        refs.statusRow.dataset.tone = 'idle'
      } else {
        const status = this._buildLufsStatusText(snapshot, target, { measuring, lastAutoFit: null })
        refs.statusRow.textContent = status.text
        refs.statusRow.dataset.tone = status.tone
      }
    }
    if (refs.autoFitBtn) {
      if (measuring) {
        // 测量中：按钮变成"取消"，让用户能从 UI 自己撤销（除暂停外的备用退出）
        refs.autoFitBtn.disabled = false
        refs.autoFitBtn.textContent = '✕ 取消测量'
        refs.autoFitBtn.title = '正在完整播放测量响度——点击放弃这次测量'
        refs.autoFitBtn.dataset.mode = 'cancel'
      } else {
        // idle：按钮回归"自动达标"，但任何时候都允许点（而非要求先 3 秒采样），
        // 因为现在的流程是"点了之后从头播放整首歌"
        refs.autoFitBtn.disabled = false
        refs.autoFitBtn.textContent = '📐 自动达标'
        refs.autoFitBtn.title = '点击后会从头完整播放整首歌，结束后自动调整 makeup gain'
        refs.autoFitBtn.dataset.mode = 'autofit'
      }
    }
  }

  // 自动达标完成横幅：放在按钮左侧，醒目大字 + 主信息一行
  _buildAutoFitBanner(lastAutoFit, fallbackTarget) {
    const target = lastAutoFit.targetLufs ?? fallbackTarget
    const platformLabel = this._platformLabelForTarget(target)

    if (lastAutoFit.alreadyOnTarget) {
      const sign = lastAutoFit.deltaLu >= 0 ? '+' : ''
      return {
        html: `<span class="fx-lufs-success-banner-icon">✓</span>`
          + `<span class="fx-lufs-success-banner-main"><strong>已达 ${platformLabel} 标准</strong>`
          + `<span class="fx-lufs-success-banner-sub">差 ${sign}${lastAutoFit.deltaLu.toFixed(1)} LU——可发布</span>`
          + `</span>`,
        tone: 'good',
      }
    }

    const sign = lastAutoFit.appliedDb >= 0 ? '+' : ''
    const predicted = lastAutoFit.predictedIntegrated
    const predictedDelta = Number.isFinite(predicted) ? predicted - target : null
    const predictedAbs = predictedDelta != null ? Math.abs(predictedDelta) : null
    let tone = 'good'
    if (predictedAbs == null) tone = 'good'
    else if (predictedAbs <= 1) tone = 'good'
    else if (predictedAbs <= 3) tone = 'warn'
    else tone = predictedDelta > 0 ? 'too-loud' : 'too-quiet'

    const predictedStr = Number.isFinite(predicted) ? `${predicted.toFixed(1)} LUFS` : '—'
    let footer = `预计响度 ${predictedStr}（${platformLabel} 标准）`
    if (lastAutoFit.hitLimit) {
      footer += '·已撞上限，可再点一次或手调 EQ / 压缩'
    } else if (lastAutoFit.largeAdjustment) {
      footer += '·调整量较大，建议听一下音质'
    } else {
      footer += '·可保存上传或重播验证'
    }

    return {
      html: `<span class="fx-lufs-success-banner-icon">✓</span>`
        + `<span class="fx-lufs-success-banner-main"><strong>自动达标完成 ${sign}${lastAutoFit.appliedDb.toFixed(1)} dB</strong>`
        + `<span class="fx-lufs-success-banner-sub">${footer}</span>`
        + `</span>`,
      tone,
    }
  }

  // 根据当前 integrated + target 算"白话状态"——傻瓜用户的核心信息渠道
  _buildLufsStatusText(snapshot, target, { measuring = false } = {}) {
    if (measuring) {
      const seconds = ((snapshot?.gatedBlockCount || 0) / 10).toFixed(1)
      return {
        text: `🔴 自动达标测量中——已采集 ${seconds} 秒。请勿暂停 / 拖动，等播完会自动调整`,
        tone: 'measuring',
      }
    }
    const integrated = snapshot?.integrated
    const blockCount = snapshot?.gatedBlockCount || 0
    if (!Number.isFinite(integrated)) {
      return { text: '请按播放，让仪表读取实际响度；或直接点"自动达标"完整测一遍', tone: 'idle' }
    }
    if (blockCount < 30) {
      const remainBlocks = Math.max(0, 30 - blockCount)
      const seconds = (remainBlocks / 10).toFixed(1)
      return { text: `正在采样——再播放约 ${seconds} 秒后读数将稳定`, tone: 'idle' }
    }
    const delta = integrated - target
    const abs = Math.abs(delta)
    const platformLabel = this._platformLabelForTarget(target)
    if (abs <= 1) {
      return {
        text: `✓ 已达 ${platformLabel} 标准（差 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} LU），可发布`,
        tone: 'good',
      }
    }
    if (abs <= 3) {
      const verb = delta > 0 ? '调小（不会爆音，但牺牲一些响）' : '调响（仍然 OK）'
      return {
        text: `⚠ 比 ${platformLabel} 标准${delta > 0 ? '响' : '轻'} ${abs.toFixed(1)} dB——上传后平台会自动${verb}`,
        tone: delta > 0 ? 'too-loud' : 'warn',
      }
    }
    if (delta > 0) {
      return {
        text: `✗ 比 ${platformLabel} 响 ${abs.toFixed(1)} dB——平台会大幅压低，建议点"自动达标"`,
        tone: 'too-loud',
      }
    }
    return {
      text: `✗ 比 ${platformLabel} 轻 ${abs.toFixed(1)} dB——听感闷，建议点"自动达标"`,
      tone: 'too-quiet',
    }
  }

  _platformLabelForTarget(target) {
    if (target === -14) return 'Spotify / B 站'
    if (target === -16) return 'Apple Music'
    if (target === -23) return 'EBU R128 广播'
    return `${target} LUFS`
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
