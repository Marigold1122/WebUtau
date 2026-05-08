// 高层 VST 服务：把"工程内 VST insert 状态"与"host 实例 handle"两边的生命周期对齐。
//
// 关键问题：工程文件里只有 instanceId + chunk + path，没有 host 内的 handle。
// VstGateway 维护 instanceId → handle 的映射，按需懒加载/卸载，且在加载完成后
// 把 host 给的元数据（参数列表、通道数、延迟等）回写给上层。
//
// 故障模型：
//   - host 进程未启动 / Tauri 不可用：所有 ensureLoaded 静默返回 null，audio 通路退化为 dry through
//   - 加载失败：缓存失败原因，UI 显示，不再无限重试（用户点"重试"按钮才再发一次）
//   - host 崩溃：监听 vst://event 中 instance_crashed 事件，清理映射；上层会在下一帧重新 ensure

import {
  isVstHostAvailable,
  subscribeVstEvents,
  vstGetState,
  vstHideEditor,
  vstLoad,
  vstSetParam,
  vstSetState,
  vstShowEditor,
  vstUnload,
} from '../audio/insert/vst/vstHostClient.js'
import { isSameVstAudioState, normalizeVstInsertState } from '../audio/insert/vst/vstInsertState.js'

const DEFAULT_BLOCK_SIZE = 256

// 单例：整个进程共用一个 gateway 即可——host 是单例，instance 也共享
let singleton = null

class VstGateway {
  constructor({ logger = null } = {}) {
    this.logger = logger
    // instanceId → { handle, state, metadata, status, error, lastChunkApplied }
    this.entries = new Map()
    this.eventListeners = new Set()
    this._unsubscribeEvents = null
    this._eventInitPromise = null
  }

  setLogger(logger) {
    this.logger = logger || null
  }

  isAvailable() {
    return isVstHostAvailable()
  }

  // 给 UI 用的快照：拿到当前所有实例的展示态
  snapshot(instanceId) {
    if (instanceId) {
      const entry = this.entries.get(instanceId)
      return entry ? this._toSnapshot(entry) : null
    }
    return [...this.entries.values()].map((entry) => this._toSnapshot(entry))
  }

  // 上层（VstTrackInsert / Inspector）订阅 gateway 事件——参数刷新、加载完成、错误
  subscribe(handler) {
    if (typeof handler !== 'function') return () => {}
    this.eventListeners.add(handler)
    this._ensureHostEventStream()
    return () => this.eventListeners.delete(handler)
  }

  // 核心入口：把 instanceId 对应的工程内状态推给 gateway，gateway 决定 load/setState/unload
  async syncInstance(state, { sampleRate = 44100, blockSize = DEFAULT_BLOCK_SIZE } = {}) {
    const normalized = normalizeVstInsertState(state)
    if (!normalized) return null

    const existing = this.entries.get(normalized.instanceId) || null
    if (existing && isSameVstAudioState(existing.state, normalized) && existing.status === 'ready') {
      return this._toSnapshot(existing)
    }

    const entry = existing || {
      instanceId: normalized.instanceId,
      handle: null,
      state: normalized,
      metadata: null,
      status: 'idle',
      error: null,
      lastChunkApplied: '',
      sampleRate,
      blockSize,
    }
    entry.state = normalized

    if (!this.isAvailable()) {
      entry.status = 'unavailable'
      entry.error = 'vst_host_unavailable'
      this.entries.set(normalized.instanceId, entry)
      this._emit({ type: 'updated', instanceId: normalized.instanceId, snapshot: this._toSnapshot(entry) })
      return this._toSnapshot(entry)
    }

    if (!entry.handle) {
      entry.status = 'loading'
      entry.error = null
      this.entries.set(normalized.instanceId, entry)
      this._emit({ type: 'updated', instanceId: normalized.instanceId, snapshot: this._toSnapshot(entry) })
      try {
        const loadResult = await vstLoad({
          pluginPath: normalized.pluginPath,
          sampleRate,
          blockSize,
        })
        entry.handle = loadResult?.handle || null
        entry.metadata = loadResult || null
        entry.sampleRate = sampleRate
        entry.blockSize = blockSize
        if (!entry.handle) {
          throw new Error('host 未返回 handle')
        }
      } catch (error) {
        entry.status = 'error'
        entry.error = error?.message || String(error)
        this.logger?.warn?.('VST load failed', { instanceId: normalized.instanceId, error: entry.error })
        this._emit({ type: 'updated', instanceId: normalized.instanceId, snapshot: this._toSnapshot(entry) })
        return this._toSnapshot(entry)
      }
    }

    if (normalized.chunkB64 && normalized.chunkB64 !== entry.lastChunkApplied) {
      try {
        await vstSetState({ handle: entry.handle, chunkB64: normalized.chunkB64 })
        entry.lastChunkApplied = normalized.chunkB64
      } catch (error) {
        // chunk 应用失败不致命——插件用默认参数继续工作；记录便于排查
        this.logger?.warn?.('VST setState failed', {
          instanceId: normalized.instanceId,
          error: error?.message || String(error),
        })
      }
    }

    entry.status = 'ready'
    entry.error = null
    this.entries.set(normalized.instanceId, entry)
    this._emit({ type: 'updated', instanceId: normalized.instanceId, snapshot: this._toSnapshot(entry) })
    return this._toSnapshot(entry)
  }

