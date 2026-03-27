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
    console.log(`${M} 编辑后重启 | 世代=${oldGen}→${this._generation}, 已完成集合=${oldSize}→${validCompleted.size}, 新句数=${newPhraseCount}`)
    this._startPolling()
  }

  incrementGeneration() {
    const oldGen = this._generation
    this._generation++
    console.log(`${M} 世代递增 | ${oldGen}→${this._generation}`)
  }

  reset() {
    const oldGen = this._generation
    this._generation++
    this._knownCompleted.clear()
    this._rebuilt = false
    this._jobStatus = null
    this.stopPolling()
    console.log(`${M} 重置 | 世代=${oldGen}→${this._generation}, 已完成集合已清空`)
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
      this._jobStatus = data
      const phrases = Array.isArray(data.phrases) ? data.phrases : []
      const total = this._getReportedTotal(data)

      if (phrases.length === 0) {
        eventBus.emit(EVENTS.JOB_PROGRESS, {
          status: data.status,
          completed: 0,
          total,
          progress: data.progress,
          phrases,
        })

        if (data.status === 'completed') {
          this.stopPolling()
          console.log(`${M} 渲染全部完成 | 总句数=${total}`)
          return
        }

        if (data.status === 'failed') {
          this.stopPolling()
          console.error(`${M} 渲染失败 | 错误=${data.error || '未知'}`)
          eventBus.emit(EVENTS.JOB_FAILED, { error: data.error })
          return
        }

        console.log(`${M} 轮询 | 状态=${data.status}, 进度=0/${total}`)
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
        if (phraseInfo.status === 'completed' && !this._knownCompleted.has(phraseInfo.index)) {
          this._downloadAndCache(phraseInfo)
        }
      }

      eventBus.emit(EVENTS.JOB_PROGRESS, {
        status: data.status,
        completed,
        total,
        progress: data.progress,
        phrases,
      })

      console.log(`${M} 轮询 | 状态=${data.status}, 进度=${completed}/${total}`)

      if (data.status === 'completed') {
        this.stopPolling()
        console.log(`${M} 渲染全部完成 | 总句数=${total}`)
      }

      if (data.status === 'failed') {
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

  async _downloadAndCache(phraseInfo) {
    const gen = this._generation
    this._knownCompleted.add(phraseInfo.index)

    try {
      const jobId = phraseStore.getJobId()
      const audioBuffer = await renderApi.downloadPhrase(jobId, phraseInfo.index)
      if (gen !== this._generation) {
        console.log(`${M} 下载结果过期 | 句子=第${phraseInfo.index}句, 发送时世代=${gen}, 当前=${this._generation} → 丢弃`)
        return
      }
      const phrase = phraseStore.getPhrase(phraseInfo.index)
      const hash = phrase?.inputHash ?? `backend-${phraseInfo.index}`
      const timeInfo = {
        startMs: phraseInfo.startMs,
        durationMs: phraseInfo.durationMs,
      }

      renderCache.set(phraseInfo.index, audioBuffer, hash, timeInfo)
      console.log(`${M} 下载缓存成功 | 句子=第${phraseInfo.index}句, hash=${hash}, 开始=${phraseInfo.startMs.toFixed(1)}ms, 时长=${phraseInfo.durationMs.toFixed(1)}ms`)
      eventBus.emit(EVENTS.RENDER_COMPLETE, {
        phraseIndex: phraseInfo.index,
        inputHash: hash,
        startMs: phraseInfo.startMs,
        durationMs: phraseInfo.durationMs,
        audioBuffer,
      })
    } catch (error) {
      if (gen === this._generation) {
        console.error(`${M} 下载失败 | 句子=第${phraseInfo.index}句, 错误=${error.message}`)
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
