// 测试 writeJsonToHandle 的三种 fail-mode 防御
//   1. write() 失败 → abort 丢弃 swap、不调 close、错误重抛（不留 0 字节文件）
//   2. 空 / 非字符串入参 → 立即拒绝（防止 caller 错误清空文件）
//   3. close 后磁盘文件意外 0 字节 → 报错（不让用户以为保存成功）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { writeJsonToHandle } from '../src/host/project/projectStorage.js'

// stub i18n 防 import 时崩
// 实际 writeJsonToHandle 用 t() 只在 createWritable 缺失分支，正常路径不走 i18n

function makeMockHandle({
  writeImpl = async () => {},
  closeImpl = async () => {},
  abortImpl = async () => {},
  getFileImpl = async () => ({ size: 100 }),
} = {}) {
  const events = []
  const handle = {
    queryPermission: async () => 'granted',
    createWritable: async () => {
      events.push('createWritable')
      return {
        write: async (data) => { events.push(`write:${data?.length ?? 0}`); await writeImpl(data) },
        close: async () => { events.push('close'); await closeImpl() },
        abort: async () => { events.push('abort'); await abortImpl() },
      }
    },
    getFile: async () => getFileImpl(),
  }
  return { handle, events }
}

describe('writeJsonToHandle', () => {
  it('正常路径：write → close，不走 abort', async () => {
    const { handle, events } = makeMockHandle()
    await writeJsonToHandle(handle, '{"ok":true}')
    assert.deepEqual(events, ['createWritable', 'write:11', 'close'])
  })

  it('write 失败 → abort，**不**调 close、错误重抛', async () => {
    const writeError = new Error('mock write fail')
    const { handle, events } = makeMockHandle({
      writeImpl: async () => { throw writeError },
    })
    await assert.rejects(
      () => writeJsonToHandle(handle, '{"ok":true}'),
      (err) => err === writeError,
    )
    // 关键：abort 被调、close **没有**被调
    assert.ok(events.includes('abort'), 'write 失败时必须 abort 丢弃 swap')
    assert.ok(!events.includes('close'), 'write 失败时不能 close（避免空 swap 提交）')
  })

  it('空字符串入参 → 立即拒绝、createWritable 都不开', async () => {
    const { handle, events } = makeMockHandle()
    await assert.rejects(
      () => writeJsonToHandle(handle, ''),
      /拒绝写入空/,
    )
    assert.equal(events.length, 0, '不应触碰文件')
  })

  it('非字符串入参 → 拒绝', async () => {
    const { handle } = makeMockHandle()
    await assert.rejects(() => writeJsonToHandle(handle, null))
    await assert.rejects(() => writeJsonToHandle(handle, undefined))
    await assert.rejects(() => writeJsonToHandle(handle, 42))
    await assert.rejects(() => writeJsonToHandle(handle, {}))
  })

  it('close 后文件意外 0 字节 → 抛错（不让上游误以为保存成功）', async () => {
    const { handle, events } = makeMockHandle({
      getFileImpl: async () => ({ size: 0 }),
    })
    await assert.rejects(
      () => writeJsonToHandle(handle, '{"big":"content"}'),
      /0 字节/,
    )
    // write 和 close 都被调（正常路径），最后是事后校验抓住
    assert.ok(events.includes('write:17'))
    assert.ok(events.includes('close'))
  })

  it('getFile 自身抛错时**不**误报 0 字节（句柄 race 兜底）', async () => {
    const { handle } = makeMockHandle({
      getFileImpl: async () => { throw new Error('handle race') },
    })
    // 即使 getFile 失败，主流程算成功（write/close 都成功）
    await writeJsonToHandle(handle, '{"ok":true}')
  })
})
