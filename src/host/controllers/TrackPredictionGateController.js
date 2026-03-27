import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { buildPredictionOverlayText } from '../app/trackPredictionProgress.js'
import { isTrackPrepReady } from '../project/trackPrepState.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { hasTracksRequiringVoiceLanguageSelection } from '../project/voiceTrackLanguageGate.js'

const VOICE_LANGUAGE_TOAST_ID = 'voice-language-reminder'

export class TrackPredictionGateController {
  constructor({
    store,
    view,
    bridge = null,
    importService,
    taskCoordinator,
    prepWaiters,
    onPlaybackRequested,
    onEditorOpened,
    onEditorCleared,
    onTrackPreparationInvalidated,
    persistEditorSnapshot,
    render,
  }) {
    this.store = store
    this.view = view
    this.bridge = bridge
    this.importService = importService
    this.taskCoordinator = taskCoordinator
    this.prepWaiters = prepWaiters
    this.onPlaybackRequested = onPlaybackRequested
    this.onEditorOpened = onEditorOpened
    this.onEditorCleared = onEditorCleared
    this.onTrackPreparationInvalidated = onTrackPreparationInvalidated
    this.persistEditorSnapshot = persistEditorSnapshot
    this.render = render
    this._activeTrackId = null
  }

  setBridge(bridge) {
    this.bridge = bridge
  }

  getActiveTrackId() {
    return this._activeTrackId
  }

  requires(track) {
    return !normalizeOptionalLanguageCode(track?.languageCode) || !isTrackPrepReady(track)
  }

  async run(trackId, intent) {
    const track = this.store.getTrack(trackId)
    if (!track || !isVoiceRuntimeSource(track.playbackState?.assignedSourceId)) return false

    const languageCode = await this._promptTrackLanguage(track, intent)
    if (!languageCode) {
      this.view.setStatus(intent === 'play' ? '未选择语言，已取消播放前准备' : `已取消打开 ${track.name}`)
      this.render('prediction-gate-cancelled')
      return false
    }

    await this._prepareRuntime(track.id, intent)
    const preparedTrack = this.store.getTrack(track.id)
    const snapshot = this.importService.buildVoiceSnapshot(preparedTrack, this.store.getProject()?.tempoData)
    const prepPromise = this.prepWaiters.wait(track.id)
    this._activeTrackId = track.id
    this.taskCoordinator.beginPrediction(track.id, intent)
    this.store.updateTrackPrepState(preparedTrack.id, { status: 'queued', progress: 8, error: null })
    this.view.showTrackSynthesisOverlay(
      preparedTrack.name,
      buildPredictionOverlayText(8),
      { title: `${preparedTrack.name} 正在预测音高`, initialPercent: 8 },
    )

    try {
      await this.bridge.loadTrack(snapshot)
      this.taskCoordinator.setRuntimeTrack(preparedTrack.id)
      this.store.replaceVoiceSnapshot(preparedTrack.id, snapshot)
      this.store.updateTrackRenderState(preparedTrack.id, { status: 'queued', completed: 0, total: 0, error: null })
      this.render('prediction-gate-runtime-loaded')
      this.view.updateTrackSynthesisOverlay(buildPredictionOverlayText(12), 0.12)
      await this.bridge.startSynthesis({ languageCode })
      const result = await prepPromise
      if (!result?.ok) return false

      if (intent === 'open') {
        this.onEditorOpened?.(preparedTrack.id)
        this.render('editor-opened-after-prediction')
        this.view.notifyRuntimeLayoutChanged()
        this.view.setStatus(`已打开 ${preparedTrack.name} | 音高预测完成`)
        return true
      }

      this.render('playback-start-after-prediction')
      this.view.setStatus(`已完成 ${preparedTrack.name} 的音高预测，开始播放`)
      await this.onPlaybackRequested?.()
      return true
    } finally {
      this._activeTrackId = null
      this.view.hideTrackSynthesisOverlay()
    }
  }

  async _prepareRuntime(trackId, intent) {
    if (intent === 'open' && this.store.getEditorTrack()?.id !== trackId) {
      await this.persistEditorSnapshot()
      this.onEditorCleared?.()
      this.render('prediction-gate-editor-cleared')
      return
    }
    await this.persistEditorSnapshot()
  }

  async _promptTrackLanguage(track, intent) {
    const selectedCode = await this.view.promptTrackLanguage(track.name, track.languageCode, {
      title: `为 ${track.name} 选择语言`,
      hint: intent === 'play'
        ? '开始播放前，必须先确认语言并完成音高预测。'
        : '进入人声编辑器前，必须先确认语言并完成音高预测。',
      actionLabel: intent === 'play' ? '预测后播放' : '预测并打开',
    })
    const languageCode = normalizeOptionalLanguageCode(selectedCode)
    if (!languageCode) return null

    const languageChanged = normalizeOptionalLanguageCode(track.languageCode) !== languageCode
    this.store.updateTrack(track.id, { languageCode })
    if (!hasTracksRequiringVoiceLanguageSelection(this.store.getProject()?.tracks || [])) {
      this.view.hidePlaybackToast(VOICE_LANGUAGE_TOAST_ID)
    }
    if (languageChanged) {
      this.taskCoordinator.resetTrackTask(track.id)
      this.store.updateTrackPrepState(track.id, { status: 'idle', progress: 0, error: null })
      this.store.updateTrackRenderState(track.id, { status: 'idle', completed: 0, total: 0, error: null })
      this.onTrackPreparationInvalidated?.(track.id)
    }
    this.render('track-language-updated')
    return languageCode
  }
}
