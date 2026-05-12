import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { buildPredictionOverlayText } from '../app/trackPredictionProgress.js'
import { isTrackPrepReady } from '../project/trackPrepState.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { hasTracksRequiringVoiceLanguageSelection } from '../project/voiceTrackLanguageGate.js'
import { t } from '../../i18n/index.js'

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

    // intent='resume'：恢复工程后由 host 自动调用，已经有 language/singer，不再弹
    // 语言对话框；流程其余部分（overlay、进度更新、prepWaiters）一律复用，避免
    // runtime 那边孤零零的 PrepareOverlay 长时间占屏。
    const isResume = intent === 'resume'

    let gateResult
    if (isResume) {
      const languageCode = normalizeOptionalLanguageCode(track.languageCode)
      if (!languageCode || !track.singerId) return false
      gateResult = { languageCode, singerId: track.singerId }
    } else {
      gateResult = await this._promptTrackLanguage(track, intent)
      if (!gateResult) {
        this.view.setStatus(intent === 'play'
          ? t('predictionGate.canceled_play')
          : t('predictionGate.canceled_open', { name: track.name }))
        this.render('prediction-gate-cancelled')
        return false
      }
    }
    const { languageCode, singerId } = gateResult

    if (!isResume) await this._prepareRuntime(track.id, intent)
    const preparedTrack = this.store.getTrack(track.id)
    const snapshot = this.importService.buildVoiceSnapshot(preparedTrack, this.store.getProject()?.tempoData)
    const prepPromise = this.prepWaiters.wait(track.id)
    this._activeTrackId = track.id
    this.taskCoordinator.beginPrediction(track.id, intent)
    this.store.updateTrackPrepState(preparedTrack.id, { status: 'queued', progress: 8, error: null })
    this.view.showTrackSynthesisOverlay(
      preparedTrack.name,
      buildPredictionOverlayText(8),
      { title: t('predictionGate.track_preparing', { name: preparedTrack.name }), initialPercent: 8 },
    )

    try {
      await this.bridge.loadTrack(snapshot)
      this.taskCoordinator.setRuntimeTrack(preparedTrack.id)
      this.store.replaceVoiceSnapshot(preparedTrack.id, snapshot)
      this.store.updateTrackRenderState(preparedTrack.id, { status: 'queued', completed: 0, total: 0, error: null })
      this.render('prediction-gate-runtime-loaded')
      this.view.updateTrackSynthesisOverlay(buildPredictionOverlayText(12), 0.12)
      await this.bridge.startSynthesis({ languageCode, singerId })
      const result = await prepPromise
      if (!result?.ok) return false

      if (intent === 'open') {
        this.onEditorOpened?.(preparedTrack.id)
        this.render('editor-opened-after-prediction')
        this.view.notifyRuntimeLayoutChanged()
        this.view.setStatus(t('predictionGate.open_done', { name: preparedTrack.name }))
        return true
      }

      if (isResume) {
        // 不切编辑器、不起播放——只把渲染链路跑起来，让 host vocalAssetRegistry 拿到音频
        this.render('prediction-gate-resume-ready')
        return true
      }

      this.render('playback-start-after-prediction')
      this.view.setStatus(t('predictionGate.play_done', { name: preparedTrack.name }))
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
    // 注意：此弹窗出现在 singerId 确定之前，无法按音源类型个性化文案。
    // 改用对 DiffSinger / Classic UTAU 都适用的"准备"字样。
    const result = await this.view.promptTrackLanguage(track.name, track.languageCode, {
      title: t('predictionGate.title_for', { name: track.name }),
      hint: intent === 'play'
        ? t('predictionGate.hint_play')
        : t('predictionGate.hint_open'),
      actionLabel: intent === 'play' ? t('predictionGate.action_play') : t('predictionGate.action_open'),
      singerId: track.singerId,
    })
    if (!result) return null
    const languageCode = normalizeOptionalLanguageCode(result.languageCode)
    if (!languageCode) return null
    const singerId = result.singerId || null

    const languageChanged = normalizeOptionalLanguageCode(track.languageCode) !== languageCode
    const singerChanged = track.singerId !== singerId
    this.store.updateTrack(track.id, { languageCode, singerId })
    if (!hasTracksRequiringVoiceLanguageSelection(this.store.getProject()?.tracks || [])) {
      this.view.hidePlaybackToast(VOICE_LANGUAGE_TOAST_ID)
    }
    if (languageChanged || singerChanged) {
      this.taskCoordinator.resetTrackTask(track.id)
      this.store.updateTrackPrepState(track.id, { status: 'idle', progress: 0, error: null })
      this.store.updateTrackRenderState(track.id, { status: 'idle', completed: 0, total: 0, error: null })
      this.onTrackPreparationInvalidated?.(track.id)
    }
    this.render('track-language-updated')
    return { languageCode, singerId }
  }
}
