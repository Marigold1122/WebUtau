import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import phraseStore from '../core/PhraseStore.js'
import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'

const M = '[歌词编辑]'

class LyricEditor {
  constructor() {
    this._editQueue = Promise.resolve()
  }

  canEdit() {
    return phraseStore.getJobId() != null && renderJobManager.isRebuilt()
  }

  editNoteLyric(noteIdentity, newLyric, phraseIndex, noteRef) {
    console.log(`${M} ← 收到编辑请求(来自钢琴卷帘) | phrase=${phraseIndex}, position=${noteIdentity.position}, duration=${noteIdentity.duration}, tone=${noteIdentity.midi}, 新歌词="${newLyric}"`)
    const rollbackSnapshot = this._snapshotPhrases()

    if (phraseIndex != null) {
      renderCache.clearIndices([phraseIndex])
      renderJobManager.incrementGeneration()

      // 乐观更新歌词：同步修改本地 note.lyric，让 UI 立刻显示
      if (noteRef) noteRef.lyric = newLyric
      eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })

      console.log(`${M} 乐观失效+歌词预更新 | 第${phraseIndex}句: 缓存已清除, 世代已递增, UI已刷新`)
    }

    const edits = [{
      action: 'lyric',
      position: noteIdentity.position,
      duration: noteIdentity.duration,
      tone: noteIdentity.midi,
      lyric: newLyric,
    }]

    const result = this._editQueue.then(() => this._processEdit(edits, rollbackSnapshot))
    this._editQueue = result.catch(() => {})
    return result
  }

  editBatchLyrics(noteEntries, lyrics) {
    const bpm = phraseStore.getBpm()
    const affectedPhrases = [...new Set(noteEntries.map((e) => e.phrase.index))]
    const rollbackSnapshot = this._snapshotPhrases()
    console.log(`${M} ← 批量编辑 | ${noteEntries.length}个音符, 歌词=[${lyrics.join(',')}], 受影响phrase=[${affectedPhrases}], bpm=${bpm}`)

    // 打印每个音符的身份和对应歌词
    noteEntries.forEach((entry, i) => {
      const pos = Math.round((entry.note.time * 480 * bpm) / 60)
      const dur = Math.round((entry.note.duration * 480 * bpm) / 60)
      console.log(`${M}   音符${i}: time=${entry.note.time.toFixed(3)}s, midi=${entry.note.midi}, pos480=${pos}, dur480=${dur}, 当前lyric="${entry.note.lyric}", 新lyric="${lyrics[i] || 'a'}"`)
    })

    renderCache.clearIndices(affectedPhrases)
    renderJobManager.incrementGeneration()

    // 乐观更新歌词：同步修改本地 note.lyric，让 UI 立刻显示新歌词
    // 后端响应后 rebuildFromEdit 会用后端权威数据覆盖
    noteEntries.forEach((entry, i) => {
      entry.note.lyric = lyrics[i] || 'a'
    })

    // 触发重绘，让音符上的文字立刻更新
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })

    console.log(`${M} 乐观失效+歌词预更新 | phrase=[${affectedPhrases}]: 缓存已清除, 世代已递增, UI已刷新`)

    const edits = noteEntries.map((entry, i) => ({
      action: 'lyric',
      position: Math.round((entry.note.time * 480 * bpm) / 60),
      duration: Math.round((entry.note.duration * 480 * bpm) / 60),
      tone: entry.note.midi,
      lyric: lyrics[i] || 'a',
    }))

    console.log(`${M} 构建edits | ${JSON.stringify(edits)}`)

    const result = this._editQueue.then(() => this._processEdit(edits, rollbackSnapshot))
    this._editQueue = result.catch(() => {})
    return result
  }

  async _processEdit(edits, rollbackSnapshot) {
    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')

    console.log(`${M} → 发送到后端 | jobId=${jobId}, edits=${edits.length}个, body=${JSON.stringify({ edits })}`)

    let response
    try {
      response = await renderApi.editNotes(jobId, edits)
      this._assertLyricOnlyResponse(edits, response?.phrases, rollbackSnapshot)
    } catch (error) {
      this._restorePhrases(rollbackSnapshot)
      console.error(`${M} 编辑失败，已回滚本地状态`, error)
      throw error
    }

    const { affectedIndices, phrases } = response
    const newCount = phrases?.length ?? 0

    console.log(`${M} ← 后端响应 | 受影响=[${affectedIndices}], 新句数=${newCount}`)

    // 打印后端返回的 phrases 中受影响句子的 notes
    if (Array.isArray(affectedIndices) && Array.isArray(phrases)) {
      for (const idx of affectedIndices) {
        const bp = phrases.find(p => p.index === idx)
        if (bp && bp.notes) {
          console.log(`${M} 后端phrase ${idx} notes: ${bp.notes.map(n => `(pos=${n.position},tone=${n.tone},lyric="${n.lyric}")`).join(', ')}`)
        }
      }
    }

    if (Array.isArray(affectedIndices) && affectedIndices.length > 0) {
      renderCache.clearIndices(affectedIndices)
      audioEngine.cancelPhrases(affectedIndices)
    }
    if (newCount > 0) {
      renderCache.clearAbove(newCount)
    }

    renderJobManager.restartForEdit(newCount)

    if (Array.isArray(phrases) && newCount > 0) {
      phraseStore.rebuildFromEdit(phrases)
    }

    console.log(`${M} 编辑流程结束`)
  }

  _snapshotPhrases() {
    return phraseStore.getPhrases().map((phrase) => ({
      ...phrase,
      notes: (phrase.notes || []).map((note) => ({ ...note })),
    }))
  }

  _restorePhrases(phrases) {
    if (!Array.isArray(phrases) || phrases.length === 0) return
    phraseStore.setPhrases(phrases)
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases })
  }

  _assertLyricOnlyResponse(edits, backendPhrases, rollbackSnapshot) {
    const lyricOnly = edits.length > 0 && edits.every((edit) => edit.action === 'lyric')
    if (!lyricOnly) return
    if (!Array.isArray(backendPhrases) || backendPhrases.length === 0) {
      throw new Error('歌词编辑后端未返回有效短语数据')
    }
    if (Array.isArray(rollbackSnapshot) && rollbackSnapshot.length > 0 && backendPhrases.length !== rollbackSnapshot.length) {
      throw new Error(`歌词编辑返回了异常分句数量: ${rollbackSnapshot.length} -> ${backendPhrases.length}`)
    }

    const backendNoteKeys = new Set()
    for (const phrase of backendPhrases) {
      for (const note of (phrase.notes || [])) {
        backendNoteKeys.add(`${note.position}-${note.tone}`)
      }
    }

    const missingEditedNotes = edits.filter((edit) => !backendNoteKeys.has(`${edit.position}-${edit.tone}`))
    if (missingEditedNotes.length > 0) {
      throw new Error('歌词编辑响应缺少被编辑音符，已拒绝应用')
    }
  }
}

export default new LyricEditor()
