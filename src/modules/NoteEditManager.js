import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import phraseStore from '../core/PhraseStore.js'

const M = '[音符编辑]'

// 本地直更歌词——当 runtime 还没 server job 时使用。
//
// 关键：phraseStore 里的 note 经 createNoteDocument 处理后**只有** time/midi/tick，
// 没有 position/tone 字段（那是 backend 协议字段）。匹配 edit 必须按
// LyricEditor._buildNoteIdentity 同款约定，把 note 的 time/midi 反推成
// (position = time*480*bpm/60, tone = midi)，跟 edit.position / edit.tone 对齐。
function applyLyricEditsLocally(edits) {
  const phrases = phraseStore.getPhrases()
  const bpm = phraseStore.getBpm() || 120
  const noteToPosition = (note) => Math.round((Number(note?.time || 0) * 480 * bpm) / 60)
  const noteToTone = (note) => Number.isFinite(note?.midi) ? Math.round(note.midi) : 60
  const affectedSet = new Set()
  for (const edit of edits) {
    if (edit?.action !== 'lyric') continue
    for (let pi = 0; pi < phrases.length; pi++) {
      const phrase = phrases[pi]
      if (!Array.isArray(phrase?.notes)) continue
      const noteIdx = phrase.notes.findIndex((n) => noteToPosition(n) === edit.position && noteToTone(n) === edit.tone)
      if (noteIdx < 0) continue
      const updatedNotes = phrase.notes.slice()
      updatedNotes[noteIdx] = { ...updatedNotes[noteIdx], lyric: edit.lyric }
      phraseStore.updatePhrase(pi, { notes: updatedNotes })
      affectedSet.add(pi)
      break
    }
  }
  return Array.from(affectedSet)
}

class NoteEditManager {
  constructor() {
    this._editQueue = Promise.resolve()
  }

  canEdit() {
    return phraseStore.getJobId() != null && renderJobManager.isRebuilt()
  }

  applyEdits(edits = []) {
    const normalizedEdits = Array.isArray(edits) ? edits.filter((edit) => edit && typeof edit.action === 'string') : []
    if (normalizedEdits.length === 0) return Promise.resolve({ affectedIndices: [], phrases: [] })
    const result = this._editQueue.then(() => this._processEdit(normalizedEdits))
    this._editQueue = result.catch(() => {})
    return result
  }

  async _processEdit(edits) {
    const jobId = phraseStore.getJobId()
    if (!jobId) {
      // jobId 为空 = 当前 runtime 还没创建 server-side 渲染任务。常见场景：
      //   1) 工程从 .webutau 加载（pruneTrack 故意删了 jobRef，因为它是 server 引用、跨会话失效）
      //   2) 用户尚未点过"渲染为人声"
      // 这种情况下"音符 / 音高"修改无法 server 端重渲染，但**纯歌词修改**只是改文本，
      // 后续渲染时直接用更新后的 lyric 即可。所以仅当全是 lyric edit 时本地更新放行
      const allLyric = edits.every((e) => e?.action === 'lyric')
      if (!allLyric) throw new Error('No active job')
      const affectedIndices = applyLyricEditsLocally(edits)
      console.log(`${M} ← 本地直更（无 server job） | edits=${edits.length}, affected=[${affectedIndices.join(',')}]`)
      return { affectedIndices, phrases: phraseStore.getPhrases() }
    }

    console.log(`${M} → 提交后端 | jobId=${jobId}, edits=${edits.length}`)
    const response = await renderApi.editNotes(jobId, edits)
    const affectedIndices = Array.isArray(response?.affectedIndices) ? response.affectedIndices : []
    const phrases = Array.isArray(response?.phrases) ? response.phrases : []
    const phraseCount = phrases.length

    if (affectedIndices.length > 0) {
      renderCache.clearIndices(affectedIndices)
      audioEngine.cancelPhrases(affectedIndices)
    }
    if (phraseCount > 0) {
      renderCache.clearAbove(phraseCount)
      renderJobManager.restartForEdit(phraseCount)
      phraseStore.rebuildFromEdit(phrases)
    }

    try {
      const pitchData = await renderApi.getPitch(jobId)
      phraseStore.setPitchData(pitchData)
    } catch (error) {
      console.warn(`${M} 获取更新后的音高失败 | ${error?.message || error}`)
    }

    console.log(`${M} ← 应用完成 | affected=[${affectedIndices.join(', ')}], phraseCount=${phraseCount}`)
    return {
      affectedIndices,
      phrases,
    }
  }
}

export default new NoteEditManager()
