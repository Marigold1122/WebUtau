import eventBus from '../core/EventBus.js'
import { EVENTS } from '../config/constants.js'
import renderApi from '../api/RenderApi.js'
import renderCache from './RenderCache.js'
import phraseStore from '../core/PhraseStore.js'

const M = '[渲染管理]'

class RenderJobManager {
  constructor() {
    this._pollingTimer = null
    this._knownCompleted = new Set()
    this._downloadsInFlight = new Map()
    this._interactiveEditBlocks = new Map()
    this._nextInteractiveEditBlockId = 1
    this._jobStatus = null
    this._rebuilt = false
    this._generation = 0
    this._pollInFlight = false
  }

  async submitMidi(midiFile, singerId, language) {
    const { jobId } = await renderApi.submitJob(midiFile, singerId, language)
    phraseStore.setJobId(jobId)
    this._jobStatus = null
    this._knownCompleted.clear()
    this._downloadsInFlight.clear()
    this._interactiveEditBlocks.clear()
    this._rebuilt = false
    this._startPolling()
    eventBus.emit(EVENTS.JOB_SUBMITTED, { jobId })
    console.log(`${M} 提交任务 | jobId=${jobId}`)
  }

  prioritize(phraseIndex) {
    const jobId = phraseStore.getJobId()
    if (!jobId) return
    renderApi.setPriority(jobId, phraseIndex)
  }

  stopPolling() {
    if (this._pollingTimer) clearInterval(this._pollingTimer)
    this._pollingTimer = null
  }

  getStatus() {
    if (!this._jobStatus) return null

    const phrases = Array.isArray(this._jobStatus.phrases) ? this._jobStatus.phrases : []
    const completed = phrases.filter((phrase) => phrase.status === 'completed').length
    const total = this._getReportedTotal(this._jobStatus)

    return {
      status: this._jobStatus.status,
      completed,
      total,
      progress: this._jobStatus.progress,
    }
  }

  isRebuilt() {
    return this._rebuilt
  }

  restartForEdit(newPhraseCount) {
    const oldGen = this._generation
    this._generation++
    const oldSize = this._knownCompleted.size
    const validCompleted = new Set()
    for (const idx of this._knownCompleted) {
      if (idx < newPhraseCount && renderCache.hasAudio(idx)) {
        validCompleted.add(idx)
      }
    }
    this._knownCompleted = validCompleted
    this._downloadsInFlight.clear()
    console.log(`${M} 编辑后重启 | 世代=${oldGen}→${this._generation}, 已完成集合=${oldSize}→${validCompleted.size}, 新句数=${newPhraseCount}`)
    this._startPolling()
  }

  incrementGeneration() {
    const oldGen = this._generation
    this._generation++
    this._downloadsInFlight.clear()
    console.log(`${M} 世代递增 | ${oldGen}→${this._generation}`)
  }

  reset() {
    const oldGen = this._generation
    this._generation++
    this._knownCompleted.clear()
    this._downloadsInFlight.clear()
    this._interactiveEditBlocks.clear()
    this._rebuilt = false
    this._jobStatus = null
    this.stopPolling()
    console.log(`${M} 重置 | 世代=${oldGen}→${this._generation}, 已完成集合已清空`)
  }

  beginInteractiveEdit(indices = []) {
    const normalized = [...new Set(indices)]
      .filter((index) => Number.isInteger(index) && index >= 0)
    if (normalized.length === 0) return null
    const token = `edit-${this._nextInteractiveEditBlockId}`
    this._nextInteractiveEditBlockId += 1
    this._interactiveEditBlocks.set(token, new Set(normalized))
    return token
  }

  endInteractiveEdit(token) {
    if (!token) return
    this._interactiveEditBlocks.delete(token)
  }

  _startPolling() {
    if (this._pollingTimer) clearInterval(this._pollingTimer)
    this._pollingTimer = setInterval(() => this._poll(), 500)
  }

