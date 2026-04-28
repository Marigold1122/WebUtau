import { normalizeOptionalLanguageCode } from '../../config/languageOptions.js'
import { isAudioTrack } from '../project/trackContentType.js'
import { isTrackPrepPending, isTrackPrepReady } from '../project/trackPrepState.js'
import {
  getEffectiveSourceLabel,
  isVoiceRuntimeSource,
} from '../project/trackSourceAssignment.js'
import { t } from '../../i18n/index.js'

function isVocalTrack(track) {
  return isVoiceRuntimeSource(track?.playbackState?.assignedSourceId)
}

function hasPendingVoiceNoteEdits(track) {
  return Boolean(track?.pendingVoiceEditState?.needsVoiceRerender && track?.pendingVoiceEditState?.edits?.length)
}

function getMonitorStatusSuffix(track) {
  const labels = []
  if (track?.playbackState?.solo) labels.push(t('status.solo'))
  if (track?.playbackState?.mute) labels.push(t('status.mute'))
  return labels.length > 0 ? ` · ${labels.join(' / ')}` : ''
}

export function normalizeShellStatusText(text) {
  if (!text) return ''
  if (text === t('status.ready') || text === t('status.runtime_connected')) return ''
  // 兼容：旧记录里的中文也清掉，避免切到英/日时残留
  if (text === '系统就绪' || text === '运行时已连接') return ''
  return text
}

export function getTrackStatusText(track) {
  if (isAudioTrack(track)) {
    return `${t('status.audio_track')}${getMonitorStatusSuffix(track)}`
  }
  if (!isVocalTrack(track)) {
    const baseText = track?.playbackState?.assignedSourceId
      ? t('status.source_prefix', { label: getEffectiveSourceLabel(track.playbackState.assignedSourceId) })
      : t('status.default_piano')
    return `${baseText}${getMonitorStatusSuffix(track)}`
  }

  if (hasPendingVoiceNoteEdits(track)) {
    return `${t('status.pending_voice_edits')}${getMonitorStatusSuffix(track)}`
  }

  if (isVocalTrack(track) && !normalizeOptionalLanguageCode(track?.languageCode)) {
    return t('status.pending_lang')
  }

  if (isVocalTrack(track)) {
    if (track?.prepState?.status === 'failed') return t('status.pitch_predict_failed')
    if (isTrackPrepPending(track)) return t('status.pitch_predicting', { progress: track?.prepState?.progress || 0 })
    if (!isTrackPrepReady(track)) return t('status.pitch_pending')
  }

  const state = track?.renderState || { status: 'idle' }
  if (state.status === 'completed') return t('status.track_done')
  if (state.status === 'failed') return isVocalTrack(track) ? t('status.audio_render_failed') : t('status.track_render_failed')
  if (state.status === 'rendering' || state.status === 'queued' || state.status === 'preparing') {
    return state.total > 0
      ? t('status.audio_render_progress', { completed: state.completed, total: state.total })
      : t('status.audio_rendering')
  }
  if (isVocalTrack(track) && isTrackPrepReady(track)) return t('status.pitch_ready')
  return t('status.awaiting_render')
}

export function getTrackInspectorStatusText(track) {
  if (isAudioTrack(track)) {
    return `${t('status.audio_clip')}${getMonitorStatusSuffix(track)}`
  }
  if (!isVocalTrack(track)) {
    const baseText = track?.playbackState?.assignedSourceId
      ? t('status.preview_suffix', { label: getEffectiveSourceLabel(track.playbackState.assignedSourceId) })
      : t('status.default_piano_preview')
    return `${baseText}${getMonitorStatusSuffix(track)}`
  }

  if (hasPendingVoiceNoteEdits(track)) {
    return `${t('status.pending_voice_rerender')}${getMonitorStatusSuffix(track)}`
  }

  if (isVocalTrack(track) && !normalizeOptionalLanguageCode(track?.languageCode)) {
    return t('status.pending_lang')
  }

  if (isVocalTrack(track)) {
    if (track?.prepState?.status === 'failed') return t('status.pitch_predict_failed')
    if (isTrackPrepPending(track)) return t('status.pitch_predicting', { progress: track?.prepState?.progress || 0 })
    if (!isTrackPrepReady(track)) return t('status.pitch_pending')
  }

  const status = track?.renderState?.status || 'idle'
  if (status === 'failed') return isVocalTrack(track) ? t('status.audio_render_failed') : t('status.track_render_failed')
  if (status === 'rendering' || status === 'queued' || status === 'preparing') return t('status.background_rendering')
  if (status === 'completed') return t('status.track_done')
  if (isVocalTrack(track) && isTrackPrepReady(track)) return t('status.pitch_ready')
  return t('status.awaiting_render')
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
