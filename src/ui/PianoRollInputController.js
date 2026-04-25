import { splitLyrics } from '../utils/splitLyrics.js'
import noteSelection from './NoteSelection.js'
import contextMenu from './ContextMenu.js'
import lyricDialog from './LyricDialog.js'
import lyricEditor from '../modules/LyricEditor.js'
import pitchEditor, { PITCH_POINT_SHAPES } from '../modules/PitchEditor.js'
import phraseStore from '../core/PhraseStore.js'
import viewport from './PianoRollViewport.js'
import pianoRollNotes from './PianoRollNotes.js'
import phonemeTiming from './PhonemeTimingVisual.js'
import grid from './PianoRollGrid.js'
import { PIANO_ROLL } from '../config/constants.js'
import playheadController from '../modules/PlayheadController.js'

const DRAG_THRESHOLD = 5
const PITCH_NOTE_HIT_PADDING_X = 4
const PITCH_NOTE_HIT_PADDING_Y = 3

const STATE = {
  READY: 'ready',
  BLANK_PENDING: 'blank-pending',
  NOTE_PENDING: 'note-pending',
  MARQUEE: 'marquee',
  CONTEXT_MENU: 'context-menu',
  SINGLE_EDIT: 'single-edit',
  BATCH_EDIT: 'batch-edit',
  PITCH_POINT_PENDING: 'pitch-point-pending',
  PITCH_POINT_DRAG: 'pitch-point-drag',
}

class PianoRollInputController {
  constructor() {
    this._state = STATE.READY
    this._downPos = null
    this._downNote = null
    this._hasDragged = false
    this._container = null
    this._noteCanvas = null
    this._editInput = null
    this._pitchBaseState = null
    this._pitchDragPointId = null
    this._pitchPreviewFrame = 0
    this._queuedPitchPreview = null
    this._pan = null
    this._panOverride = false
  }

  bindTo(container, noteCanvas) {
    this._container = container
    this._noteCanvas = noteCanvas
    container.addEventListener('mousedown', (e) => this._onMouseDown(e))
    window.addEventListener('mousemove', (e) => this._onMouseMove(e))
    window.addEventListener('mouseup', (e) => this._onMouseUp(e))
    container.addEventListener('dblclick', (e) => this._onDblClick(e))
    container.addEventListener('contextmenu', (e) => this._onContextMenu(e))
    window.addEventListener('keydown', (e) => this._onKeyDown(e))
    window.addEventListener('keyup', (e) => this._onKeyUp(e))
    // 暴露给父窗口调用：焦点在宿主时，宿主按 H 仍可通过此钩子切换抓手状态
    window.__webutauSetVoicePanOverride = (active) => this.setPanOverride(active)
  }

  /** 设置临时抓手状态；父窗口通过 window.__webutauSetVoicePanOverride 调用 */
  setPanOverride(active) {
    const next = Boolean(active)
    if (next === this._panOverride) return
    this._panOverride = next
    if (next) {
      this._container?.classList.add('piano-roll-pan-override')
    } else {
      this._container?.classList.remove('piano-roll-pan-override')
      if (this._pan) this._endPan()
    }
  }

  _onMouseDown(e) {
    // 中键：立即进入抓手拖动（与当前模式无关）
    if (e.button === 1) {
      e.preventDefault()
      this._startPan(e)
      return
    }
    if (e.button === 2) return
    if (playheadController.isDraggingPlayhead?.()) return
    if (this._shouldIgnorePointerTarget(e.target)) return
    // 按住 H 时，左键拖动也是抓手
    if (this._panOverride) {
      e.preventDefault()
      this._startPan(e)
      return
    }
    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return
    if (this._state === STATE.CONTEXT_MENU) {
      contextMenu.hide()
      this._state = STATE.READY
    }

    if (pitchEditor.isEnabled()) {
      this._onPitchMouseDown(e)
      return
    }

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTestNote(pos.time, pos.pitch)
    this._downPos = pos
    this._downNote = hit
    this._hasDragged = false

    this._state = hit ? STATE.NOTE_PENDING : STATE.BLANK_PENDING
  }

