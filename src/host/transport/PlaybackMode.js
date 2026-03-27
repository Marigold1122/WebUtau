/**
 * PlaybackMode — 播放模式状态机
 *
 * 管理宿主播放时的两种模式及其子状态：
 *
 *   PREVIEW（卷帘关闭，多轨预览）
 *     phrase miss → 静音跳过 + toast
 *
 *   EDIT（卷帘打开，单轨编辑）
 *     phrase miss → 暂停等待（buffering），渲染就绪后恢复
 *
 * 状态转移图：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │               setEditorOpen()                │
 *   │  PREVIEW ◄──────────────────────► EDIT       │
 *   │               setEditorClosed()              │
 *   └──────────────────────────────────────────────┘
 *
 *   EDIT 子状态：
 *     IDLE ──play──► PLAYING ──phraseMiss──► BUFFERING
 *                      ▲                       │
 *                      └───phraseReady─────────┘
 */

export const MODE = Object.freeze({
  PREVIEW: 'preview',
  EDIT: 'edit',
})

export const PLAYBACK = Object.freeze({
  IDLE: 'idle',
  PLAYING: 'playing',
  BUFFERING: 'buffering',
})

export class PlaybackMode {
  constructor() {
    this.mode = MODE.PREVIEW
    this.playback = PLAYBACK.IDLE
    this.editorTrackId = null
    this.bufferingPhraseIndex = null
    this.bufferingJobId = null
  }

  // ── 模式切换 ──

  setEditorOpen(trackId) {
    this.mode = MODE.EDIT
    this.editorTrackId = trackId || null
    this._clearBuffering()
  }

  setEditorClosed() {
    this.mode = MODE.PREVIEW
    this.editorTrackId = null
    this._clearBuffering()
  }

  // ── 播放状态 ──

  onPlayStart() {
    this.playback = PLAYBACK.PLAYING
    this._clearBuffering()
  }

  onPlayStop() {
    this.playback = PLAYBACK.IDLE
    this._clearBuffering()
  }

  // ── Phrase miss 处理 ──

  /**
   * 当播放中遇到未渲染的 phrase 时调用。
   * 返回应执行的动作：
   *   { action: 'skip' }     → 静音跳过 + toast（PREVIEW 模式，或命中非当前编辑轨）
   *   { action: 'buffer', phraseIndex, jobId } → 暂停等待（EDIT 模式）
   */
  handlePhraseMiss(trackId, phraseIndex, jobId) {
    if (this.mode === MODE.PREVIEW) {
      return { action: 'skip' }
    }
    if (this.editorTrackId && trackId && trackId !== this.editorTrackId) {
      return { action: 'skip' }
    }

    // EDIT 模式：进入 buffering
    if (this.playback === PLAYBACK.BUFFERING) {
      // 已经在等待中，不重复触发
      return { action: 'already-buffering' }
    }

    this.playback = PLAYBACK.BUFFERING
    this.bufferingPhraseIndex = phraseIndex
    this.bufferingJobId = jobId
    return { action: 'buffer', phraseIndex, jobId }
  }

  /**
   * 当一个 phrase 渲染就绪时调用。
   * 返回是否应恢复播放。
   */
  handlePhraseReady(phraseIndex, jobId = null) {
    if (this.playback !== PLAYBACK.BUFFERING) return { action: 'none' }
    if (this.bufferingPhraseIndex !== phraseIndex) return { action: 'none' }
    if (this.bufferingJobId && jobId && this.bufferingJobId !== jobId) return { action: 'none' }

    this.playback = PLAYBACK.PLAYING
    this._clearBuffering()
    return { action: 'resume' }
  }

  // ── 查询 ──

  getMode() {
    return this.mode
  }

  getPlayback() {
    return this.playback
  }

  isPreview() {
    return this.mode === MODE.PREVIEW
  }

  isEdit() {
    return this.mode === MODE.EDIT
  }

  isBuffering() {
    return this.playback === PLAYBACK.BUFFERING
  }

  isPlaying() {
    return this.playback === PLAYBACK.PLAYING
  }

  getEditorTrackId() {
    return this.editorTrackId
  }

  getSnapshot() {
    return {
      mode: this.mode,
      playback: this.playback,
      editorTrackId: this.editorTrackId,
      bufferingPhraseIndex: this.bufferingPhraseIndex,
      bufferingJobId: this.bufferingJobId,
    }
  }

  // ── 内部 ──

  _clearBuffering() {
    this.bufferingPhraseIndex = null
    this.bufferingJobId = null
  }
}
