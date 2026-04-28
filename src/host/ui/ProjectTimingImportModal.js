import { createTempoDocument } from '../../shared/tempoDocument.js'
import { t, onLocaleChange } from '../../i18n/index.js'

function getRefs() {
  return {
    overlay: document.getElementById('project-timing-import-modal'),
    title: document.getElementById('project-timing-import-title'),
    hint: document.getElementById('project-timing-import-hint'),
    importedSummary: document.getElementById('project-timing-import-summary'),
    currentSection: document.getElementById('project-timing-current-section'),
    currentSummary: document.getElementById('project-timing-current-summary'),
    btnCancel: document.getElementById('btn-project-timing-cancel'),
    btnKeep: document.getElementById('btn-project-timing-keep'),
    btnSync: document.getElementById('btn-project-timing-sync'),
  }
}

function formatTempoSummary(tempoData) {
  const safeTempoData = createTempoDocument(tempoData)
  const tempos = safeTempoData.tempos || []
  const timeSignatures = safeTempoData.timeSignatures || []
  const keySignatures = safeTempoData.keySignatures || []

  const bpmValues = [...new Set(tempos.map(({ bpm }) => Math.round(bpm)).filter(Number.isFinite))]
  const tempoText = !safeTempoData.hasTempoInfo
    ? t('modal.timing.tempo_default', { bpm: Math.round(tempos[0]?.bpm || 120) })
    : bpmValues.length <= 1
      ? `${bpmValues[0] || Math.round(tempos[0]?.bpm || 120)} BPM`
      : `${Math.min(...bpmValues)} ~ ${Math.max(...bpmValues)} BPM`

  const signatureValues = [...new Set(timeSignatures.map(({ timeSignature }) => {
    return Array.isArray(timeSignature) ? timeSignature.join('/') : '4/4'
  }))]
  const signatureText = !safeTempoData.hasTimeSignatureInfo
    ? t('modal.timing.sig_default', { value: signatureValues[0] || '4/4' })
    : signatureValues.length <= 1
      ? signatureValues[0]
      : `${signatureValues[0]} → ${signatureValues[signatureValues.length - 1]}`

  const keyValues = [...new Set(keySignatures.map(({ key, scale }) => {
    const normalizedKey = typeof key === 'string' && key ? key : 'C'
    return `${normalizedKey}${scale === 'minor' ? ' minor' : ' major'}`
  }))]
  const keyText = !safeTempoData.hasKeySignatureInfo
    ? t('modal.timing.not_provided')
    : keyValues.length <= 1
      ? keyValues[0]
      : `${keyValues[0]} → ${keyValues[keyValues.length - 1]}`

  return {
    tempoText,
    signatureText,
    keyText,
  }
}

function renderSummary(container, tempoData) {
  if (!container) return
  const summary = formatTempoSummary(tempoData)
  container.innerHTML = ''
  ;[
    [t('modal.timing.tempo'), summary.tempoText],
    [t('modal.timing.time_sig'), summary.signatureText],
    [t('modal.timing.key_sig'), summary.keyText],
  ].forEach(([label, value]) => {
    const row = document.createElement('div')
    row.className = 'modal-summary-row'
    const name = document.createElement('span')
    name.className = 'modal-summary-label'
    name.textContent = label
    const text = document.createElement('span')
    text.className = 'modal-summary-value'
    text.textContent = value
    row.append(name, text)
    container.appendChild(row)
  })
}

export class ProjectTimingImportModal {
  constructor() {
    this.refs = getRefs()
    this.pendingResolve = null
    this._lastPromptArgs = null
  }

  init() {
    this.refs.btnCancel?.addEventListener('click', () => this._close(null))
    this.refs.btnKeep?.addEventListener('click', () => this._close('keep'))
    this.refs.btnSync?.addEventListener('click', () => this._close('sync'))
    // locale 切换时重渲当前展示中的内容
    onLocaleChange(() => {
      if (this.pendingResolve && this._lastPromptArgs) this._renderTexts(this._lastPromptArgs)
    })
  }

  _renderTexts({ fileName, importedTempoData, currentTempoData, hasCurrentProject }) {
    if (!this.refs.title) return
    this.refs.title.textContent = t('modal.timing.title_named', { name: fileName })
    this.refs.hint.textContent = hasCurrentProject
      ? t('modal.timing.hint_with_current')
      : t('modal.timing.hint_new')
    renderSummary(this.refs.importedSummary, importedTempoData)
    renderSummary(this.refs.currentSummary, currentTempoData)
    this.refs.currentSection.hidden = !hasCurrentProject
    this.refs.btnKeep.textContent = hasCurrentProject
      ? t('modal.timing.keep_current')
      : t('modal.timing.use_default')
    this.refs.btnCancel.textContent = t('modal.timing.cancel')
    this.refs.btnSync.textContent = t('modal.timing.sync')
  }

  prompt({
    fileName = 'MIDI',
    importedTempoData = null,
    currentTempoData = null,
    hasCurrentProject = false,
  } = {}) {
    if (!this.refs.overlay) return Promise.resolve('sync')
    if (this.pendingResolve) this.pendingResolve(null)

    const args = { fileName, importedTempoData, currentTempoData, hasCurrentProject }
    this._lastPromptArgs = args
    this._renderTexts(args)

    this.refs.overlay.classList.add('is-open')
    document.body.classList.add('modal-open')
    queueMicrotask(() => this.refs.btnSync?.focus())

    return new Promise((resolve) => {
      this.pendingResolve = resolve
    })
  }

  _close(result) {
    if (!this.pendingResolve) return
    this.refs.overlay?.classList.remove('is-open')
    document.body.classList.remove('modal-open')
    const resolve = this.pendingResolve
    this.pendingResolve = null
    this._lastPromptArgs = null
    resolve(result)
  }
}
