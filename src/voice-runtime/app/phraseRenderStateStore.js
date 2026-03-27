import eventBus from '../../core/EventBus.js'
import { EVENTS } from '../../config/constants.js'
import renderCache from '../../modules/RenderCache.js'

class PhraseRenderStateStore {
  constructor() {
    this.states = new Map()
    this.bound = false
  }

  init() {
    if (this.bound) return
    this.bound = true
    ;[
      EVENTS.CACHE_UPDATED,
      EVENTS.CACHE_INVALIDATED,
      EVENTS.RENDER_COMPLETE,
      EVENTS.RENDER_PRIORITIZE,
    ].forEach((eventName) => {
      eventBus.on(eventName, ({ phraseIndex } = {}) => this._syncFromRenderCache(phraseIndex))
    })
    eventBus.on(EVENTS.PHRASES_REBUILT, ({ phrases } = {}) => this._prune(phrases?.length || 0))
    eventBus.on(EVENTS.PHRASES_EDITED, ({ phrases } = {}) => this._prune(phrases?.length || 0))
  }

  hydrateFromManifest(manifest) {
    this.states.clear()
    const phraseStates = Array.isArray(manifest?.phraseStates) ? manifest.phraseStates : []
    phraseStates.forEach((phraseState) => {
      this.states.set(phraseState.phraseIndex, {
        status: phraseState.status || 'pending',
        startMs: Number.isFinite(phraseState.startMs) ? phraseState.startMs : null,
        durationMs: Number.isFinite(phraseState.durationMs) ? phraseState.durationMs : null,
      })
    })
  }

  clear() {
    this.states.clear()
  }

  getStatus(phraseIndex) {
    return this.states.get(phraseIndex)?.status || renderCache.getStatus(phraseIndex)
  }

  getTimeInfo(phraseIndex) {
    const state = this.states.get(phraseIndex)
    if (state && Number.isFinite(state.startMs) && Number.isFinite(state.durationMs)) {
      return {
        startMs: state.startMs,
        durationMs: state.durationMs,
      }
    }
    return renderCache.getTimeInfo(phraseIndex)
  }

  _syncFromRenderCache(phraseIndex) {
    if (!Number.isInteger(phraseIndex)) return
    const current = this.states.get(phraseIndex) || {}
    const timeInfo = renderCache.getTimeInfo(phraseIndex)
    this.states.set(phraseIndex, {
      status: renderCache.getStatus(phraseIndex),
      startMs: Number.isFinite(timeInfo?.startMs) ? timeInfo.startMs : current.startMs ?? null,
      durationMs: Number.isFinite(timeInfo?.durationMs) ? timeInfo.durationMs : current.durationMs ?? null,
    })
  }

  _prune(phraseCount) {
    for (const phraseIndex of this.states.keys()) {
      if (phraseIndex >= phraseCount) this.states.delete(phraseIndex)
    }
  }
}

export default new PhraseRenderStateStore()
