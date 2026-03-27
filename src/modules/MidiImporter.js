import { Midi } from '@tonejs/midi'
import { parseMidi } from 'midi-file'
import eventBus from '../core/EventBus.js'
import { EVENTS, PIANO_ROLL } from '../config/constants.js'
import { decodeMidiText } from '../shared/decodeMidiText.js'
import { createPhraseDocuments } from '../shared/phraseDocument.js'
import { createTempoDocument } from '../shared/tempoDocument.js'

class MidiImporter {
  constructor() {
    this.midiData = null
    this.selectedTrackIndex = null
    this.trackLyrics = new Map()
    this.tempoData = null
  }

  async loadFile(file) {
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const rawMidi = parseMidi(bytes)
    this.midiData = new Midi(bytes)
    this.selectedTrackIndex = null
    this.trackLyrics = this._buildTrackLyrics(rawMidi)
    this.tempoData = this._buildTempoData()

    const tracks = this.midiData.tracks
      .map((track, index) => this._createTrackSummary(track, index))
      .filter((track) => track.noteCount > 0)

    eventBus.emit(EVENTS.MIDI_LOADED, { tracks, fileName: file.name })
    return tracks
  }

  selectTrack(trackIndex) {
    this.selectedTrackIndex = trackIndex
    const phrases = this.getTrackPhrases(trackIndex)
    eventBus.emit(EVENTS.TRACK_SELECTED, { phrases, trackIndex, tempoData: this.tempoData })
    return phrases
  }

  getTrackPhrases(trackIndex) {
    if (!this.midiData) return []
    const track = this.midiData.tracks[trackIndex]
    if (!track) return []
    const phrases = this._extractPhrases(track, this.trackLyrics.get(trackIndex) || [])
    return createPhraseDocuments(phrases)
  }

  getPpq() {
    return this.midiData?.header?.ppq || 480
  }

  _createTrackSummary(track, index) {
    const sortedNotes = [...track.notes].sort((left, right) => left.ticks - right.ticks)
    const duration = sortedNotes.length > 0
      ? sortedNotes[sortedNotes.length - 1].time + sortedNotes[sortedNotes.length - 1].duration
      : 0
    const durationTicks = sortedNotes.length > 0
      ? sortedNotes[sortedNotes.length - 1].ticks + sortedNotes[sortedNotes.length - 1].durationTicks
      : 0

    return {
      index,
      name: decodeMidiText(track.name) || `轨道 ${index + 1}`,
      noteCount: sortedNotes.length,
      hasLyrics: (this.trackLyrics.get(index) || []).length > 0,
      duration,
      durationTicks,
      previewNotes: this._buildPreviewNotes(sortedNotes),
    }
  }

  _buildPreviewNotes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return []
    return notes.map((note) => ({
      time: note.time,
      duration: note.duration,
      tick: note.ticks,
      durationTicks: note.durationTicks,
      midi: note.midi,
      velocity: note.velocity,
    }))
  }

  _buildTempoData() {
    const header = this.midiData?.header
    const tempos = (header?.tempos || []).map(({ bpm, ticks, time }) => ({
      bpm: bpm > 0 ? bpm : PIANO_ROLL.DEFAULT_BPM,
      time: Number.isFinite(time) ? time : header.ticksToSeconds(ticks),
      ticks: Number.isFinite(ticks) ? ticks : null,
    }))
    const timeSignatures = (header?.timeSignatures || []).map(({ timeSignature, ticks, time }) => ({
      timeSignature: Array.isArray(timeSignature) ? timeSignature : [...PIANO_ROLL.DEFAULT_TIME_SIGNATURE],
      time: Number.isFinite(time) ? time : header.ticksToSeconds(ticks),
      ticks: Number.isFinite(ticks) ? ticks : null,
    }))
    const keySignatures = (header?.keySignatures || []).map(({ key, scale, ticks }) => ({
      key: typeof key === 'string' && key ? key : 'C',
      scale: scale === 'minor' ? 'minor' : 'major',
      time: Number.isFinite(ticks) ? header.ticksToSeconds(ticks) : 0,
      ticks: Number.isFinite(ticks) ? ticks : null,
    }))
    return createTempoDocument({ tempos, timeSignatures, keySignatures })
  }

  _extractPhrases(track, lyrics) {
    const notes = [...track.notes].sort((a, b) => a.time - b.time)
    if (notes.length === 0) return []

    const groups = []
    let currentGroup = [notes[0]]

    for (let index = 1; index < notes.length; index += 1) {
      const note = notes[index]
      const previous = currentGroup[currentGroup.length - 1]
      const previousEnd = previous.time + previous.duration
      if (note.time - previousEnd > 0.3) {
        groups.push(currentGroup)
        currentGroup = [note]
        continue
      }
      currentGroup.push(note)
    }

    groups.push(currentGroup)

    return groups.map((group, index) => {
      const startTime = group[0].time
      const endTime = group[group.length - 1].time + group[group.length - 1].duration
      const text = this._buildPhraseText(lyrics, startTime, endTime)
      const chars = Array.from(text)
      group.forEach((note, i) => { note.lyric = chars[i] || 'a' })
      const phrase = { index, startTime, endTime, text, notes: group }
      return { ...phrase, inputHash: this._buildInputHash(phrase) }
    })
  }

  _buildTrackLyrics(rawMidi) {
    if (!this.midiData) return new Map()

    const trackLyrics = new Map()
    let splitTrackIndex = 0

    rawMidi.tracks.forEach((trackEvents) => {
      const currentProgram = Array(16).fill(0)
      const trackKeys = new Set()
      const lyrics = []
      let ticks = 0

      trackEvents.forEach((event) => {
        ticks += event.deltaTime || 0
        if (event.type === 'lyrics' || event.type === 'text') {
          const text = decodeMidiText(event.text || '')
          lyrics.push({ text, time: this.midiData.header.ticksToSeconds(ticks) })
        }
        if (event.channel === undefined) return
        if (event.type === 'programChange') currentProgram[event.channel] = event.programNumber
        trackKeys.add(`${currentProgram[event.channel]}:${event.channel}`)
      })

      if (lyrics.length > 0) trackLyrics.set(splitTrackIndex, lyrics)
      splitTrackIndex += Math.max(1, trackKeys.size)
    })

    if (rawMidi.header.format === 1 && splitTrackIndex === this.midiData.tracks.length + 1) {
      return new Map([...trackLyrics].map(([index, lyrics]) => [index - 1, lyrics]).filter(([index]) => index >= 0))
    }

    return trackLyrics
  }

  _buildPhraseText(lyrics, startTime, endTime) {
    const text = lyrics
      .filter((item) => item.time >= startTime - 0.05 && item.time <= endTime + 0.3)
      .map((item) => this._sanitizeLyric(item.text))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()

    return text || 'a'
  }

  _sanitizeLyric(text) {
    return String(text || '')
      .replace(/[\\/]/g, ' ')
      .replace(/\r?\n/g, ' ')
  }

  _buildInputHash(phrase) {
    return `${phrase.startTime.toFixed(3)}-${phrase.endTime.toFixed(3)}-${phrase.text}`
  }
}

export default new MidiImporter()
