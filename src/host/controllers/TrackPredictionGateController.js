import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { buildPredictionOverlayText } from '../app/trackPredictionProgress.js'
import { hasPredictedPitch, isTrackPrepReady } from '../project/trackPrepState.js'
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
    // 如果 track 已经有有效 pitchData（USTX 携带的合成曲线 / _meta 影子还原 / 上一轮渲染产物），
    // 不重新预测——只把 snapshot 推给 runtime 让 iframe 加载已有曲线就行。
    // 用户的 USTX 工程含 pitchCurve 时，选完语言/声库不该被强制重算（覆盖原 pitch 数据）
    const alreadyPredicted = isTrackPrepReady(preparedTrack) && hasPredictedPitch(preparedTrack.voiceSnapshot)
    const snapshot = this.importService.buildVoiceSnapshot(preparedTrack, this.store.getProject()?.tempoData)
    this._activeTrackId = track.id

    if (alreadyPredicted) {
      // 已经有 pitchData → 跳过 prepWaiters 等待（编辑器立即可用）+ 不显示 PrepareOverlay；
      // 但 startSynthesis 仍要调——它在 webUTAU 架构里**不只是音高预测**，更重要的是
      // "提交 MIDI 给后端做 phrase 音频渲染"。不调就没 WAV 文件、播放无声。
      // 关键：必须调 beginPrediction 让 jobRef.status='active'，否则 taskCoordinator.
      // matchesActiveTask 拒绝所有 backend 后续事件（onRenderProgress / onRenderComplete /
      // onJobSubmitted / onPhraseReady 都用 matchesActiveTask 守卫），UI 永远停在
      // "渲染中"、音频也注册不进 vocalAssetRegistry → 播放无声
      try {
        this.taskCoordinator.beginPrediction(preparedTrack.id, intent)
        await this.bridge.loadTrack(snapshot)
        this.taskCoordinator.setRuntimeTrack(preparedTrack.id)
        this.store.updateTrackRenderState(preparedTrack.id, { status: 'queued', completed: 0, total: 0, error: null })
        this.render('prediction-gate-skip-resync')
        await this.bridge.startSynthesis({ languageCode, singerId })
        // 不 await prepWaiters——pitchData 已存在，编辑器不必等 backend prediction
        if (intent === 'open') {
          this.onEditorOpened?.(preparedTrack.id)
          this.render('editor-opened-with-precomputed-pitch')
          this.view.notifyRuntimeLayoutChanged()
          this.view.setStatus(t('predictionGate.open_done', { name: preparedTrack.name }))
          return true
        }
        if (isResume) {
          this.render('prediction-gate-resume-ready')
          return true
        }
        this.render('playback-start-with-precomputed-pitch')
        this.view.setStatus(t('predictionGate.play_done', { name: preparedTrack.name }))
        await this.onPlaybackRequested?.()
        return true
      } finally {
        this._activeTrackId = null
        this.view.hideTrackSynthesisOverlay()
      }
    }

    const prepPromise = this.prepWaiters.wait(track.id)
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
    // 关键：language/singer 变更通常意味着"需要按新声库重新预测"，但 track 已经携带
    // 有效 pitchData（USTX 工程的 OpenUtau pitch 曲线、上一轮 AI 预测产物等）时，
    // 用户的意图是"补语言信息但保留现成的音高"——若清掉 prepState，run() 后续就会
    // 重启 startSynthesis 覆盖 pitchData。所以只在确实没有 pitch 数据时才作废。
    const trackAfterUpdate = this.store.getTrack(track.id)
    const hasUsableSnapshot = isTrackPrepReady(trackAfterUpdate)
      && hasPredictedPitch(trackAfterUpdate?.voiceSnapshot)
    if ((languageChanged || singerChanged) && !hasUsableSnapshot) {
      this.taskCoordinator.resetTrackTask(track.id)
      this.store.updateTrackPrepState(track.id, { status: 'idle', progress: 0, error: null })
      this.store.updateTrackRenderState(track.id, { status: 'idle', completed: 0, total: 0, error: null })
      this.onTrackPreparationInvalidated?.(track.id)
    }
    this.render('track-language-updated')
    return { languageCode, singerId }
  }
}