  _onPitchMouseDown(e) {
    if (!pitchEditor.canEdit()) return
    const pos = this._canvasPos(e)
    if (!pos) return

    const pointHit = this._hitTestPitchPoint(pos.x, pos.y)
    const segmentHit = pointHit ? null : this._hitTestPitchSegment(pos.x, pos.y)
    const noteHit = this._findPitchEditableNote(pos.x, pos.y)
    this._downPos = pos
    this._hasDragged = false
    this._downNote = noteHit

    if (pointHit) {
      const pointNote = this._resolveDisplayNote(pointHit) || noteHit
      this._downNote = pointNote
      this._pitchBaseState = pitchEditor.captureControlState()
      this._pitchDragPointId = pointHit.id
      pitchEditor.selectPoint(pointHit.id)
      if (pointNote && !noteSelection.isSelected(pointNote.note)) {
        noteSelection.replaceWithNote(pointNote.note, pointNote.phrase)
      }
      pianoRollNotes.requestDraw()
      this._state = STATE.PITCH_POINT_PENDING
      return
    }

    if (segmentHit) {
      const segmentNote = this._resolveDisplayNote(segmentHit) || noteHit
      this._downNote = segmentNote
      pitchEditor.selectSegment(segmentHit.id)
      if (segmentNote && !noteSelection.isSelected(segmentNote.note)) {
        noteSelection.replaceWithNote(segmentNote.note, segmentNote.phrase)
      }
      pianoRollNotes.requestDraw()
      this._state = segmentNote ? STATE.NOTE_PENDING : STATE.BLANK_PENDING
      return
    }

    pitchEditor.clearSelection()
    pianoRollNotes.requestDraw()
    this._state = noteHit ? STATE.NOTE_PENDING : STATE.BLANK_PENDING
  }

  _onMouseMove(e) {
    if (this._pan) {
      this._updatePan(e)
      return
    }
    if (playheadController.isDraggingPlayhead?.()) return

    if (pitchEditor.isEnabled()) {
      this._onPitchMouseMove(e)
      return
    }

    if (!this._downPos) return

    if (this._state === STATE.BLANK_PENDING) {
      const pos = this._canvasPos(e)
      if (pos && this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._state = STATE.MARQUEE
        noteSelection.startMarquee(this._downPos.x, this._downPos.y)
        this._updateMarqueeDrag(pos, e)
      }
    }

    if (this._state === STATE.MARQUEE) {
      const pos = this._canvasPos(e)
      this._updateMarqueeDrag(pos, e)
    }

    if (this._state === STATE.NOTE_PENDING) {
      const pos = this._canvasPos(e)
      if (pos && this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._hasDragged = true
      }
    }
  }

  _onPitchMouseMove(e) {
    if (!this._downPos) return
    const pos = this._canvasPos(e)
    if (!pos) return

    if (this._state === STATE.PITCH_POINT_PENDING && this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
      this._state = STATE.PITCH_POINT_DRAG
      this._hasDragged = true
    }

    if (this._state === STATE.PITCH_POINT_DRAG) {
      this._queuePitchPreview({
        type: 'move-point',
        pointId: this._pitchDragPointId,
        time: pos.time,
        pitch: pos.pitchValue,
      })
      return
    }

    if (this._state === STATE.BLANK_PENDING) {
      if (this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._state = STATE.MARQUEE
        noteSelection.startMarquee(this._downPos.x, this._downPos.y)
        this._updateMarqueeDrag(pos, e)
      }
      return
    }

    if (this._state === STATE.MARQUEE) {
      this._updateMarqueeDrag(pos, e)
      return
    }

    if (this._state === STATE.NOTE_PENDING) {
      if (this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._hasDragged = true
      }
    }
  }

