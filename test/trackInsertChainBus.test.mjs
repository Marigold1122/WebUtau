// 用 Web Audio API mock 验证 TrackInsertChainBus：
//   - attach() 起来后节点拓扑正确（input → 4 段 EQ → comp → makeup → output）
//   - applyConfig 写入参数 + bypass 透明化
//   - dispose() 不留泄漏
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TrackInsertChainBus } from '../src/host/audio/insert/TrackInsertChainBus.js'
import { normalizeTrackInsertChain } from '../src/host/project/trackInsertChainState.js'

// ──── 最小 Web Audio mock ──────────────────────────────────────────
function createMockAudioParam(initialValue) {
  return {
    value: initialValue,
    _history: [],
    setValueAtTime(v) { this.value = v; this._history.push(['setValueAtTime', v]) },
    setTargetAtTime(v) { this.value = v; this._history.push(['setTargetAtTime', v]) },
    cancelScheduledValues() {},
  }
}
function createMockNode(kind) {
  const connections = []
  return {
    kind,
    connections,
    connect(target) { connections.push(target) },
    disconnect() { connections.length = 0 },
    // AudioParams（按节点类型给）
    gain: createMockAudioParam(1),
    frequency: createMockAudioParam(0),
    Q: createMockAudioParam(1),
    threshold: createMockAudioParam(0),
    ratio: createMockAudioParam(1),
    attack: createMockAudioParam(0),
    release: createMockAudioParam(0),
    knee: createMockAudioParam(0),
    type: '',
  }
}
function createMockContext() {
  return {
    currentTime: 0,
    createGain: () => createMockNode('gain'),
    createBiquadFilter: () => createMockNode('biquad'),
    createDynamicsCompressor: () => createMockNode('comp'),
  }
}

describe('TrackInsertChainBus.attach', () => {
  it('挂上后 input/output 存在、4 段 EQ + comp + makeup 都建好', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    assert.ok(bus.input)
    assert.ok(bus.output)
    assert.equal(bus.eqNodes.length, 4)
    assert.equal(bus.eqNodes[0].type, 'lowshelf')
    assert.equal(bus.eqNodes[1].type, 'peaking')
    assert.equal(bus.eqNodes[2].type, 'peaking')
    assert.equal(bus.eqNodes[3].type, 'highshelf')
    assert.ok(bus.compressor)
    assert.ok(bus.makeupGain)
  })

  it('节点串联拓扑：input → eq0 → eq1 → eq2 → eq3 → comp → makeup → output', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    // input 直连第一段 EQ
    assert.equal(bus.input.connections[0], bus.eqNodes[0])
    // 4 段 EQ 依次串联
    for (let i = 0; i < 3; i++) {
      assert.equal(bus.eqNodes[i].connections[0], bus.eqNodes[i + 1])
    }
    // EQ[3] → comp
    assert.equal(bus.eqNodes[3].connections[0], bus.compressor)
    // comp → makeup → output
    assert.equal(bus.compressor.connections[0], bus.makeupGain)
    assert.equal(bus.makeupGain.connections[0], bus.output)
  })

  it('重复调 attach 不会重复建节点', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx).attach(ctx)
    assert.equal(bus.eqNodes.length, 4)
  })
})

describe('TrackInsertChainBus.applyConfig', () => {
  it('两槽默认 disabled → 透明化（EQ gain=0、Comp threshold=0 ratio=1 makeup=1）', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig(normalizeTrackInsertChain({}))
    bus.eqNodes.forEach((eq) => {
      assert.equal(eq.gain.value, 0, 'EQ disabled → gain 归零')
    })
    assert.equal(bus.compressor.threshold.value, 0, 'Comp disabled → threshold=0')
    assert.equal(bus.compressor.ratio.value, 1, 'Comp disabled → ratio=1（透明）')
    assert.equal(bus.makeupGain.gain.value, 1, 'Comp disabled → makeup 锁 1')
  })

  it('启用 EQ → 用户设的 gain 写入各段', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig({
      eq4: { enabled: true, bands: [
        { type: 'lowshelf', freq: 100, gain: 3, q: 0.7 },
        { type: 'peaking', freq: 500, gain: -2, q: 1 },
        { type: 'peaking', freq: 3000, gain: 4, q: 1 },
        { type: 'highshelf', freq: 12000, gain: 2, q: 0.7 },
      ] },
      comp: { enabled: false },
    })
    assert.equal(bus.eqNodes[0].gain.value, 3)
    assert.equal(bus.eqNodes[1].gain.value, -2)
    assert.equal(bus.eqNodes[2].gain.value, 4)
    assert.equal(bus.eqNodes[3].gain.value, 2)
    assert.equal(bus.eqNodes[0].frequency.value, 100)
    assert.equal(bus.eqNodes[3].frequency.value, 12000)
  })

  it('EQ 从 enabled → disabled，gain 自动归零（不动 freq/Q）', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig({
      eq4: { enabled: true, bands: [{ type: 'lowshelf', freq: 100, gain: 5, q: 0.7 }, {}, {}, {}] },
      comp: { enabled: false },
    })
    assert.equal(bus.eqNodes[0].gain.value, 5)
    // 切到 disabled
    bus.applyConfig({
      eq4: { enabled: false, bands: [{ type: 'lowshelf', freq: 100, gain: 5, q: 0.7 }, {}, {}, {}] },
      comp: { enabled: false },
    })
    assert.equal(bus.eqNodes[0].gain.value, 0, 'EQ disabled 时 gain 归 0')
    assert.equal(bus.eqNodes[0].frequency.value, 100, '但 freq 仍保留用户设定')
  })

  it('启用 Comp → threshold / ratio / attack / release / knee / makeup 全写入', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig({
      eq4: { enabled: false },
      comp: {
        enabled: true,
        threshold: -24, ratio: 4, attack: 0.01, release: 0.2, knee: 6, makeupGain: 3,
      },
    })
    assert.equal(bus.compressor.threshold.value, -24)
    assert.equal(bus.compressor.ratio.value, 4)
    assert.equal(bus.compressor.attack.value, 0.01)
    assert.equal(bus.compressor.release.value, 0.2)
    assert.equal(bus.compressor.knee.value, 6)
    // makeupGain 3dB → 线性约 1.41
    assert.ok(bus.makeupGain.gain.value > 1.4 && bus.makeupGain.gain.value < 1.42)
  })
})

describe('TrackInsertChainBus.isTransparent', () => {
  it('两槽都 disabled → 整链透明', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig(normalizeTrackInsertChain({}))
    assert.equal(bus.isTransparent(), true)
  })
  it('EQ 启用 → 非透明', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig({ eq4: { enabled: true, bands: [] }, comp: { enabled: false } })
    assert.equal(bus.isTransparent(), false)
  })
})

describe('TrackInsertChainBus.dispose', () => {
  it('dispose 后引用全清', () => {
    const ctx = createMockContext()
    const bus = new TrackInsertChainBus().attach(ctx)
    bus.applyConfig(normalizeTrackInsertChain({}))
    bus.dispose()
    assert.equal(bus.input, null)
    assert.equal(bus.output, null)
    assert.equal(bus.eqNodes.length, 0)
    assert.equal(bus.compressor, null)
    assert.equal(bus.makeupGain, null)
    assert.equal(bus.config, null)
  })
  it('dispose 没 attach 过的 bus 不抛错', () => {
    const bus = new TrackInsertChainBus()
    assert.doesNotThrow(() => bus.dispose())
  })
})
