// HostSessionStore 新增 activeDockTab 字段的行为单测
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HostSessionStore } from '../src/host/session/HostSessionStore.js'

describe('HostSessionStore.activeDockTab', () => {
  it('默认值是 mixer（首次打开 dock 优先看混音器，不是混响）', () => {
    const s = new HostSessionStore()
    assert.equal(s.getActiveDockTab(), 'mixer')
    assert.equal(s.getSnapshot().activeDockTab, 'mixer')
  })

  it('setActiveDockTab("reverb") → reverb', () => {
    const s = new HostSessionStore()
    assert.equal(s.setActiveDockTab('reverb'), 'reverb')
    assert.equal(s.getActiveDockTab(), 'reverb')
  })

  it('setActiveDockTab 接收任意字符串都 clamp 成 mixer 或 reverb', () => {
    const s = new HostSessionStore()
    assert.equal(s.setActiveDockTab('reverb'), 'reverb')
    assert.equal(s.setActiveDockTab('garbage'), 'mixer')
    assert.equal(s.setActiveDockTab(null), 'mixer')
    assert.equal(s.setActiveDockTab(undefined), 'mixer')
    assert.equal(s.setActiveDockTab(123), 'mixer')
  })

  it('activeDockTab 与 reverbDockOpen 是独立字段', () => {
    const s = new HostSessionStore()
    s.setReverbDockOpen(true)
    s.setActiveDockTab('reverb')
    assert.equal(s.isReverbDockOpen(), true)
    assert.equal(s.getActiveDockTab(), 'reverb')
    s.setActiveDockTab('mixer')
    assert.equal(s.isReverbDockOpen(), true, 'dock 应保持打开 —— 只是切换了 tab')
    assert.equal(s.getActiveDockTab(), 'mixer')
  })

  it('snapshot 含 activeDockTab 字段', () => {
    const s = new HostSessionStore()
    s.setActiveDockTab('reverb')
    s.setReverbDockOpen(true)
    const snap = s.getSnapshot()
    assert.equal(snap.activeDockTab, 'reverb')
    assert.equal(snap.reverbDockOpen, true)
  })
})
