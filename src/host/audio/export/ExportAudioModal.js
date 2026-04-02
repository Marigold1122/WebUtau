const SAMPLE_RATE_OPTIONS = [
  { value: 22050, label: '22050 Hz' },
  { value: 44100, label: '44100 Hz' },
  { value: 48000, label: '48000 Hz' },
]

const BIT_DEPTH_OPTIONS = [
  { value: 16, label: '16 bit' },
  { value: 24, label: '24 bit' },
]

const CHANNEL_OPTIONS = [
  { value: 1, label: '单声道' },
  { value: 2, label: '立体声' },
]

export class ExportAudioModal {
  constructor() {
    this.overlay = null
    this.sampleRateSelect = null
    this.bitDepthSelect = null
    this.channelSelect = null
    this.progressBar = null
    this.progressText = null
    this.warningText = null
    this.btnExportSelected = null
    this.btnExportAll = null
    this.btnCancel = null
    this._resolvePromise = null
    this._rejectPromise = null
    this._blocked = false
    this._hasSelectedTrack = false
  }

  init() {
    this.overlay = document.getElementById('export-audio-modal')
    if (!this.overlay) return
    this.sampleRateSelect = this.overlay.querySelector('#export-sample-rate')
    this.bitDepthSelect = this.overlay.querySelector('#export-bit-depth')
    this.channelSelect = this.overlay.querySelector('#export-channels')
    this.progressBar = this.overlay.querySelector('#export-progress-fill')
    this.progressText = this.overlay.querySelector('#export-progress-text')
    this.warningText = this.overlay.querySelector('#export-warning-text')
    this.btnExportSelected = this.overlay.querySelector('#btn-export-audio-selected')
    this.btnExportAll = this.overlay.querySelector('#btn-export-audio-confirm')
    this.btnCancel = this.overlay.querySelector('#btn-export-audio-cancel')

    this._populateSelect(this.sampleRateSelect, SAMPLE_RATE_OPTIONS, 44100)
    this._populateSelect(this.bitDepthSelect, BIT_DEPTH_OPTIONS, 16)
    this._populateSelect(this.channelSelect, CHANNEL_OPTIONS, 2)

    this.btnExportSelected?.addEventListener('click', () => this._handleExport('selected'))
    this.btnExportAll?.addEventListener('click', () => this._handleExport('all'))
    this.btnCancel?.addEventListener('click', () => this._handleCancel())
  }

  open({ blocked = false, blockedReason = '', selectedTrackName = '' } = {}) {
    if (!this.overlay) return Promise.reject(new Error('导出弹窗未初始化'))
    this._resetProgress()
    this._setExporting(false)
    this._setBlocked(blocked, blockedReason)
    this._hasSelectedTrack = Boolean(selectedTrackName)
    if (this.btnExportSelected) {
      this.btnExportSelected.textContent = selectedTrackName
        ? `导出所选轨道 (${selectedTrackName})`
        : '导出所选轨道'
      this.btnExportSelected.disabled = !this._hasSelectedTrack || blocked
    }
    this.overlay.classList.add('visible')
    this.overlay.setAttribute('aria-hidden', 'false')
    return new Promise((resolve, reject) => {
      this._resolvePromise = resolve
      this._rejectPromise = reject
    })
  }

  close() {
    if (!this.overlay) return
    this.overlay.classList.remove('visible')
    this.overlay.setAttribute('aria-hidden', 'true')
  }

  getSettings() {
    return {
      sampleRate: parseInt(this.sampleRateSelect?.value, 10) || 44100,
      bitDepth: parseInt(this.bitDepthSelect?.value, 10) || 16,
      channels: parseInt(this.channelSelect?.value, 10) || 2,
    }
  }

  setProgress({ message = '', percent = 0 } = {}) {
    if (this.progressText) {
      this.progressText.textContent = message || ''
    }
    if (this.progressBar) {
      this.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`
    }
  }

  _setBlocked(blocked, reason = '') {
    this._blocked = blocked
    if (this.btnExportAll) {
      this.btnExportAll.disabled = blocked
    }
    if (this.btnExportSelected) {
      this.btnExportSelected.disabled = blocked || !this._hasSelectedTrack
    }
    if (this.warningText) {
      this.warningText.textContent = blocked ? (reason || '人声轨渲染尚未完成，无法导出') : ''
      this.warningText.classList.toggle('visible', blocked)
    }
  }

  _setExporting(active) {
    if (this.btnExportAll) {
      this.btnExportAll.disabled = active || this._blocked
      this.btnExportAll.textContent = active ? '正在导出...' : '整体导出'
    }
    if (this.btnExportSelected) {
      this.btnExportSelected.disabled = active || this._blocked || !this._hasSelectedTrack
    }
    if (this.btnCancel) {
      this.btnCancel.textContent = active ? '关闭' : '取消'
    }
    if (this.sampleRateSelect) this.sampleRateSelect.disabled = active
    if (this.bitDepthSelect) this.bitDepthSelect.disabled = active
    if (this.channelSelect) this.channelSelect.disabled = active
  }

  _resetProgress() {
    this.setProgress({ message: '', percent: 0 })
  }

  _handleExport(mode) {
    if (this._blocked) return
    if (mode === 'selected' && !this._hasSelectedTrack) return
    const settings = this.getSettings()
    settings.mode = mode
    this._setExporting(true)
    this._resolvePromise?.(settings)
    this._resolvePromise = null
    this._rejectPromise = null
  }

  _handleCancel() {
    this.close()
    this._rejectPromise?.('cancelled')
    this._resolvePromise = null
    this._rejectPromise = null
  }

  _populateSelect(select, options, defaultValue) {
    if (!select) return
    select.innerHTML = ''
    options.forEach((opt) => {
      const el = document.createElement('option')
      el.value = String(opt.value)
      el.textContent = opt.label
      if (opt.value === defaultValue) el.selected = true
      select.appendChild(el)
    })
  }
}
