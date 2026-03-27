import { splitLyrics } from '../utils/splitLyrics.js'
import noteSelection from './NoteSelection.js'
import contextMenu from './ContextMenu.js'
import lyricDialog from './LyricDialog.js'
import lyricEditor from '../modules/LyricEditor.js'
import phraseStore from '../core/PhraseStore.js'
import viewport from './PianoRollViewport.js'
import pianoRollNotes from './PianoRollNotes.js'
import { PIANO_ROLL } from '../config/constants.js'

const DRAG_THRESHOLD = 5
const STATE = {
  READY: 'ready',
  BLANK_PENDING: 'blank-pending',
  NOTE_PENDING: 'note-pending',
  MARQUEE: 'marquee',
  CONTEXT_MENU: 'context-menu',
  SINGLE_EDIT: 'single-edit',
  BATCH_EDIT: 'batch-edit',
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
  }

  bindTo(container, noteCanvas) {
    this._container = container
    this._noteCanvas = noteCanvas
    container.addEventListener('mousedown', (e) => this._onMouseDown(e))
    window.addEventListener('mousemove', (e) => this._onMouseMove(e))
    window.addEventListener('mouseup', (e) => this._onMouseUp(e))
    container.addEventListener('dblclick', (e) => this._onDblClick(e))
    container.addEventListener('contextmenu', (e) => this._onContextMenu(e))
  }

  _onMouseDown(e) {
    if (e.button === 2) return
    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return
    if (this._state === STATE.CONTEXT_MENU) {
      contextMenu.hide()
      this._state = STATE.READY
    }

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTest(pos.time, pos.pitch)
    this._downPos = pos
    this._downNote = hit
    this._hasDragged = false

    this._state = hit ? STATE.NOTE_PENDING : STATE.BLANK_PENDING
  }

  _onMouseMove(e) {
    if (!this._downPos) return

    if (this._state === STATE.BLANK_PENDING) {
      const pos = this._canvasPos(e)
      if (pos && this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._state = STATE.MARQUEE
        noteSelection.startMarquee(this._downPos.x, this._downPos.y)
      }
    }

    if (this._state === STATE.MARQUEE) {
      const pos = this._canvasPos(e)
      if (pos) {
        noteSelection.updateMarquee(pos.x, pos.y)
        pianoRollNotes.draw()
      }
    }

    if (this._state === STATE.NOTE_PENDING) {
      const pos = this._canvasPos(e)
      if (pos && this._dist(pos, this._downPos) >= DRAG_THRESHOLD) {
        this._hasDragged = true
      }
    }
  }

  _onMouseUp(e) {
    if (this._state === STATE.BLANK_PENDING) {
      noteSelection.clear()
      pianoRollNotes.draw()
      this._state = STATE.READY
    } else if (this._state === STATE.NOTE_PENDING) {
      if (!this._hasDragged && this._downNote) {
        noteSelection.replaceWithNote(this._downNote.note, this._downNote.phrase)
        pianoRollNotes.draw()
      }
      this._state = STATE.READY
    } else if (this._state === STATE.MARQUEE) {
      noteSelection.commitMarquee(phraseStore.getPhrases(), viewport)
      pianoRollNotes.draw()
      this._state = STATE.READY
    }
    this._downPos = null
    this._downNote = null
  }

  _onDblClick(e) {
    if (this._state !== STATE.READY) return
    if (!lyricEditor.canEdit()) return

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTest(pos.time, pos.pitch)
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

  _onContextMenu(e) {
    e.preventDefault()
    if (this._state === STATE.SINGLE_EDIT || this._state === STATE.BATCH_EDIT) return

    const pos = this._canvasPos(e)
    if (!pos) return
    const hit = this._hitTest(pos.time, pos.pitch)

    if (!hit && noteSelection.count() === 0) return

    if (hit && !noteSelection.isSelected(hit.note)) {
      noteSelection.replaceWithNote(hit.note, hit.phrase)
      pianoRollNotes.draw()
    }

    if (noteSelection.count() === 0) return

    this._state = STATE.CONTEXT_MENU
    contextMenu.show(pos.x, pos.y, this._container, [
      { label: '编辑歌词', action: () => this._openBatchEdit() },
    ], () => {
      if (this._state === STATE.CONTEXT_MENU) this._state = STATE.READY
    })
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
    const y = viewport.pitchToY(hit.note.midi) + PIANO_ROLL.KEY_HEIGHT
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

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); confirm() }
      if (e.key === 'Escape') { this._removeEditInput(); this._state = STATE.READY }
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

  _hitTest(time, pitch) {
    for (const phrase of phraseStore.getPhrases()) {
      for (const note of phrase.notes) {
        if (pitch === note.midi && time >= note.time && time <= note.time + note.duration) {
          return { note, phrase }
        }
      }
    }
    return null
  }

  _canvasPos(e) {
    if (!this._noteCanvas) return null
    const rect = this._noteCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return { x, y, time: viewport.xToTime(x), pitch: viewport.yToPitch(y) }
  }

  _dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
  }
}

export default new PianoRollInputController()
