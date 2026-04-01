import { LANGUAGE_OPTIONS, normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { fetchVoicebanks, getDefaultSingerId } from '../../api/VoicebankApi.js'

function getRefs() {
  return {
    overlay: document.getElementById('track-language-modal'),
    title: document.getElementById('track-language-title'),
    hint: document.getElementById('track-language-hint'),
    select: document.getElementById('track-language-select'),
    voicebankSelect: document.getElementById('track-voicebank-select'),
    btnCancel: document.getElementById('btn-track-language-cancel'),
    btnConfirm: document.getElementById('btn-track-language-confirm'),
  }
}

export class TrackLanguageModal {
  constructor() {
    this.refs = getRefs()
    this.pendingResolve = null
    this._voicebanksLoaded = false
  }

  init() {
    this._renderOptions()
    this._bindEvents()
  }

  async prompt(trackName, languageCode, options = {}) {
    if (!this.refs.overlay || !this.refs.select) return null
    if (this.pendingResolve) this.pendingResolve(null)

    const normalizedCode = normalizeOptionalLanguageCode(languageCode) || ''
    this.refs.title.textContent = options.title || `为 ${trackName} 选择语言`
    this.refs.hint.textContent = options.hint || '继续前，必须先确认歌曲语言。'
    this.refs.select.value = normalizedCode
    this.refs.btnConfirm.textContent = options.actionLabel || '继续'
    this._updateConfirmState()

    await this._loadVoicebanks(options.singerId)

    this.refs.overlay.classList.add('is-open')
    document.body.classList.add('modal-open')
    queueMicrotask(() => this.refs.select?.focus())

    return new Promise((resolve) => {
      this.pendingResolve = resolve
    })
  }

  async _loadVoicebanks(currentSingerId) {
    const select = this.refs.voicebankSelect
    if (!select) return
    try {
      const voicebanks = await fetchVoicebanks()
      select.innerHTML = ''
      voicebanks.forEach((vb) => {
        const option = document.createElement('option')
        option.value = vb.id
        option.textContent = vb.name || vb.id
        select.appendChild(option)
      })
      if (currentSingerId && voicebanks.some((vb) => vb.id === currentSingerId)) {
        select.value = currentSingerId
      } else {
        select.value = getDefaultSingerId(voicebanks) || ''
      }
      this._voicebanksLoaded = true
    } catch {
      select.innerHTML = '<option value="">无法加载声库</option>'
      this._voicebanksLoaded = false
    }
    this._updateConfirmState()
  }

  _renderOptions() {
    this.refs.select.innerHTML = '<option value="">请选择语言</option>'
    LANGUAGE_OPTIONS.forEach((option) => {
      const element = document.createElement('option')
      element.value = option.code
      element.textContent = `${option.label} (${option.code})`
      this.refs.select.appendChild(element)
    })
  }

  _updateConfirmState() {
    const hasLanguage = Boolean(normalizeOptionalLanguageCode(this.refs.select?.value))
    const hasSinger = Boolean(this.refs.voicebankSelect?.value)
    this.refs.btnConfirm.disabled = !(hasLanguage && hasSinger)
  }

  _bindEvents() {
    this.refs.select?.addEventListener('change', () => this._updateConfirmState())
    this.refs.voicebankSelect?.addEventListener('change', () => this._updateConfirmState())
    this.refs.btnCancel?.addEventListener('click', () => this._close(null))
    this.refs.btnConfirm?.addEventListener('click', () => {
      const code = normalizeOptionalLanguageCode(this.refs.select.value)
      if (!code) return
      const singerId = this.refs.voicebankSelect?.value || null
      this._close({ languageCode: code, singerId })
    })
  }

  _close(result) {
    if (!this.pendingResolve) return
    this.refs.overlay?.classList.remove('is-open')
    document.body.classList.remove('modal-open')
    const resolve = this.pendingResolve
    this.pendingResolve = null
    resolve(result)
  }
}
