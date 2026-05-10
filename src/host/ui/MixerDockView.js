/**
 * Mixer Dock View —— Studio One / Logic Mixer 风的纵向通道条视图。
 *
 * 数据流：完全只读现有 store / project state（track.playbackState.{volume,pan,mute,solo,reverbSend}），
 * 不内置任何 state；用户操作经 handlers 走既有的 ProjectMixController 同步管线。
 *
 * Phase 1（本文件目前状态）：只搭骨架——
 *   - 渲染容器 + 滚动区 + 占位空状态
 *   - 后续 phase 才会逐步加 channel strip、fader、pan、meter 等
 *
 * 与 ReverbDockView 的关系：平级 sibling DOM，通过 ShellLayoutView 的 tab 切换决定显隐
 */

import { t } from '../../i18n/index.js'

export class MixerDockView {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this._wasVisible = false
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers
  }

  init() {
    // Phase 1 没有 dock 内的交互按钮可绑定；预留 init 接口与 ReverbDockView 形状一致
    this.refs.btnToggleMixerDock?.addEventListener('click', () => {
      this.handlers.onToggleMixerDock?.()
    })
  }

  /**
   * @param {object} params
   * @param {object|null} params.project
   * @param {Array} params.tracks
   * @param {object} params.viewState - { reverbDockOpen, activeDockTab }
   */
  render({ project = null, tracks = [], viewState = {} } = {}) {
    const dock = this.refs.mixerDock
    const toggleButton = this.refs.btnToggleMixerDock
    if (!dock) return false

    const dockOpen = Boolean(viewState?.reverbDockOpen)
    const activeTab = viewState?.activeDockTab === 'reverb' ? 'reverb' : 'mixer'
    const visible = Boolean(project) && dockOpen && activeTab === 'mixer'

    if (toggleButton) {
      toggleButton.disabled = !project
      // 按钮高亮反映"dock 开 + 当前正在看 mixer tab"——和 reverb 按钮的语义对称
      toggleButton.classList.toggle('accent', visible)
      toggleButton.setAttribute('aria-pressed', String(visible))
    }

    dock.classList.toggle('hidden', !visible)

    if (!visible) {
      this._wasVisible = false
      return false
    }

    // 第一次打开 mixer tab 的"slide-up"动画——和 reverb dock 行为一致，
    // 让用户感知到 dock 切到 mixer 模式
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
    this._wasVisible = true

    // 占位骨架——后续 phase 用 channel strip 替换
    this._renderSkeleton(dock, tracks)
    return true
  }

  _renderSkeleton(dock, tracks) {
    dock.replaceChildren()
    const trackCount = Array.isArray(tracks) ? tracks.length : 0
    if (trackCount === 0) {
      const empty = document.createElement('div')
      empty.className = 'mixer-dock-empty'
      empty.textContent = t('mixer.empty_hint')
      dock.appendChild(empty)
      return
    }
    // 横向滚动区 + 占位通道条 + master strip 占位（后续 phase 才真做）
    const strips = document.createElement('div')
    strips.className = 'mixer-dock-strips'
    tracks.forEach((track) => {
      const strip = document.createElement('div')
      strip.className = 'mixer-channel-strip mixer-channel-strip--placeholder'
      strip.dataset.trackId = track?.id || ''
      const name = document.createElement('div')
      name.className = 'mixer-channel-strip-name'
      name.textContent = track?.name || ''
      strip.appendChild(name)
      strips.appendChild(strip)
    })
    // Master strip 占位——视觉上明显区分（更宽 + 不同色调）
    const master = document.createElement('div')
    master.className = 'mixer-channel-strip mixer-channel-strip--master mixer-channel-strip--placeholder'
    const masterLabel = document.createElement('div')
    masterLabel.className = 'mixer-channel-strip-name mixer-channel-strip-name--master'
    masterLabel.textContent = 'MASTER'
    master.appendChild(masterLabel)
    strips.appendChild(master)
    dock.appendChild(strips)
  }
}
