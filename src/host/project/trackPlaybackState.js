import {
  mergeTrackGuitarToneConfig,
  normalizeTrackGuitarToneConfig,
} from '../audio/insert/trackInsertCatalog.js'
import { normalizeAssignedSourceId } from './trackSourceAssignment.js'
import {
  DEFAULT_TRACK_REVERB_SEND,
  createTrackReverbState,
  mergeTrackReverbState,
  normalizeTrackReverbConfig,
  normalizeTrackReverbPresetId,
  normalizeTrackReverbSend,
  toLegacyTrackReverbFields,
} from './trackReverbState.js'
import {
  mergeTrackInsertChainSlot,
  normalizeTrackInsertChain,
} from './trackInsertChainState.js'

export const DEFAULT_TRACK_VOLUME = 0.5
export const MAX_TRACK_PLAYBACK_GAIN = 2
export const DEFAULT_TRACK_PAN = 0
export const DEFAULT_TRACK_REVERB_PRESET_ID = normalizeTrackReverbPresetId()

export {
  DEFAULT_TRACK_REVERB_SEND,
  normalizeTrackGuitarToneConfig,
  normalizeTrackReverbConfig,
  normalizeTrackReverbPresetId,
  normalizeTrackReverbSend,
}

export function normalizeTrackVolume(value, fallback = DEFAULT_TRACK_VOLUME) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_TRACK_VOLUME
  const normalizedValue = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(0, Math.min(1, normalizedValue))
}

// pan 取值范围 [-1, 1]：-1 完全左、0 居中、+1 完全右。clamp 防御非法值
export function normalizeTrackPan(value, fallback = DEFAULT_TRACK_PAN) {
  const resolvedFallback = Number.isFinite(fallback) ? fallback : DEFAULT_TRACK_PAN
  const normalizedValue = Number.isFinite(value) ? value : resolvedFallback
  return Math.max(-1, Math.min(1, normalizedValue))
}

export function resolveTrackPlaybackGain(value, fallback = DEFAULT_TRACK_VOLUME) {
  return normalizeTrackVolume(value, fallback) * MAX_TRACK_PLAYBACK_GAIN
}

export function createTrackPlaybackState(state = {}, defaults = {}) {
  const reverb = createTrackReverbState(state, defaults)
  return {
    assignedSourceId: normalizeAssignedSourceId(state.assignedSourceId),
    mute: Boolean(state.mute),
    solo: Boolean(state.solo),
    volume: normalizeTrackVolume(state.volume, defaults?.volume),
    pan: normalizeTrackPan(state.pan, defaults?.pan),
    ...toLegacyTrackReverbFields(reverb),
    reverb,
    guitarTone: normalizeTrackGuitarToneConfig(state?.guitarTone, defaults?.guitarTone),
    // 单轨 insert 效果链（EQ4 + Comp）—— 默认两槽都 disabled，老工程零行为变化
    inserts: normalizeTrackInsertChain(state?.inserts, defaults?.inserts),
  }
}

export function mergeTrackPlaybackState(currentState, changes = {}, defaults = {}) {
  const current = createTrackPlaybackState(currentState, defaults)
  const nextReverb = mergeTrackReverbState(current.reverb, changes, defaults)
  // inserts 三种写法都接：
  //   1) `inserts: { eq4: {...}, comp: {...} }` —— 完整链替换（罕见）
  //   2) `inserts: { slot: 'eq4', patch: {...} }` —— 单槽 patch（UI 常用）
  //   3) 不传 inserts —— 保留 current
  let nextInserts = current.inserts
  if (Object.prototype.hasOwnProperty.call(changes || {}, 'inserts')) {
    const incoming = changes.inserts
    if (incoming && typeof incoming === 'object'
        && typeof incoming.slot === 'string'
        && Object.prototype.hasOwnProperty.call(incoming, 'patch')) {
      nextInserts = mergeTrackInsertChainSlot(current.inserts, incoming.slot, incoming.patch)
    } else {
      nextInserts = normalizeTrackInsertChain(incoming, current.inserts)
    }
  }
  return createTrackPlaybackState({
    ...current,
    ...changes,
    ...toLegacyTrackReverbFields(nextReverb),
    reverb: nextReverb,
    guitarTone: Object.prototype.hasOwnProperty.call(changes || {}, 'guitarTone')
      ? mergeTrackGuitarToneConfig(current.guitarTone, changes.guitarTone)
      : current.guitarTone,
    inserts: nextInserts,
  }, defaults)
}
