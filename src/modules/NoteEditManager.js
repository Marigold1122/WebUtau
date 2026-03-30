import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import phraseStore from '../core/PhraseStore.js'

const M = '[音符编辑]'

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
    if (!jobId) throw new Error('No active job')

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
