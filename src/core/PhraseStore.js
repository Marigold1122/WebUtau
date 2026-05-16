import eventBus from './EventBus.js'
import { EVENTS } from '../config/constants.js'
import { createPhraseDocuments } from '../shared/phraseDocument.js'
import { createNoteDocument } from '../shared/noteDocument.js'
import { createTimelineAxis } from '../shared/timelineAxis.js'
import { createTempoDocument } from '../shared/tempoDocument.js'

class PhraseStore {
  constructor() {
    this._phrases = []
    this._midiFile = null
    this._jobId = null
    this._bpm = 120
    this._tempoData = null
    this._pitchData = null  // { pitchCurve, pitchDeviation, midiPpq, pitchStepTick }
  }

  setPhrases(phrases) {
    this._phrases = Array.isArray(phrases)
      ? createPhraseDocuments(phrases).map((phrase) => this._normalizePhraseHashes(phrase))
      : []
    eventBus.emit(EVENTS.PHRASES_UPDATED)
  }

  getPhrases() {
    return this._phrases
  }

  getPhrase(index) {
    return this._phrases[index] ?? null
  }

  getPhraseInputHash(index) {
    const phrase = this.getPhrase(index)
    return typeof phrase?.inputHash === 'string' && phrase.inputHash.length > 0
      ? phrase.inputHash
      : null
  }

  updatePhrase(index, changes) {
    const phrase = this._phrases[index]
    if (!phrase) return null

    const oldHash = phrase.inputHash ?? this._computeHash(phrase)
    const nextPhrase = this._normalizePhraseHashes({ ...phrase, ...changes })
    const newHash = nextPhrase.inputHash
    this._phrases[index] = nextPhrase

    eventBus.emit(EVENTS.PHRASE_MODIFIED, { phraseIndex: index, newHash, oldHash })
    return nextPhrase
  }

  capturePhraseHashes(indices) {
    if (!Array.isArray(indices) || indices.length === 0) return []
    return [...new Set(indices)]
      .filter((index) => Number.isInteger(index) && index >= 0)
      .map((index) => {
        const phrase = this._phrases[index]
        return {
          phraseIndex: index,
          exists: Boolean(phrase),
          inputHash: phrase?.inputHash ?? null,
          baseInputHash: phrase?.baseInputHash ?? null,
        }
      })
  }

  restorePhraseHashes(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return
    let changed = false
    for (const entry of snapshot) {
      if (!entry?.exists) continue
      const phrase = this._phrases[entry.phraseIndex]
      if (!phrase) continue
      phrase.inputHash = entry.inputHash ?? this._computeHash(phrase)
      phrase.baseInputHash = entry.baseInputHash ?? phrase.inputHash
      changed = true
    }
    if (changed) eventBus.emit(EVENTS.PHRASES_UPDATED)
  }

  applyPitchRenderVersion(indices, versionTag) {
    this._applyRenderVersion(indices, 'pitch', versionTag)
  }

  applyPhonemeTimingRenderVersion(indices, versionTag) {
    this._applyRenderVersion(indices, 'phoneme', versionTag)
  }

  setMidiFile(file) {
    this._midiFile = file
  }

  getMidiFile() {
    return this._midiFile
  }

  setJobId(jobId) {
    this._jobId = jobId
  }

  getJobId() {
    return this._jobId
  }

  setBpm(bpm) {
    this._bpm = bpm
  }

  getBpm() {
    return this._bpm
  }

  setTempoData(tempoData) {
    this._tempoData = createTempoDocument(tempoData)
  }

  getTempoData() {
    return createTempoDocument(this._tempoData)
  }

  setPitchData(pitchData) {
    this._pitchData = this._clonePitchData(pitchData)
    console.log(`[数据中心] 音高数据已加载 | ${this._pitchData?.pitchCurve?.length ?? 0}个采样点`)
    eventBus.emit(EVENTS.PITCH_LOADED, { pitchData: this._pitchData })
  }

  previewPitchData(pitchData) {
    this._pitchData = this._clonePitchData(pitchData)
    eventBus.emit(EVENTS.PITCH_CHANGED, { pitchData: this._pitchData })
  }

  getPitchData() {
    return this._pitchData
  }

