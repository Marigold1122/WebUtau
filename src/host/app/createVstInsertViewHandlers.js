// VST insert 视图处理函数。仿照 createVoiceConversionViewHandlers 的形态——
// 接收 store / view / audioGraph / gateway 依赖，返回供 ShellLayoutView 用的 handler 集合
// + 一个 computeViewState() 用于 render 时给 inspector 喂数据。
//
// 该模块只关心"用户在 inspector VST 区段的交互"——文件选择、加载、移除、bypass、打开 GUI。
// 不持有 host 真正的状态：handle / 参数等都委托给 VstGateway。

import { mergeVstInsertState, normalizeVstInsertState } from '../audio/insert/vst/vstInsertState.js'
import { pickVst3PluginFile } from '../audio/insert/vst/vstHostClient.js'
import { getVstGateway } from '../services/VstGateway.js'

// 每条 track 对应的最近一次 gateway snapshot（仅用于 viewState 渲染，不参与持久化）
const trackGatewaySnapshots = new Map()

// 把 instanceId → trackId 反向索引一份，方便事件回流时找到目标 track
const instanceToTrackId = new Map()

function attachGatewayListener(gateway, { store, audioGraph, onProjectChanged, logger }) {
  if (!gateway || gateway.__hostListenerAttached) return
  gateway.__hostListenerAttached = true
  gateway.subscribe((event) => {
    if (!event) return
    if (event.type === 'updated' && event.instanceId) {
      const trackId = instanceToTrackId.get(event.instanceId)
      if (!trackId) return
      trackGatewaySnapshots.set(trackId, event.snapshot)
      // gateway 状态变化（载入完成 / 报错）触发上层重渲染，这样 inspector 能反映 status
      onProjectChanged?.({ silent: true })
    } else if (event.type === 'host_event' && event.payload?.event === 'editor_closed') {
      // 编辑器被用户从原生窗口关闭——不影响工程状态，只触发 UI 重渲染
      onProjectChanged?.({ silent: true })
    }
    // ignore: released（前端主动 release 时已经清理；不会在这里到达）
    void store
    void audioGraph
    void logger
  })
}

export function createVstInsertViewHandlers({
  store,
  audioGraph,
  onProjectChanged,
  logger = null,
} = {}) {
  const gateway = getVstGateway({ logger })
  attachGatewayListener(gateway, { store, audioGraph, onProjectChanged, logger })

  function getSelectedTrack() {
    return store.getSelectedTrack?.() || null
  }

  async function applyTrackVstInsert(trackId, nextInsertState) {
    const normalized = normalizeVstInsertState(nextInsertState)
    store.updateTrack?.(trackId, { vstInsert: normalized })
    if (normalized) {
      instanceToTrackId.set(normalized.instanceId, trackId)
    }
    audioGraph?.syncTrackState?.(trackId, { vstInsert: normalized })
    if (normalized) {
      try {
        await gateway.syncInstance(normalized, {
          sampleRate: audioGraph?.rawContext?.sampleRate || 44100,
        })
      } catch (error) {
        logger?.warn?.('VST insert sync failed', { trackId, error: error?.message || String(error) })
      }
    }
    onProjectChanged?.()
  }

  async function loadVstFromFilePicker(trackId, { replace = false } = {}) {
    const track = store.getTrack?.(trackId)
    if (!track) return
    let pluginPath = null
    try {
      pluginPath = await pickVst3PluginFile()
    } catch (error) {
      if (error?.code !== 'vst_host_unavailable') {
        logger?.warn?.('VST file picker failed', { error: error?.message || String(error) })
      }
      return
    }
    if (!pluginPath) return

    const previousInsert = replace ? null : (track.vstInsert || null)
    // 替换时强制生成新 instanceId（旧实例释放）
    if (replace && previousInsert?.instanceId) {
      try { await gateway.releaseInstance(previousInsert.instanceId) } catch (_e) {}
      instanceToTrackId.delete(previousInsert.instanceId)
      trackGatewaySnapshots.delete(trackId)
    }

    const nextInsert = mergeVstInsertState(replace ? null : previousInsert, {
      pluginPath,
      // 替换 / 新建：清空 chunk + 用 path basename 作展示名
      chunkB64: '',
      displayName: '',
    })
    await applyTrackVstInsert(trackId, nextInsert)
  }

  return {
    handlers: {
      async onVstLoadRequested(options = {}) {
        const track = getSelectedTrack()
        if (!track) return
        await loadVstFromFilePicker(track.id, options)
      },
      async onVstRemoveRequested() {
        const track = getSelectedTrack()
        if (!track) return
        const existing = track.vstInsert || null
        if (existing?.instanceId) {
          try { await gateway.releaseInstance(existing.instanceId) } catch (_e) {}
          instanceToTrackId.delete(existing.instanceId)
        }
        trackGatewaySnapshots.delete(track.id)
        await applyTrackVstInsert(track.id, null)
      },
      async onVstBypassChanged(bypass) {
        const track = getSelectedTrack()
        if (!track?.vstInsert) return
        const next = mergeVstInsertState(track.vstInsert, { bypass: Boolean(bypass) })
        await applyTrackVstInsert(track.id, next)
      },
      async onVstOpenEditor() {
        const track = getSelectedTrack()
        if (!track?.vstInsert?.instanceId) return
        await gateway.showEditor(track.vstInsert.instanceId)
      },
    },
    computeViewState(selectedTrack) {
      // selectedTrack 由 createHostApp 在 render 阶段提供——
      // VST section 仅在选中轨道时显示，未选 = 不可见
      if (!selectedTrack) {
        return { visible: false, hostAvailable: gateway.isAvailable() }
      }
      const insert = selectedTrack.vstInsert || null
      const snapshot = insert ? trackGatewaySnapshots.get(selectedTrack.id) : null
      return {
        visible: true,
        hostAvailable: gateway.isAvailable(),
        vstInsert: insert,
        status: snapshot?.status || (insert ? 'idle' : 'idle'),
        errorMessage: snapshot?.error || '',
      }
    },
  }
}