  _onMouseUp(e) {
    if (this._pan) {
      this._endPan()
      return
    }
    if (playheadController.isDraggingPlayhead?.()) return

    if (pitchEditor.isEnabled()) {
      void this._onPitchMouseUp(e)
      return
    }

    if (this._state === STATE.BLANK_PENDING) {
      noteSelection.clear()
      pianoRollNotes.requestDraw()
      this._state = STATE.READY
    } else if (this._state === STATE.NOTE_PENDING) {
      if (!this._hasDragged && this._downNote) {
        noteSelection.replaceWithNote(this._downNote.note, this._downNote.phrase)
        pianoRollNotes.requestDraw()
      }
      this._state = STATE.READY
    } else if (this._state === STATE.MARQUEE) {
      noteSelection.commitMarquee(phraseStore.getPhrases(), viewport)
      pianoRollNotes.requestDraw()
      this._state = STATE.READY
    }
    this._downPos = null
    this._downNote = null
  }

  async _onPitchMouseUp(_e) {
    const completedState = this._state
    const completedNote = this._downNote

    if (completedState === STATE.PITCH_POINT_DRAG) {
      this._flushPitchPreview()
      this._downPos = null
    }

    try {
      if (completedState === STATE.PITCH_POINT_DRAG) {
        await pitchEditor.commitPreview('move-point')
      } else if (completedState === STATE.NOTE_PENDING) {
        if (completedNote) {
          noteSelection.replaceWithNote(completedNote.note, completedNote.phrase)
        } else {
          pitchEditor.clearSelection()
        }
        pianoRollNotes.requestDraw()
      } else if (completedState === STATE.BLANK_PENDING) {
        noteSelection.clear()
        pianoRollNotes.requestDraw()
      } else if (completedState === STATE.MARQUEE) {
        noteSelection.commitMarquee(phraseStore.getPhrases(), viewport)
        pianoRollNotes.requestDraw()
      }
    } catch (error) {
      console.error('[InputController] 音高编辑失败:', error)
    } finally {
      this._state = STATE.READY
      this._downPos = null
      this._downNote = null
      this._hasDragged = false
      this._resetPitchGestureState()
    }

    // 浮窗的显隐统一由 PITCH_EDITOR_SELECTION_CHANGED 事件驱动，
    // 这里不再主动 open / close —— 见 PitchShapePopover / NoteEditPopover。
  }

  _onDblClick(e) {
    if (playheadController.isDraggingPlayhead?.()) return
    if (this._shouldIgnorePointerTarget(e.target)) return

    if (pitchEditor.isEnabled()) {
      void this._onPitchDoubleClick(e)
      return
    }

    if (this._state !== STATE.READY) return
    if (!lyricEditor.canEdit()) return

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTestNote(pos.time, pos.pitch)
    if (!hit) return

    const bpm = phraseStore.getBpm()
    const noteIdentity = {
      position: Math.round((hit.note.time * 480 * bpm) / 60),
      duration: Math.round((hit.note.duration * 480 * bpm) / 60),
      midi: hit.note.midi,
    }

    console.log(`▶ [用户] 双击音符 | phrase=${hit.phrase.index}, 音高=${hit.note.midi}, 时间=${hit.note.time.toFixed(3)}s, 当前歌词="${hit.note.lyric}", tick=${noteIdentity.position}`)
    this._state = STATE.SINGLE_EDIT
    this._showSingleEditInput(hit, noteIdentity)
  }

  async _onPitchDoubleClick(e) {
    if (this._state !== STATE.READY || !pitchEditor.canEdit()) return
    const pos = this._canvasPos(e)
    if (!pos) return
    const pointHit = this._hitTestPitchPoint(pos.x, pos.y)
    if (pointHit) return
    let targetNote = this._findPitchEditableNote(pos.x, pos.y)
    if (!targetNote) {
      const segmentHit = this._hitTestPitchSegment(pos.x, pos.y)
      if (segmentHit) targetNote = this._resolveDisplayNote(segmentHit)
    }
    if (!targetNote) return
    try {
      await pitchEditor.addPointForNote(targetNote.note, pos.time, pos.pitchValue)
    } catch (error) {
      console.error('[InputController] 添加音高控制点失败:', error)
    }
  }

