import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeMusicForPrompt,
  extractMusicStructure,
} from '../src/host/ai/extractMusicStructure.js'
import {
  buildLyricPrompt,
  buildPartialRetryPrompt,
  mergePartialRetryResponse,
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

test('parseLyricResponse - 字数对不上返回 syllable-mismatch + 全部 corrections + parsedPhrases', () => {
  // 行为：字数错的句子收集到 corrections，LLM 原始输出保留在 parsedPhrases。
  // 上层（QuickLyricPanel）用这两个字段触发局部重写
  const raw = '{"phrases":[{"index":1,"lyric":["夏","夜"]}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'syllable-mismatch')
  assert.equal(r.phraseIndex, 1)
  assert.equal(r.expected, 3)
  assert.equal(r.actual, 2)
  assert.equal(r.corrections.length, 1)
  assert.deepEqual(r.parsedPhrases[0].lyric, ['夏', '夜'])
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

// ─── 容错解析：以下都是观测到的真实 LLM 失态格式 ─────────────────
test('parseLyricResponse - LLM 加前缀寒暄 + 代码块', () => {
  const raw = '好的，下面是您要的歌词：\n```json\n{"phrases":[{"index":1,"lyric":["夏","夜","风"]}]}\n```'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - trailing comma 在末尾', () => {
  const raw = '{"phrases":[{"index":1,"lyric":["夏","夜","风"],}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 智能引号 / 全角引号', () => {
  const raw = '{“phrases”:[{“index”:1,“lyric”:[“夏”,“夜”,“风”]}]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 外面套了一层 data wrapper', () => {
  const raw = '{"data":{"phrases":[{"index":1,"lyric":["夏","夜","风"]}]}}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 截断（缺最后 }]）也能补回', () => {
  const raw = '{"phrases":[{"index":1,"lyric":["夏","夜","风"]},{"index":2,"lyric":["落","花"]}'
  const r = parseLyricResponse(raw, {
    phrases: [{ syllableCount: 3 }, { syllableCount: 2 }],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风', '落', '花'])
})

test('parseLyricResponse - 带 // 注释行', () => {
  const raw = '{\n"phrases":[\n// 第 1 句\n{"index":1,"lyric":["夏","夜","风"]}\n]}'
  const r = parseLyricResponse(raw, { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.flatChars, ['夏', '夜', '风'])
})

test('parseLyricResponse - 完全坏掉的 JSON 仍返回 invalid-json', () => {
  // 控制组：确认兜底确实在"实在没救"的时候才放弃
  const r = parseLyricResponse('this is not json at all, no braces', { phrases: [{ syllableCount: 3 }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid-json')
})

// ─── 多句错位：parseLyricResponse 收集所有 corrections 供上层局部重写 ─────────
test('parseLyricResponse - 多句字数对不上时 corrections 收齐所有', () => {
  const raw = JSON.stringify({
    phrases: [
      { index: 1, lyric: ['夜', '凉', '风', '起'] },
      { index: 2, lyric: ['月', '影', '入', '窗'] },
      { index: 3, lyric: ['空', '城', '远'] }, // 应 4 给 3
      { index: 4, lyric: ['寒', '梅', '初', '开', '了'] }, // 应 4 给 5
      { index: 5, lyric: ['雪', '满', '长', '街'] },
    ],
  })
  const r = parseLyricResponse(raw, {
    phrases: [
      { syllableCount: 4 }, { syllableCount: 4 }, { syllableCount: 4 },
      { syllableCount: 4 }, { syllableCount: 4 },
    ],
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'syllable-mismatch')
  assert.equal(r.corrections.length, 2)
  // 检查 corrections 内容
  assert.deepEqual(r.corrections.map((c) => c.phraseIndex), [3, 4])
  assert.equal(r.corrections[0].expected, 4)
  assert.equal(r.corrections[0].actual, 3)
  assert.equal(r.corrections[1].actual, 5)
  // parsedPhrases 保留 LLM 原始输出（含错位）
  assert.equal(r.parsedPhrases.length, 5)
  assert.deepEqual(r.parsedPhrases[2].lyric, ['空', '城', '远'])
  assert.deepEqual(r.parsedPhrases[3].lyric, ['寒', '梅', '初', '开', '了'])
})

// ─── 局部重写 prompt + 合并 ────────────────────────────
test('buildPartialRetryPrompt - 上下文包含已对句子 + 待修订句字数要求', () => {
  const parsedPhrases = [
    { index: 1, lyric: ['夜', '凉', '风', '起'] },
    { index: 2, lyric: ['月', '影', '入', '窗'] },
    { index: 3, lyric: ['空', '城', '远'] }, // bad
    { index: 4, lyric: ['寒', '梅', '初', '开'] },
  ]
  const corrections = [{ phraseIndex: 3, expected: 4, actual: 3 }]
  const msgs = buildPartialRetryPrompt({
    originalMusicStructure: { phrases: [{}, {}, {}, {}] },
    parsedPhrases,
    corrections,
    theme: '冬季城破',
    style: '古风',
  })
  assert.equal(msgs.length, 2)
  const userContent = msgs[1].content
  // 上下文里应该有已对的句子
  assert.match(userContent, /夜凉风起/)
  assert.match(userContent, /月影入窗/)
  assert.match(userContent, /寒梅初开/)
  // 需要重写的句子要给字数 + 现有内容
  assert.match(userContent, /第 3 句：必须正好 4 个字/)
  assert.match(userContent, /空城远/)
  // 主题/风格也要在
  assert.match(userContent, /冬季城破/)
  assert.match(userContent, /古风/)
  // 输出格式说明里有 index: 3
  assert.match(userContent, /"index": 3/)
})

test('mergePartialRetryResponse - LLM 重写正确时把内容合回对应位置', () => {
  const parsedPhrases = [
    { index: 1, lyric: ['夜', '凉', '风', '起'] },
    { index: 2, lyric: ['月', '影', '入', '窗'] },
    { index: 3, lyric: ['空', '城', '远'] }, // bad
    { index: 4, lyric: ['寒', '梅', '初', '开'] },
  ]
  const corrections = [{ phraseIndex: 3, expected: 4, actual: 3 }]
  const retryPhrases = [
    { index: 3, lyric: ['孤', '城', '远', '岸'] }, // 重写成 4 字
  ]
  const merged = mergePartialRetryResponse({
    retryPhrases,
    parsedPhrases,
    corrections,
    originalMusicStructure: {
      phrases: [
        { syllableCount: 4 }, { syllableCount: 4 },
        { syllableCount: 4 }, { syllableCount: 4 },
      ],
    },
  })
  assert.equal(merged.ok, true)
  assert.equal(merged.phrases.length, 4)
  assert.deepEqual(merged.phrases[2].lyric, ['孤', '城', '远', '岸'])
  // 没动其他位置
  assert.deepEqual(merged.phrases[0].lyric, ['夜', '凉', '风', '起'])
  assert.deepEqual(merged.phrases[3].lyric, ['寒', '梅', '初', '开'])
  // flatChars 总数对
  assert.equal(merged.flatChars.length, 16)
})

test('mergePartialRetryResponse - 多位置同时重写', () => {
  const parsedPhrases = [
    { index: 1, lyric: ['夜', '凉'] }, // bad
    { index: 2, lyric: ['月', '影', '入', '窗'] },
    { index: 3, lyric: ['空', '城', '远'] }, // bad
  ]
  const corrections = [
    { phraseIndex: 1, expected: 4, actual: 2 },
    { phraseIndex: 3, expected: 4, actual: 3 },
  ]
  const retryPhrases = [
    { index: 1, lyric: ['夜', '凉', '风', '起'] },
    { index: 3, lyric: ['孤', '城', '远', '岸'] },
  ]
  const merged = mergePartialRetryResponse({
    retryPhrases,
    parsedPhrases,
    corrections,
    originalMusicStructure: {
      phrases: [{ syllableCount: 4 }, { syllableCount: 4 }, { syllableCount: 4 }],
    },
  })
  assert.equal(merged.ok, true)
  assert.deepEqual(merged.phrases[0].lyric, ['夜', '凉', '风', '起'])
  assert.deepEqual(merged.phrases[2].lyric, ['孤', '城', '远', '岸'])
})

test('mergePartialRetryResponse - 重写后仍有字数错时返回 syllable-mismatch', () => {
  const parsedPhrases = [
    { index: 1, lyric: ['夜', '凉'] }, // bad
    { index: 2, lyric: ['月', '影', '入', '窗'] },
  ]
  const corrections = [{ phraseIndex: 1, expected: 4, actual: 2 }]
  const retryPhrases = [
    { index: 1, lyric: ['夜', '凉', '风'] }, // 重写还是只给 3 字（应 4）
  ]
  const merged = mergePartialRetryResponse({
    retryPhrases,
    parsedPhrases,
    corrections,
    originalMusicStructure: {
      phrases: [{ syllableCount: 4 }, { syllableCount: 4 }],
    },
  })
  assert.equal(merged.ok, false)
  assert.equal(merged.reason, 'syllable-mismatch')
  assert.equal(merged.phraseIndex, 1)
  assert.equal(merged.actual, 3)
})
