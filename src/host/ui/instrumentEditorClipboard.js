/**
 * 乐器编辑器（InstrumentEditorView）的应用级 note 剪贴板。
 *
 * 设计要点：
 *   - 单例：整个浏览器会话共享一个剪贴板（不同轨之间也能复制粘贴）
 *   - 数据本体不带 id：粘贴时由调用方分配新 id（避免 id 冲突）
 *   - 锚点对齐到 tick=0：复制时把最早的 note tick 减成 0，粘贴时只需 + atTick
 *   - 保留全字段：lyric / pitch / vibrato / tuning / velocity 必须在 round-trip 中保留，
 *     否则颤音、滑音等参数会在复制粘贴后丢失（这是最容易踩的坑）
 *
 * 不直接读 navigator.clipboard：浏览器原生剪贴板只接受字符串，跨标签页的体验
 *   不是我们核心需求；先做应用内剪贴板，未来要做跨页粘贴时再扩
 */

let _clipboardPayload = null

function deepCloneNote(note) {
  // structuredClone 保留所有嵌套字段（pitch.data 数组、vibrato 对象等）
  // 不用 JSON.parse(JSON.stringify) —— 那会丢 undefined 与函数（虽然 note 里没有，但保险起见）
  return structuredClone(note)
}

/**
 * 把一组选中音符存入剪贴板。
 *
 * @param {Array<object>} notes - 要存的音符（已经是从选区里抽出来的）
 *   每个 note 必须包含 tick / durationTicks / midi 等字段；id 不会被存
 * @returns {boolean} 是否真的存进去了（空数组返回 false）
 */
export function setClipboard(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return false
  }
  // 找到锚点（最小 tick），把所有 note 平移到 tick=0 起步——粘贴方便
  const anchorTick = notes.reduce(
    (min, note) => Math.min(min, Math.round(note?.tick ?? 0)),
    Number.POSITIVE_INFINITY,
  )
  const safeAnchor = Number.isFinite(anchorTick) ? anchorTick : 0
  _clipboardPayload = {
    // 保留所有字段，去掉 id（粘贴时分配）
    notes: notes.map((note) => {
      const cloned = deepCloneNote(note)
      delete cloned.id
      cloned.tick = Math.max(0, Math.round((cloned.tick ?? 0) - safeAnchor))
      return cloned
    }),
    // 留个时间戳，调试方便
    capturedAt: Date.now(),
  }
  return true
}

/**
 * 读出剪贴板内容（深克隆）。返回 null 表示没东西可粘贴。
 * @returns {{ notes: Array<object>, capturedAt: number } | null}
 */
export function getClipboard() {
  if (!_clipboardPayload) return null
  return {
    notes: _clipboardPayload.notes.map(deepCloneNote),
    capturedAt: _clipboardPayload.capturedAt,
  }
}

export function hasClipboard() {
  return _clipboardPayload !== null && _clipboardPayload.notes.length > 0
}

/**
 * 清空剪贴板（一般不需要主动调；测试时用得到）
 */
export function clearClipboard() {
  _clipboardPayload = null
}