  _onContextMenu(e) {
    e.preventDefault()
    if (playheadController.isDraggingPlayhead?.()) return
    if (this._shouldIgnorePointerTarget(e.target)) return

    if (pitchEditor.isEnabled()) {
      this._onPitchContextMenu(e)
      return
    }

    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTestNote(pos.time, pos.pitch)

    if (!hit && noteSelection.count() === 0) return

    if (hit && !noteSelection.isSelected(hit.note)) {
      noteSelection.replaceWithNote(hit.note, hit.phrase)
      pianoRollNotes.requestDraw()
    }

    if (noteSelection.count() === 0) return

    this._state = STATE.CONTEXT_MENU
    contextMenu.show(pos.x, this._wrapperY(pos.y), this._container, [
      { label: '编辑歌词', action: () => this._openBatchEdit() },
    ], () => {
      if (this._state === STATE.CONTEXT_MENU) this._state = STATE.READY
    })
  }

  _onPitchContextMenu(e) {
    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return
    if (!pitchEditor.canEdit()) return

    const pos = this._canvasPos(e)
    if (!pos) return
    const pointHit = this._hitTestPitchPoint(pos.x, pos.y)
    const segmentHit = pointHit ? null : this._hitTestPitchSegment(pos.x, pos.y)
    const noteHit = this._findPitchEditableNote(pos.x, pos.y)
    const items = []

    if (pointHit) {
      pitchEditor.selectPoint(pointHit.id)
      pianoRollNotes.requestDraw()
      if (pitchEditor.canDeletePoint(pointHit.id)) {
        items.push({
          label: '删除控制点',
          action: () => {
            pitchEditor.deletePoint(pointHit.id)
              .catch((error) => console.error('[InputController] 删除控制点失败:', error))
          },
        })
      }
      if (pitchEditor.canChangeShape(pointHit.id)) {
        items.push(
          {
            label: '设为平滑段',
            action: () => {
              pitchEditor.setPointShape(pointHit.id, PITCH_POINT_SHAPES.IN_OUT)
                .catch((error) => console.error('[InputController] 设置平滑段失败:', error))
            },
          },
          {
            label: '设为线性段',
            action: () => {
              pitchEditor.setPointShape(pointHit.id, PITCH_POINT_SHAPES.LINEAR)
                .catch((error) => console.error('[InputController] 设置线性段失败:', error))
            },
          },
          {
            label: '设为缓入段',
            action: () => {
              pitchEditor.setPointShape(pointHit.id, PITCH_POINT_SHAPES.IN)
                .catch((error) => console.error('[InputController] 设置缓入段失败:', error))
            },
          },
          {
            label: '设为缓出段',
            action: () => {
              pitchEditor.setPointShape(pointHit.id, PITCH_POINT_SHAPES.OUT)
                .catch((error) => console.error('[InputController] 设置缓出段失败:', error))
            },
          },
        )
      }
    } else if (segmentHit) {
      pitchEditor.selectSegment(segmentHit.id)
      pianoRollNotes.requestDraw()
      if (segmentHit.canChangeShape) {
        items.push(
          {
            label: '设为平滑段',
            action: () => {
              pitchEditor.setSelectedSegmentShape(PITCH_POINT_SHAPES.IN_OUT)
                .catch((error) => console.error('[InputController] 设置平滑段失败:', error))
            },
          },
          {
            label: '设为线性段',
            action: () => {
              pitchEditor.setSelectedSegmentShape(PITCH_POINT_SHAPES.LINEAR)
                .catch((error) => console.error('[InputController] 设置线性段失败:', error))
            },
          },
          {
            label: '设为缓入段',
            action: () => {
              pitchEditor.setSelectedSegmentShape(PITCH_POINT_SHAPES.IN)
                .catch((error) => console.error('[InputController] 设置缓入段失败:', error))
            },
          },
          {
            label: '设为缓出段',
            action: () => {
              pitchEditor.setSelectedSegmentShape(PITCH_POINT_SHAPES.OUT)
                .catch((error) => console.error('[InputController] 设置缓出段失败:', error))
            },
          },
        )
      }
    }

    if (!pointHit && noteHit && !noteSelection.isSelected(noteHit.note)) {
      noteSelection.replaceWithNote(noteHit.note, noteHit.phrase)
      pianoRollNotes.requestDraw()
    }

    const selectedRange = pitchEditor.getTickRangeForNoteEntries(noteSelection.getSelected())
    if (selectedRange && pitchEditor.hasOriginalPitch()) {
      items.push({
        label: '恢复所选音高',
        action: () => {
          pitchEditor.restoreRange(selectedRange.startTick, selectedRange.endTick)
            .catch((error) => console.error('[InputController] 恢复所选音高失败:', error))
        },
      })
    }

    if (pitchEditor.hasOriginalPitch()) {
      items.push({
        label: '恢复全部音高',
        action: () => {
          pitchEditor.restoreAll()
            .catch((error) => console.error('[InputController] 恢复全部音高失败:', error))
        },
      })
    }

    if (items.length === 0) return

    this._state = STATE.CONTEXT_MENU
    contextMenu.show(pos.x, this._wrapperY(pos.y), this._container, items, () => {
      if (this._state === STATE.CONTEXT_MENU) this._state = STATE.READY
    })
  }

