import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { isTrackPrepPending, isTrackPrepReady } from '../project/trackPrepState.js'
import {
  getEffectiveSourceLabel,
  isVoiceRuntimeSource,
} from '../project/trackSourceAssignment.js'

function isVocalTrack(track) {
  return isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)
}

function hasPendingVoiceNoteEdits(track) {
  return Boolean(track?.pendingVoiceEditState?.needsVoiceRerender && track?.pendingVoiceEditState?.edits?.length)
}

function getMonitorStatusSuffix(track) {
  const labels = []
  if (track?.playbackState?.solo) labels.push('独奏')
  if (track?.playbackState?.mute) labels.push('静音')
  return labels.length > 0 ? ` · ${labels.join(' / ')}` : ''
}

export function normalizeShellStatusText(text) {
  if (!text) return ''
  if (text === '系统就绪' || text === '运行时已连接') return ''
  return text
}

export function getTrackStatusText(track) {
  if (isAudioTrack(track)) {
    return `导入音频${getMonitorStatusSuffix(track)}`
  }
  if (!isVocalTrack(track)) {
    const baseText = track?.playbackState?.assignedSourceId
      ? `声源：${getEffectiveSourceLabel(track.playbackState.assignedSourceId)}`
      : '默认钢琴'
    return `${baseText}${getMonitorStatusSuffix(track)}`
  }

  if (hasPendingVoiceNoteEdits(track)) {
    return `音符已改动 · 待切到歌词/音高重渲${getMonitorStatusSuffix(track)}`
  }

  if (isVocalTrack(track) && !normalizeOptionalLanguageCode(track?.languageCode)) {
    return '待选语言'
  }

  if (isVocalTrack(track)) {
    if (track?.prepState?.status === 'failed') return '音高预测失败'
    if (isTrackPrepPending(track)) return `音高预测 ${track?.prepState?.progress || 0}%`
    if (!isTrackPrepReady(track)) return '待预测音高'
  }

  const state = track?.renderState || { status: 'idle' }
  if (state.status === 'completed') return '当前轨已完成'
  if (state.status === 'failed') return isVocalTrack(track) ? '音频渲染失败' : '当前轨渲染失败'
  if (state.status === 'rendering' || state.status === 'queued' || state.status === 'preparing') {
    return state.total > 0 ? `音频渲染 ${state.completed}/${state.total}` : '音频渲染中...'
  }
  if (isVocalTrack(track) && isTrackPrepReady(track)) return '音高已就绪'
  return '等待渲染'
}

export function getTrackInspectorStatusText(track) {
  if (isAudioTrack(track)) {
    return `音频片段${getMonitorStatusSuffix(track)}`
  }
  if (!isVocalTrack(track)) {
    const baseText = track?.playbackState?.assignedSourceId
      ? `${getEffectiveSourceLabel(track.playbackState.assignedSourceId)} 预览`
      : '默认钢琴预览'
    return `${baseText}${getMonitorStatusSuffix(track)}`
  }

  if (hasPendingVoiceNoteEdits(track)) {
    return `待重新渲染人声 · 当前改动段落先按钢琴预览${getMonitorStatusSuffix(track)}`
  }

  if (isVocalTrack(track) && !normalizeOptionalLanguageCode(track?.languageCode)) {
    return '待选语言'
  }

  if (isVocalTrack(track)) {
    if (track?.prepState?.status === 'failed') return '音高预测失败'
    if (isTrackPrepPending(track)) return `音高预测 ${track?.prepState?.progress || 0}%`
    if (!isTrackPrepReady(track)) return '待预测音高'
  }

  const status = track?.renderState?.status || 'idle'
  if (status === 'failed') return isVocalTrack(track) ? '音频渲染失败' : '当前轨渲染失败'
  if (status === 'rendering' || status === 'queued' || status === 'preparing') return '后台渲染中'
  if (status === 'completed') return '当前轨已完成'
  if (isVocalTrack(track) && isTrackPrepReady(track)) return '音高已就绪'
  return '等待渲染'
}

export function getTrackRenderClass(track) {
  if (isAudioTrack(track)) return 'ready'
  if (!isVocalTrack(track)) return 'idle'
  if (hasPendingVoiceNoteEdits(track)) return 'dirty'

  if (isVocalTrack(track)) {
    if (track?.prepState?.status === 'failed') return 'dirty'
    if (isTrackPrepPending(track)) return 'rendering'
  }

  const status = track?.renderState?.status || 'idle'
  if (status === 'completed') return 'ready'
  if (status === 'failed') return 'dirty'
  if (status === 'rendering' || status === 'queued' || status === 'preparing') return 'rendering'
  if (isVocalTrack(track) && isTrackPrepReady(track)) return 'ready'
  return 'idle'
}