  _clonePitchData(pitchData) {
    if (!pitchData) return null
    return {
      pitchCurve: Array.isArray(pitchData.pitchCurve)
        ? pitchData.pitchCurve.map((point) => ({
          tick: Number.isFinite(point?.tick) ? Math.round(point.tick) : 0,
          pitch: Number.isFinite(point?.pitch) ? point.pitch : 0,
        }))
        : [],
      pitchDeviation: {
        xs: Array.isArray(pitchData.pitchDeviation?.xs)
          ? pitchData.pitchDeviation.xs.map((x) => (Number.isFinite(x) ? Math.round(x) : 0))
          : [],
        ys: Array.isArray(pitchData.pitchDeviation?.ys)
          ? pitchData.pitchDeviation.ys.map((y) => (Number.isFinite(y) ? Math.round(y) : 0))
          : [],
      },
      midiPpq: Number.isFinite(pitchData.midiPpq) ? Math.max(1, Math.round(pitchData.midiPpq)) : 480,
      pitchStepTick: Number.isFinite(pitchData.pitchStepTick) ? Math.max(1, Math.round(pitchData.pitchStepTick)) : 5,
    }
  }

  // text 的唯一产生方式：从 notes 的 lyric 拼接
  _buildTextFromNotes(notes) {
    return notes.map((n) => n.lyric || 'a').join('')
  }

  // 把前端 notes 分配到后端 phrases 的时间窗口中
  // 处理孤儿 note（掉进 phrase 间空隙的 note，如 extender 合并导致窗口缩小）
  _distributeNotes(allNotes, sortedPhrases) {
    // 第一轮：按时间中点分配到窗口内
    const assigned = new Set()
    const phraseNotes = sortedPhrases.map((bp) => {
      const startSec = bp.startMs / 1000
      const endSec = (bp.startMs + bp.durationMs) / 1000
      const notes = allNotes
        .filter((n) => {
          const mid = n.time + n.duration / 2
          return mid >= startSec && mid < endSec
        })
        .sort((a, b) => a.time - b.time)
      for (const n of notes) assigned.add(n)
      return notes
    })

    // 第二轮：回收孤儿 note — 分配到时间上最近的 phrase（前后均可）
    // 之前只找"前一个 phrase"——但 backend 可能为优化静默而把 phrase[0].startMs 设得比
    // 第一个 webutau note 还晚，那个 note 没有"前一个 phrase"可归 → 被静默丢掉
    // → 用户感受到的"开头缺音符" round-trip bug
    const orphans = allNotes.filter((n) => !assigned.has(n))
    if (orphans.length > 0) {
      console.log(`[数据中心] 分配孤儿note | ${orphans.length}个未分配`)
      for (const orphan of orphans) {
        const orphanTime = orphan.time
        // 找时间上**最近**的 phrase：先看前一个（startSec ≤ orphanTime 中最大的），
        // 没有就退化到第一个 phrase（覆盖"在所有 phrase 之前"的孤儿，避免丢音符）
        let bestIdx = -1
        let bestDelta = Infinity
        for (let i = 0; i < sortedPhrases.length; i++) {
          const startSec = sortedPhrases[i].startMs / 1000
          const endSec = startSec + sortedPhrases[i].durationMs / 1000
          // 优先匹配 orphan 落入或紧邻的 phrase
          let delta
          if (orphanTime < startSec) delta = startSec - orphanTime
          else if (orphanTime > endSec) delta = orphanTime - endSec
          else delta = 0
          if (delta < bestDelta) {
            bestDelta = delta
            bestIdx = i
          }
        }
        if (bestIdx >= 0) {
          phraseNotes[bestIdx].push(orphan)
          phraseNotes[bestIdx].sort((a, b) => a.time - b.time)
          console.log(`[数据中心]   孤儿 time=${orphanTime.toFixed(3)}s midi=${orphan.midi} → 归入phrase ${sortedPhrases[bestIdx].index} (delta=${bestDelta.toFixed(3)}s)`)
        } else {
          // 完全没 phrase（边界情况）：保留到第一个 phrase 兜底，绝对不丢音符
          console.warn(`[数据中心]   孤儿 time=${orphanTime.toFixed(3)}s midi=${orphan.midi} → 无 phrase 可归，分配到 phrase[0] 兜底`)
          if (phraseNotes.length > 0) {
            phraseNotes[0].push(orphan)
            phraseNotes[0].sort((a, b) => a.time - b.time)
          }
        }
      }
    }

    return phraseNotes
  }

