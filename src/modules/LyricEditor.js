import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import renderJobManager from './RenderJobManager.js'
import audioEngine from './AudioEngine.js'
import phraseStore from '../core/PhraseStore.js'
import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'

const M = '[歌词编辑]'
const HISTORY_LIMIT = 100

class LyricEditor {
  constructor() {
    this._editQueue = Promise.resolve()
    this._undoStack = []
    this._optimisticVersion = 0
    eventBus.on(EVENTS.JOB_SUBMITTED, () => this.resetHistory())
  }

  canEdit() {
    return phraseStore.getJobId() != null && renderJobManager.isRebuilt()
  }

  canUndo() {
    return this._undoStack.length > 0
  }

  resetHistory() {
    this._undoStack = []
    this._optimisticVersion = 0
  }

  async undo() {
    if (!this.canEdit() || !this.canUndo()) return false
    const snapshot = this._undoStack.pop()
    if (!Array.isArray(snapshot) || snapshot.length === 0) return false
    try {
      await this.restoreSnapshot(snapshot, { recordHistory: false, reason: 'undo' })
      return true
    } catch (error) {
      this._pushUndoSnapshot(snapshot)
      throw error
    }
  }

  editNoteLyric(noteIdentity, newLyric, phraseIndex, noteRef) {
    console.log(`${M} ← 收到编辑请求(来自钢琴卷帘) | phrase=${phraseIndex}, position=${noteIdentity.position}, duration=${noteIdentity.duration}, tone=${noteIdentity.midi}, 新歌词="${newLyric}"`)
    const rollbackSnapshot = this._snapshotPhrases()

    if (phraseIndex != null) {
      this._markPhrasesDirty([phraseIndex])
      if (noteRef) this._applyOptimisticLyricMap(new Map([[this._buildNoteIdentity(noteRef), newLyric]]))
      console.log(`${M} 乐观失效+歌词预更新 | 第${phraseIndex}句: 缓存已清除, 世代已递增, UI已刷新`)
    }

    const edits = [{
      action: 'lyric',
      position: noteIdentity.position,
      duration: noteIdentity.duration,
      tone: noteIdentity.midi,
      lyric: newLyric,
    }]

    this._pushUndoSnapshot(rollbackSnapshot)
    return this._enqueueEdit(edits, rollbackSnapshot)
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

    this._markPhrasesDirty(affectedPhrases)

    // 乐观更新歌词：同步修改本地 note.lyric，让 UI 立刻显示新歌词
    // 后端响应后 rebuildFromEdit 会用后端权威数据覆盖
    this._applyOptimisticLyricMap(new Map(
      noteEntries.map((entry, i) => [this._buildNoteIdentity(entry.note), lyrics[i] || 'a']),
    ))

    console.log(`${M} 乐观失效+歌词预更新 | phrase=[${affectedPhrases}]: 缓存已清除, 世代已递增, UI已刷新`)

    const edits = noteEntries.map((entry, i) => ({
      action: 'lyric',
      position: Math.round((entry.note.time * 480 * bpm) / 60),
      duration: Math.round((entry.note.duration * 480 * bpm) / 60),
      tone: entry.note.midi,
      lyric: lyrics[i] || 'a',
    }))

    console.log(`${M} 构建edits | ${JSON.stringify(edits)}`)

    this._pushUndoSnapshot(rollbackSnapshot)
    return this._enqueueEdit(edits, rollbackSnapshot)
  }

  restoreSnapshot(targetSnapshot, { recordHistory = false, reason = 'restore' } = {}) {
    if (!Array.isArray(targetSnapshot) || targetSnapshot.length === 0) return Promise.resolve(false)
    const rollbackSnapshot = this._snapshotPhrases()
    const { edits, affectedPhrases, lyricMap } = this._buildRestorePlan(targetSnapshot)
    if (edits.length === 0) return Promise.resolve(false)

    this._markPhrasesDirty(affectedPhrases)
    this._applyOptimisticLyricMap(lyricMap)
    console.log(`${M} ← 执行撤回快照 | reason=${reason}, edits=${edits.length}, affected=[${affectedPhrases.join(',')}]`)

    if (recordHistory) {
      this._pushUndoSnapshot(rollbackSnapshot)
    }
    return this._enqueueEdit(edits, rollbackSnapshot)
  }

