import eventBus from '../core/EventBus.js'
import { EVENTS, PHRASE_STATUS } from '../config/constants.js'

class RenderCache {
  constructor() {
    this.cache = new Map()
  }

  get(phraseIndex) {
    return this.cache.get(phraseIndex) || null
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