  async _poll() {
    if (this._pollInFlight) return
    this._pollInFlight = true
    const gen = this._generation
    try {
      const jobId = phraseStore.getJobId()
      if (!jobId) return

      const data = await renderApi.getJobStatus(jobId)
      if (gen !== this._generation) {
        console.log(`${M} 轮询结果过期 | 发送时世代=${gen}, 当前世代=${this._generation} → 丢弃`)
        return
      }
      const rawPhrases = Array.isArray(data.phrases) ? data.phrases : []
      const blockedPhraseIndices = this._collectBlockedPhraseIndices()
      const phrases = this._applyLocalEditBlocks(rawPhrases, blockedPhraseIndices)
      const status = blockedPhraseIndices.size > 0 && data.status === 'completed'
        ? 'rendering'
        : data.status
      const effectiveData = {
        ...data,
        status,
        phrases,
      }
      this._jobStatus = effectiveData
      const total = this._getReportedTotal(effectiveData)

      if (phrases.length === 0) {
        eventBus.emit(EVENTS.JOB_PROGRESS, {
          status,
          completed: 0,
          total,
          progress: data.progress,
          phrases,
        })

        if (status === 'completed') {
          this.stopPolling()
          console.log(`${M} 渲染全部完成 | 总句数=${total}`)
          return
        }

        if (status === 'failed') {
          this.stopPolling()
          console.error(`${M} 渲染失败 | 错误=${data.error || '未知'}`)
          eventBus.emit(EVENTS.JOB_FAILED, { error: data.error })
          return
        }

        console.log(`${M} 轮询 | 状态=${status}, 进度=0/${total}`)
        return
      }

      if (!this._rebuilt && phrases.length > 0) {
        const hasTimeInfo = phrases.every((p) => p.startMs != null && p.durationMs != null)
        if (hasTimeInfo) {
          renderCache.clear()
          phraseStore.rebuildFromBackend(phrases)
          this._rebuilt = true
          console.log(`${M} 首次后端分句完成 | 句数=${phrases.length}`)
          // 异步获取音高数据（不阻塞轮询）
          this._fetchPitch()
        }
      }

      const completed = phrases.filter((phrase) => phrase.status === 'completed').length

      for (const phraseInfo of phrases) {
        if (phraseInfo.status !== 'completed') continue
        const expectedHash = this._getExpectedPhraseHash(phraseInfo.index)
        if (renderCache.isValid(phraseInfo.index, expectedHash)) {
          this._knownCompleted.add(phraseInfo.index)
          continue
        }
        this._knownCompleted.delete(phraseInfo.index)
        const inFlightHash = this._downloadsInFlight.get(phraseInfo.index)
        if (inFlightHash === expectedHash) continue
        if (inFlightHash && inFlightHash !== expectedHash) {
          this._downloadsInFlight.delete(phraseInfo.index)
        }
        this._downloadAndCache(phraseInfo, expectedHash)
      }

      eventBus.emit(EVENTS.JOB_PROGRESS, {
        status,
        completed,
        total,
        progress: data.progress,
        phrases,
      })

      console.log(`${M} 轮询 | 状态=${status}, 进度=${completed}/${total}`)

      if (status === 'completed') {
        this.stopPolling()
        console.log(`${M} 渲染全部完成 | 总句数=${total}`)
      }

      if (status === 'failed') {
        this.stopPolling()
        console.error(`${M} 渲染失败 | 错误=${data.error || '未知'}`)
        eventBus.emit(EVENTS.JOB_FAILED, { error: data.error })
      }
    } catch (error) {
      if (gen === this._generation) console.error(`${M} 轮询异常 |`, error)
    } finally {
      this._pollInFlight = false
    }
  }

  _getReportedTotal(jobStatus) {
    if (Array.isArray(jobStatus?.phrases) && jobStatus.phrases.length > 0) {
      return jobStatus.phrases.length
    }

    return phraseStore.getPhrases().length
  }

  _getExpectedPhraseHash(phraseIndex) {
    const phrase = phraseStore.getPhrase(phraseIndex)
    return phrase?.inputHash ?? `backend-${phraseIndex}`
  }

  _collectBlockedPhraseIndices() {
    const blocked = new Set()
    for (const indices of this._interactiveEditBlocks.values()) {
      for (const index of indices) blocked.add(index)
    }
    return blocked
  }

  _applyLocalEditBlocks(phrases, blockedPhraseIndices) {
    if (!Array.isArray(phrases) || phrases.length === 0 || !blockedPhraseIndices || blockedPhraseIndices.size === 0) {
      return phrases
    }
    return phrases.map((phraseInfo) => {
      if (!blockedPhraseIndices.has(phraseInfo?.index) || phraseInfo?.status !== 'completed') return phraseInfo
      return {
        ...phraseInfo,
        status: 'pending',
      }
    })
  }

  async _downloadAndCache(phraseInfo, expectedHash = this._getExpectedPhraseHash(phraseInfo.index)) {
    const gen = this._generation
    this._downloadsInFlight.set(phraseInfo.index, expectedHash)

    try {
      const jobId = phraseStore.getJobId()
      if (!jobId) return
      const audioBuffer = await renderApi.downloadPhrase(jobId, phraseInfo.index, expectedHash)
      if (gen !== this._generation) {
        console.log(`${M} 下载结果过期 | 句子=第${phraseInfo.index}句, 发送时世代=${gen}, 当前=${this._generation} → 丢弃`)
        return
      }
      const currentHash = this._getExpectedPhraseHash(phraseInfo.index)
      if (currentHash !== expectedHash) {
        console.log(`${M} 下载结果过期 | 句子=第${phraseInfo.index}句, 期望hash=${expectedHash}, 当前hash=${currentHash} → 丢弃`)
        return
      }
      const timeInfo = {
        startMs: phraseInfo.startMs,
        durationMs: phraseInfo.durationMs,
      }

      renderCache.set(phraseInfo.index, audioBuffer, expectedHash, timeInfo)
      this._knownCompleted.add(phraseInfo.index)
      console.log(`${M} 下载缓存成功 | 句子=第${phraseInfo.index}句, hash=${expectedHash}, 开始=${phraseInfo.startMs.toFixed(1)}ms, 时长=${phraseInfo.durationMs.toFixed(1)}ms`)
      eventBus.emit(EVENTS.RENDER_COMPLETE, {
        phraseIndex: phraseInfo.index,
        inputHash: expectedHash,
        startMs: phraseInfo.startMs,
        durationMs: phraseInfo.durationMs,
        audioBuffer,
      })
    } catch (error) {
      if (gen === this._generation) {
        this._knownCompleted.delete(phraseInfo.index)
        console.error(`${M} 下载失败 | 句子=第${phraseInfo.index}句, 错误=${error.message}`)
      }
    } finally {
      if (this._downloadsInFlight.get(phraseInfo.index) === expectedHash) {
        this._downloadsInFlight.delete(phraseInfo.index)
      }
    }
  }

  async _fetchPitch() {
    const jobId = phraseStore.getJobId()
    if (!jobId) return
    try {
      const pitchData = await renderApi.getPitch(jobId)
      phraseStore.setPitchData(pitchData)
    } catch (error) {
      console.warn(`${M} 音高数据获取失败 | ${error.message}`)
    }
  }
}

export default new RenderJobManager()
