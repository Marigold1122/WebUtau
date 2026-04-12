import {
  getTunnelStatus,
  isTauriRuntime,
  requestStartTunnel,
  requestStopTunnel,
  watchTunnelStatus,
} from '../services/tunnelService.js'

const STATE_LABELS = {
  idle: '未启动',
  preparing: '准备中',
  downloading: '正在下载 cloudflared',
  starting: '正在建立隧道',
  ready: '已就绪',
  error: '失败',
  stopped: '已停止',
  disabled: '不可用',
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
    this._lastStatus = null
    this._busy = false
  }

  init(container) {
    if (!container || this._root) return
    this._root = container
    container.classList.add('share-panel-section')
    container.innerHTML = `
      <h2>分享链接</h2>
      <div class="share-panel" data-share-root>
        <div class="share-state-row">
          <span class="share-state-dot" data-share-dot></span>
          <span class="share-state-text" data-share-state>初始化中…</span>
        </div>
        <div class="share-message" data-share-message></div>
        <div class="share-progress" data-share-progress hidden>
          <div class="share-progress-bar"><div class="share-progress-fill" data-share-fill></div></div>
          <div class="share-progress-text" data-share-progress-text></div>
        </div>
        <div class="share-url-block" data-share-url-block hidden>
          <div class="share-url-row">
            <code class="share-url" data-share-url></code>
            <button type="button" class="panel-action-btn share-copy-btn" data-share-copy>复制</button>
          </div>
          <a class="share-url-open" data-share-open target="_blank" rel="noreferrer noopener">在浏览器中打开 ↗</a>
        </div>
        <div class="share-error" data-share-error hidden></div>
        <div class="share-actions" data-share-actions hidden>
          <button type="button" class="panel-action-btn panel-action-btn--primary" data-share-start>生成分享链接</button>
          <button type="button" class="panel-action-btn" data-share-stop hidden>停止分享</button>
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

    this._refs.copy.addEventListener('click', () => this._handleCopy())
    this._refs.start.addEventListener('click', () => this._handleStart())
    this._refs.stop.addEventListener('click', () => this._handleStop())

    // 立即拉一次状态填充 UI，避免长时间停留在"初始化中…"
    getTunnelStatus().then((status) => this._render(status)).catch(() => {})

    this._stopWatch = watchTunnelStatus((status) => this._render(status))
  }

  destroy() {
    if (this._stopWatch) {
      this._stopWatch()
      this._stopWatch = null
    }
    this._root = null
    this._refs = null
  }

  async _handleCopy() {
    const url = this._lastStatus?.url
    if (!url || !this._refs) return
    try {
      await navigator.clipboard.writeText(url)
      this._refs.copy.textContent = '已复制 ✓'
      window.setTimeout(() => {
        if (this._refs) this._refs.copy.textContent = '复制'
      }, 1500)
    } catch (err) {
      console.warn('[SharePanel] 复制失败:', err)
      this._refs.copy.textContent = '复制失败'
      window.setTimeout(() => {
        if (this._refs) this._refs.copy.textContent = '复制'
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
      this._refs.error.textContent = `启动失败: ${err?.message || err}`
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
      this._refs.error.textContent = `停止失败: ${err?.message || err}`
    } finally {
      this._busy = false
      if (this._refs) this._refs.stop.disabled = false
    }
  }

  _render(status) {
    if (!this._refs) return
    this._lastStatus = status
    const refs = this._refs

    const stateLabel = STATE_LABELS[status.state] || status.state || '未知'
    refs.state.textContent = stateLabel
    refs.dot.dataset.state = status.state || 'unknown'
    refs.message.textContent = status.message || ''
    refs.message.hidden = !status.message

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
    } else {
      refs.urlBlock.hidden = true
      refs.open.removeAttribute('href')
    }

    if (status.error) {
      refs.error.hidden = false
      refs.error.textContent = status.error
    } else {
      refs.error.hidden = true
    }

    const showActions = status.manualStart || isTauriRuntime()
    refs.actions.hidden = !showActions
    if (showActions) {
      const canStart = isStartableState(status.state)
      refs.start.hidden = !canStart
      refs.start.textContent = status.state === 'error' || status.state === 'stopped'
        ? '重新生成分享链接'
        : '生成分享链接'
      refs.stop.hidden = !(status.state === 'ready' || status.state === 'starting' || status.state === 'downloading' || status.state === 'preparing')
    }

    refs.hint.textContent = this._buildHint(status)
  }

  _buildHint(status) {
    if (status.state === 'ready') {
      return '链接每次启动都会变化；分享给他人即可临时访问。关闭应用后链接立即失效。'
    }
    if (status.state === 'downloading') {
      return '首次启动需要从 GitHub 下载 cloudflared，约 20–35 MB。'
    }
    if (status.state === 'preparing') {
      return '正在准备 cloudflared，请稍候。'
    }
    if (status.state === 'starting') {
      return '正在与 Cloudflare 建立隧道，通常几秒内完成。'
    }
    if (status.state === 'error') {
      return '常见原因：网络无法访问 GitHub 或 Cloudflare；点击按钮可重试。'
    }
    if (status.state === 'disabled') {
      if (isTauriRuntime()) return '点击上方按钮以生成临时分享链接。'
      return '当前会话未启用分享隧道。可在启动 dev 脚本时保留 MELODY_TUNNEL=1。'
    }
    if (status.state === 'stopped') {
      return '隧道已停止。点击按钮可重新生成。'
    }
    return ''
  }
}

export default new SharePanel()
