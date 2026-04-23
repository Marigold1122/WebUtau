/**
 * 乐器编辑器「选择工具」的纯计算辅助函数。
 * 无 DOM 依赖，便于单测；与 InstrumentEditorView 的 event 处理分离。
 */

/** 按位置（tick, midi）命中音符，返回 index（从上到下遍历以捕获最上层）；未命中返回 -1 */
export function findNoteIndexByTickMidi(notes, tick, midi) {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i]
    if (note.midi !== midi) continue
    const noteEnd = note.tick + note.durationTicks
    if (tick >= note.tick && tick <= noteEnd) return i
  }
  return -1
}

/**
 * 计算矩形 marquee 与所有音符的交集。
 * rect 由 (startTick, endTick, startMidi, endMidi) 组成，不要求 start<end。
 * 返回交集内的音符 id 数组。
 */
export function collectNotesInRect(notes, rect) {
  const t0 = Math.min(rect.startTick, rect.endTick)
  const t1 = Math.max(rect.startTick, rect.endTick)
  const m0 = Math.min(rect.startMidi, rect.endMidi)
  const m1 = Math.max(rect.startMidi, rect.endMidi)
  const hits = []
  for (const note of notes) {
    if (note.midi < m0 || note.midi > m1) continue
    const noteEnd = note.tick + note.durationTicks
    if (noteEnd < t0 || note.tick > t1) continue
    hits.push(note.id)
  }
  return hits
}

/**
 * 将指定 id 的音符平移 deltaTicks/deltaMidi；clamp tick 到 0、midi 到 [minMidi, maxMidi]。
 * 返回新的 notes 数组，未选中的音符对象保持引用相同。
 */
export function translateSelectedNotes(notes, selectedIds, deltaTicks, deltaMidi, minMidi, maxMidi) {
  if (!deltaTicks && !deltaMidi) return notes
  return notes.map((note) => {
    if (!selectedIds.has(note.id)) return note
    const nextTick = Math.max(0, note.tick + deltaTicks)
    const nextMidi = Math.max(minMidi, Math.min(maxMidi, note.midi + deltaMidi))
    if (nextTick === note.tick && nextMidi === note.midi) return note
    return { ...note, tick: nextTick, midi: nextMidi }
  })
}

/** 从一组 ids 中移除已选，其余添加；用于 Shift+点击切换选择状态 */
export function toggleIdsInSelection(selectedIds, ids) {
  const next = new Set(selectedIds)
  for (const id of ids) {
    if (next.has(id)) next.delete(id)
    else next.add(id)
  }
  return next
}

/** 从 notes 数组中移除选中的音符，返回新数组 */
export function removeSelectedNotes(notes, selectedIds) {
  if (!selectedIds || selectedIds.size === 0) return notes
  return notes.filter((note) => !selectedIds.has(note.id))
}