  _onKeyDown(e) {
    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return
    if (this._isEditableTarget(e.target)) return

    // 按住 H：无论当前是哪种编辑模式（音符/歌词/音高）都进入临时抓手
    if (e.key?.toLowerCase?.() === 'h' && !e.repeat) {
      if (!this._panOverride) {
        this._panOverride = true
        this._container?.classList.add('piano-roll-pan-override')
      }
      e.preventDefault()
      return
    }

    if (!pitchEditor.isEnabled()) return

    if ((e.key === 'Delete' || e.key === 'Backspace') && pitchEditor.hasSelectedPoint()) {
      e.preventDefault()
      pitchEditor.deleteSelectedPoint()
        .catch((error) => console.error('[InputController] 删除选中音高点失败:', error))
      return
    }

    if (e.key === 'Escape') {
      if (contextMenu.isVisible()) {
        contextMenu.hide()
        this._state = STATE.READY
        return
      }
      if (pitchEditor.hasSelectedPoint()) {
        pitchEditor.clearSelection()
        pianoRollNotes.requestDraw()
      }
    }
  }

  _onKeyUp(e) {
    if (e.key?.toLowerCase?.() !== 'h') return
    if (!this._panOverride) return
    this._panOverride = false
    this._container?.classList.remove('piano-roll-pan-override')
    if (this._pan) this._endPan()
  }

