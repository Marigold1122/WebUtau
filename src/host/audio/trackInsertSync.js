// Track insert 链路同步——把 ProjectAudioGraph 的双段 insert 重连逻辑抽离，
// 让主图谱文件保持在 max-lines baseline 内
//
// 调用方应在 channel 对象上维护以下字段（首次创建时填 '__uninitialized__' 占位 key）：
//   builtinInsertEffect / builtinInsertId / builtinInsertKey
//   vstInsertEffect / vstInsertInstanceId / vstInsertKey

import { createTrackInsertEffect } from './insert/createTrackInsertEffect.js'
import {
  buildTrackInsertProfile,
  normalizeTrackGuitarToneConfig,
  normalizeTrackInsertId,
  supportsTrackGuitarToneInsertId,
} from './insert/trackInsertCatalog.js'
import { normalizeVstInsertState } from './insert/vst/vstInsertState.js'
import { connectInsertChain, disconnectInsertChain } from './trackInsertChain.js'

function buildBuiltinKey(insertId, guitarTone) {
  const normalizedInsertId = normalizeTrackInsertId(insertId)
  if (!normalizedInsertId) return 'none'
  if (!supportsTrackGuitarToneInsertId(normalizedInsertId)) return normalizedInsertId
  return `${normalizedInsertId}::${JSON.stringify(normalizeTrackGuitarToneConfig(guitarTone))}`
}

function buildVstKey(vstInsertState) {
  if (!vstInsertState) return 'none'
  // chunkB64 不参与 key——chunk 变化通过 VstGateway 内部的 isSameVstAudioState 处理；
  // 否则每次插件 GUI 调旋钮都重建 AudioWorklet，太抖
  return [
    vstInsertState.instanceId,
    vstInsertState.pluginPath,
    vstInsertState.bypass ? '1' : '0',
    vstInsertState.programIndex,
  ].join('::')
}

function tryUpdateBuiltinInPlace(channel, state, nextBuiltinId, nextBuiltinKey, logger) {
  if (channel.builtinInsertId !== nextBuiltinId) return false
  if (!nextBuiltinId) return false
  if (typeof channel.builtinInsertEffect?.updateProfile !== 'function') return false
  try {
    channel.builtinInsertEffect.updateProfile(buildTrackInsertProfile(nextBuiltinId, {
      guitarToneConfig: state?.guitarTone,
    }))
    channel.builtinInsertKey = nextBuiltinKey
    return true
  } catch (error) {
    logger?.warn?.('Builtin insert live update failed; recreating', {
      insertId: nextBuiltinId,
      error: error?.message || String(error),
    })
    return false
  }
}

function tryUpdateVstInPlace(channel, nextVstState, nextVstKey, logger) {
  if (channel.vstInsertInstanceId !== (nextVstState?.instanceId || null)) return false
  if (!nextVstState) return false
  if (typeof channel.vstInsertEffect?.updateProfile !== 'function') return false
  try {
    channel.vstInsertEffect.updateProfile({ engine: 'vst', vstInsert: nextVstState })
    channel.vstInsertKey = nextVstKey
    return true
  } catch (error) {
    logger?.warn?.('VST insert live update failed; recreating', {
      instanceId: nextVstState.instanceId,
      error: error?.message || String(error),
    })
    return false
  }
}

function rebuildBuiltin(channel, state, nextBuiltinId, nextBuiltinKey, rawContext, logger) {
  channel.builtinInsertEffect?.dispose?.()
  channel.builtinInsertEffect = null
  channel.builtinInsertId = null
  if (nextBuiltinId) {
    try {
      const effect = createTrackInsertEffect({
        rawContext,
        insertId: nextBuiltinId,
        guitarToneConfig: state?.guitarTone,
        logger,
      })
      if (effect) {
        channel.builtinInsertEffect = effect
        channel.builtinInsertId = nextBuiltinId
      }
    } catch (error) {
      logger?.warn?.('Builtin insert setup failed', {
        insertId: nextBuiltinId,
        error: error?.message || String(error),
      })
    }
  }
  channel.builtinInsertKey = nextBuiltinKey
}

function rebuildVst(channel, nextVstState, nextVstKey, rawContext, logger) {
  channel.vstInsertEffect?.dispose?.()
  channel.vstInsertEffect = null
  channel.vstInsertInstanceId = null
  if (nextVstState) {
    try {
      const effect = createTrackInsertEffect({
        rawContext,
        vstInsert: nextVstState,
        logger,
      })
      if (effect) {
        channel.vstInsertEffect = effect
        channel.vstInsertInstanceId = nextVstState.instanceId
      }
    } catch (error) {
      logger?.warn?.('VST insert setup failed', {
        instanceId: nextVstState.instanceId,
        error: error?.message || String(error),
      })
    }
  }
  channel.vstInsertKey = nextVstKey
}

export function syncTrackInsertChain(channel, state, { rawContext, logger } = {}) {
  if (!channel || !rawContext) return false

  const nextBuiltinId = normalizeTrackInsertId(state?.insertId)
  const nextBuiltinKey = buildBuiltinKey(nextBuiltinId, state?.guitarTone)
  const nextVstState = normalizeVstInsertState(state?.vstInsert)
  const nextVstKey = buildVstKey(nextVstState)

  let builtinDirty = channel.builtinInsertKey !== nextBuiltinKey
  let vstDirty = channel.vstInsertKey !== nextVstKey
  if (!builtinDirty && !vstDirty) return false

  if (builtinDirty && tryUpdateBuiltinInPlace(channel, state, nextBuiltinId, nextBuiltinKey, logger)) {
    builtinDirty = false
  }
  if (vstDirty && tryUpdateVstInPlace(channel, nextVstState, nextVstKey, logger)) {
    vstDirty = false
  }
  if (!builtinDirty && !vstDirty) return false

  // 至少一段需要重建：先把整条链断开，重新装配
  disconnectInsertChain(channel.input, [channel.builtinInsertEffect, channel.vstInsertEffect])

  if (builtinDirty) rebuildBuiltin(channel, state, nextBuiltinId, nextBuiltinKey, rawContext, logger)
  if (vstDirty) rebuildVst(channel, nextVstState, nextVstKey, rawContext, logger)

  connectInsertChain(channel.input, channel.postInsert, [
    channel.builtinInsertEffect,
    channel.vstInsertEffect,
  ])
  return true
}
