function writeLog(method, message, payload = null) {
  if (payload == null) {
    console[method](message)
    return
  }
  console[method](message, payload)
}

function buildTrackPayload(trackOrTrackId) {
  if (!trackOrTrackId) return null
  if (typeof trackOrTrackId === 'string') return { trackId: trackOrTrackId }
  return {
    trackId: trackOrTrackId.id,
    trackName: trackOrTrackId.name,
  }
}

export function createHostLogger(scope = 'HostShell') {
  const prefix = `[${scope}]`

  return {
    info(message, payload = null) {
      writeLog('log', `${prefix} ${message}`, payload)
    },
    warn(message, payload = null) {
      writeLog('warn', `${prefix} ${message}`, payload)
    },
    error(message, payload = null) {
      writeLog('error', `${prefix} ${message}`, payload)
    },
    render(reason, payload = null) {
      writeLog('log', `${prefix} 渲染 | 原因=${reason}`, payload)
    },
    sourcePickerToggled(track, isOpen) {
      writeLog('log', `${prefix} 轨道声源菜单${isOpen ? '打开' : '关闭'}`, buildTrackPayload(track))
    },
    sourcePickerClosed(track, reason) {
      writeLog('log', `${prefix} 轨道声源菜单关闭 | 原因=${reason}`, buildTrackPayload(track))
    },
    sourceAssigned(track, assignedSourceId, effectiveSourceLabel) {
      writeLog('log', `${prefix} 轨道声源已更新`, {
        ...buildTrackPayload(track),
        assignedSourceId: assignedSourceId || null,
        effectiveSourceLabel,
      })
    },
    focusSolo(action, trackId) {
      writeLog('log', `${prefix} FocusSolo | ${action}`, buildTrackPayload(trackId))
    },
  }
}
