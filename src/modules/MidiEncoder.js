const PPQ = 480
const DEFAULT_BPM = 120
const DEFAULT_TIME_SIGNATURE = [4, 4]
const MIDI_FILE_NAME = 'track.mid'
const textEncoder = new TextEncoder()

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function encodeVlq(value) {
  let current = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  const bytes = [current & 0x7f]
  current >>= 7
  while (current > 0) {
    bytes.push((current & 0x7f) | 0x80)
    current >>= 7
  }
  return bytes.reverse()
}

function secondsToTicks(seconds, bpm) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return Math.round((safeSeconds * PPQ * bpm) / 60)
}

function normalizeTimeSignature(timeSignature) {
  const numerator = Number.isFinite(timeSignature?.[0]) && timeSignature[0] > 0 ? Math.round(timeSignature[0]) : DEFAULT_TIME_SIGNATURE[0]
  const rawDenominator = Number.isFinite(timeSignature?.[1]) && timeSignature[1] > 0 ? Math.round(timeSignature[1]) : DEFAULT_TIME_SIGNATURE[1]
  const denominatorPower = Math.max(0, Math.round(Math.log2(rawDenominator)))
  return [numerator, 2 ** denominatorPower, denominatorPower]
}

function buildEvents(phrases, bpm, timeSignature) {
  const events = []
  let sequence = 0
  const pushEvent = (tick, order, bytes) => {
    events.push({ tick: Math.max(0, Math.round(tick)), order, sequence, bytes })
    sequence += 1
  }

  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM
  const [numerator, , denominatorPower] = normalizeTimeSignature(timeSignature)
  const microsecondsPerQuarter = Math.round(60000000 / safeBpm)

  pushEvent(0, 0, [0xff, 0x51, 0x03, (microsecondsPerQuarter >> 16) & 0xff, (microsecondsPerQuarter >> 8) & 0xff, microsecondsPerQuarter & 0xff])
  pushEvent(0, 0, [0xff, 0x58, 0x04, numerator, denominatorPower, 24, 8])

  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const lyrics = Array.from(String(phrase?.text || ''))
    for (const [noteIndex, note] of (Array.isArray(phrase?.notes) ? phrase.notes : []).entries()) {
      const tick = secondsToTicks(note?.time, safeBpm)
      const durationTicks = Math.max(1, secondsToTicks(note?.duration, safeBpm))
      const midi = clamp(Math.round(Number.isFinite(note?.midi) ? note.midi : 60), 0, 127)
      const velocity = Number.isFinite(note?.velocity) ? clamp(Math.round(note.velocity * 127), 1, 127) : 80
      const lyric = note.lyric || (lyrics[noteIndex] && lyrics[noteIndex].trim() ? lyrics[noteIndex] : 'a')
      const lyricBytes = Array.from(textEncoder.encode(lyric))

      pushEvent(tick, 1, [0xff, 0x05, ...encodeVlq(lyricBytes.length), ...lyricBytes])
      pushEvent(tick, 2, [0x90, midi, velocity])
      pushEvent(tick + durationTicks, 3, [0x80, midi, 0x00])
    }
  }

  const lastTick = events.reduce((maxTick, event) => Math.max(maxTick, event.tick), 0)
  pushEvent(lastTick, 9, [0xff, 0x2f, 0x00])

  return events.sort((left, right) => left.tick - right.tick || left.order - right.order || left.sequence - right.sequence)
}

function buildMidiBytes(trackData) {
  const result = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (trackData.length >> 24) & 0xff, (trackData.length >> 16) & 0xff, (trackData.length >> 8) & 0xff, trackData.length & 0xff,
  ]

  result.push(...trackData)
  return result
}

const midiEncoder = {
  encode(phrases, bpm, timeSignature = DEFAULT_TIME_SIGNATURE) {
    const events = buildEvents(phrases, bpm, timeSignature)
    const trackData = []
    let previousTick = 0

    for (const event of events) {
      trackData.push(...encodeVlq(event.tick - previousTick), ...event.bytes)
      previousTick = event.tick
    }

    return new File([new Uint8Array(buildMidiBytes(trackData))], MIDI_FILE_NAME, { type: 'audio/midi' })
  },
}

export default midiEncoder
