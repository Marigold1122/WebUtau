import { findClosestCatalogMidi, getHostPlaybackSourceId } from './sourceCatalog.js'

export const DEFAULT_CHUNK_DURATION_SEC = 6

/**
 * 从 project tracks.previewNotes 生成 "按时间分块"的采样加载计划。
 *
 * 输出：trackPlans —— 每条可听乐器轨的：
 *   - trackId / sourceId
 *   - triggeredCatalogMidis: Set<number> 整首歌需要的 catalog MIDI（去重）
 *   - chunkMidisByIndex: Map<chunkIndex, Set<midi>>
 *       chunk i 代表时间窗口 [i*dur, (i+1)*dur)，对应播到该段时需要的 catalog MIDI
 *   - allChunkIndices: number[] 升序排列的 chunk 编号
 *
 * 另外：
 *   currentChunkIndex = floor(fromTimeSec / chunkDurationSec)
 *   chunkDurationSec
 *
 * 注：chunk index 基于歌曲绝对时间（而非相对 fromTimeSec），这样 seek 时索引稳定。
 * 注：一个 note 跨越 chunk 边界时也只归入其起始 chunk——这是对齐 createScheduledNotes 的触发语义。
 */
export function buildPlaybackSamplePlan({
  tracks,
  audibleTrackIds,
  fromTimeSec = 0,
  chunkDurationSec = DEFAULT_CHUNK_DURATION_SEC,
} = {}) {
  const chunkDur = Number.isFinite(chunkDurationSec) && chunkDurationSec > 0
    ? chunkDurationSec
    : DEFAULT_CHUNK_DURATION_SEC
  const safeTracks = Array.isArray(tracks) ? tracks : []
  const audibleSet = audibleTrackIds instanceof Set
    ? audibleTrackIds
    : new Set(Array.isArray(audibleTrackIds) ? audibleTrackIds : [])

  const trackPlans = []

  safeTracks.forEach((track) => {
    if (!track || !audibleSet.has(track.id)) return

    const dirtyRanges = Array.isArray(track?.pendingVoiceEditState?.dirtyRanges)
      ? track.pendingVoiceEditState.dirtyRanges
      : []
    const previewDirtyVocal = track?.playbackState?.assignedSourceId === 'vocal' && dirtyRanges.length > 0
    const sourceId = previewDirtyVocal
      ? 'piano'
      : getHostPlaybackSourceId(track.playbackState?.assignedSourceId)
    if (!sourceId) return

    const triggeredCatalogMidis = new Set()
    const chunkMidisByIndex = new Map()

    ;(track.previewNotes || []).forEach((note) => {
      const startSec = Number.isFinite(note?.time) ? Math.max(0, note.time) : 0
      const durationSec = Number.isFinite(note?.duration) ? Math.max(0.05, note.duration) : 0.05
      const endSec = startSec + durationSec
      // 与 createScheduledNotes 对齐：早于 fromTimeSec 且尾部也早于 fromTimeSec 的 note 跳过
      if (endSec <= fromTimeSec) return
      if (
        previewDirtyVocal
        && !dirtyRanges.some((range) => startSec < (range?.endTime || 0) && (range?.startTime || 0) < endSec)
      ) {
        return
      }
      const midi = Number.isFinite(note?.midi) ? note.midi : NaN
      const catalogMidi = findClosestCatalogMidi(sourceId, midi)
      if (catalogMidi == null) return

      triggeredCatalogMidis.add(catalogMidi)
      const chunkIndex = Math.max(0, Math.floor(startSec / chunkDur))
      let bucket = chunkMidisByIndex.get(chunkIndex)
      if (!bucket) {
        bucket = new Set()
        chunkMidisByIndex.set(chunkIndex, bucket)
      }
      bucket.add(catalogMidi)
    })

    if (triggeredCatalogMidis.size === 0) return

    trackPlans.push({
      trackId: track.id,
      sourceId,
      triggeredCatalogMidis,
      chunkMidisByIndex,
      allChunkIndices: [...chunkMidisByIndex.keys()].sort((a, b) => a - b),
    })
  })

  const currentChunkIndex = Math.max(0, Math.floor(fromTimeSec / chunkDur))
  return {
    trackPlans,
    currentChunkIndex,
    chunkDurationSec: chunkDur,
  }
}

/**
 * 给定当前 chunk index 和一个 chunk 候选集合，按"距离当前块的播放优先级"升序排列：
 *   current, current+1, current+2, ..., current-1, current-2, ...
 * 这样前向播放路径的 chunk 总是优先加载。
 */
export function sortChunksByPlaybackPriority(chunkIndices, currentChunkIndex) {
  const ahead = []
  const behind = []
  for (const idx of chunkIndices) {
    if (idx >= currentChunkIndex) ahead.push(idx)
    else behind.push(idx)
  }
  ahead.sort((a, b) => a - b)
  behind.sort((a, b) => b - a) // 越近当前块优先级越高
  return [...ahead, ...behind]
}

export function timeToChunkIndex(timeSec, chunkDurationSec = DEFAULT_CHUNK_DURATION_SEC) {
  if (!Number.isFinite(timeSec) || timeSec < 0) return 0
  const dur = Number.isFinite(chunkDurationSec) && chunkDurationSec > 0
    ? chunkDurationSec
    : DEFAULT_CHUNK_DURATION_SEC
  return Math.floor(timeSec / dur)
}
