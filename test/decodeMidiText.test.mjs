import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeMidiText } from '../src/shared/decodeMidiText.js'

test('decodeMidiText recovers direct UTF-8 mojibake', () => {
  assert.equal(decodeMidiText('æ­æè½¨'), '歌手轨')
})

test('decodeMidiText recovers nested UTF-8 then gb18030 mojibake from Only my railgun track names', () => {
  assert.equal(decodeMidiText('ÃÃ·ÃÃ½ÃÃ'), '主旋律')
  assert.equal(decodeMidiText('Â¼ÂªÃÃ»1'), '吉他1')
  assert.equal(decodeMidiText('Â±Â´ÃÂ¹1'), '贝斯1')
})