  rebuildFromBackend(backendPhrases) {
    if (!Array.isArray(backendPhrases) || backendPhrases.length === 0) return false

    const allNotes = this._phrases.flatMap((p) => p.notes || [])
    const oldCount = this._phrases.length
    const sorted = backendPhrases.slice().sort((a, b) => a.index - b.index)
    const phraseNotes = this._distributeNotes(allNotes, sorted)

    const rebuilt = sorted.map((bp, i) => {
      const startSec = bp.startMs / 1000
      const endSec = (bp.startMs + bp.durationMs) / 1000
      const notes = phraseNotes[i]
      const text = this._buildTextFromNotes(notes)
      const baseInputHash = this._computeHashFromNotes(notes, text)
      return {
        index: bp.index,
        startTime: startSec,
        endTime: endSec,
        text,
        notes,
        baseInputHash,
        inputHash: baseInputHash,
      }
    })

    this._phrases = rebuilt
    eventBus.emit(EVENTS.PHRASES_REBUILT, { phrases: rebuilt })
    console.log(`[数据中心] 后端重建完成 | ${oldCount}句 → ${rebuilt.length}句`)
    return true
  }

  rebuildFromEdit(backendPhrases) {
    if (!Array.isArray(backendPhrases) || backendPhrases.length === 0) return false
    const sorted = backendPhrases.slice().sort((a, b) => a.index - b.index)
    const axis = createTimelineAxis({
      tempoData: this._tempoData,
      ppq: 480,
      totalTicks: sorted.reduce((maxTick, phrase) => {
        return Math.max(
          maxTick,
          ...(Array.isArray(phrase?.notes)
            ? phrase.notes.map((note) => Math.max(0, Math.round((note?.position || 0) + (note?.duration || 0))))
            : [0]),
        )
      }, 0),
    })
    const previousVelocityByKey = new Map()
    const previousNoteStateByKey = new Map()
    for (const phrase of this._phrases) {
      for (const note of phrase?.notes || []) {
        const startTick = Math.max(0, Math.round(axis.timeToTick(note?.time || 0)))
        const endTick = Math.max(startTick, Math.round(axis.timeToTick((note?.time || 0) + (note?.duration || 0))))
        const durationTick = Math.max(1, endTick - startTick)
        const key = `${startTick}:${durationTick}:${Math.round(note?.midi || 60)}`
        previousVelocityByKey.set(key, Number.isFinite(note?.velocity) ? note.velocity : 0.8)
        previousNoteStateByKey.set(key, {
          lyric: note?.lyric || 'a',
          tuning: Number.isFinite(note?.tuning) ? Math.round(note.tuning) : 0,
          pitch: note?.pitch || null,
          vibrato: note?.vibrato || null,
        })
      }
    }

    console.log(`[数据中心] 编辑重建开始 | ${backendPhrases.length}个后端phrase`)

    const rebuilt = sorted.map((bp) => {
      const startSec = bp.startMs / 1000
      const endSec = (bp.startMs + bp.durationMs) / 1000
      const notes = (Array.isArray(bp?.notes) ? bp.notes : [])
        .map((note) => {
          const startTick = Math.max(0, Math.round(note?.position || 0))
          const durationTick = Math.max(1, Math.round(note?.duration || 1))
          const startTime = axis.tickToTime(startTick)
          const endTime = axis.tickToTime(startTick + durationTick)
          const midi = Number.isFinite(note?.tone) ? Math.round(note.tone) : 60
          const key = `${startTick}:${durationTick}:${midi}`
          const velocity = previousVelocityByKey.get(key) ?? 0.8
          const previousState = previousNoteStateByKey.get(key) || null
          return createNoteDocument({
            time: startTime,
            duration: Math.max(0.05, endTime - startTime),
            tick: startTick,
            durationTicks: durationTick,
            midi,
            velocity,
            lyric: note?.lyric || previousState?.lyric || 'a',
            tuning: Number.isFinite(note?.tuning) ? note.tuning : (previousState?.tuning ?? 0),
            pitch: note?.pitch ?? previousState?.pitch ?? null,
            vibrato: note?.vibrato ?? previousState?.vibrato ?? null,
          })
        })
        .sort((left, right) => {
          if (left.time !== right.time) return left.time - right.time
          if (left.midi !== right.midi) return left.midi - right.midi
          return left.duration - right.duration
        })
      const text = this._buildTextFromNotes(notes)
      const baseInputHash = this._computeHashFromNotes(notes, text)
      console.log(`[数据中心] 编辑重建 → phrase ${bp.index}: ${notes.length}个notes, text="${text}", hash=${baseInputHash}`)
      return {
        index: bp.index,
        startTime: startSec,
        endTime: endSec,
        text,
        notes,
        baseInputHash,
        inputHash: baseInputHash,
      }
    })

    // 注意：createPhraseDocuments 会 map(createNoteDocument) 深拷贝所有 note，
    // 产生新的对象引用。下游（NoteSelection / PianoRollNotes）必须收到 **_phrases 本身**，
    // 否则 note 引用分叉：NoteSelection 在 rebuilt 上 remap，但 phraseStore.getPhrases()
    // 返回的是 _phrases，两套 note 对象引用不同，导致后续点击 isSelected() 永远 miss，
    // 表现为"点击音符无选中高亮"。所以这里 emit 的是权威副本 _phrases。
    this._phrases = createPhraseDocuments(rebuilt).map((phrase) => this._normalizePhraseHashes(phrase))
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: this._phrases })
    console.log(`[数据中心] 编辑重建完成 | ${rebuilt.length}句`)
    return true
  }


  _computeHashFromNotes(notes, text) {
    if (notes.length === 0) return `empty-${text}`
    const first = notes[0].time
    const last = notes[notes.length - 1]
    const end = last.time + last.duration
    return `${first.toFixed(3)}-${end.toFixed(3)}-${text}`
  }

  _computeHash(phrase) {
    if (phrase.notes && phrase.notes.length > 0) {
      return this._computeHashFromNotes(phrase.notes, this._buildTextFromNotes(phrase.notes))
    }
    return `${phrase.startTime.toFixed(3)}-${phrase.endTime.toFixed(3)}-${phrase.text}`
  }

  _resolveBaseInputHash(phrase) {
    if (typeof phrase?.baseInputHash === 'string' && phrase.baseInputHash.length > 0) {
      return this._stripRenderVersions(phrase.baseInputHash)
    }
    if (typeof phrase?.inputHash === 'string' && phrase.inputHash.length > 0) {
      return this._stripRenderVersions(phrase.inputHash)
    }
    return this._computeHash(phrase)
  }

  _applyRenderVersion(indices, channel, versionTag) {
    if (!Array.isArray(indices) || indices.length === 0 || typeof versionTag !== 'string' || versionTag.length === 0) {
      return
    }
    if (!/^[a-z]+$/.test(channel)) return

    let changed = false
    for (const index of [...new Set(indices)]) {
      if (!Number.isInteger(index) || index < 0) continue
      const phrase = this._phrases[index]
      if (!phrase) continue
      const baseInputHash = this._resolveBaseInputHash(phrase)
      const nextInputHash = `${baseInputHash}|${channel}:${versionTag}`
      if (phrase.baseInputHash === baseInputHash && phrase.inputHash === nextInputHash) continue
      phrase.baseInputHash = baseInputHash
      phrase.inputHash = nextInputHash
      changed = true
    }

    if (changed) eventBus.emit(EVENTS.PHRASES_UPDATED)
  }

  _stripRenderVersions(inputHash) {
    const value = typeof inputHash === 'string' ? inputHash : ''
    const marker = value.search(/\|(pitch|phoneme):/)
    return marker >= 0 ? value.slice(0, marker) : value
  }

  _normalizePhraseHashes(phrase) {
    const baseInputHash = this._resolveBaseInputHash(phrase)
    const inputHash = typeof phrase?.inputHash === 'string' && phrase.inputHash.length > 0
      ? phrase.inputHash
      : baseInputHash
    return {
      ...phrase,
      baseInputHash,
      inputHash,
    }
  }
}

export default new PhraseStore()
