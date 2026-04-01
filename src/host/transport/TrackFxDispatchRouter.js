import { isAudioTrack } from '../project/trackContentType.js'
import { isVoiceRuntimeSource } from '../project/trackSourceAssignment.js'
import { canUseConvertedVocal } from '../vocal/VocalPlaybackResolver.js'

function appendIfPresent(targets, scheduler) {
  if (!scheduler || targets.includes(scheduler)) return
  targets.push(scheduler)
}

export class TrackFxDispatchRouter {
  constructor({
    projectStore = null,
    instrumentScheduler = null,
    importedAudioScheduler = null,
    vocalScheduler = null,
    convertedVocalScheduler = null,
  } = {}) {
    this.projectStore = projectStore
    this.instrumentScheduler = instrumentScheduler
    this.importedAudioScheduler = importedAudioScheduler
    this.vocalScheduler = vocalScheduler
    this.convertedVocalScheduler = convertedVocalScheduler
  }

  dispatch(trackId, methodName, ...args) {
    if (!trackId || !methodName) return false
    const targets = this._resolveTargets(trackId)
    let updated = false
    targets.forEach((scheduler) => {
      const method = scheduler?.[methodName]
      if (typeof method !== 'function') return
      updated = Boolean(method.call(scheduler, trackId, ...args)) || updated
    })
    return updated
  }

  _resolveTargets(trackId) {
    const track = this.projectStore?.getTrack?.(trackId) || null
    if (!track) {
      return this._getFallbackTargets()
    }

    const targets = []
    if (isAudioTrack(track)) {
      appendIfPresent(targets, this.importedAudioScheduler)
      return targets.length > 0 ? targets : this._getFallbackTargets()
    }

    if (isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)) {
      if (canUseConvertedVocal(track)) {
        appendIfPresent(targets, this.convertedVocalScheduler)
      } else {
        appendIfPresent(targets, this.vocalScheduler)
      }
      return targets.length > 0 ? targets : this._getFallbackTargets()
    }

    appendIfPresent(targets, this.instrumentScheduler)
    return targets.length > 0 ? targets : this._getFallbackTargets()
  }

  _getFallbackTargets() {
    const targets = []
    appendIfPresent(targets, this.instrumentScheduler)
    appendIfPresent(targets, this.importedAudioScheduler)
    appendIfPresent(targets, this.vocalScheduler)
    appendIfPresent(targets, this.convertedVocalScheduler)
    return targets
  }
}
