import eventBus from '../core/EventBus.js'
import { EVENTS, PHRASE_STATUS } from '../config/constants.js'

class RenderCache {
  constructor() {
    this.cache = new Map()
  }

  get(phraseIndex) {
    return this.cache.get(phraseIndex) || null
  }

  capture(indices) {
    if (!Array.isArray(indices) || indices.length === 0) return []
    return [...new Set(indices)]
      .filter((phraseIndex) => Number.isInteger(phraseIndex) && phraseIndex >= 0)
      .map((phraseIndex) => {
        const entry = this.cache.get(phraseIndex)
        return {
          phraseIndex,
          existed: entry != null,
          entry: entry
            ? {
              audioBuffer: entry.audioBuffer,
              inputHash: entry.inputHash,
              status: entry.status,
              startMs: entry.startMs ?? null,
              durationMs: entry.durationMs ?? null,
            }
            : null,
        }
      })
  }

  restore(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return
    for (const item of snapshot) {
      if (!Number.isInteger(item?.phraseIndex)) continue
      if (!item.existed || !item.entry) {
        this.cache.delete(item.phraseIndex)
        eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex: item.phraseIndex })
        continue
      }
      this.cache.set(item.phraseIndex, {
        audioBuffer: item.entry.audioBuffer,
        inputHash: item.entry.inputHash,
        status: item.entry.status,
        startMs: item.entry.startMs,
        durationMs: item.entry.durationMs,
      })
      eventBus.emit(
        item.entry.status === PHRASE_STATUS.AVAILABLE ? EVENTS.CACHE_UPDATED : EVENTS.CACHE_INVALIDATED,
        { phraseIndex: item.phraseIndex },
      )
    }
  }

  set(phraseIndex, audioBuffer, inputHash, timeInfo = null) {
    this.cache.set(phraseIndex, {
      audioBuffer,
      inputHash,
      status: PHRASE_STATUS.AVAILABLE,
      startMs: timeInfo?.startMs ?? null,
      durationMs: timeInfo?.durationMs ?? null,
    })
    eventBus.emit(EVENTS.CACHE_UPDATED, { phraseIndex })
  }

  invalidate(phraseIndex) {
    const entry = this.cache.get(phraseIndex)
    if (!entry) return
    entry.status = PHRASE_STATUS.EXPIRED
    eventBus.emit(EVENTS.CACHE_INVALIDATED, { phraseIndex })
  }

  getStatus(phraseIndex) {
    return this.cache.get(phraseIndex)?.status || PHRASE_STATUS.PENDING
  }

  getTimeInfo(phraseIndex) {
    const entry = this.cache.get(phraseIndex)
    if (!entry || entry.startMs == null) return null
    return {
      startMs: entry.startMs,
      durationMs: entry.durationMs,
    }
  }

  setStatus(phraseIndex, status) {
    const entry = this.cache.get(phraseIndex)
    if (!entry) {
      this.cache.set(phraseIndex, { audioBuffer: null, inputHash: null, status })
      return
    }
    entry.status = status
  }

  isValid(phraseIndex, currentHash) {
    const entry = this.cache.get(phraseIndex)
    if (!entry) return false
    if (entry.status !== PHRASE_STATUS.AVAILABLE) return false
    if (entry.inputHash !== currentHash) return false
    return true
  }

  isValidVerbose(phraseIndex, currentHash) {
    const entry = this.cache.get(phraseIndex)
    if (!entry) return { valid: false, reason: 'no-entry' }
    if (entry.status !== PHRASE_STATUS.AVAILABLE) return { valid: false, reason: `status=${entry.status}` }
    if (entry.inputHash !== currentHash) return { valid: false, reason: `hash-mismatch: cache=${entry.inputHash} vs current=${currentHash}` }
    return { valid: true, reason: 'ok' }
  }

  clear() {
    this.cache.clear()
  }

  hasAudio(phraseIndex) {
    const entry = this.cache.get(phraseIndex)
    return entry != null && entry.audioBuffer != null
  }

  clearIndices(indices) {
    for (const idx of indices) this.cache.delete(idx)
  }

  clearAbove(maxIndex) {
    for (const key of this.cache.keys()) {
      if (key >= maxIndex) this.cache.delete(key)
    }
  }
}

export default new RenderCache()
