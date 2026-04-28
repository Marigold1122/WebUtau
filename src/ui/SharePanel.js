import {
  getTunnelStatus,
  isTauriRuntime,
  requestStartTunnel,
  requestStopTunnel,
  watchTunnelStatus,
} from '../services/tunnelService.js'
import { onLocaleChange, t } from '../i18n/index.js'

function stateLabel(state) {
  if (!state) return t('share.state.unknown')
  return t(`share.state.${state}`)
}

// 后端 (Tauri / dev server) 返回的 message 是中文。前端按 state + 原文做映射，
// 命中已知文案时用 i18n 替换；未命中则原样显示（便于用户/开发者排错）
const MESSAGE_BY_STATE = {
  ready: 'public_ready',
  starting: 'starting',
  stopped: 'stopped',
  idle: 'not_yet',
}
const MESSAGE_BY_TEXT = new Map([
  ['公开链接已就绪', 'public_ready'],
  ['正在建立 Cloudflare quick tunnel', 'starting'],
  ['隧道已停止', 'stopped'],
  ['尚未生成分享链接', 'not_yet'],
  ['未找到 cloudflared 二进制', 'cloudflared_missing'],
  ['启动 cloudflared 失败', 'start_failed'],
  ['cloudflared 异常退出', 'cloudflared_exited'],
  ['无法读取隧道状态', 'no_status'],
  ['无法连接到隧道状态服务', 'no_connect'],
  ['获取状态失败', 'fetch_failed'],
  ['隧道服务不可用', 'not_available'],
])

function localizeMessage(message, state) {
  if (!message) return ''
  const directKey = MESSAGE_BY_TEXT.get(message)
  if (directKey) return t(`shareMessage.${directKey}`)
  const fromState = MESSAGE_BY_STATE[state]
  if (fromState) return t(`shareMessage.${fromState}`)
  return message
}

function formatMB(bytes) {
  return ((bytes || 0) / 1024 / 1024).toFixed(1)
}

function isStartableState(state) {
  return state === 'idle' || state === 'stopped' || state === 'error' || state === 'disabled'
}

class SharePanel {
  constructor() {
    this._root = null
    this._refs = null
    this._stopWatch = null
    this._stopLocaleWatch = null
    this._lastStatus = null
    this._busy = false
  }

  init(container) {
    if (!container || this._root) return
    this._root = container
    container.classList.add('share-panel-section')
    container.innerHTML = `
      <h2 data-i18n="share.heading">${t('share.heading')}</h2>
      <div class="share-panel" data-share-root>
        <div class="share-state-row">
          <span class="share-state-dot" data-share-dot></span>
          <span class="share-state-text" data-share-state></span>
        </div>
        <div class="share-message" data-share-message></div>
        <div class="share-progress" data-share-progress hidden>
          <div class="share-progress-bar"><div class="share-progress-fill" data-share-fill></div></div>
          <div class="share-progress-text" data-share-progress-text></div>
        </div>
        <div class="share-url-block" data-share-url-block hidden>
          <div class="share-url-row">
            <code class="share-url" data-share-url></code>
            <button type="button" class="panel-action-btn share-copy-btn" data-share-copy></button>
          </div>
          <a class="share-url-open" data-share-open target="_blank" rel="noreferrer noopener"></a>
        </div>
        <div class="share-error" data-share-error hidden></div>
        <div class="share-actions" data-share-actions hidden>
          <button type="button" class="panel-action-btn panel-action-btn--primary" data-share-start></button>
          <button type="button" class="panel-action-btn" data-share-stop hidden></button>
        </div>
        <div class="share-hint" data-share-hint></div>
      </div>
    `

    this._refs = {
      dot: container.querySelector('[data-share-dot]'),
      state: container.querySelector('[data-share-state]'),
      message: container.querySelector('[data-share-message]'),
      progress: container.querySelector('[data-share-progress]'),
      fill: container.querySelector('[data-share-fill]'),
      progressText: container.querySelector('[data-share-progress-text]'),
      urlBlock: container.querySelector('[data-share-url-block]'),
      url: container.querySelector('[data-share-url]'),
      open: container.querySelector('[data-share-open]'),
      copy: container.querySelector('[data-share-copy]'),
      error: container.querySelector('[data-share-error]'),
      actions: container.querySelector('[data-share-actions]'),
      start: container.querySelector('[data-share-start]'),
      stop: container.querySelector('[data-share-stop]'),
      hint: container.querySelector('[data-share-hint]'),
    }
    this._refs.state.textContent = t('share.initializing')
    this._refs.copy.textContent = t('share.copy')
    this._refs.open.textContent = t('share.open_browser')
    this._refs.start.textContent = t('share.btn_start')
    this._refs.stop.textContent = t('share.btn_stop')

    this._refs.copy.addEventListener('click', () => this._handleCopy())
    this._refs.start.addEventListener('click', () => this._handleStart())
    this._refs.stop.addEventListener('click', () => this._handleStop())

    // 立即拉一次状态填充 UI，避免长时间停留在"初始化中…"
    getTunnelStatus().then((status) => this._render(status)).catch(() => {})

    this._stopWatch = watchTunnelStatus((status) => this._render(status))
    // locale 切换时重渲（按钮文字、状态文字都来自 t()）
    this._stopLocaleWatch = onLocaleChange(() => {
      if (this._lastStatus) this._render(this._lastStatus)
      else if (this._refs) this._refs.state.textContent = t('share.initializing')
    })
  }

