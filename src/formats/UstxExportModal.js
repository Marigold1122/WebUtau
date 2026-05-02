import { t } from '../i18n/index.js'
import { isVoiceRuntimeSource } from '../host/project/trackSourceAssignment.js'
import { isAudioTrack } from '../host/project/trackContentType.js'

export class UstxExportModal {
  constructor() {
    this.overlay = null
    this.trackListEl = null
    this.btnExport = null
    this.btnCancel = null
    this.btnSelectAll = null
    this.btnDeselectAll = null
    this._resolvePromise = null
    this._rejectPromise = null
  }

  init() {
    this.overlay = document.getElementById('ustx-export-modal')
    if (!this.overlay) return
    this.trackListEl = this.overlay.querySelector('#ustx-export-track-list')
    this.btnExport = this.overlay.querySelector('#btn-ustx-export-confirm')
    this.btnCancel = this.overlay.querySelector('#btn-ustx-export-cancel')
    this.btnSelectAll = this.overlay.querySelector('#btn-ustx-select-all')
    this.btnDeselectAll = this.overlay.querySelector('#btn-ustx-deselect-all')

    this.btnExport?.addEventListener('click', () => this._handleExport())
    this.btnCancel?.addEventListener('click', () => this._handleCancel())
    this.btnSelectAll?.addEventListener('click', () => this._setAllChecked(true))
    this.btnDeselectAll?.addEventListener('click', () => this._setAllChecked(false))
  }

  /**
   * @param {object[]} allTracks - all project tracks
   * @returns {Promise<string[]>} checked track IDs
   */
  open(allTracks = []) {
    if (!this.overlay) return Promise.reject(new Error('USTX export modal not initialized'))
    const vocalTracks = allTracks.filter((track) =>
      !isAudioTrack(track) && isVoiceRuntimeSource(track?.playbackState?.assignedSourceId),
    )
    this._renderTrackList(vocalTracks)
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

  getCheckedTrackIds() {
    const checkboxes = this.trackListEl?.querySelectorAll('input[type="checkbox"]:checked') || []
    return Array.from(checkboxes).map((cb) => cb.dataset.trackId).filter(Boolean)
  }

  _renderTrackList(tracks) {
    if (!this.trackListEl) return
    this.trackListEl.innerHTML = ''
    if (tracks.length === 0) {
      this.trackListEl.innerHTML = `<div class="ustx-export-empty">${t('modal.ustxExport.no_vocal_tracks')}</div>`
      if (this.btnExport) this.btnExport.disabled = true
      return
    }
    tracks.forEach((track) => {
      const noteCount = Array.isArray(track.previewNotes) ? track.previewNotes.length : 0
      const singer = track.singerId || ''
      const row = document.createElement('label')
      row.className = 'ustx-export-track-row'
      row.innerHTML = [
        `<input type="checkbox" data-track-id="${this._escapeAttr(track.id)}" checked />`,
        `<span class="ustx-export-track-name">${this._escapeHtml(track.name || '')}</span>`,
        `<span class="ustx-export-track-info">${this._escapeHtml(singer)} &mdash; ${noteCount} ${t('modal.ustxExport.notes')}</span>`,
      ].join('')
      this.trackListEl.appendChild(row)
    })
    if (this.btnExport) this.btnExport.disabled = false
  }

  _setAllChecked(checked) {
    const checkboxes = this.trackListEl?.querySelectorAll('input[type="checkbox"]') || []
    checkboxes.forEach((cb) => { cb.checked = checked })
  }

  _handleExport() {
    const checkedIds = this.getCheckedTrackIds()
    if (checkedIds.length === 0) return
    this.close()
    this._resolvePromise?.(checkedIds)
    this._resolvePromise = null
    this._rejectPromise = null
  }

  _handleCancel() {
    this.close()
    this._rejectPromise?.('cancelled')
    this._resolvePromise = null
    this._rejectPromise = null
  }

  _escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  _escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;')
  }
}
