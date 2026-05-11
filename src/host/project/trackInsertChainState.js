/**
 * 单轨"插入效果链"状态：EQ4 + Compressor 两个固定槽。
 *
 * 设计要点：
 *   - 与 masterChain 区分：master 是全局母带链（EQ+Comp+Limiter，永远 enabled），
 *     track insert 是**每轨独立**、默认 **enabled=false**（透明、零行为）；用户开启后才走效果。
 *   - 与既有 track.playbackState.insertId 完全独立：insertId 是"乐器音色"（吉他放大器等），
 *     位于音频链 source → insertId → **inserts** → pan → volume。inserts 是混音段处理。
 *   - 参数范围 / 默认完全复用 masterChain 那套（DEFAULT_EQ_BANDS / DEFAULT_COMPRESSOR），
 *     避免维护两套常量。
 *
 * 持久化：跟着 track.playbackState 一起进 .webutau 文件。
 * 老工程兼容：空 / null → 默认（两槽都 disabled），不改变播放结果。
 */

import {
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ_BANDS,
  TRACK_INSERT_EQ_RANGES,
  normalizeCompressorShared,
  normalizeEqBandShared,
} from './masterChainState.js'

const HAS_OWN = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

export const TRACK_INSERT_SLOT_EQ4 = 'eq4'
export const TRACK_INSERT_SLOT_COMP = 'comp'

// 默认：两槽都 disabled —— 老工程 / 新工程都"无效果"，载入后行为零变化
export const DEFAULT_TRACK_INSERT_CHAIN = Object.freeze({
  eq4: Object.freeze({
    enabled: false,
    bands: DEFAULT_EQ_BANDS,
  }),
  comp: Object.freeze({
    ...DEFAULT_COMPRESSOR,
    enabled: false,
  }),
})

function normalizeEq4(input, fallback) {
  const baseline = fallback || DEFAULT_TRACK_INSERT_CHAIN.eq4
  const enabled = HAS_OWN(input, 'enabled') ? Boolean(input.enabled) : Boolean(baseline.enabled)
  const inputBands = Array.isArray(input?.bands) ? input.bands : []
  const fallbackBands = Array.isArray(baseline.bands) ? baseline.bands : DEFAULT_EQ_BANDS
  const bands = DEFAULT_EQ_BANDS.map((_, i) =>
    normalizeEqBandShared(inputBands[i], fallbackBands[i] || DEFAULT_EQ_BANDS[i], TRACK_INSERT_EQ_RANGES[i]),
  )
  return { enabled, bands }
}

function normalizeComp(input, fallback) {
  const baseline = fallback || DEFAULT_TRACK_INSERT_CHAIN.comp
  return normalizeCompressorShared(input, baseline)
}

export function normalizeTrackInsertChain(input, fallback = null) {
  const baseline = fallback || DEFAULT_TRACK_INSERT_CHAIN
  return {
    eq4: normalizeEq4(input?.eq4, baseline.eq4),
    comp: normalizeComp(input?.comp, baseline.comp),
  }
}

/**
 * 合并某槽的 patch 到现有 chain。
 *   - slotKey='eq4'：patch 可含 enabled / bands 或某个 band 的局部参数
 *   - slotKey='comp'：patch 可含 enabled / threshold / ratio / attack / release / knee / makeupGain
 *
 * patch 不传 enabled 时，原 enabled 保留（防止误把已开启的槽 disable）
 */
export function mergeTrackInsertChainSlot(currentChain, slotKey, patch = {}) {
  const current = normalizeTrackInsertChain(currentChain)
  if (slotKey !== TRACK_INSERT_SLOT_EQ4 && slotKey !== TRACK_INSERT_SLOT_COMP) {
    return current   // 未知 slot 不动
  }
  const merged = { ...current[slotKey], ...(patch || {}) }
  // bands 单独处理：patch.bands 是一个**完整 array**时整体替换；
  //  patch.bandIndex + patch.band 形态时只覆盖单段（更适合 UI 单旋钮调用）
  if (slotKey === TRACK_INSERT_SLOT_EQ4) {
    if (Array.isArray(patch?.bands)) {
      merged.bands = patch.bands
    } else if (Number.isInteger(patch?.bandIndex) && patch.band && typeof patch.band === 'object') {
      const bands = (current.eq4.bands || DEFAULT_EQ_BANDS).slice()
      bands[patch.bandIndex] = { ...(bands[patch.bandIndex] || {}), ...patch.band }
      merged.bands = bands
      delete merged.bandIndex
      delete merged.band
    }
  }
  return normalizeTrackInsertChain({
    ...current,
    [slotKey]: merged,
  })
}