  async releaseInstance(instanceId) {
    const entry = this.entries.get(instanceId)
    if (!entry) return
    this.entries.delete(instanceId)
    if (entry.handle && this.isAvailable()) {
      try { await vstUnload({ handle: entry.handle }) }
      catch (error) {
        this.logger?.warn?.('VST unload failed', { instanceId, error: error?.message || String(error) })
      }
    }
    this._emit({ type: 'released', instanceId })
  }

  async showEditor(instanceId) {
    const entry = this.entries.get(instanceId)
    if (!entry?.handle) return
    try { await vstShowEditor({ handle: entry.handle }) }
    catch (error) {
      this.logger?.warn?.('VST showEditor failed', { instanceId, error: error?.message || String(error) })
    }
  }

  async hideEditor(instanceId) {
    const entry = this.entries.get(instanceId)
    if (!entry?.handle) return
    try { await vstHideEditor({ handle: entry.handle }) }
    catch (error) {
      this.logger?.warn?.('VST hideEditor failed', { instanceId, error: error?.message || String(error) })
    }
  }

  // 给 UI 用：用户拖动 GUI 之外的旋钮时直接 setParam
  async setParam(instanceId, index, value) {
    const entry = this.entries.get(instanceId)
    if (!entry?.handle) return
    try { await vstSetParam({ handle: entry.handle, index, value }) }
    catch (error) {
      this.logger?.warn?.('VST setParam failed', { instanceId, index, error: error?.message || String(error) })
    }
  }

  // 工程保存前调用：从 host 拉最新 chunk，覆盖工程内的 chunkB64
  async captureLatestChunk(instanceId) {
    const entry = this.entries.get(instanceId)
    if (!entry?.handle) return null
    try {
      const result = await vstGetState({ handle: entry.handle })
      const chunk = typeof result === 'string' ? result : (result?.chunkB64 || '')
      entry.lastChunkApplied = chunk
      return chunk
    } catch (error) {
      this.logger?.warn?.('VST getState failed', { instanceId, error: error?.message || String(error) })
      return null
    }
  }

  _toSnapshot(entry) {
    return {
      instanceId: entry.instanceId,
      handle: entry.handle,
      status: entry.status,
      error: entry.error,
      metadata: entry.metadata,
      pluginPath: entry.state?.pluginPath || '',
      displayName: entry.state?.displayName || '',
      bypass: Boolean(entry.state?.bypass),
    }
  }

  _emit(event) {
    this.eventListeners.forEach((handler) => {
      try { handler(event) }
      catch (_error) {}
    })
  }

  _ensureHostEventStream() {
    if (this._eventInitPromise) return
    this._eventInitPromise = subscribeVstEvents((payload) => {
      if (!payload || typeof payload !== 'object') return
      // 简单分发：把 host 事件原样转给订阅者，让 VstTrackInsert / UI 自行解释
      this._emit({ type: 'host_event', payload })
      // instance_crashed：清掉 handle，下一次 sync 时会重新 load
      if (payload.event === 'instance_crashed' && payload.handle) {
        for (const [instanceId, entry] of this.entries) {
          if (entry.handle === payload.handle) {
            entry.handle = null
            entry.status = 'error'
            entry.error = 'instance_crashed'
            this._emit({ type: 'updated', instanceId, snapshot: this._toSnapshot(entry) })
            break
          }
        }
      }
    }).then((unlisten) => {
      this._unsubscribeEvents = typeof unlisten === 'function' ? unlisten : null
    })
  }
}

export function getVstGateway({ logger = null } = {}) {
  if (!singleton) {
    singleton = new VstGateway({ logger })
  } else if (logger) {
    singleton.setLogger(logger)
  }
  return singleton
}
