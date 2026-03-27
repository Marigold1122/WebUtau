import { LANGUAGE_OPTIONS, normalizeOptionalLanguageCode } from '../../config/languageOptions.js'

function getRefs() {
  return {
    overlay: document.getElementById('track-language-modal'),
    title: document.getElementById('track-language-title'),
    hint: document.getElementById('track-language-hint'),
    select: document.getElementById('track-language-select'),
    btnCancel: document.getElementById('btn-track-language-cancel'),
    btnConfirm: document.getElementById('btn-track-language-confirm'),
  }
}

export class TrackLanguageModal {
  constructor() {
    this.refs = getRefs()
    this.pendingResolve = null
  }

  init() {
    this._renderOptions()
    this._bindEvents()
  }

  prompt(trackName, languageCode, options = {}) {
    if (!this.refs.overlay || !this.refs.select) return Promise.resolve(null)
    if (this.pendingResolve) this.pendingResolve(null)

    const normalizedCode = normalizeOptionalLanguageCode(languageCode) || ''
    this.refs.title.textContent = options.title || `为 ${trackName} 选择语言`
    this.refs.hint.textContent = options.hint || '继续前，必须先确认歌曲语言。'
    this.refs.select.value = normalizedCode
    this.refs.btnConfirm.textContent = options.actionLabel || '继续'
    this.refs.btnConfirm.disabled = !normalizedCode
    this.refs.overlay.classList.add('is-open')
    document.body.classList.add('modal-open')
    queueMicrotask(() => this.refs.select?.focus())

    return new Promise((resolve) => {
      this.pendingResolve = resolve
    })
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

  _bindEvents() {
    this.refs.select?.addEventListener('change', () => {
      this.refs.btnConfirm.disabled = !normalizeOptionalLanguageCode(this.refs.select.value)
    })
    this.refs.btnCancel?.addEventListener('click', () => this._close(null))
    this.refs.btnConfirm?.addEventListener('click', () => {
      const code = normalizeOptionalLanguageCode(this.refs.select.value)
      if (!code) return
      this._close(code)
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