  /** 记录拖动起点与起始滚动偏移；后续 mousemove 以 1:1 反向滚动 */
  _startPan(e) {
    this._pan = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollX: viewport.scrollX,
      startScrollY: viewport.scrollY,
    }
    this._container?.classList.add('piano-roll-panning')
  }

  _updatePan(e) {
    if (!this._pan) return
    const dx = e.clientX - this._pan.startClientX
    const dy = e.clientY - this._pan.startClientY
    const targetScrollX = Math.max(0, this._pan.startScrollX - dx)
    const targetScrollY = this._pan.startScrollY - dy
    const prevX = viewport.scrollX
    const prevY = viewport.scrollY
    viewport.scrollByX(targetScrollX - prevX)
    viewport.scrollByY(targetScrollY - prevY)
    if (Math.abs(viewport.scrollX - prevX) < 0.5 && Math.abs(viewport.scrollY - prevY) < 0.5) return
    this._refreshViewportAfterMarqueeScroll()
  }

  _endPan() {
    this._pan = null
    this._container?.classList.remove('piano-roll-panning')
  }

  _openBatchEdit() {
    console.log(`[InputController] _openBatchEdit 被调用 | canEdit=${lyricEditor.canEdit()}, selected=${noteSelection.count()}`)
    if (!lyricEditor.canEdit()) return
    this._state = STATE.BATCH_EDIT
    const selected = noteSelection.getSelected()
    const currentLyrics = selected.map((s) => s.note.lyric || 'a').join(' ')

    lyricDialog.show(currentLyrics, this._container, {
      onConfirm: (text) => {
        const lyrics = splitLyrics(text)
        if (lyrics.length > 0) {
          console.log(`▶ [用户] 批量编辑确认 | ${selected.length}个音符, 歌词=[${lyrics.join(',')}]`)
          lyricEditor.editBatchLyrics(selected, lyrics)
            .catch((err) => console.error('[InputController] 批量编辑失败:', err))
        }
        this._state = STATE.READY
      },
      onCancel: () => {
        this._state = STATE.READY
      },
    })
  }

  _showSingleEditInput(hit, noteIdentity) {
    this._removeEditInput()

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'lyric-edit-input'
    input.value = hit.note.lyric || 'a'
    input.select()

    const x = viewport.timeToX(hit.note.time)
    const y = this._wrapperY(viewport.pitchToY(hit.note.midi) + PIANO_ROLL.KEY_HEIGHT)
    input.style.left = `${x}px`
    input.style.top = `${y}px`

    let confirmed = false
    const confirm = () => {
      if (confirmed) return
      confirmed = true
      const newLyric = input.value.trim() || 'a'
      const oldLyric = hit.note.lyric || 'a'
      this._removeEditInput()
      this._state = STATE.READY
      if (newLyric !== oldLyric) {
        console.log(`▶ [用户] 确认编辑 | 旧歌词="${oldLyric}" → 新歌词="${newLyric}" | phrase=${hit.phrase.index}`)
        lyricEditor.editNoteLyric(noteIdentity, newLyric, hit.phrase.index, hit.note)
          .catch((err) => console.error('[InputController] 歌词编辑失败:', err))
      }
    }

    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); confirm() }
      if (event.key === 'Escape') { this._removeEditInput(); this._state = STATE.READY }
    })
    input.addEventListener('blur', confirm)

    this._container.appendChild(input)
    this._editInput = input
    input.focus()
  }

  _removeEditInput() {
    if (this._editInput) {
      this._editInput.remove()
      this._editInput = null
    }
  }

  _hitTestNote(time, pitch) {
    for (const phrase of phraseStore.getPhrases()) {
      for (const note of phrase.notes) {
        if (pitch === note.midi && time >= note.time && time <= note.time + note.duration) {
          return { note, phrase }
        }
      }
    }
    return null
  }

  _hitTestPitchPoint(pixelX, pixelY) {
    const points = pitchEditor.getDisplayPoints()
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index]
      const x = viewport.timeToX(point.time)
      const y = viewport.pitchToY(point.pitch) + PIANO_ROLL.KEY_HEIGHT / 2
      const dx = x - pixelX
      const dy = y - pixelY
      if (Math.sqrt(dx * dx + dy * dy) <= PIANO_ROLL.PITCH_POINT_HIT_RADIUS) {
        return point
      }
    }
    return null
  }

  _hitTestPitchSegment(pixelX, pixelY) {
    const segments = pitchEditor.getDisplaySegments()
    let best = null
    let bestDistance = Infinity
    for (const segment of segments) {
      const x1 = viewport.timeToX(segment.startTime)
      const y1 = viewport.pitchToY(segment.startPitch) + PIANO_ROLL.KEY_HEIGHT / 2
      const x2 = viewport.timeToX(segment.endTime)
      const y2 = viewport.pitchToY(segment.endPitch) + PIANO_ROLL.KEY_HEIGHT / 2
      const distance = this._distancePointToSegment(pixelX, pixelY, x1, y1, x2, y2)
      if (distance <= PIANO_ROLL.PITCH_POINT_HIT_RADIUS && distance < bestDistance) {
        best = segment
        bestDistance = distance
      }
    }
    return best
  }

  _canvasPos(e) {
    return this._canvasPosFromClient(e?.clientX, e?.clientY)
  }

  _canvasPosFromClient(clientX, clientY) {
    if (!this._noteCanvas || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
    const rect = this._noteCanvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
    return {
      x,
      y,
      time: viewport.xToTime(x),
      pitch: viewport.yToPitch(y),
      pitchValue: viewport.yToPitchValue(y),
    }
  }

  _resetPitchGestureState() {
    if (this._pitchPreviewFrame) {
      cancelAnimationFrame(this._pitchPreviewFrame)
      this._pitchPreviewFrame = 0
    }
    this._queuedPitchPreview = null
    this._pitchBaseState = null
    this._pitchDragPointId = null
    this._pitchClickSegmentId = null
  }

  _queuePitchPreview(preview) {
    this._queuedPitchPreview = preview
    if (this._pitchPreviewFrame) return
    this._pitchPreviewFrame = requestAnimationFrame(() => {
      this._pitchPreviewFrame = 0
      this._applyQueuedPitchPreview()
    })
  }

  _flushPitchPreview() {
    if (this._pitchPreviewFrame) {
      cancelAnimationFrame(this._pitchPreviewFrame)
      this._pitchPreviewFrame = 0
    }
    this._applyQueuedPitchPreview()
  }

  _applyQueuedPitchPreview() {
    const preview = this._queuedPitchPreview
    this._queuedPitchPreview = null
    if (!preview) return

    if (preview.type === 'move-point') {
      const result = pitchEditor.buildMovedState(
        this._pitchBaseState || pitchEditor.captureControlState(),
        preview.pointId,
        preview.time,
        preview.pitch,
      )
      pitchEditor.previewControlState(result.controls, { selectedPointId: result.selectedPointId })
    }
  }

  _wrapperY(canvasY) {
    return canvasY + PIANO_ROLL.TIME_RULER_HEIGHT
  }

  _updateMarqueeDrag(pos) {
    if (this._state !== STATE.MARQUEE || !pos) return
    noteSelection.updateMarquee(pos.x, pos.y)
    pianoRollNotes.requestDraw()
  }

  /** 拖动平移或其他滚动变化后的统一重绘钩子（名字沿用历史，虽然现在已不限于 marquee）*/
  _refreshViewportAfterMarqueeScroll() {
    grid.draw()
    pianoRollNotes.requestDraw()
    phonemeTiming.draw(pianoRollNotes.getPhrases())
    playheadController.setPosition(playheadController.getPosition())
  }

  _findPitchEditableNote(pixelX, pixelY) {
    let best = null
    let bestDistance = Infinity
    for (const phrase of phraseStore.getPhrases()) {
      for (const note of phrase.notes) {
        const x = viewport.timeToX(note.time)
        const y = viewport.pitchToY(note.midi) + PIANO_ROLL.NOTE_VERTICAL_OFFSET
        const width = Math.max(1, viewport.durationToWidth(note.duration))
        const height = PIANO_ROLL.KEY_HEIGHT - PIANO_ROLL.NOTE_VERTICAL_GAP
        const dx = pixelX < x
          ? x - pixelX
          : pixelX > x + width
            ? pixelX - (x + width)
            : 0
        const dy = pixelY < y
          ? y - pixelY
          : pixelY > y + height
            ? pixelY - (y + height)
            : 0
        if (dx > PITCH_NOTE_HIT_PADDING_X || dy > PITCH_NOTE_HIT_PADDING_Y) continue
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) {
          best = { note, phrase }
          bestDistance = distance
        }
      }
    }
    return best
  }

  _resolveDisplayNote(displayRef) {
    if (!displayRef) return null
    const phrase = phraseStore.getPhrases().find((candidate) => candidate.index === displayRef.phraseIndex)
    const note = phrase?.notes?.[displayRef.noteIndex] || null
    if (!phrase || !note) return null
    return { phrase, note }
  }

  _shouldIgnorePointerTarget(target) {
    return Boolean(target?.closest?.('#playhead, .context-menu, .lyric-dialog, .lyric-edit-input, .piano-roll-editor-toolbar'))
  }

  _isEditableTarget(target) {
    return Boolean(target?.closest?.('input, textarea, [contenteditable="true"]'))
  }

  _dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
  }

  _distancePointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2)
    }
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    const cx = x1 + dx * t
    const cy = y1 + dy * t
    return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
  }
}

export default new PianoRollInputController()
