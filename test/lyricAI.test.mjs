import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeMusicForPrompt,
  extractMusicStructure,
} from '../src/host/ai/extractMusicStructure.js'
import {
  buildLyricPrompt,
  parseLyricResponse,
} from '../src/host/ai/buildLyricPrompt.js'

function makeNote(midi, time, duration, lyric = 'a') {
  return { midi, time, duration, lyric }
}

test('extractMusicStructure - 空 snapshot 返回 0 句 0 音节', () => {
  const s = extractMusicStructure({ phrases: [], bpm: 120 })
  assert.equal(s.phraseCount, 0)
  assert.equal(s.totalNotes, 0)
  assert.equal(s.bpm, 120)
})

test('extractMusicStructure - 基本统计', () => {
  const snapshot = {
    phrases: [
      { notes: [makeNote(60, 0, 0.5), makeNote(62, 0.5, 0.5), makeNote(64, 1.0, 1.0)] },
      { notes: [makeNote(67, 2.0, 0.5), makeNote(65, 2.5, 1.0)] },
    ],
    bpm: 100,
  }
  const s = extractMusicStructure(snapshot)
  assert.equal(s.phraseCount, 2)
  assert.equal(s.totalNotes, 5)
  assert.equal(s.bpm, 100)
  assert.equal(s.tempoLabel, '中速') // 100 BPM -> 中速 (95-119)
  assert.equal(s.pitchLow, 'C4')  // midi 60
  assert.equal(s.pitchHigh, 'G4') // midi 67
  assert.equal(s.phrases.length, 2)
  assert.equal(s.phrases[0].syllableCount, 3)
  assert.equal(s.phrases[1].syllableCount, 2)
})

test('extractMusicStructure - 节奏分级（短/中/长 相对该句最短音）', () => {
  // 第 1 句：[0.5, 0.5, 2.0] —— ratio 1, 1, 4 → 短/短/长
  const snapshot = {
    phrases: [
      { notes: [makeNote(60, 0, 0.5), makeNote(62, 0.5, 0.5), makeNote(64, 1, 2.0)] },
    ],
    bpm: 120,
  }
  const s = extractMusicStructure(snapshot)
  assert.deepEqual(s.phrases[0].rhythm, ['短', '短', '长'])
})

test('extractMusicStructure - tempo 分档', () => {
  assert.equal(extractMusicStructure({ phrases: [], bpm: 60 }).tempoLabel, '慢板')
  assert.equal(extractMusicStructure({ phrases: [], bpm: 80 }).tempoLabel, '中慢板')
  assert.equal(extractMusicStructure({ phrases: [], bpm: 100 }).tempoLabel, '中速')
  assert.equal(extractMusicStructure({ phrases: [], bpm: 130 }).tempoLabel, '中快板')
  assert.equal(extractMusicStructure({ phrases: [], bpm: 160 }).tempoLabel, '快板')
})

test('extractMusicStructure - 已有歌词标记', () => {
  const snapshot = {
    phrases: [
      { notes: [
        makeNote(60, 0, 0.5, '夏'),
        makeNote(62, 0.5, 0.5, 'a'),  // 'a' 算作未填
        makeNote(64, 1.0, 0.5, '夜'),
      ]},
    ],
    bpm: 120,
  }
  const s = extractMusicStructure(snapshot)
  assert.deepEqual(s.phrases[0].existingLyrics, ['夏', '', '夜'])
})

test('describeMusicForPrompt - 空时给出兜底文案', () => {
  const text = describeMusicForPrompt({ phrases: [], totalNotes: 0, phraseCount: 0 })
  assert.match(text, /音乐结构为空/)
})

test('describeMusicForPrompt - 包含句数 / 音节数 / 节奏图', () => {
  const snapshot = {
    phrases: [
      { notes: [makeNote(60, 0, 0.5), makeNote(64, 0.5, 1.0)] },
    ],
    bpm: 120,
  }
  const text = describeMusicForPrompt(extractMusicStructure(snapshot))
  assert.match(text, /共 1 句/)
  assert.match(text, /2 个音节/)
  assert.match(text, /第 1 句/)
  assert.match(text, /2 个音节/)
  // 节奏：[0.5, 1.0] → 短/中
  assert.match(text, /节奏「短 中」/)
})

test('buildLyricPrompt - 必传 musicStructure，否则抛错', () => {
  assert.throws(() => buildLyricPrompt({ theme: 'foo' }))
})

test('buildLyricPrompt - 返回 system + user 两条 messages', () => {
  const snapshot = {
    phrases: [{ notes: [makeNote(60, 0, 0.5), makeNote(64, 0.5, 0.5)] }],
    bpm: 120,
  }
  const messages = buildLyricPrompt({
    musicStructure: extractMusicStructure(snapshot),
    theme: '夏夜河边离别',
    style: '古风',
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].role, 'user')
  assert.match(messages[0].content, /虚拟歌手/)
  assert.match(messages[1].content, /夏夜河边离别/)
  assert.match(messages[1].content, /古风/)
})

test('parseLyricResponse - 空字符串返回 ok=false', () => {
  const r = parseLyricResponse('', { phrases: [] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty-response')
})

test('parseLyricResponse - 非 JSON 返回 invalid-json', () => {
  const r = parseLyricResponse('not json', { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid-json')
})

test('parseLyricResponse - markdown 代码块也能解析', () => {
  const raw = '```json\n{"phrases":[{"index":1,"lyric":["夏","夜","风"]}]}\n```'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 句数对不上返回 phrase-count-mismatch', () => {
  const raw = '{"phrases":[{"index":1,"lyric":["a"]}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 1 }, { syllableCount: 2 }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'phrase-count-mismatch')
  assert.equal(r.expected, 2)
  assert.equal(r.actual, 1)
})

test('parseLyricResponse - 字数对不上返回 syllable-mismatch', () => {
  const raw = '{"phrases":[{"index":1,"lyric":["夏","夜"]}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'syllable-mismatch')
  assert.equal(r.phraseIndex, 1)
  assert.equal(r.expected, 3)
  assert.equal(r.actual, 2)
})

test('parseLyricResponse - 字符串 lyric 也能转成数组', () => {
  // 万一 LLM 偷懒返回字符串而不是数组，也接住
  const raw = '{"phrases":[{"index":1,"lyric":"夏夜风"}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 多句拼平到 flatChars', () => {
  const raw = '{"phrases":[{"index":1,"lyric":["a","b"]},{"index":2,"lyric":["c","d","e"]}]}'
  const r = parseLyricResponse(raw, {
    phrases: [{ syllableCount: 2 }, { syllableCount: 3 }],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['a', 'b', 'c', 'd', 'e'])
})
