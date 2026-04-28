import { PIANO_ROLL } from '../config/constants.js'
import { DEFAULT_LANGUAGE_CODE, LANGUAGE_OPTIONS, normalizeLanguageCode } from '../config/languageOptions.js'
import { t } from '../i18n/index.js'

class TrackSelector {
  constructor() {
    this.overlay = null
    this.resolve = null
    this.languageCode = DEFAULT_LANGUAGE_CODE
  }

  init() {
    if (this.overlay) return
    this.overlay = document.createElement('div')
    this.overlay.id = 'track-selector-overlay'
    this.overlay.innerHTML = `
      <div class="track-selector-card">
        <h2 class="track-selector-title"></h2>
        <div class="track-selector-tempo"></div>
        <div class="track-selector-language"></div>
        <div class="track-selector-list"></div>
      </div>
    `
    this.overlay.style.display = 'none'
    document.body.appendChild(this.overlay)
  }

  show(tracks, fileName, tempoData) {
    if (!this.overlay) this.init()

    const title = this.overlay.querySelector('.track-selector-title')
    const tempo = this.overlay.querySelector('.track-selector-tempo')
    const language = this.overlay.querySelector('.track-selector-language')
    const list = this.overlay.querySelector('.track-selector-list')
    title.textContent = t('trackSelector.title', { name: fileName })
    const { tempoText, timeSignatureText } = this._formatTempoText(tempoData)
    tempo.innerHTML = `
      <span class="tempo-info">${t('trackSelector.tempo_info', { tempo: tempoText, sig: timeSignatureText })}</span>
      <label class="tempo-sync-label">
        <input type="checkbox" class="tempo-sync-checkbox" checked />
        ${t('trackSelector.sync_tempo')}
      </label>
    `
    this._renderLanguageSelector(language)
    list.innerHTML = ''

    tracks.forEach((track) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'track-option'
      const noteText = t('trackSelector.note_count', { count: track.noteCount })
      const lyricText = track.hasLyrics ? t('trackSelector.has_lyrics') : t('trackSelector.no_lyrics')
      button.textContent = `${track.name} | ${noteText} | ${lyricText}`
      button.addEventListener('click', () => this._onSelect(track.index))
      list.appendChild(button)
    })

    this.overlay.style.display = 'flex'
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  _onSelect(trackIndex) {
    const checkbox = this.overlay?.querySelector('.tempo-sync-checkbox')
    const languageSelect = this.overlay?.querySelector('.track-selector-language-select')
    const syncTempo = checkbox ? checkbox.checked : true
    const languageCode = normalizeLanguageCode(languageSelect?.value)
    this.languageCode = languageCode
    this.overlay.style.display = 'none'
    if (this.resolve) this.resolve({ trackIndex, syncTempo, languageCode })
    this.resolve = null
  }

  _renderLanguageSelector(container) {
    if (!container) return
    container.innerHTML = `
      <label class="track-selector-language-label" for="track-language-select">${t('trackSelector.song_lang')}</label>
      <select id="track-language-select" class="track-selector-language-select"></select>
    `
    const select = container.querySelector('.track-selector-language-select')
    if (!select) return
    LANGUAGE_OPTIONS.forEach((option) => {
      const element = document.createElement('option')
      element.value = option.code
      element.textContent = `${option.label} (${option.code})`
      select.appendChild(element)
    })
    select.value = normalizeLanguageCode(this.languageCode)
    select.addEventListener('change', () => {
      this.languageCode = normalizeLanguageCode(select.value)
      select.value = this.languageCode
    })
  }

  _formatTempoText(tempoData) {
    const tempos = tempoData?.tempos || []
    const timeSignatures = tempoData?.timeSignatures || []
    const hasTempoInfo = tempoData?.hasTempoInfo ?? tempos.length > 0
    const hasTimeSignatureInfo = tempoData?.hasTimeSignatureInfo ?? timeSignatures.length > 0
    const defaultSignature = PIANO_ROLL.DEFAULT_TIME_SIGNATURE.join('/')

    const bpmValues = [...new Set(tempos.map(({ bpm }) => Math.round(bpm)))]
    const signatureValues = [...new Set(timeSignatures.map(({ timeSignature }) => timeSignature.join('/')))]

    const tempoText = !hasTempoInfo
      ? t('trackSelector.bpm_default', { bpm: PIANO_ROLL.DEFAULT_BPM })
      : bpmValues.length <= 1
        ? `${bpmValues[0] || PIANO_ROLL.DEFAULT_BPM} BPM`
        : t('trackSelector.bpm_variable', { lo: Math.min(...bpmValues), hi: Math.max(...bpmValues) })

    const timeSignatureText = !hasTimeSignatureInfo
      ? t('trackSelector.sig_default', { value: defaultSignature })
      : signatureValues.length <= 1
        ? signatureValues[0] || defaultSignature
        : t('trackSelector.sig_variable', { from: signatureValues[0], to: signatureValues[signatureValues.length - 1] })

    return { tempoText, timeSignatureText }
  }
}

export default new TrackSelector()
