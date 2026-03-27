import { createTempoDocument } from '../../shared/tempoDocument.js'

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
    ? `${Math.round(tempos[0]?.bpm || 120)} BPM（默认）`
    : bpmValues.length <= 1
      ? `${bpmValues[0] || Math.round(tempos[0]?.bpm || 120)} BPM`
      : `${Math.min(...bpmValues)} ~ ${Math.max(...bpmValues)} BPM`

  const signatureValues = [...new Set(timeSignatures.map(({ timeSignature }) => {
    return Array.isArray(timeSignature) ? timeSignature.join('/') : '4/4'
  }))]
  const signatureText = !safeTempoData.hasTimeSignatureInfo
    ? `${signatureValues[0] || '4/4'}（默认）`
    : signatureValues.length <= 1
      ? signatureValues[0]
      : `${signatureValues[0]} → ${signatureValues[signatureValues.length - 1]}`

  const keyValues = [...new Set(keySignatures.map(({ key, scale }) => {
    const normalizedKey = typeof key === 'string' && key ? key : 'C'
    return `${normalizedKey}${scale === 'minor' ? ' minor' : ' major'}`
  }))]
  const keyText = !safeTempoData.hasKeySignatureInfo
    ? '未提供'
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
    ['曲速', summary.tempoText],
    ['拍号', summary.signatureText],
    ['调号', summary.keyText],
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
  }

  init() {
    this.refs.btnCancel?.addEventListener('click', () => this._close(null))
    this.refs.btnKeep?.addEventListener('click', () => this._close('keep'))
    this.refs.btnSync?.addEventListener('click', () => this._close('sync'))
  }

  prompt({
    fileName = 'MIDI',
    importedTempoData = null,
    currentTempoData = null,
    hasCurrentProject = false,
  } = {}) {
    if (!this.refs.overlay) return Promise.resolve('sync')
    if (this.pendingResolve) this.pendingResolve(null)

    this.refs.title.textContent = `导入 ${fileName} 的时序信息`
    this.refs.hint.textContent = hasCurrentProject
      ? '导入工程包含新的曲速、拍号或调号信息。要把这些时间信息同步到当前工程吗？'
      : '导入的 MIDI 带有曲速、拍号或调号信息。要应用到新工程吗？'
    renderSummary(this.refs.importedSummary, importedTempoData)
    renderSummary(this.refs.currentSummary, currentTempoData)
    this.refs.currentSection.hidden = !hasCurrentProject
    this.refs.btnKeep.textContent = hasCurrentProject ? '保持当前工程' : '使用默认时序'

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
    resolve(result)
  }
}
