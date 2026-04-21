import { checkForUpdates, isUpdateCheckSupported } from '../../services/updateService.js'

// 「关于」面板：展示当前版本、一键检查更新、显示最新版本的更新日志与下载按钮。
// 面板被 inspector 首次切换到时完成增量渲染——避免 index.html 里塞大段模板。

const PANEL_ID = 'inspector-tab-about'
const ENHANCED_FLAG = 'data-aboutEnhanced'
const STATUS_ATTR = 'data-updateStatus'

function formatPublishedAt(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function openExternal(url) {
  if (!url) return
  // Tauri 环境下默认会用系统浏览器打开 target=_blank；网页版也一样。
  window.open(url, '_blank', 'noopener,noreferrer')
}

export class AboutPanelView {
  constructor(options = {}) {
    this.logger = options.logger || null
    this.panel = null
    this.elements = null
    this.isChecking = false
    this.lastResult = null
  }

  init() {
    this.panel = document.getElementById(PANEL_ID)
    if (!this.panel) return
    if (this.panel.getAttribute(ENHANCED_FLAG) === '1') return
    this.panel.setAttribute(ENHANCED_FLAG, '1')

    this.#injectMarkup()
    this.elements.btnCheck?.addEventListener('click', () => {
      void this.runCheck({ userInitiated: true })
    })
    this.elements.btnDownload?.addEventListener('click', () => {
      const url = this.lastResult?.downloadUrl || this.lastResult?.releaseUrl
      openExternal(url)
    })
    this.elements.btnReleaseNotes?.addEventListener('click', () => {
      openExternal(this.lastResult?.releaseUrl)
    })

    this.setStatus('idle', '点击按钮检查是否有新版本。')
    if (!isUpdateCheckSupported()) {
      this.elements.btnCheck.disabled = true
      this.setStatus('info', '网页版无自动更新，请使用桌面版获取最新功能。')
    }
  }

  #injectMarkup() {
    const aboutInfo = this.panel.querySelector('.about-info')
    const currentVersion = this.#readAppVersion()

    const block = document.createElement('div')
    block.className = 'about-update'
    block.innerHTML = `
      <div class="about-version-row">
        <span class="about-version-label">当前版本</span>
        <span class="about-version-value" data-field="currentVersion">${currentVersion || '—'}</span>
      </div>
      <div class="about-update-actions">
        <button type="button" class="about-update-btn primary" data-role="check">检查更新</button>
        <button type="button" class="about-update-btn" data-role="download" hidden>下载新版本</button>
        <button type="button" class="about-update-btn ghost" data-role="release-notes" hidden>查看发布页</button>
      </div>
      <div class="about-update-status" data-role="status" ${STATUS_ATTR}="idle"></div>
      <div class="about-update-notes" data-role="notes" hidden></div>
      <div class="about-links">
        <a href="https://github.com/Marigold1122/melody-singer" target="_blank" rel="noopener noreferrer">项目主页</a>
        <a href="https://github.com/Marigold1122/melody-singer/releases" target="_blank" rel="noopener noreferrer">发布记录</a>
      </div>
    `

    if (aboutInfo) {
      aboutInfo.insertAdjacentElement('afterend', block)
    } else {
      this.panel.appendChild(block)
    }

    this.elements = {
      btnCheck: block.querySelector('[data-role="check"]'),
      btnDownload: block.querySelector('[data-role="download"]'),
      btnReleaseNotes: block.querySelector('[data-role="release-notes"]'),
      statusEl: block.querySelector('[data-role="status"]'),
      notesEl: block.querySelector('[data-role="notes"]'),
      currentVersionEl: block.querySelector('[data-field="currentVersion"]'),
    }
  }

  #readAppVersion() {
    // __APP_VERSION__ 由 vite.config.js 的 define 注入（构建时替换为字面量）；
    // 第一次 check 之后会被 check_for_updates 回传的 current_version 覆盖。
    try {
      // eslint-disable-next-line no-undef
      if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
        return String(__APP_VERSION__)
      }
    } catch {}
    return ''
  }

  setStatus(kind, text) {
    if (!this.elements?.statusEl) return
    this.elements.statusEl.setAttribute(STATUS_ATTR, kind)
    this.elements.statusEl.textContent = text || ''
  }

  async runCheck({ userInitiated = false } = {}) {
    if (this.isChecking) return
    if (!isUpdateCheckSupported()) {
      this.setStatus('info', '网页版无自动更新，请使用桌面版获取最新功能。')
      return
    }
    this.isChecking = true
    this.elements.btnCheck.disabled = true
    this.setStatus('loading', '正在检查更新…')
    if (this.elements.btnDownload) this.elements.btnDownload.hidden = true
    if (this.elements.btnReleaseNotes) this.elements.btnReleaseNotes.hidden = true
    if (this.elements.notesEl) {
      this.elements.notesEl.hidden = true
      this.elements.notesEl.textContent = ''
    }

    try {
      const result = await checkForUpdates()
      this.lastResult = result
      this.logger?.info?.('检查更新结果', { userInitiated, result })

      if (result.currentVersion && this.elements.currentVersionEl) {
        this.elements.currentVersionEl.textContent = result.currentVersion
      }

      if (result.error) {
        this.setStatus('error', `检查失败：${result.error}`)
        return
      }

      if (result.updateAvailable && result.latestVersion) {
        const published = formatPublishedAt(result.publishedAt)
        this.setStatus(
          'update',
          `发现新版本 v${result.latestVersion}${published ? `（发布于 ${published}）` : ''}`,
        )
        if (result.downloadUrl && this.elements.btnDownload) {
          this.elements.btnDownload.hidden = false
        }
        if (result.releaseUrl && this.elements.btnReleaseNotes) {
          this.elements.btnReleaseNotes.hidden = false
        }
        if (result.releaseNotes && this.elements.notesEl) {
          this.elements.notesEl.textContent = result.releaseNotes
          this.elements.notesEl.hidden = false
        }
      } else if (result.latestVersion) {
        this.setStatus('ok', `已是最新版本（v${result.latestVersion}）。`)
      } else {
        this.setStatus('ok', '已是最新版本。')
      }
    } catch (err) {
      this.logger?.error?.('检查更新异常', err)
      this.setStatus('error', `检查异常：${err?.message || err}`)
    } finally {
      this.isChecking = false
      this.elements.btnCheck.disabled = false
    }
  }
}
