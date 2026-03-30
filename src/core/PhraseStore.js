import eventBus from './EventBus.js'
import { EVENTS } from '../config/constants.js'

class PhraseStore {
  constructor() {
    this._phrases = []
    this._midiFile = null
    this._jobId = null
    this._bpm = 120
    this._pitchData = null  // { pitchCurve, pitchDeviation, midiPpq, pitchStepTick }
  }

  setPhrases(phrases) {
    this._phrases = Array.isArray(phrases) ? [...phrases] : []
    eventBus.emit(EVENTS.PHRASES_UPDATED)
  }

  getPhrases() {
    return this._phrases
  }

  getPhrase(index) {
    return this._phrases[index] ?? null
  }

  updatePhrase(index, changes) {
    const phrase = this._phrases[index]
    if (!phrase) return null

    const oldHash = phrase.inputHash ?? this._computeHash(phrase)
    const nextPhrase = { ...phrase, ...changes }
    const newHash = this._computeHash(nextPhrase)

    nextPhrase.inputHash = newHash
    this._phrases[index] = nextPhrase

    eventBus.emit(EVENTS.PHRASE_MODIFIED, { phraseIndex: index, newHash, oldHash })
    return nextPhrase
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

    // 第二轮：回收孤儿 note — 分配到时间上最近的前一个 phrase
    const orphans = allNotes.filter((n) => !assigned.has(n))
    if (orphans.length > 0) {
      console.log(`[数据中心] 分配孤儿note | ${orphans.length}个未分配`)
      for (const orphan of orphans) {
        const orphanTime = orphan.time
        // 找时间上最近的前一个 phrase（endSec <= orphanTime 或最近的）
        let bestIdx = -1
        for (let i = 0; i < sortedPhrases.length; i++) {
          const startSec = sortedPhrases[i].startMs / 1000
          if (startSec <= orphanTime) bestIdx = i
        }
        if (bestIdx >= 0) {
          phraseNotes[bestIdx].push(orphan)
          phraseNotes[bestIdx].sort((a, b) => a.time - b.time)
          console.log(`[数据中心]   孤儿 time=${orphanTime.toFixed(3)}s midi=${orphan.midi} → 归入phrase ${sortedPhrases[bestIdx].index}`)
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
      const inputHash = this._computeHashFromNotes(notes, text)
      return { index: bp.index, startTime: startSec, endTime: endSec, text, notes, inputHash }
    })

    this._phrases = rebuilt
    eventBus.emit(EVENTS.PHRASES_REBUILT, { phrases: rebuilt })
    console.log(`[数据中心] 后端重建完成 | ${oldCount}句 → ${rebuilt.length}句`)
    return true
  }

  rebuildFromEdit(backendPhrases) {
    if (!Array.isArray(backendPhrases) || backendPhrases.length === 0) return false
    const bpm = this._bpm

    // 步骤1: 收集所有前端 notes
    const allNotes = this._phrases.flatMap((p) => p.notes || [])
    console.log(`[数据中心] 编辑重建开始 | ${backendPhrases.length}个后端phrase, ${allNotes.length}个前端notes, bpm=${bpm}`)

    // 步骤2: 构建后端 lyric 查找表 — 用 (position, tone) 二元组
    const lyricLookup = new Map()
    for (const bp of backendPhrases) {
      for (const bn of (bp.notes || [])) {
        lyricLookup.set(`${bn.position}-${bn.tone}`, bn.lyric)
      }
    }

    // 步骤3: 按时间窗口分配 + 回收孤儿
    const sorted = backendPhrases.slice().sort((a, b) => a.index - b.index)
    const phraseNotes = this._distributeNotes(allNotes, sorted)

    // 步骤4: 覆盖 lyric + 构建 phrases
    let totalLyricUpdated = 0
    const rebuilt = sorted.map((bp, i) => {
      const startSec = bp.startMs / 1000
      const endSec = (bp.startMs + bp.durationMs) / 1000
      const notes = phraseNotes[i]

      for (const n of notes) {
        const pos480 = Math.round((n.time * 480 * bpm) / 60)
        const key = `${pos480}-${n.midi}`
        const newLyric = lyricLookup.get(key)
        if (newLyric !== undefined) {
          n.lyric = newLyric
          totalLyricUpdated++
        }
      }

      const text = this._buildTextFromNotes(notes)
      const inputHash = this._computeHashFromNotes(notes, text)
      console.log(`[数据中心] 编辑重建 → phrase ${bp.index}: ${notes.length}个notes, lyric更新=${totalLyricUpdated}, text="${text}", hash=${inputHash}`)
      return { index: bp.index, startTime: startSec, endTime: endSec, text, notes, inputHash }
    })

    this._phrases = rebuilt
    eventBus.emit(EVENTS.PHRASES_EDITED, { phrases: rebuilt })
    console.log(`[数据中心] 编辑重建完成 | ${rebuilt.length}句, lyric总更新=${totalLyricUpdated}`)
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
}

export default new PhraseStore()
