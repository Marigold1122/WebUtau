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

/** Cmd+A：返回当前所有 note 的 id 集合 */
export function selectAllIds(notes) {
  const set = new Set()
  if (!Array.isArray(notes)) return set
  for (const note of notes) {
    if (note?.id) set.add(note.id)
  }
  return set
}

/**
 * Cmd+C / Cmd+X 时把选中的音符提取出来——交给 clipboard.setClipboard 用。
 * 返回的是普通对象数组（含全字段），未深克隆，clipboard 模块自己再深克隆。
 */
export function extractSelectionForClipboard(notes, selectedIds) {
  if (!selectedIds || selectedIds.size === 0) return []
  if (!Array.isArray(notes)) return []
  return notes.filter((note) => selectedIds.has(note.id))
}

/**
 * Cmd+V：把 clipboard 里的 note 在 atTick 处粘贴。
 *
 * @param {Array<object>} existingNotes - 当前编辑器里已有的 note 数组
 * @param {Array<object>} clipboardNotes - 剪贴板里的 note（tick 已锚定到 0 起步）
 * @param {number} atTick - 粘贴的起点 tick（一般是播放头）
 * @param {function} idAllocator - 调用方提供的 id 生成函数
 * @returns {{ notes: Array<object>, newIds: Set<string> }} 新的 note 数组 + 新粘贴的 note id 集合
 */
export function pasteClipboardAtTick(existingNotes, clipboardNotes, atTick, idAllocator) {
  if (!Array.isArray(clipboardNotes) || clipboardNotes.length === 0) {
    return { notes: existingNotes, newIds: new Set() }
  }
  if (typeof idAllocator !== 'function') {
    throw new Error('pasteClipboardAtTick: idAllocator must be a function')
  }
  const safeAt = Math.max(0, Math.round(Number.isFinite(atTick) ? atTick : 0))
  const newIds = new Set()
  const pasted = clipboardNotes.map((note) => {
    const id = idAllocator()
    newIds.add(id)
    return {
      ...note,
      id,
      tick: Math.max(0, Math.round((note.tick ?? 0) + safeAt)),
    }
  })
  return {
    notes: [...existingNotes, ...pasted],
    newIds,
  }
}

/**
 * Cmd+D：把当前选中的 note 紧贴在选区右侧复制一份。
 *
 * 偏移量 = 选区里"最右 note 末尾 tick" - "最早 note 起点 tick"
 *   保证 dup 出来的整体紧挨在原选区右边（不会重叠也不会留空）
 *
 * @returns {{ notes: Array<object>, newIds: Set<string> }} 新数组 + 复刻出来的新 id
 */
export function duplicateSelectedNotes(existingNotes, selectedIds, idAllocator) {
  if (!selectedIds || selectedIds.size === 0) {
    return { notes: existingNotes, newIds: new Set() }
  }
  if (typeof idAllocator !== 'function') {
    throw new Error('duplicateSelectedNotes: idAllocator must be a function')
  }
  const selected = existingNotes.filter((note) => selectedIds.has(note.id))
  if (selected.length === 0) return { notes: existingNotes, newIds: new Set() }

  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = 0
  for (const note of selected) {
    const start = Math.round(note.tick ?? 0)
    const end = start + Math.max(1, Math.round(note.durationTicks ?? 1))
    if (start < minStart) minStart = start
    if (end > maxEnd) maxEnd = end
  }
  if (!Number.isFinite(minStart)) return { notes: existingNotes, newIds: new Set() }

  const offset = Math.max(1, maxEnd - minStart)
  const newIds = new Set()
  const duplicated = selected.map((note) => {
    const id = idAllocator()
    newIds.add(id)
    return {
      ...note,
      id,
      tick: Math.max(0, Math.round((note.tick ?? 0) + offset)),
    }
  })
  return {
    notes: [...existingNotes, ...duplicated],
    newIds,
  }
}