  async _processEdit(edits, rollbackSnapshot, requestVersion) {
    const jobId = phraseStore.getJobId()
    if (!jobId) throw new Error('No active job')

    console.log(`${M} → 发送到后端 | jobId=${jobId}, edits=${edits.length}个, body=${JSON.stringify({ edits })}`)

    let response
    try {
      response = await renderApi.editNotes(jobId, edits)
      this._assertLyricOnlyResponse(edits, response?.phrases, rollbackSnapshot)
    } catch (error) {
      if (requestVersion === this._optimisticVersion) {
        this._restorePhrases(rollbackSnapshot)
      }
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

    if (requestVersion !== this._optimisticVersion) {
      console.log(`${M} 跳过过期响应 | version=${requestVersion}, latest=${this._optimisticVersion}`)
      return response
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

  _enqueueEdit(edits, rollbackSnapshot) {
    const requestVersion = ++this._optimisticVersion
    const result = this._editQueue.then(() => this._processEdit(edits, rollbackSnapshot, requestVersion))
    this._editQueue = result.catch(() => {})
    return result
  }

  _restorePhrases(phrases) {
    if (!Array.isArray(phrases) || phrases.length === 0) return
    phraseStore.setPhrases(phrases)
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases })
  }

  _markPhrasesDirty(phraseIndices) {
    const indices = [...new Set((Array.isArray(phraseIndices) ? phraseIndices : []).filter((index) => Number.isInteger(index) && index >= 0))]
    if (indices.length === 0) return
    renderCache.clearIndices(indices)
    audioEngine.cancelPhrases(indices)
    indices.forEach((phraseIndex) => {
      eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex })
    })
    renderJobManager.incrementGeneration()
  }

  _applyOptimisticLyricMap(lyricMap) {
    if (!(lyricMap instanceof Map) || lyricMap.size === 0) return
    phraseStore.getPhrases().forEach((phrase) => {
      ;(phrase.notes || []).forEach((note) => {
        const nextLyric = lyricMap.get(this._buildNoteIdentity(note))
        if (typeof nextLyric === 'string' && nextLyric.length > 0) {
          note.lyric = nextLyric
        }
      })
    })
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: phraseStore.getPhrases() })
  }

  _buildRestorePlan(targetSnapshot) {
    const bpm = phraseStore.getBpm()
    const targetLyricMap = new Map()
    targetSnapshot.forEach((phrase) => {
      ;(phrase?.notes || []).forEach((note) => {
        targetLyricMap.set(this._buildNoteIdentity(note, bpm), note?.lyric || 'a')
      })
    })

    const edits = []
    const affectedPhrases = new Set()
    phraseStore.getPhrases().forEach((phrase) => {
      ;(phrase?.notes || []).forEach((note) => {
        const identity = this._buildNoteIdentity(note, bpm)
        if (!targetLyricMap.has(identity)) return
        const nextLyric = targetLyricMap.get(identity) || 'a'
        if ((note?.lyric || 'a') === nextLyric) return
        affectedPhrases.add(phrase.index)
        edits.push({
          action: 'lyric',
          position: Math.round((note.time * 480 * bpm) / 60),
          duration: Math.round((note.duration * 480 * bpm) / 60),
          tone: note.midi,
          lyric: nextLyric,
        })
      })
    })

    return {
      edits,
      affectedPhrases: [...affectedPhrases].sort((left, right) => left - right),
      lyricMap: targetLyricMap,
    }
  }

  _buildNoteIdentity(note, bpm = phraseStore.getBpm()) {
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120
    const position = Math.round((Number(note?.time || 0) * 480 * safeBpm) / 60)
    const duration = Math.round((Number(note?.duration || 0) * 480 * safeBpm) / 60)
    const tone = Number.isFinite(note?.midi) ? Math.round(note.midi) : 60
    return `${position}:${duration}:${tone}`
  }

  _pushUndoSnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return
    const normalized = snapshot.map((phrase) => ({
      ...phrase,
      notes: (phrase.notes || []).map((note) => ({ ...note })),
    }))
    const nextSignature = this._buildSnapshotSignature(normalized)
    const lastSignature = this._undoStack.length > 0
      ? this._buildSnapshotSignature(this._undoStack[this._undoStack.length - 1])
      : null
    if (nextSignature === lastSignature) return
    this._undoStack.push(normalized)
    if (this._undoStack.length > HISTORY_LIMIT) {
      this._undoStack.splice(0, this._undoStack.length - HISTORY_LIMIT)
    }
  }

  _buildSnapshotSignature(snapshot) {
    return snapshot
      .map((phrase) => (phrase?.notes || [])
        .map((note) => `${note.time}:${note.duration}:${note.midi}:${note.lyric || 'a'}`)
        .join('|'))
      .join('||')
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
        backendNoteKeys.add(`${note.position}:${note.duration}:${note.tone}`)
      }
    }

    const missingEditedNotes = edits.filter((edit) => !backendNoteKeys.has(`${edit.position}:${edit.duration}:${edit.tone}`))
    if (missingEditedNotes.length > 0) {
      throw new Error('歌词编辑响应缺少被编辑音符，已拒绝应用')
    }
  }
}

export default new LyricEditor()