  destroy() {
    if (this._stopWatch) {
      this._stopWatch()
      this._stopWatch = null
    }
    if (this._stopLocaleWatch) {
      try { this._stopLocaleWatch() } catch (_e) {}
      this._stopLocaleWatch = null
    }
    this._root = null
    this._refs = null
  }

  async _handleCopy() {
    const url = this._lastStatus?.url
    if (!url || !this._refs) return
    try {
      await navigator.clipboard.writeText(url)
      this._refs.copy.textContent = t('share.copied')
      window.setTimeout(() => {
        if (this._refs) this._refs.copy.textContent = t('share.copy')
      }, 1500)
    } catch (err) {
      console.warn('[SharePanel] 复制失败:', err)
      this._refs.copy.textContent = t('share.copy_failed')
      window.setTimeout(() => {
        if (this._refs) this._refs.copy.textContent = t('share.copy')
      }, 1500)
    }
  }

  async _handleStart() {
    if (this._busy || !this._refs) return
    this._busy = true
    this._refs.start.disabled = true
    this._refs.error.hidden = true
    try {
      const status = await requestStartTunnel()
      this._render(status)
    } catch (err) {
      this._refs.error.hidden = false
      this._refs.error.textContent = t('share.start_failed', { message: err?.message || err })
    } finally {
      this._busy = false
      if (this._refs) this._refs.start.disabled = false
    }
  }

  async _handleStop() {
    if (this._busy || !this._refs) return
    this._busy = true
    this._refs.stop.disabled = true
    try {
      const status = await requestStopTunnel()
      this._render(status)
    } catch (err) {
      this._refs.error.hidden = false
      this._refs.error.textContent = t('share.stop_failed', { message: err?.message || err })
    } finally {
      this._busy = false
      if (this._refs) this._refs.stop.disabled = false
    }
  }

  _render(status) {
    if (!this._refs) return
    this._lastStatus = status
    const refs = this._refs

    refs.state.textContent = stateLabel(status.state)
    refs.dot.dataset.state = status.state || 'unknown'
    const localized = localizeMessage(status.message, status.state)
    refs.message.textContent = localized
    refs.message.hidden = !localized

    const showProgress = status.state === 'downloading' && status.totalBytes > 0
    if (showProgress) {
      const pct = Math.max(0, Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100)))
      refs.progress.hidden = false
      refs.fill.style.width = `${pct}%`
      refs.progressText.textContent = `${formatMB(status.downloadedBytes)} / ${formatMB(status.totalBytes)} MB · ${pct}%`
    } else {
      refs.progress.hidden = true
    }

    if (status.url) {
      refs.urlBlock.hidden = false
      refs.url.textContent = status.url
      refs.open.href = status.url
      refs.open.textContent = t('share.open_browser')
    } else {
      refs.urlBlock.hidden = true
      refs.open.removeAttribute('href')
    }

    if (status.error) {
      refs.error.hidden = false
      // error 字段也可能是后端返回的中文长文，用同样的字典做替换；命中失败时原样显示
      refs.error.textContent = MESSAGE_BY_TEXT.has(status.error)
        ? t(`shareMessage.${MESSAGE_BY_TEXT.get(status.error)}`)
        : (status.error === '应用资源目录中缺少 cloudflared，请重新安装或检查打包流程'
            ? t('shareMessage.cloudflared_missing_detail')
            : status.error)
    } else {
      refs.error.hidden = true
    }

    const showActions = status.manualStart || isTauriRuntime()
    refs.actions.hidden = !showActions
    if (showActions) {
      const canStart = isStartableState(status.state)
      refs.start.hidden = !canStart
      refs.start.textContent = (status.state === 'error' || status.state === 'stopped')
        ? t('share.btn_regenerate')
        : t('share.btn_start')
      refs.stop.textContent = t('share.btn_stop')
      refs.stop.hidden = !(status.state === 'ready' || status.state === 'starting' || status.state === 'downloading' || status.state === 'preparing')
    }

    refs.hint.textContent = this._buildHint(status)
  }

  _buildHint(status) {
    if (status.state === 'ready') return t('share.hint.ready')
    if (status.state === 'downloading') return t('share.hint.downloading')
    if (status.state === 'preparing') return t('share.hint.preparing')
    if (status.state === 'starting') return t('share.hint.starting')
    if (status.state === 'error') return t('share.hint.error')
    if (status.state === 'disabled') {
      if (isTauriRuntime()) return t('share.hint.tauri_disabled')
      return t('share.hint.web_disabled')
    }
    if (status.state === 'stopped') return t('share.hint.stopped')
    return ''
  }
}

export default new SharePanel()
