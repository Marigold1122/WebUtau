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
import { buildMixerChannelStrip } from './mixer/buildMixerChannelStrip.js'
import { getTrackColorById } from './tracks/trackColorPalette.js'

export class MixerDockView {
  constructor(refs, handlers = {}) {
    this.refs = refs
    this.handlers = handlers
    this._wasVisible = false
    /** @type {Map<string, ReturnType<typeof buildMixerChannelStrip>>} */
    this._stripsByTrackId = new Map()
    this._masterStrip = null
    this._stripsContainer = null
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

    // 渲染 channel strip 列表 + master strip（顺序：tracks... + master）
    this._renderSkeleton(dock, tracks, project)
    return true
  }

  _renderSkeleton(dock, tracks, project) {
    const trackCount = Array.isArray(tracks) ? tracks.length : 0
    if (trackCount === 0) {
      this._teardownStrips(dock)
      const empty = document.createElement('div')
      empty.className = 'mixer-dock-empty'
      empty.textContent = t('mixer.empty_hint')
      dock.replaceChildren(empty)
      return
    }
    // 容器复用：第一次创建一个 strips 容器 + master strip，后续 render 只增删轨条
    if (!this._stripsContainer || !dock.contains(this._stripsContainer)) {
      this._stripsContainer = document.createElement('div')
      this._stripsContainer.className = 'mixer-dock-strips'
      dock.replaceChildren(this._stripsContainer)
    }
    if (!this._masterStrip) {
      this._masterStrip = buildMixerChannelStrip({ track: null, isMaster: true })
    }
    // Reconcile 轨条：按当前 tracks 顺序构造缺失的、移除多余的、复用 update 已存在的
    const nextIds = new Set()
    tracks.forEach((track) => {
      if (!track?.id) return
      nextIds.add(track.id)
      let strip = this._stripsByTrackId.get(track.id)
      const trackColor = getTrackColorById(track.id, tracks)
      if (!strip) {
        strip = buildMixerChannelStrip({ track, trackColor })
        this._stripsByTrackId.set(track.id, strip)
      } else {
        strip.update(track)
        if (trackColor && strip.root.style.getPropertyValue('--mixer-strip-color') !== trackColor) {
          strip.root.style.setProperty('--mixer-strip-color', trackColor)
        }
      }
    })
    // 删除已不存在的轨条
    Array.from(this._stripsByTrackId.entries()).forEach(([id, strip]) => {
      if (!nextIds.has(id)) {
        strip.root.remove()
        this._stripsByTrackId.delete(id)
      }
    })
    // 重新挂载：先按 tracks 顺序追加，最后追加 master——保证顺序正确（即使 reorder）
    tracks.forEach((track) => {
      const strip = this._stripsByTrackId.get(track.id)
      if (strip && strip.root.parentNode !== this._stripsContainer) {
        this._stripsContainer.appendChild(strip.root)
      } else if (strip) {
        // 已挂载——但顺序可能错；append 同 parent 会移动节点位置，确保最终顺序对
        this._stripsContainer.appendChild(strip.root)
      }
    })
    if (this._masterStrip.root.parentNode !== this._stripsContainer) {
      this._stripsContainer.appendChild(this._masterStrip.root)
    } else {
      this._stripsContainer.appendChild(this._masterStrip.root) // 永远置于最右
    }
    // master 名（i18n 可能切换语言）每帧检查刷
    const masterName = this._masterStrip.refs?.name
    if (masterName) {
      const desired = t('mixer.master_label')
      if (masterName.textContent !== desired) masterName.textContent = desired
    }
    // project 用于将来获取 mixState.masterVolume —— 这一步先无视
    void project
  }

  _teardownStrips(dock) {
    this._stripsByTrackId.forEach((strip) => strip.root.remove())
    this._stripsByTrackId.clear()
    this._masterStrip?.root.remove()
    this._masterStrip = null
    this._stripsContainer = null
  }
}
