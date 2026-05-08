import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('PhonemeTimingVisual depends on projection, not editor internals', async () => {
  const source = await read('src/ui/PhonemeTimingVisual.js')

  assert.match(source, /PhonemeTimingProjection\.js/)
  assert.doesNotMatch(source, /PhonemeEditor\.js/)
})

test('PhonemeTimingProjection stays pure and boundary-safe', async () => {
  const source = await read('src/modules/PhonemeTimingProjection.js')

  assert.doesNotMatch(source, /RenderApi|PhraseStore|PitchEditor/)
  assert.doesNotMatch(source, /PhonemeTimingStore|PhonemeTimingVisual|PhonemeEditor/)
  assert.doesNotMatch(source, /fetch|localStorage|sessionStorage/)
})

test('phoneme timing DTO contract stays pure and shared', async () => {
  const source = await read('src/shared/phonemeTimingContract.js')

  assert.doesNotMatch(source, /RenderApi|PhraseStore|PitchEditor|PhonemeEditor/)
  assert.doesNotMatch(source, /fetch|localStorage|sessionStorage|canvas|getBoundingClientRect/)
})

test('phoneme timing commit stays on its independent write endpoint', async () => {
  const source = await read('src/modules/PhonemeTimingCommit.js')

  assert.match(source, /applyPhonemeTimingEdit/)
  assert.doesNotMatch(source, /applyPitchDeviation|applyNoteParams|editNotes/)
  assert.doesNotMatch(source, /\/pitch|\/note-params|\/edit-notes|fetch\(/)
})

test('backend phoneme timing write path does not cross pitch or note-param channels', async () => {
  const controller = await read('server/DiffSingerApi/Controllers/SynthesisController.PhonemeTiming.cs')
  const service = await read('server/DiffSingerApi/Services/SynthesisService.PhonemeTiming.cs')
  const adapter = await read('server/DiffSingerApi/Services/PhonemeTimingAdapter.Edit.cs')

  assert.match(controller, /HttpPost\("jobs\/\{id\}\/phoneme-timings"\)/)
  assert.match(service, /PhonemeTimingAdapter\.ApplyEdit/)
  assert.match(service, /SkipTiming = true/)
  assert.match(service, /SkipPhonemizer = true/)
  assert.doesNotMatch(`${controller}\n${service}\n${adapter}`, /ApplyPitchDeviation|ApplyNoteParams|ApplyNoteEdits/)
  assert.doesNotMatch(adapter, /lyric|tuning|pitch|vibrato|PITD/)
})
